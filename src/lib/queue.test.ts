import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { QueueDirs } from './queue.ts'
import {
  enqueue,
  enqueueBatch,
  dequeue,
  markDone,
  markFailed,
  isDone,
  isQueued,
  isFailed,
  retry,
  getStatus,
  cleanup,
  validateSessionId,
  validateRecipeName,
  loadQueueState,
  isFailedByState,
  getDb,
} from './queue.ts'

// Test UUIDs (replacing short ids like 'sid-1' for validation compliance)
const SID1 = '00000000-0000-4000-a000-000000000001'
const SID2 = '00000000-0000-4000-a000-000000000002'
const SID3 = '00000000-0000-4000-a000-000000000003'
const SID4 = '00000000-0000-4000-a000-000000000004'
const SID_ABC = '00000000-0000-4000-a000-00000000abc0'
const SID_DEF = '00000000-0000-4000-a000-00000000def0'

describe('queue', () => {
  let dirs: QueueDirs
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'queue-test-'))
    dirs = {
      queueDir: join(tempDir, 'queue') + '/',
      doneDir: join(tempDir, 'done') + '/',
      failedDir: join(tempDir, 'failed') + '/',
    }
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('enqueue', () => {
    test('creates a queued entry with key format {sessionId}.{recipeName}', async () => {
      await enqueue(SID_ABC, 'diary', dirs)
      expect(await isQueued(SID_ABC, 'diary', dirs)).toBe(true)
    })

    test('auto-creates database when it does not exist', async () => {
      await enqueue(SID_ABC, 'diary', dirs)
      expect(await isQueued(SID_ABC, 'diary', dirs)).toBe(true)
    })

    test('does not overwrite an existing entry (INSERT OR IGNORE)', async () => {
      await enqueue(SID_ABC, 'diary', dirs)
      await enqueue(SID_ABC, 'diary', dirs) // duplicate
      const status = await getStatus(dirs)
      expect(status.queued).toBe(1)
    })
  })

  describe('enqueueBatch', () => {
    test('複数エントリを一括で enqueue する', async () => {
      await enqueueBatch([
        { sessionId: SID1, recipeName: 'diary' },
        { sessionId: SID2, recipeName: 'report' },
      ], dirs)

      expect(await isQueued(SID1, 'diary', dirs)).toBe(true)
      expect(await isQueued(SID2, 'report', dirs)).toBe(true)
    })

    test('空配列でもエラーにならない', async () => {
      await enqueueBatch([], dirs)
      const status = await getStatus(dirs)
      expect(status.queued).toBe(0)
    })

    test('既存エントリは無視する（INSERT OR IGNORE）', async () => {
      await enqueue(SID1, 'diary', dirs)
      await enqueueBatch([
        { sessionId: SID1, recipeName: 'diary' },  // duplicate
        { sessionId: SID2, recipeName: 'report' },
      ], dirs)

      const status = await getStatus(dirs)
      expect(status.queued).toBe(2)
    })

    test('無効な sessionId でバリデーションエラー', async () => {
      expect(() =>
        enqueueBatch([{ sessionId: 'invalid', recipeName: 'diary' }], dirs)
      ).toThrow(/Invalid sessionId/)
    })

    test('無効な recipeName でバリデーションエラー', async () => {
      expect(() =>
        enqueueBatch([{ sessionId: SID1, recipeName: '../bad' }], dirs)
      ).toThrow(/Invalid recipeName/)
    })

    test('バリデーションエラー時はどのエントリも挿入されない（トランザクション）', async () => {
      try {
        enqueueBatch([
          { sessionId: SID1, recipeName: 'diary' },   // valid
          { sessionId: 'invalid', recipeName: 'diary' }, // invalid
        ], dirs)
      } catch { /* expected */ }

      const status = await getStatus(dirs)
      expect(status.queued).toBe(0)
    })
  })

  describe('dequeue', () => {
    test('returns null when queue is empty', async () => {
      const entry = await dequeue(dirs)
      expect(entry).toBeNull()
    })

    test('returns the newest entry first and removes it', async () => {
      // enqueue two items with different updated_at
      await enqueue(SID1, 'recipe-a', dirs)

      // Make SID1 older via direct DB update
      const db = getDb(dirs)
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [Date.now() - 10000, `${SID1}.recipe-a`])
      db.close()

      await enqueue(SID2, 'recipe-b', dirs)

      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()
      expect(entry!.sessionId).toBe(SID2)
      expect(entry!.recipeName).toBe('recipe-b')
      expect(entry!.key).toBe(`${SID2}.recipe-b`)

      // Dequeued entry should no longer be queued
      expect(await isQueued(SID2, 'recipe-b', dirs)).toBe(false)

      // Older entry should still be queued
      expect(await isQueued(SID1, 'recipe-a', dirs)).toBe(true)
    })

    test('dequeues in newest-first order across multiple calls', async () => {
      await enqueue(SID1, 'recipe-a', dirs)
      await enqueue(SID2, 'recipe-b', dirs)
      await enqueue(SID3, 'recipe-c', dirs)

      // Set updated_at to control ordering
      const db = getDb(dirs)
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [1000, `${SID1}.recipe-a`])
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [2000, `${SID2}.recipe-b`])
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [3000, `${SID3}.recipe-c`])
      db.close()

      const first = await dequeue(dirs)
      expect(first!.sessionId).toBe(SID3)

      const second = await dequeue(dirs)
      expect(second!.sessionId).toBe(SID2)

      const third = await dequeue(dirs)
      expect(third!.sessionId).toBe(SID1)

      const fourth = await dequeue(dirs)
      expect(fourth).toBeNull()
    })

    test('returns null when database does not exist yet', async () => {
      const nonExistDirs: QueueDirs = {
        queueDir: join(tempDir, 'nonexistent', 'queue') + '/',
        doneDir: dirs.doneDir,
        failedDir: dirs.failedDir,
      }
      const entry = await dequeue(nonExistDirs)
      expect(entry).toBeNull()
    })
  })

  describe('parseKey (via enqueue/dequeue round-trip)', () => {
    test('correctly parses recipe name containing dots', async () => {
      await enqueue(SID_ABC, 'my.diary', dirs)

      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()
      expect(entry!.sessionId).toBe(SID_ABC)
      expect(entry!.recipeName).toBe('my.diary')
      expect(entry!.key).toBe(`${SID_ABC}.my.diary`)
    })

    test('correctly parses recipe name with multiple dots', async () => {
      await enqueue(SID_DEF, 'my.special.recipe', dirs)

      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()
      expect(entry!.sessionId).toBe(SID_DEF)
      expect(entry!.recipeName).toBe('my.special.recipe')
    })

    test('isDone works with dotted recipe name', async () => {
      await markDone(`${SID_ABC}.my.diary`, 50, dirs)
      expect(await isDone(SID_ABC, 'my.diary', 50, dirs)).toBe(true)
    })

    test('isQueued works with dotted recipe name', async () => {
      await enqueue(SID_ABC, 'my.diary', dirs)
      expect(await isQueued(SID_ABC, 'my.diary', dirs)).toBe(true)
    })

    test('isFailed works with dotted recipe name', async () => {
      await enqueue(SID_ABC, 'my.diary', dirs)
      await markFailed(`${SID_ABC}.my.diary`, undefined, dirs)
      expect(await isFailed(SID_ABC, 'my.diary', dirs)).toBe(true)
    })
  })

  describe('markDone', () => {
    test('marks entry as done with lineCount and removes from queued', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markDone(`${SID1}.diary`, 42, dirs)

      expect(await isDone(SID1, 'diary', 42, dirs)).toBe(true)

      // Verify lineCount in DB
      const db = getDb(dirs)
      const row = db.query(`SELECT line_count, status FROM queue_entries WHERE key = ?`).get(`${SID1}.diary`) as { line_count: number; status: string }
      expect(row.status).toBe('done')
      expect(row.line_count).toBe(42)
      db.close()

      // Should no longer be queued
      expect(await isQueued(SID1, 'diary', dirs)).toBe(false)
    })

    test('works even when entry did not exist before', async () => {
      await markDone(`${SID1}.diary`, 100, dirs)
      expect(await isDone(SID1, 'diary', 100, dirs)).toBe(true)
    })
  })

  describe('markFailed', () => {
    test('marks entry as failed and removes from queued', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      expect(await isFailed(SID1, 'diary', dirs)).toBe(true)
      expect(await isQueued(SID1, 'diary', dirs)).toBe(false)
    })

    test('works when database does not exist yet', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      expect(await isFailed(SID1, 'diary', dirs)).toBe(true)
    })

    test('works after dequeue (entry already removed from DB)', async () => {
      await enqueue(SID1, 'diary', dirs)
      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()

      // Entry is already removed by dequeue
      expect(await isQueued(SID1, 'diary', dirs)).toBe(false)

      // markFailed should still succeed
      await markFailed(`${SID1}.diary`, undefined, dirs)
      expect(await isFailed(SID1, 'diary', dirs)).toBe(true)
    })

    test('records retryCount: 1 on first call', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const db = getDb(dirs)
      const row = db.query(`SELECT retry_count FROM queue_entries WHERE key = ?`).get(`${SID1}.diary`) as { retry_count: number }
      expect(row.retry_count).toBe(1)
      db.close()
    })

    test('increments retryCount on subsequent calls', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const db = getDb(dirs)
      const row = db.query(`SELECT retry_count FROM queue_entries WHERE key = ?`).get(`${SID1}.diary`) as { retry_count: number }
      expect(row.retry_count).toBe(2)
      db.close()
    })

    test('records reason when provided', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, 'claude exited with code 1', dirs)

      const db = getDb(dirs)
      const row = db.query(`SELECT retry_count, fail_reason FROM queue_entries WHERE key = ?`).get(`${SID1}.diary`) as { retry_count: number; fail_reason: string }
      expect(row.retry_count).toBe(1)
      expect(row.fail_reason).toBe('claude exited with code 1')
      db.close()
    })

    test('updates reason on subsequent failure', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, 'first error', dirs)
      await markFailed(`${SID1}.diary`, 'second error', dirs)

      const db = getDb(dirs)
      const row = db.query(`SELECT retry_count, fail_reason FROM queue_entries WHERE key = ?`).get(`${SID1}.diary`) as { retry_count: number; fail_reason: string }
      expect(row.retry_count).toBe(2)
      expect(row.fail_reason).toBe('second error')
      db.close()
    })
  })

  describe('isDone', () => {
    test('returns true when done and lineCount >= currentLineCount', async () => {
      await markDone(`${SID1}.diary`, 100, dirs)
      expect(await isDone(SID1, 'diary', 100, dirs)).toBe(true)
      expect(await isDone(SID1, 'diary', 50, dirs)).toBe(true)
    })

    test('returns false when done but fewer lines than currentLineCount', async () => {
      await markDone(`${SID1}.diary`, 50, dirs)
      expect(await isDone(SID1, 'diary', 100, dirs)).toBe(false)
    })

    test('returns false when entry does not exist', async () => {
      expect(await isDone(SID1, 'diary', 10, dirs)).toBe(false)
    })
  })

  describe('isQueued', () => {
    test('returns true when entry is in queue', async () => {
      await enqueue(SID1, 'diary', dirs)
      expect(await isQueued(SID1, 'diary', dirs)).toBe(true)
    })

    test('returns false when entry is not in queue', async () => {
      expect(await isQueued(SID1, 'diary', dirs)).toBe(false)
    })
  })

  describe('isFailed', () => {
    test('returns false when entry does not exist', async () => {
      expect(await isFailed(SID1, 'diary', dirs)).toBe(false)
    })

    test('returns true when failed and updated_at is recent (within retryAfterMs)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      // Just failed - should still be considered failed (too soon to retry)
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1000 })).toBe(true)
    })

    test('returns false when retryCount < maxRetries and updated_at is old enough (auto-retry)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      // Set updated_at to the past via DB
      const db = getDb(dirs)
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [Date.now() - 2000, `${SID1}.diary`])
      db.close()

      // retryCount=1, maxRetries=3, updated_at is 2s ago, retryAfterMs=1000ms => should retry
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1000, maxRetries: 3 })).toBe(false)
    })

    test('returns true when retryCount >= maxRetries (permanent-failed)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=1
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=2
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=3

      // Set updated_at to the past
      const db = getDb(dirs)
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [Date.now() - 100000, `${SID1}.diary`])
      db.close()

      // retryCount=3, maxRetries=3 => permanent-failed, always true
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1, maxRetries: 3 })).toBe(true)
    })

    test('uses default retryAfterMs and maxRetries when not specified', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      // With defaults (24h, 3 retries), just-failed should return true
      expect(await isFailed(SID1, 'diary', dirs)).toBe(true)
    })
  })

  describe('retry', () => {
    test('moves entry from failed to queued', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      await retry(`${SID1}.diary`, dirs)

      expect(await isQueued(SID1, 'diary', dirs)).toBe(true)
      expect(await isFailed(SID1, 'diary', dirs)).toBe(false)
    })
  })

  describe('getStatus', () => {
    test('returns counts for each status', async () => {
      await enqueue(SID1, 'diary', dirs)
      await enqueue(SID2, 'diary', dirs)
      await markDone(`${SID3}.diary`, 10, dirs)
      await enqueue(SID4, 'diary', dirs)
      await markFailed(`${SID4}.diary`, undefined, dirs)

      const status = await getStatus(dirs)
      expect(status.queued).toBe(2)
      expect(status.done).toBe(1)
      expect(status.failed).toBe(1)
    })

    test('returns zeros when database is empty', async () => {
      const status = await getStatus(dirs)
      expect(status.queued).toBe(0)
      expect(status.done).toBe(0)
      expect(status.failed).toBe(0)
    })
  })

  describe('cleanup', () => {
    test('removes failed entries whose session no longer exists', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      await enqueue(SID2, 'diary', dirs)
      await markFailed(`${SID2}.diary`, undefined, dirs)

      const isSessionExists = async (sid: string) => sid === SID1
      const removed = await cleanup(isSessionExists, dirs)

      expect(removed).toBe(1)
      expect(await isFailed(SID1, 'diary', dirs)).toBe(true)
      expect(await isFailed(SID2, 'diary', dirs)).toBe(false)
    })

    test('returns 0 when all sessions exist', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const isSessionExists = async (_sid: string) => true
      const removed = await cleanup(isSessionExists, dirs)
      expect(removed).toBe(0)
    })

    test('returns 0 when no failed entries exist', async () => {
      const isSessionExists = async (_sid: string) => false
      const removed = await cleanup(isSessionExists, dirs)
      expect(removed).toBe(0)
    })
  })

  describe('validateSessionId', () => {
    test('accepts valid UUID v4', () => {
      expect(() => validateSessionId('550e8400-e29b-41d4-a716-446655440000')).not.toThrow()
      expect(() => validateSessionId('ABCDEF00-1234-5678-9ABC-DEF012345678')).not.toThrow()
    })

    test('rejects empty string', () => {
      expect(() => validateSessionId('')).toThrow(/Invalid sessionId/)
    })

    test('rejects path traversal', () => {
      expect(() => validateSessionId('../etc/passwd')).toThrow(/Invalid sessionId/)
    })

    test('rejects non-UUID strings', () => {
      expect(() => validateSessionId('abc-123')).toThrow(/Invalid sessionId/)
      expect(() => validateSessionId('not-a-uuid')).toThrow(/Invalid sessionId/)
    })

    test('rejects UUID with extra characters', () => {
      expect(() => validateSessionId('550e8400-e29b-41d4-a716-446655440000-extra')).toThrow(/Invalid sessionId/)
      expect(() => validateSessionId(' 550e8400-e29b-41d4-a716-446655440000')).toThrow(/Invalid sessionId/)
    })
  })

  describe('validateRecipeName', () => {
    test('accepts valid recipe names', () => {
      expect(() => validateRecipeName('diary')).not.toThrow()
      expect(() => validateRecipeName('my-recipe')).not.toThrow()
      expect(() => validateRecipeName('my.recipe')).not.toThrow()
      expect(() => validateRecipeName('recipe_v2')).not.toThrow()
      expect(() => validateRecipeName('My.Special-Recipe_v2')).not.toThrow()
    })

    test('rejects empty string', () => {
      expect(() => validateRecipeName('')).toThrow(/Invalid recipeName/)
    })

    test('rejects path traversal', () => {
      expect(() => validateRecipeName('../etc/passwd')).toThrow(/Invalid recipeName/)
      expect(() => validateRecipeName('..%2fetc%2fpasswd')).toThrow(/Invalid recipeName/)
    })

    test('rejects special characters', () => {
      expect(() => validateRecipeName('recipe;rm -rf /')).toThrow(/Invalid recipeName/)
      expect(() => validateRecipeName('recipe name')).toThrow(/Invalid recipeName/)
      expect(() => validateRecipeName('recipe/sub')).toThrow(/Invalid recipeName/)
    })

    test('rejects names starting with dot or hyphen or underscore', () => {
      expect(() => validateRecipeName('.hidden')).toThrow(/Invalid recipeName/)
      expect(() => validateRecipeName('-start')).toThrow(/Invalid recipeName/)
      expect(() => validateRecipeName('_start')).toThrow(/Invalid recipeName/)
    })
  })

  describe('makeKey validation integration', () => {
    test('enqueue rejects invalid sessionId', async () => {
      await expect(enqueue('../etc', 'diary', dirs)).rejects.toThrow(/Invalid sessionId/)
    })

    test('enqueue rejects invalid recipeName', async () => {
      await expect(enqueue('550e8400-e29b-41d4-a716-446655440000', '../etc/passwd', dirs)).rejects.toThrow(/Invalid recipeName/)
    })

    test('isDone rejects invalid inputs', async () => {
      await expect(isDone('../x', 'diary', 10, dirs)).rejects.toThrow(/Invalid sessionId/)
      await expect(isDone('550e8400-e29b-41d4-a716-446655440000', '../x', 10, dirs)).rejects.toThrow(/Invalid recipeName/)
    })

    test('isQueued rejects invalid inputs', async () => {
      await expect(isQueued('../x', 'diary', dirs)).rejects.toThrow(/Invalid sessionId/)
      await expect(isQueued('550e8400-e29b-41d4-a716-446655440000', '../x', dirs)).rejects.toThrow(/Invalid recipeName/)
    })

    test('isFailed rejects invalid inputs', async () => {
      await expect(isFailed('../x', 'diary', dirs)).rejects.toThrow(/Invalid sessionId/)
      await expect(isFailed('550e8400-e29b-41d4-a716-446655440000', '../x', dirs)).rejects.toThrow(/Invalid recipeName/)
    })
  })

  describe('loadQueueState', () => {
    test('returns empty sets/maps when database is empty', async () => {
      const state = await loadQueueState(dirs)
      expect(state.queued.size).toBe(0)
      expect(state.done.size).toBe(0)
      expect(state.failed.size).toBe(0)
    })

    test('loads all queued entries', async () => {
      await enqueue(SID1, 'diary', dirs)
      await enqueue(SID2, 'recipe-a', dirs)

      const state = await loadQueueState(dirs)
      expect(state.queued.size).toBe(2)
      expect(state.queued.has(`${SID1}.diary`)).toBe(true)
      expect(state.queued.has(`${SID2}.recipe-a`)).toBe(true)
    })

    test('loads all done entries with lineCount', async () => {
      await markDone(`${SID1}.diary`, 42, dirs)
      await markDone(`${SID2}.recipe-a`, 100, dirs)

      const state = await loadQueueState(dirs)
      expect(state.done.size).toBe(2)
      expect(state.done.get(`${SID1}.diary`)).toEqual({ lineCount: 42 })
      expect(state.done.get(`${SID2}.recipe-a`)).toEqual({ lineCount: 100 })
    })

    test('loads all failed entries with meta and mtimeMs', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, 'error1', dirs)
      await enqueue(SID2, 'recipe-a', dirs)
      await markFailed(`${SID2}.recipe-a`, undefined, dirs)

      const state = await loadQueueState(dirs)
      expect(state.failed.size).toBe(2)

      const f1 = state.failed.get(`${SID1}.diary`)
      expect(f1).toBeDefined()
      expect(f1!.meta.retryCount).toBe(1)
      expect(f1!.meta.reason).toBe('error1')
      expect(f1!.mtimeMs).toBeGreaterThan(0)

      const f2 = state.failed.get(`${SID2}.recipe-a`)
      expect(f2).toBeDefined()
      expect(f2!.meta.retryCount).toBe(1)
      expect(f2!.meta.reason).toBeUndefined()
    })

    test('agrees with isQueued for all entries', async () => {
      await enqueue(SID1, 'diary', dirs)
      await enqueue(SID2, 'recipe-a', dirs)

      const state = await loadQueueState(dirs)

      // Entries that are queued
      expect(state.queued.has(`${SID1}.diary`)).toBe(await isQueued(SID1, 'diary', dirs))
      expect(state.queued.has(`${SID2}.recipe-a`)).toBe(await isQueued(SID2, 'recipe-a', dirs))
      // Entry that is not queued
      expect(state.queued.has(`${SID3}.diary`)).toBe(await isQueued(SID3, 'diary', dirs))
    })

    test('agrees with isDone for all entries', async () => {
      await markDone(`${SID1}.diary`, 50, dirs)

      const state = await loadQueueState(dirs)

      // isDone checks lineCount: done with 50 lines, check with 50 => true
      const doneEntry = state.done.get(`${SID1}.diary`)
      const doneLineCount = doneEntry?.lineCount ?? 0
      expect(doneLineCount >= 50).toBe(await isDone(SID1, 'diary', 50, dirs))
      // done with 50, check with 100 => false
      expect(doneLineCount >= 100).toBe(await isDone(SID1, 'diary', 100, dirs))
      // Entry that is not done
      expect(state.done.has(`${SID2}.diary`)).toBe(await isDone(SID2, 'diary', 10, dirs))
    })

    test('agrees with isFailed for recently failed entries', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const state = await loadQueueState(dirs)
      const retryOpts = { retryAfterMs: 60000, maxRetries: 3 }

      // Recently failed => both should return true
      expect(isFailedByState(state, `${SID1}.diary`, retryOpts)).toBe(true)
      expect(await isFailed(SID1, 'diary', dirs, retryOpts)).toBe(true)
    })

    test('agrees with isFailed for permanent-failed entries', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=1
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=2
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=3

      const state = await loadQueueState(dirs)
      const retryOpts = { retryAfterMs: 1, maxRetries: 3 }

      // Permanent-failed => both should return true
      expect(isFailedByState(state, `${SID1}.diary`, retryOpts)).toBe(true)
      expect(await isFailed(SID1, 'diary', dirs, retryOpts)).toBe(true)
    })

    test('agrees with isFailed for retryable entries (old updated_at)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      // Set updated_at to the past via DB
      const db = getDb(dirs)
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [Date.now() - 5000, `${SID1}.diary`])
      db.close()

      const state = await loadQueueState(dirs)
      const retryOpts = { retryAfterMs: 1000, maxRetries: 3 }

      // Retryable => both should return false
      expect(isFailedByState(state, `${SID1}.diary`, retryOpts)).toBe(false)
      expect(await isFailed(SID1, 'diary', dirs, retryOpts)).toBe(false)
    })

    test('loads mixed state correctly', async () => {
      // Setup: SID1 queued, SID2 done, SID3 failed
      await enqueue(SID1, 'diary', dirs)
      await markDone(`${SID2}.recipe-a`, 75, dirs)
      await enqueue(SID3, 'diary', dirs)
      await markFailed(`${SID3}.diary`, 'timeout', dirs)

      const state = await loadQueueState(dirs)

      expect(state.queued.has(`${SID1}.diary`)).toBe(true)
      expect(state.done.get(`${SID2}.recipe-a`)).toEqual({ lineCount: 75 })
      expect(state.failed.get(`${SID3}.diary`)!.meta.reason).toBe('timeout')
    })
  })

  describe('isFailedByState', () => {
    test('returns false when key is not in failed map', async () => {
      const state = await loadQueueState(dirs)
      expect(isFailedByState(state, `${SID1}.diary`)).toBe(false)
    })

    test('returns true for recently failed (retryCount < maxRetries, updated_at recent)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const state = await loadQueueState(dirs)
      expect(isFailedByState(state, `${SID1}.diary`, { retryAfterMs: 60000, maxRetries: 3 })).toBe(true)
    })

    test('returns true for permanent-failed (retryCount >= maxRetries)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs) // 1
      await markFailed(`${SID1}.diary`, undefined, dirs) // 2
      await markFailed(`${SID1}.diary`, undefined, dirs) // 3

      const state = await loadQueueState(dirs)
      // Even with very short retryAfterMs, permanent-failed stays true
      expect(isFailedByState(state, `${SID1}.diary`, { retryAfterMs: 1, maxRetries: 3 })).toBe(true)
    })

    test('returns false when retryable (retryCount < maxRetries, updated_at old enough)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const db = getDb(dirs)
      db.run(`UPDATE queue_entries SET updated_at = ? WHERE key = ?`, [Date.now() - 5000, `${SID1}.diary`])
      db.close()

      const state = await loadQueueState(dirs)
      expect(isFailedByState(state, `${SID1}.diary`, { retryAfterMs: 1000, maxRetries: 3 })).toBe(false)
    })

    test('uses default retryAfterMs and maxRetries when not specified', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const state = await loadQueueState(dirs)
      // With defaults (24h, 3 retries), just-failed should return true
      expect(isFailedByState(state, `${SID1}.diary`)).toBe(true)
    })
  })
})
