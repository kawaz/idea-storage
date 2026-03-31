import { define } from 'gunshi'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.ts'
import { loadRecipes } from '../lib/recipe.ts'
import { getRecipesDir } from '../lib/paths.ts'
import { getSessionMeta } from '../lib/conversation.ts'
import { findMatchingRecipe } from '../lib/recipe-matcher.ts'
import { enqueue, isQueued, isFailed, isDone } from '../lib/queue.ts'
import { exitWithError } from '../lib/errors.ts'
import { dirExists } from '../lib/dir-exists.ts'
import { log } from '../lib/logging.ts'
import { UUID_JSONL_PATTERN } from '../lib/session-finder.ts'

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

  let count = 0

  for (const claudeDir of config.claudeDirs) {
    const projectsDir = join(claudeDir, 'projects')
    const glob = new Bun.Glob('**/*.jsonl')

    if (!(await dirExists(projectsDir))) continue

    for await (const relativePath of glob.scan(projectsDir)) {
      const filename = relativePath.split('/').pop() ?? ''
      if (!UUID_JSONL_PATTERN.test(filename)) continue

      const filePath = join(projectsDir, relativePath)
      const meta = await getSessionMeta(filePath)

      // Age check (skip only too-young sessions; no upper limit)
      if (meta.ageSec < minAgeSec) continue

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
        log({ msg: 'queued', key: `${meta.id}.${recipe.name}` })
        count++
      }
    }
  }

  log({ msg: 'enqueue_done', count })
}

const sessionEnqueue = define({
  name: 'enqueue',
  description: 'Find sessions and add to queue',
  run: async () => {
    await runEnqueue()
  },
})

export default sessionEnqueue
