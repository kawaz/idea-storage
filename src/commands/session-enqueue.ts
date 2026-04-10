import { define } from 'gunshi'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.ts'
import { loadRecipes } from '../lib/recipe.ts'
import { getRecipesDir } from '../lib/paths.ts'
import { getSessionMeta } from '../lib/conversation.ts'
import { matchesRecipe } from '../lib/recipe-matcher.ts'
import { enqueueBatch, loadQueueState, isFailedByState } from '../lib/queue.ts'
import { CliError } from '../lib/errors.ts'
import { dirExists } from '../lib/dir-exists.ts'
import { log } from '../lib/logging.ts'
import { UUID_JSONL_PATTERN } from '../lib/session-finder.ts'

export async function runEnqueue(): Promise<void> {
  const config = await loadConfig()
  let recipes
  try {
    recipes = await loadRecipes(getRecipesDir())
  } catch {
    throw new CliError(`No recipes found in ${getRecipesDir()}\nCreate recipe-*.md files in that directory. See config-examples/ for examples.`)
  }

  if (recipes.length === 0) {
    throw new CliError(`No recipes found in ${getRecipesDir()}\nCreate recipe-*.md files in that directory. See config-examples/ for examples.`)
  }

  const minAgeSec = config.minAgeMinutes * 60

  // Load queue state once upfront (readdir x3 instead of per-entry file checks)
  const state = await loadQueueState()

  const pending: Array<{ sessionId: string; recipeName: string }> = []

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
        if (!matchesRecipe(recipe, meta)) continue

        const key = `${meta.id}.${recipe.name}`

        // Skip if already queued or failed
        if (state.queued.has(key)) continue
        if (isFailedByState(state, key)) continue

        // Skip if already done with same or more lines
        const doneEntry = state.done.get(key)
        if (doneEntry && doneEntry.lineCount >= meta.lineCount) continue

        pending.push({ sessionId: meta.id, recipeName: recipe.name })
        log({ msg: 'queued', key })
      }
    }
  }

  // Batch INSERT in a single transaction
  if (pending.length > 0) {
    enqueueBatch(pending)
  }

  log({ msg: 'enqueue_done', count: pending.length })
}

const sessionEnqueue = define({
  name: 'enqueue',
  description: 'Find sessions and add to queue',
  run: async () => {
    await runEnqueue()
  },
})

export default sessionEnqueue
