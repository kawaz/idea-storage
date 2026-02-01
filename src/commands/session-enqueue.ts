import { define } from 'gunshi'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.ts'
import { loadRecipes } from '../lib/recipe.ts'
import { getRecipesDir } from '../lib/paths.ts'
import { getSessionMeta } from '../lib/conversation.ts'
import { findMatchingRecipe } from '../lib/recipe-matcher.ts'
import { enqueue, isQueued, isFailed, isDone } from '../lib/queue.ts'
import { exitWithError } from '../lib/errors.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

export async function runEnqueue(): Promise<void> {
  const config = await loadConfig()
  let recipes
  try {
    recipes = await loadRecipes(getRecipesDir())
  } catch {
    exitWithError(`No recipes found in ${getRecipesDir()}`)
  }

  if (recipes.length === 0) {
    exitWithError(`No recipes found in ${getRecipesDir()}`)
  }

  const minAgeSec = config.minAgeMinutes * 60
  const maxAgeSec = config.maxAgeMinutes * 60

  let count = 0

  for (const claudeDir of config.claudeDirs) {
    const projectsDir = join(claudeDir, 'projects')
    const glob = new Bun.Glob('**/*.jsonl')

    let scannable = true
    try {
      await Bun.file(projectsDir).exists()
    } catch {
      scannable = false
    }
    if (!scannable) continue

    for await (const relativePath of glob.scan(projectsDir)) {
      const filename = relativePath.split('/').pop() ?? ''
      if (!UUID_PATTERN.test(filename)) continue

      const filePath = join(projectsDir, relativePath)
      const meta = await getSessionMeta(filePath)

      // Age check
      if (meta.ageSec < minAgeSec || meta.ageSec > maxAgeSec) continue

      // Check each recipe
      for (const recipe of recipes) {
        const matched = findMatchingRecipe([recipe], meta)
        if (!matched) continue

        // Skip if already queued or failed
        if (await isQueued(meta.id, recipe.name)) continue
        if (await isFailed(meta.id, recipe.name)) continue

        // Skip if already done with same or more lines
        if (await isDone(meta.id, recipe.name, meta.lineCount)) continue

        await enqueue(meta.id, recipe.name)
        console.log(`Queued: ${meta.id}.${recipe.name}`)
        count++
      }
    }
  }

  console.log(`Enqueued ${count} items`)
}

const sessionEnqueue = define({
  name: 'enqueue',
  description: 'Find sessions and add to queue',
  run: async () => {
    await runEnqueue()
  },
})

export default sessionEnqueue
