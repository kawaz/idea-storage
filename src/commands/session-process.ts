import { define } from 'gunshi'
import { join } from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { loadConfig } from '../lib/config.ts'
import { loadRecipes } from '../lib/recipe.ts'
import { getRecipesDir, getDataDir, getDoneDir } from '../lib/paths.ts'
import { getSessionMeta, formatConversationToText } from '../lib/conversation.ts'
import { splitConversation } from '../lib/chunker.ts'
import { generateFrontmatter } from '../lib/frontmatter.ts'
import { runClaude } from '../lib/claude-runner.ts'
import { dequeue, markDone, markFailed } from '../lib/queue.ts'
import { exitWithError } from '../lib/errors.ts'
import type { Recipe } from '../types/index.ts'

async function findFirstSessionFile(claudeDirs: string[], sessionId: string): Promise<string | null> {
  for (const claudeDir of claudeDirs) {
    const projectsDir = join(claudeDir, 'projects')
    const glob = new Bun.Glob(`**/${sessionId}.jsonl`)
    for await (const relativePath of glob.scan(projectsDir)) {
      return join(projectsDir, relativePath)
    }
  }
  return null
}

function findRecipeByName(recipes: Recipe[], name: string): Recipe | undefined {
  return recipes.find(r => r.name === name)
}

function formatDatePath(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}/${m}/${d}`
}

function formatFileTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
}

export async function runProcess(): Promise<boolean> {
  const entry = await dequeue()
  if (!entry) {
    console.log('No items in queue')
    return false
  }

  const { sessionId, recipeName, key } = entry
  const config = await loadConfig()
  const dataDir = getDataDir()

  // Find session file
  const sessionFile = await findFirstSessionFile(config.claudeDirs, sessionId)
  if (!sessionFile) {
    console.log(`${key}: session file not found`)
    return true
  }

  // Find recipe
  let recipes: Recipe[]
  try {
    recipes = await loadRecipes(getRecipesDir())
  } catch {
    exitWithError(`No recipes found in ${getRecipesDir()}`)
  }

  const recipe = findRecipeByName(recipes, recipeName)
  if (!recipe) {
    console.log(`${key}: recipe '${recipeName}' not found`)
    return true
  }

  // Get session metadata
  const meta = await getSessionMeta(sessionFile)

  // Determine mode based on on_existing and done state
  let prompt = recipe.prompt
  let hasPreviousRun = false
  try {
    const doneFilePath = join(getDoneDir(), key)
    const doneFile = Bun.file(doneFilePath)
    if (await doneFile.exists()) {
      const prevLines = parseInt(await doneFile.text(), 10)
      if (!isNaN(prevLines) && meta.lineCount > prevLines) {
        hasPreviousRun = true
      }
    }
  } catch {
    // No previous done entry
  }

  if (hasPreviousRun) {
    switch (recipe.onExisting) {
      case 'skip':
        console.log(`${key}: skipping (already processed)`)
        return true
      case 'append':
        prompt += '\n\n---\nNote: Session continued. Please append to existing entry.'
        break
      case 'separate':
        // New file, no modification needed
        break
    }
  }

  console.log(`${key}: [${recipeName}] (${meta.lineCount} lines) @ ${meta.project || 'unknown'}`)

  // Extract conversation text
  const convText = await formatConversationToText(sessionFile)
  if (!convText) {
    console.log(`${key}: skipped (no conversation messages)`)
    await markDone(key, meta.lineCount)
    return true
  }

  // Split into chunks
  const chunks = splitConversation(convText)

  // Write chunks to temp files
  const tmpDir = join(dataDir, '.tmp')
  await mkdir(tmpDir, { recursive: true })
  const chunkFiles: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = join(tmpDir, `${sessionId}.conversation.${i + 1}.txt`)
    await Bun.write(chunkPath, chunks[i]!)
    chunkFiles.push(chunkPath)
  }

  // Build file list
  const fileList = chunkFiles.map(f => `- ${f}`).join('\n')

  // Build full prompt
  const sessionStart = meta.startTime.toISOString()
  const fullPrompt = `${prompt}

---
## セッション情報
- Session ID: ${sessionId}
- Project: ${meta.project || 'unknown'}
- Created: ${sessionStart}

## 会話ログ
会話ログは以下のファイルにあります。全てのファイルを端折らず順番に読んでから日誌を書いてください。
${fileList}`

  try {
    const output = await runClaude({ prompt: fullPrompt, addDir: dataDir })

    // Generate frontmatter
    const sessionEnd = meta.endTime ? meta.endTime.toISOString() : 'unknown'
    const generatedAt = new Date().toISOString()
    const fm = generateFrontmatter({
      session_id: sessionId,
      project: meta.project || 'unknown',
      session_start: sessionStart,
      session_end: sessionEnd,
      generated_at: generatedAt,
      recipe: recipeName,
      source_lines: meta.lineCount,
      user_turns: meta.userTurns,
    })

    // Output file path: {dataDir}/{recipeName}/YYYY/MM/DD/{yyyymmddTHHMMSSZ}.{sessionId}.md
    const datePath = formatDatePath(meta.startTime)
    const outputDir = join(dataDir, recipeName, datePath)
    await mkdir(outputDir, { recursive: true })

    const fileTs = formatFileTimestamp(meta.startTime)
    const outputFile = join(outputDir, `${fileTs}.${sessionId}.md`)

    await Bun.write(outputFile, fm + output)
    await markDone(key, meta.lineCount)
    console.log(`${key}: success -> ${outputFile}`)
  } catch (err) {
    await markFailed(key)
    console.error(`${key}: failed (${err instanceof Error ? err.message : String(err)})`)
  } finally {
    // Cleanup temp files
    for (const f of chunkFiles) {
      try { await rm(f) } catch { /* ignore */ }
    }
  }

  return true
}

const sessionProcess = define({
  name: 'process',
  description: 'Process one item from the queue',
  run: async () => {
    await runProcess()
  },
})

export default sessionProcess
