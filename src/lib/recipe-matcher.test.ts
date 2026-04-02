import { describe, expect, test } from 'bun:test'
import { matchesRecipe } from './recipe-matcher.ts'
import type { Recipe, SessionMeta } from '../types/index.ts'

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: 'test-recipe',
    filePath: '/tmp/recipe-test.md',
    match: {},
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

describe('matchesRecipe', () => {
  test('returns true when all conditions match', () => {
    const recipe = makeRecipe({
      match: {
        project: '*/myapp',
        minTurns: 3,
        minAge: 1800,
      },
    })
    const session = makeSession({
      project: '/Users/kawaz/projects/myapp',
      userTurns: 5,
      ageSec: 3600,
    })
    expect(matchesRecipe(recipe, session)).toBe(true)
  })

  test('returns false when project does not match', () => {
    const recipe = makeRecipe({
      match: { project: '*/emeradaco/*' },
    })
    const session = makeSession({
      project: '/Users/kawaz/projects/myapp',
    })
    expect(matchesRecipe(recipe, session)).toBe(false)
  })

  test('matches project with glob pattern', () => {
    const recipe = makeRecipe({
      match: { project: '*/emeradaco/*' },
    })
    const session = makeSession({
      project: '/Users/kawaz/repos/emeradaco/antenna',
    })
    expect(matchesRecipe(recipe, session)).toBe(true)
  })

  test('returns false when userTurns is below minTurns', () => {
    const recipe = makeRecipe({
      match: { minTurns: 3 },
    })
    const session = makeSession({ userTurns: 2 })
    expect(matchesRecipe(recipe, session)).toBe(false)
  })

  test('default minTurns=1 filters out sessions with 0 user turns', () => {
    const recipe = makeRecipe({ match: {} })
    const session = makeSession({ userTurns: 0 })
    expect(matchesRecipe(recipe, session)).toBe(false)
  })

  test('default minTurns=1 allows sessions with 1+ user turns', () => {
    const recipe = makeRecipe({ match: {} })
    const session = makeSession({ userTurns: 1 })
    expect(matchesRecipe(recipe, session)).toBe(true)
  })

  test('returns false when ageSec is below minAge', () => {
    const recipe = makeRecipe({
      match: { minAge: 7200 },
    })
    const session = makeSession({ ageSec: 3600 })
    expect(matchesRecipe(recipe, session)).toBe(false)
  })

  test('recipe with no conditions matches sessions with user turns', () => {
    const recipe = makeRecipe({ match: {} })
    const session = makeSession()
    expect(matchesRecipe(recipe, session)).toBe(true)
  })

  test('boundary: userTurns exactly equals minTurns matches', () => {
    const recipe = makeRecipe({ match: { minTurns: 5 } })
    const session = makeSession({ userTurns: 5 })
    expect(matchesRecipe(recipe, session)).toBe(true)
  })

  test('boundary: ageSec exactly equals minAge matches', () => {
    const recipe = makeRecipe({ match: { minAge: 3600 } })
    const session = makeSession({ ageSec: 3600 })
    expect(matchesRecipe(recipe, session)).toBe(true)
  })

  test('古いセッションも maxAge 制限なくマッチする', () => {
    const recipe = makeRecipe({ match: { minAge: 60 } })
    const session = makeSession({ ageSec: 999999 })
    expect(matchesRecipe(recipe, session)).toBe(true)
  })
})
