import { define } from 'gunshi'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { loadConfig } from '../lib/config.ts'
import { loadRecipes } from '../lib/recipe.ts'
import { getRecipesDir, getDataDir, getDoneDir } from '../lib/paths.ts'
import { getSessionMeta } from '../lib/conversation.ts'
import { generateFrontmatter } from '../lib/frontmatter.ts'
import { runClaude, ClaudeTimeoutError, ClaudeAbortError } from '../lib/claude-runner.ts'
import type { ClaudeRunOptions } from '../lib/claude-runner.ts'
import { dequeue, markDone, markFailed } from '../lib/queue.ts'
import { exitWithError } from '../lib/errors.ts'
import { splitTimeline, extractChunkText, type TimelineChunk } from '../lib/chunker.ts'
import { log, logError } from '../lib/logging.ts'
import type { Recipe, SessionMeta } from '../types/index.ts'

const csaBin = 'claude-session-analysis'

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

// --- フォークセッション用のタイムライン切り詰め ---

/**
 * フォークセッションのタイムラインから、フォーク後の新規部分のみを抽出する。
 * firstNewUuid の先頭8文字を CSA ブロックID として検索し、
 * そのブロック以降（--- 区切り含む）を返す。
 */
export function trimTimelineForFork(timelineText: string, firstNewUuid: string): string {
  if (!firstNewUuid) return timelineText

  const blockIdPrefix = firstNewUuid.slice(0, 8)
  const lines = timelineText.split('\n')

  // ヘッダー（最初の --- ... --- ペア）を特定
  let headerEnd = 0
  if (lines[0]?.trim() === '---') {
    let i = 1
    while (i < lines.length && lines[i]?.trim() !== '---') i++
    headerEnd = i + 1 // 閉じの --- の次
  }

  // CSA ブロックID パターン: タイプ文字(U,T,B,F,G,R,W,S等) + 8文字hex
  // .includes() だとメッセージ本文中の偶然の一致で誤マッチするため、
  // CSA のブロックIDフォーマットに限定してマッチする
  const blockIdPattern = new RegExp(`[A-Z]${blockIdPrefix}\\b`)

  // ブロックIDを含む行を探す
  for (let i = headerEnd; i < lines.length; i++) {
    if (blockIdPattern.test(lines[i] ?? '')) {
      // この行を含むブロックの開始位置（直前の --- か headerEnd）を見つける
      let blockStart = i
      for (let j = i - 1; j >= headerEnd; j--) {
        if (lines[j]?.trim() === '---') {
          blockStart = j
          break
        }
      }
      // ヘッダー + このブロック以降を返す
      const header = lines.slice(0, headerEnd).join('\n')
      const body = lines.slice(blockStart).join('\n')
      return header + '\n' + body
    }
  }

  // 見つからない場合はそのまま返す
  return timelineText
}

// --- チャンク分割パス用のプロンプトビルダー ---

/**
 * セクションプロンプトを生成する。
 * 各チャンクを個別に処理するための指示をレシピの指示と組み合わせる。
 */
export function buildSectionPrompt(
  recipePrompt: string,
  chunk: TimelineChunk,
  chunkText: string,
  sessionInfo: string,
): string {
  return `あなたはこれからセッションの一部分（チャンク）を読みます。
以下のレシピの指示に従って、このチャンクについてのセクションを書いてください。

--- レシピの指示 ---
${recipePrompt}
---

重要:
- このチャンクの内容に集中して、深く具体的に書いてください
- 短くまとめすぎないでください。このセクションはそのまま最終出力の一部になります
- セクション見出し（## ）を1つ付けてください。内容に合った見出しにしてください
- 他のチャンクの内容は知らなくて構いません

---
## チャンク情報
- チャンク: ${chunk.index + 1}/${chunk.label}
- ターン数: ${chunk.turnCount}

## セッション情報
${sessionInfo}

## 会話タイムライン（このチャンクの部分）
${chunkText}`
}

/**
 * 合成プロンプトを生成する。
 * 各セクションの結果を統合して最終出力を作るための指示。
 */
