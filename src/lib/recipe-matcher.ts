import type { Recipe, SessionMeta } from '../types/index.ts'

/**
 * Test if a session matches a recipe's conditions.
 * All specified conditions must be satisfied (AND logic).
 * Unspecified conditions are skipped (always match).
 */
export function matchesRecipe(recipe: Recipe, session: SessionMeta): boolean {
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

  // minTurns (default 1: filter out sessions with no user interaction)
  const minTurns = match.minTurns ?? 1
  if (session.userTurns < minTurns) return false

  // minAge
  if (match.minAge != null && session.ageSec < match.minAge) return false

  return true
}
