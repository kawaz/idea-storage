import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Recipe } from '../types/index.ts'

// --- Mock setup (must be before importing runEnqueue) ---

let mockClaudeDirs: string[] = []
let mockMinAgeMinutes = 0
let mockRecipes: Recipe[] = []
let mockRecipesThrow = false

mock.module('../lib/config.ts', () => ({
  loadConfig: mock(async () => ({
    claudeDirs: mockClaudeDirs,
    minAgeMinutes: mockMinAgeMinutes,
  })),
}))

mock.module('../lib/recipe.ts', () => ({
  loadRecipes: mock(async () => {
    if (mockRecipesThrow) throw new Error('no recipes dir')
    return mockRecipes
  }),
}))

// Track enqueue calls and control queue state
const enqueueCalls: Array<{ sessionId: string; recipeName: string }> = []
const queuedSet = new Set<string>()
const failedSet = new Set<string>()
const doneMap = new Map<string, number>() // key -> lineCount

mock.module('../lib/queue.ts', () => ({
  enqueueBatch: mock((entries: Array<{ sessionId: string; recipeName: string }>) => {
    for (const entry of entries) {
      enqueueCalls.push(entry)
      queuedSet.add(`${entry.sessionId}.${entry.recipeName}`)
    }
  }),
  loadQueueState: mock(async () => ({
    queued: new Set(queuedSet),
    done: new Map(
      Array.from(doneMap.entries()).map(([k, v]) => [k, { lineCount: v }]),
    ),
    failed: new Map(
      Array.from(failedSet).map((k) => [
        k,
        { meta: { retryCount: 1 }, mtimeMs: Date.now() },
      ]),
    ),
  })),
  isFailedByState: mock(
    (state: { failed: Map<string, unknown> }, key: string) => {
      return state.failed.has(key)
    },
  ),
}))

