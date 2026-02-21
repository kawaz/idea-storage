import { describe, expect, test } from 'bun:test'
import { findMatchingRecipe } from './recipe-matcher.ts'
import type { Recipe, SessionMeta } from '../types/index.ts'

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: 'test-recipe',
    filePath: '/tmp/recipe-test.md',
    match: {},
    priority: 0,
    onExisting: 'append',
    prompt: 'Test prompt',
    ...overrides,
  }
}

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: 'test-session-id',
    filePath: '/tmp/session.jsonl',
    project: '/Users/kawaz/projects/myapp',
    lineCount: 200,
    ageSec: 3600,
    hasEnd: true,
    startTime: new Date('2025-01-01T00:00:00'),
    userTurns: 5,
    ...overrides,
  }
}

describe('findMatchingRecipe', () => {
  test('returns recipe when all conditions match', () => {
    const recipe = makeRecipe({
      match: {
        project: '*/myapp',
        minLines: 100,
        maxLines: 500,
        minAge: 1800,
        requireSessionEnd: true,
      },
    })
    const session = makeSession({
      project: '/Users/kawaz/projects/myapp',
      lineCount: 200,
      ageSec: 3600,
      hasEnd: true,
    })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('returns null when project does not match', () => {
    const recipe = makeRecipe({
      match: { project: '*/emeradaco/*' },
    })
    const session = makeSession({
      project: '/Users/kawaz/projects/myapp',
    })
    expect(findMatchingRecipe([recipe], session)).toBeNull()
  })

  test('matches project with glob pattern', () => {
    const recipe = makeRecipe({
      match: { project: '*/emeradaco/*' },
    })
    const session = makeSession({
      project: '/Users/kawaz/repos/emeradaco/antenna',
    })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('returns null when lineCount is below minLines', () => {
    const recipe = makeRecipe({
      match: { minLines: 100 },
    })
    const session = makeSession({ lineCount: 50 })
    expect(findMatchingRecipe([recipe], session)).toBeNull()
  })

  test('returns null when lineCount is above maxLines', () => {
    const recipe = makeRecipe({
      match: { maxLines: 100 },
    })
    const session = makeSession({ lineCount: 200 })
    expect(findMatchingRecipe([recipe], session)).toBeNull()
  })

  test('returns null when ageSec is below minAge', () => {
    const recipe = makeRecipe({
      match: { minAge: 7200 },
    })
    const session = makeSession({ ageSec: 3600 })
    expect(findMatchingRecipe([recipe], session)).toBeNull()
  })

  test('returns null when requireSessionEnd is true but session has no end', () => {
    const recipe = makeRecipe({
      match: { requireSessionEnd: true },
    })
    const session = makeSession({ hasEnd: false })
    expect(findMatchingRecipe([recipe], session)).toBeNull()
  })

  test('matches when requireSessionEnd is true and session has end', () => {
    const recipe = makeRecipe({
      match: { requireSessionEnd: true },
    })
    const session = makeSession({ hasEnd: true })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('selects recipe with highest priority when multiple match', () => {
    const low = makeRecipe({ name: 'low', priority: 0, match: {} })
    const high = makeRecipe({ name: 'high', priority: 10, match: {} })
    const mid = makeRecipe({ name: 'mid', priority: 5, match: {} })
    const session = makeSession()
    const result = findMatchingRecipe([low, high, mid], session)
    expect(result).toBe(high)
  })

  test('returns first recipe when priorities are equal', () => {
    const first = makeRecipe({ name: 'first', priority: 0, match: {} })
    const second = makeRecipe({ name: 'second', priority: 0, match: {} })
    const session = makeSession()
    const result = findMatchingRecipe([first, second], session)
    expect(result).toBe(first)
  })

  test('recipe with no conditions matches all sessions', () => {
    const recipe = makeRecipe({ match: {} })
    const session = makeSession()
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('returns null when no recipes provided', () => {
    const session = makeSession()
    expect(findMatchingRecipe([], session)).toBeNull()
  })

  test('skips non-matching recipes and returns the matching one', () => {
    const noMatch = makeRecipe({
      name: 'no-match',
      priority: 10,
      match: { project: '*/other-project/*' },
    })
    const matches = makeRecipe({
      name: 'matches',
      priority: 0,
      match: {},
    })
    const session = makeSession()
    const result = findMatchingRecipe([noMatch, matches], session)
    expect(result).toBe(matches)
  })

  test('boundary: lineCount exactly equals minLines matches', () => {
    const recipe = makeRecipe({ match: { minLines: 100 } })
    const session = makeSession({ lineCount: 100 })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('boundary: lineCount exactly equals maxLines matches', () => {
    const recipe = makeRecipe({ match: { maxLines: 100 } })
    const session = makeSession({ lineCount: 100 })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('boundary: ageSec exactly equals minAge matches', () => {
    const recipe = makeRecipe({ match: { minAge: 3600 } })
    const session = makeSession({ ageSec: 3600 })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })

  test('古いセッションも maxAge 制限なくマッチする', () => {
    const recipe = makeRecipe({ match: { minAge: 60 } })
    const session = makeSession({ ageSec: 999999 })
    expect(findMatchingRecipe([recipe], session)).toBe(recipe)
  })
})