export function buildSynthesisPrompt(sections: string[], sessionInfo: string): string {
  return `出力はMarkdown形式で。

以下は、あるセッションの出力を分割して書いたセクションです。
あなたの仕事は：

1. 全セクションをそのまま並べる（各セクションの見出しと本文はそのまま維持）
2. 冒頭にタイトル（# ）を付ける
3. 末尾に「## まとめ」セクションを追加する
   - 全体を通して感じたことを自分の言葉で書く
   - 各セクションの繰り返しにならないように、俯瞰的な視点で
   - セッション全体の流れや変化について

各セクションは編集しないでください。追加するのはタイトルとまとめだけです。

---
## セッション情報
${sessionInfo}

## セクション一覧
${sections.map((s, i) => `### --- セクション ${i + 1} ---\n${s}`).join('\n\n')}`
}

/**
 * チャンク分割パスで処理する。
 * 各チャンクを並列で処理し、結果を合成する。
 * 1つのチャンクが失敗したら AbortController で他の全チャンクをキャンセルする。
 *
 * @param _runClaudeOverride - テスト用: runClaude の差し替え関数
 */
export async function processChunked(
  convText: string,
  chunks: TimelineChunk[],
  recipePrompt: string,
  sessionId: string,
  meta: SessionMeta,
  timeoutMs?: number,
  _runClaudeOverride?: (options: ClaudeRunOptions) => Promise<string>,
): Promise<string> {
  const run = _runClaudeOverride ?? runClaude
  const sessionInfo = `- Session ID: ${sessionId}\n- Project: ${meta.project || 'unknown'}\n- Created: ${meta.startTime.toISOString()}`

  const controller = new AbortController()

  // 各チャンクを並列で処理し、1つが失敗したら全てをキャンセル
  const sectionSettled = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const chunkText = extractChunkText(convText, chunk)
      const sectionPrompt = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo)
      try {
        return await run({ prompt: sectionPrompt, timeoutMs, signal: controller.signal })
      } catch (err) {
        controller.abort()
        throw err
      }
    })
  )

  // 結果を集約: 最初の非-abort エラーを投げ直す
  const sectionResults: string[] = []
  let firstError: unknown = null
  for (const result of sectionSettled) {
    if (result.status === 'fulfilled') {
      sectionResults.push(result.value)
    } else if (!(result.reason instanceof ClaudeAbortError)) {
      // abort 以外のエラー（元々の失敗原因）を記録
      firstError ??= result.reason
    }
  }

  if (firstError) {
    throw firstError
  }

  // 合成
  const synthesisPrompt = buildSynthesisPrompt(sectionResults, sessionInfo)
  return run({ prompt: synthesisPrompt, timeoutMs })
}

export interface RunProcessOptions {
  taskTimeoutMs?: number
}