describe('session-enqueue', () => {
  let tempDir: string
  let claudeDir: string

  function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
    return {
      name: 'diary',
      filePath: '/tmp/recipe-diary.md',
      match: {},
      onExisting: 'append',
      prompt: 'Write a diary',
      ...overrides,
    }
  }

  /** Create a minimal JSONL session file with the given UUID. */
  async function createSessionFile(
    projectsDir: string,
    sessionId: string,
    opts: {
      project?: string
      lines?: number
      ageMs?: number
      hasSummary?: boolean
      subDir?: string
    } = {},
  ): Promise<string> {
    const {
      project = '/tmp/test-project',
      lines = 5,
      ageMs = 3 * 60 * 60 * 1000, // 3 hours (> default 2h minAge)
      hasSummary = false,
      subDir = 'default-project',
    } = opts

    const dir = join(projectsDir, subDir)
    await mkdir(dir, { recursive: true })
    const filePath = join(dir, `${sessionId}.jsonl`)

    const now = Date.now()
    const sessionStart = new Date(now - ageMs).toISOString()

    const jsonlLines: string[] = []

    // First line: user message with cwd
    jsonlLines.push(JSON.stringify({
      type: 'user',
      timestamp: sessionStart,
      uuid: `${sessionId.slice(0, 8)}-line-0001`,
      cwd: project,
      message: { role: 'user', content: 'Hello' },
    }))

    // Additional lines (assistant responses)
    for (let i = 1; i < lines; i++) {
      jsonlLines.push(JSON.stringify({
        type: 'assistant',
        timestamp: new Date(now - ageMs + i * 1000).toISOString(),
        uuid: `${sessionId.slice(0, 8)}-line-${String(i + 1).padStart(4, '0')}`,
        message: { role: 'assistant', content: [{ type: 'text', text: `Response ${i}` }] },
      }))
    }

    // Summary line if requested
    if (hasSummary) {
      jsonlLines.push(JSON.stringify({
        type: 'summary',
        timestamp: new Date(now - ageMs + lines * 1000).toISOString(),
        summary: 'Session ended',
      }))
    }

    await Bun.write(filePath, jsonlLines.join('\n') + '\n')

    // Set mtime to simulate age
    const { utimesSync } = await import('node:fs')
    const mtime = new Date(now - ageMs)
    utimesSync(filePath, mtime, mtime)

    return filePath
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'session-enqueue-test-'))
    claudeDir = join(tempDir, 'claude')
    await mkdir(join(claudeDir, 'projects'), { recursive: true })

    // Reset mock state
    mockClaudeDirs = [claudeDir]
    mockMinAgeMinutes = 120 // 2 hours
    mockRecipes = [makeRecipe()]
    mockRecipesThrow = false

    // Reset queue mock state
    enqueueCalls.length = 0
    queuedSet.clear()
    failedSet.clear()
    doneMap.clear()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('claudeDirs の projects ディレクトリが存在しない場合、何もエンキューしない', async () => {
    mockClaudeDirs = [join(tempDir, 'nonexistent')]

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

  test('UUID形式以外のファイル名がフィルタリングされる', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const subDir = join(projectsDir, 'test-project')
    await mkdir(subDir, { recursive: true })

    // Non-UUID files
    await Bun.write(join(subDir, 'not-a-uuid.jsonl'), '{"type":"user"}\n')
    await Bun.write(join(subDir, 'readme.md'), '# README\n')
    await Bun.write(join(subDir, 'abc.jsonl'), '{"type":"user"}\n')

    // Valid UUID file
    const validUuid = '12345678-1234-1234-1234-123456789abc'
    await createSessionFile(projectsDir, validUuid, { subDir: 'test-project' })

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    // Only the valid UUID session should be enqueued
    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0]!.sessionId).toBe(validUuid)
  })

  test('既に queued のセッションはスキップされる', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId)

    // Pre-mark as queued
    queuedSet.add(`${sessionId}.diary`)

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    // enqueue should not be called (already queued)
    expect(enqueueCalls).toHaveLength(0)
  })

  test('既に done のセッション（同一行数以上）はスキップされる', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId, { lines: 5 })

    // Mark as done with enough lines (5 lines in the session)
    doneMap.set(`${sessionId}.diary`, 5)

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

  test('done だが行数が増えたセッションは再エンキューされる', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId, { lines: 10 })

    // Mark as done with fewer lines than current
    doneMap.set(`${sessionId}.diary`, 5)

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0]!.sessionId).toBe(sessionId)
  })

  test('既に failed のセッションはスキップされる', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId)

    // Mark as failed
    failedSet.add(`${sessionId}.diary`)

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

  test('正常にエンキューされる', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId)

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0]).toEqual({ sessionId, recipeName: 'diary' })
  })

  test('レシピがマッチしないセッションはスキップされる', async () => {
    // Recipe requires project matching pattern
    mockRecipes = [makeRecipe({
      name: 'diary',
      match: { project: '**/special-project/**' },
    })]

    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId, {
      project: '/home/user/other-project',
    })

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

  test('minAge未満のセッションはスキップされる', async () => {
    mockMinAgeMinutes = 120 // 2 hours

    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    // Session is only 30 minutes old (< 2 hour minimum)
    await createSessionFile(projectsDir, sessionId, {
      ageMs: 30 * 60 * 1000,
    })

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

  test('複数セッション・複数レシピの組み合わせ', async () => {
    mockRecipes = [
      makeRecipe({ name: 'diary' }),
      makeRecipe({ name: 'review' }),
    ]

    const projectsDir = join(claudeDir, 'projects')
    const session1 = '11111111-1111-1111-1111-111111111111'
    const session2 = '22222222-2222-2222-2222-222222222222'
    await createSessionFile(projectsDir, session1, { subDir: 'proj-a' })
    await createSessionFile(projectsDir, session2, { subDir: 'proj-b' })

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    // 2 sessions x 2 recipes = 4 enqueue calls
    expect(enqueueCalls).toHaveLength(4)

    const keys = enqueueCalls.map(c => `${c.sessionId}.${c.recipeName}`).sort()
    expect(keys).toContain(`${session1}.diary`)
    expect(keys).toContain(`${session1}.review`)
    expect(keys).toContain(`${session2}.diary`)
    expect(keys).toContain(`${session2}.review`)
  })

  test('レシピが空の場合は CliError を throw する（process.exit しない）', async () => {
    mockRecipes = []

    const { runEnqueue } = await import('./session-enqueue.ts')
    const { CliError } = await import('../lib/errors.ts')
    await expect(runEnqueue()).rejects.toThrow(CliError)
  })

  test('レシピディレクトリが存在しない場合は CliError を throw する（process.exit しない）', async () => {
    mockRecipesThrow = true

    const { runEnqueue } = await import('./session-enqueue.ts')
    const { CliError } = await import('../lib/errors.ts')
    await expect(runEnqueue()).rejects.toThrow(CliError)
  })

  test('レシピが空の場合のエラーメッセージに次のアクション案内が含まれる', async () => {
    mockRecipes = []

    const { runEnqueue } = await import('./session-enqueue.ts')
    try {
      await runEnqueue()
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('recipe-*.md')
      expect((err as Error).message).toContain('config-examples/')
    }
  })

  test('レシピディレクトリが存在しない場合のエラーメッセージに次のアクション案内が含まれる', async () => {
    mockRecipesThrow = true

    const { runEnqueue } = await import('./session-enqueue.ts')
    try {
      await runEnqueue()
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain('recipe-*.md')
      expect((err as Error).message).toContain('config-examples/')
    }
  })

  test('複数のclaudeDirsを走査する', async () => {
    const claudeDir2 = join(tempDir, 'claude2')
    await mkdir(join(claudeDir2, 'projects'), { recursive: true })
    mockClaudeDirs = [claudeDir, claudeDir2]

    const session1 = '11111111-1111-1111-1111-111111111111'
    const session2 = '22222222-2222-2222-2222-222222222222'

    await createSessionFile(join(claudeDir, 'projects'), session1, {
      subDir: 'proj-a',
    })
    await createSessionFile(join(claudeDir2, 'projects'), session2, {
      subDir: 'proj-b',
    })

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    const sessionIds = enqueueCalls.map(c => c.sessionId).sort()
    expect(sessionIds).toContain(session1)
    expect(sessionIds).toContain(session2)
  })

  test('done の行数が多い場合はスキップされる（doneLines > sessionLines）', async () => {
    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await createSessionFile(projectsDir, sessionId, { lines: 5 })

    // Done with more lines than current session
    doneMap.set(`${sessionId}.diary`, 100)

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

  test('レシピのminTurns条件でフィルタリングされる', async () => {
    mockRecipes = [makeRecipe({
      name: 'diary',
      match: { minTurns: 10 },
    })]

    const projectsDir = join(claudeDir, 'projects')
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    // Session has only a few user turns (< minTurns 10)
    await createSessionFile(projectsDir, sessionId, { lines: 5 })

    const { runEnqueue } = await import('./session-enqueue.ts')
    await runEnqueue()

    expect(enqueueCalls).toHaveLength(0)
  })

})
