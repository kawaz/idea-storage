import type { Recipe, SessionMeta } from '../types/index.ts'

/**
 * Test if a session matches a single recipe's conditions.
 * All specified conditions must be satisfied (AND logic).
 * Unspecified conditions are skipped (always match).
 */
function matchesRecipe(recipe: Recipe, session: SessionMeta): boolean {
  const { match } = recipe

  // project: glob match
  // Design rationale: Recipe patterns use single `*` intending to match across
  // path separators (e.g. `*/emeradaco/*`), but Bun.Glob treats `*` as not
  // matching `/`. We normalize lone `*` to `**` for path-level globbing.
  if (match.project != null) {
    const pattern = match.project.replace(/(?<!\*)\*(?!\*)/g, '**')
    const glob = new Bun.Glob(pattern)
    if (!glob.match(session.project)) return false
  }

  // minLines / maxLines
  if (match.minLines != null && session.lineCount < match.minLines) return false
  if (match.maxLines != null && session.lineCount > match.maxLines) return false

  // minAge
  if (match.minAge != null && session.ageSec < match.minAge) return false

  // requireSessionEnd
  if (match.requireSessionEnd != null && match.requireSessionEnd && !session.hasEnd) return false

  return true
}

/**
 * Find the best matching recipe for a session.
 * Returns the recipe with the highest priority among all matches.
 * If priorities are equal, returns the first one in the array.
 * Returns null if no recipe matches.
 */
export function findMatchingRecipe(recipes: Recipe[], session: SessionMeta): Recipe | null {
  let best: Recipe | null = null

  for (const recipe of recipes) {
    if (!matchesRecipe(recipe, session)) continue
    if (best === null || recipe.priority > best.priority) {
      best = recipe
    }
  }

  return best
}