export async function runProcess(options: RunProcessOptions = {}): Promise<boolean> {
  const entry = await dequeue()
  if (!entry) {
    log({ msg: 'no_items_in_queue' })
    return false
  }

  const { sessionId, recipeName, key } = entry
  const config = await loadConfig()
  const dataDir = getDataDir()

  // Find session file
  const sessionFile = await findFirstSessionFile(config.claudeDirs, sessionId)
  if (!sessionFile) {
    log({ key, msg: 'session_file_not_found' })
    await markFailed(key, 'session file not found')
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
    log({ key, msg: 'recipe_not_found', recipe: recipeName })
    await markFailed(key, `recipe not found: ${recipeName}`)
    return true
  }

  // Get session metadata
  const meta = await getSessionMeta(sessionFile)

  // Get session stats from claude-session-analysis (early fetch for log + frontmatter)
  let sessionStats: { turns?: number; bytes?: number; duration_ms?: number } = {}
  try {
    const statsProc = Bun.spawn([csaBin, 'sessions', '--format', 'jsonl', sessionId], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const statsOut = await new Response(statsProc.stdout).text()
    await statsProc.exited
    const line = statsOut.trim().split('\n')[0]
    if (line) sessionStats = JSON.parse(line)
  } catch {
    // fallback: use meta values
  }

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
        log({ key, msg: 'skip', reason: 'already_processed' })
        return true
      case 'append':
        prompt += '\n\n---\nNote: Session continued. Please append to existing entry.'
        break
      case 'separate':
        // New file, no modification needed
        break
    }
  }

  const sizeBytes = sessionStats.bytes ?? null
  const turns = sessionStats.turns ?? meta.userTurns
  const project = meta.project || 'unknown'
  log({ key, msg: 'start', recipe: recipeName, sizeBytes, turns, project })

  // Extract conversation timeline via claude-session-analysis
  const csaProc = Bun.spawn([csaBin, 'timeline', sessionId, '--md', '--no-emoji'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [convText, csaStderr] = await Promise.all([
    new Response(csaProc.stdout).text(),
    new Response(csaProc.stderr).text(),
  ])
  const csaExitCode = await csaProc.exited

  if (csaExitCode !== 0) {
    logError({ key, msg: 'csa_failed', exitCode: csaExitCode, stderr: csaStderr })
    await markFailed(key, `csa failed with exit code ${csaExitCode}`)
    return true
  }

  if (!convText.trim()) {
    log({ key, msg: 'skip', reason: 'no_conversation' })
    await markDone(key, meta.lineCount)
    return true
  }

  // フォークセッションの場合、タイムラインを切り詰め＋プロンプト調整
  let timelineText = convText
  if (meta.forkInfo) {
    log({ key, msg: 'fork', parent: meta.forkInfo.parentSessionId })

    if (!meta.forkInfo.firstNewUuid) {
      log({ key, msg: 'skip', reason: 'fork_no_new_conversation' })
      await markDone(key, meta.lineCount)
      return true
    }

    const originalLen = convText.length
    timelineText = trimTimelineForFork(convText, meta.forkInfo.firstNewUuid)
    log({ key, msg: 'trimmed', from: originalLen, to: timelineText.length })
    prompt += `\n\n---\nNote: このセッションは元セッション ${meta.forkInfo.parentSessionId} からフォークされたものです。以下のタイムラインはフォーク後の新規会話のみです。`
  }

  // チャンク分割の判定
  const chunks = splitTimeline(timelineText)

  const { taskTimeoutMs } = options

  try {
    let output: string
    const sessionStart = meta.startTime.toISOString()

    if (chunks.length > 1) {
      log({ key, msg: 'chunked', chunks: chunks.length })
      output = await processChunked(timelineText, chunks, prompt, sessionId, meta, taskTimeoutMs)
    } else {
      // 既存の単一パス（変更なし）
      const fullPrompt = `${prompt}

---
## セッション情報
- Session ID: ${sessionId}
- Project: ${meta.project || 'unknown'}
- Created: ${sessionStart}

## 会話タイムライン
${timelineText}`
      output = await runClaude({ prompt: fullPrompt, addDir: dataDir, timeoutMs: taskTimeoutMs })
    }

    // Generate frontmatter
    const sessionEnd = meta.endTime ? meta.endTime.toISOString() : 'unknown'
    const generatedAt = new Date().toISOString()
    const fmData: Record<string, unknown> = {
      session_id: sessionId,
      project: meta.project || 'unknown',
      session_start: sessionStart,
      session_end: sessionEnd,
      generated_at: generatedAt,
      recipe: recipeName,
      user_turns: sessionStats.turns ?? meta.userTurns,
      session_bytes: sessionStats.bytes,
      duration_ms: sessionStats.duration_ms,
    }
    if (meta.forkInfo) {
      fmData.forked_from = meta.forkInfo.parentSessionId
    }
    const fm = generateFrontmatter(fmData)

    // Output file path: {dataDir}/{recipeName}/YYYY/MM/DD/{yyyymmddTHHMMSSZ}.{sessionId}.md
    const datePath = formatDatePath(meta.startTime)
    const outputDir = join(dataDir, recipeName, datePath)
    await mkdir(outputDir, { recursive: true })

    const fileTs = formatFileTimestamp(meta.startTime)
    const outputFile = join(outputDir, `${fileTs}.${sessionId}.md`)

    await Bun.write(outputFile, fm + output)
    await markDone(key, meta.lineCount)
    log({ key, msg: 'success', output: outputFile })
  } catch (err) {
    const reason = err instanceof ClaudeTimeoutError
      ? `task timeout after ${err.timeoutMs}ms`
      : err instanceof Error ? err.message : String(err)
    if (err instanceof ClaudeTimeoutError) {
      logError({ key, msg: 'task_timeout', timeoutMs: err.timeoutMs })
    } else {
      logError({ key, msg: 'failed', error: reason })
    }
    await markFailed(key, reason)
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
