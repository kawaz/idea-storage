import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { QueueDirs } from './queue.ts'
import {
  enqueue,
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
    test('creates a file in queueDir with key format {sessionId}.{recipeName}', async () => {
      await enqueue(SID_ABC, 'diary', dirs)
      const file = Bun.file(join(dirs.queueDir, `${SID_ABC}.diary`))
      expect(await file.exists()).toBe(true)
    })

    test('creates queueDir if it does not exist', async () => {
      await enqueue(SID_ABC, 'diary', dirs)
      const file = Bun.file(join(dirs.queueDir, `${SID_ABC}.diary`))
      expect(await file.exists()).toBe(true)
    })

    test('creates an empty file (touch)', async () => {
      await enqueue(SID_ABC, 'diary', dirs)
      const file = Bun.file(join(dirs.queueDir, `${SID_ABC}.diary`))
      expect(await file.text()).toBe('')
    })
  })

  describe('dequeue', () => {
    test('returns null when queue is empty', async () => {
      const entry = await dequeue(dirs)
      expect(entry).toBeNull()
    })

    test('returns the oldest entry first (FIFO) and removes the file', async () => {
      // enqueue two items with different mtimes
      await enqueue(SID1, 'recipe-a', dirs)
      await enqueue(SID2, 'recipe-b', dirs)

      // Make SID1 older to guarantee ordering
      const { utimesSync } = await import('node:fs')
      const oldTime = new Date(Date.now() - 10000)
      utimesSync(join(dirs.queueDir, `${SID1}.recipe-a`), oldTime, oldTime)

      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()
      expect(entry!.sessionId).toBe(SID1)
      expect(entry!.recipeName).toBe('recipe-a')
      expect(entry!.key).toBe(`${SID1}.recipe-a`)

      // File should be removed
      const file = Bun.file(join(dirs.queueDir, `${SID1}.recipe-a`))
      expect(await file.exists()).toBe(false)

      // Newer entry should still exist
      const file2 = Bun.file(join(dirs.queueDir, `${SID2}.recipe-b`))
      expect(await file2.exists()).toBe(true)
    })

    test('dequeues in FIFO order across multiple calls', async () => {
      const { utimesSync } = await import('node:fs')

      await enqueue(SID1, 'recipe-a', dirs)
      utimesSync(join(dirs.queueDir, `${SID1}.recipe-a`), new Date(1000), new Date(1000))

      await enqueue(SID2, 'recipe-b', dirs)
      utimesSync(join(dirs.queueDir, `${SID2}.recipe-b`), new Date(2000), new Date(2000))

      await enqueue(SID3, 'recipe-c', dirs)
      utimesSync(join(dirs.queueDir, `${SID3}.recipe-c`), new Date(3000), new Date(3000))

      const first = await dequeue(dirs)
      expect(first!.sessionId).toBe(SID1)

      const second = await dequeue(dirs)
      expect(second!.sessionId).toBe(SID2)

      const third = await dequeue(dirs)
      expect(third!.sessionId).toBe(SID3)

      const fourth = await dequeue(dirs)
      expect(fourth).toBeNull()
    })

    test('returns null when queueDir does not exist', async () => {
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
    test('creates doneDir/{key} with lineCount and removes queueDir/{key}', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markDone(`${SID1}.diary`, 42, dirs)

      const doneFile = Bun.file(join(dirs.doneDir, `${SID1}.diary`))
      expect(await doneFile.exists()).toBe(true)
      expect(await doneFile.text()).toBe('42')

      const queueFile = Bun.file(join(dirs.queueDir, `${SID1}.diary`))
      expect(await queueFile.exists()).toBe(false)
    })

    test('creates doneDir if it does not exist', async () => {
      await markDone(`${SID1}.diary`, 100, dirs)
      const doneFile = Bun.file(join(dirs.doneDir, `${SID1}.diary`))
      expect(await doneFile.exists()).toBe(true)
    })
  })

  describe('markFailed', () => {
    test('moves file from queueDir to failedDir', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const failedFile = Bun.file(join(dirs.failedDir, `${SID1}.diary`))
      expect(await failedFile.exists()).toBe(true)

      const queueFile = Bun.file(join(dirs.queueDir, `${SID1}.diary`))
      expect(await queueFile.exists()).toBe(false)
    })

    test('creates failedDir if it does not exist', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      const failedFile = Bun.file(join(dirs.failedDir, `${SID1}.diary`))
      expect(await failedFile.exists()).toBe(true)
    })

    test('works after dequeue (queue file already removed)', async () => {
      await enqueue(SID1, 'diary', dirs)
      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()

      // Queue file is already removed by dequeue
      const queueFile = Bun.file(join(dirs.queueDir, `${SID1}.diary`))
      expect(await queueFile.exists()).toBe(false)

      // markFailed should still succeed and create the failed file
      await markFailed(`${SID1}.diary`, undefined, dirs)
      const failedFile = Bun.file(join(dirs.failedDir, `${SID1}.diary`))
      expect(await failedFile.exists()).toBe(true)
    })

    test('records retryCount: 1 on first call', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const content = await Bun.file(join(dirs.failedDir, `${SID1}.diary`)).json()
      expect(content.retryCount).toBe(1)
    })

    test('increments retryCount on subsequent calls', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      const content = await Bun.file(join(dirs.failedDir, `${SID1}.diary`)).json()
      expect(content.retryCount).toBe(2)
    })

    test('records reason when provided', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, 'claude exited with code 1', dirs)

      const content = await Bun.file(join(dirs.failedDir, `${SID1}.diary`)).json()
      expect(content.retryCount).toBe(1)
      expect(content.reason).toBe('claude exited with code 1')
    })

    test('preserves reason from previous failure when incrementing', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, 'first error', dirs)
      await markFailed(`${SID1}.diary`, 'second error', dirs)

      const content = await Bun.file(join(dirs.failedDir, `${SID1}.diary`)).json()
      expect(content.retryCount).toBe(2)
      expect(content.reason).toBe('second error')
    })

    test('treats existing empty file as retryCount 0 (backward compat)', async () => {
      // Simulate legacy empty failed file
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dirs.failedDir, { recursive: true })
      await Bun.write(join(dirs.failedDir, `${SID1}.diary`), '')

      await markFailed(`${SID1}.diary`, undefined, dirs)

      const content = await Bun.file(join(dirs.failedDir, `${SID1}.diary`)).json()
      expect(content.retryCount).toBe(1)
    })
  })

  describe('isDone', () => {
    test('returns true when done file exists and lineCount >= currentLineCount', async () => {
      await markDone(`${SID1}.diary`, 100, dirs)
      expect(await isDone(SID1, 'diary', 100, dirs)).toBe(true)
      expect(await isDone(SID1, 'diary', 50, dirs)).toBe(true)
    })

    test('returns false when done file has fewer lines than currentLineCount', async () => {
      await markDone(`${SID1}.diary`, 50, dirs)
      expect(await isDone(SID1, 'diary', 100, dirs)).toBe(false)
    })

    test('returns false when done file does not exist', async () => {
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
    test('returns false when failed file does not exist', async () => {
      expect(await isFailed(SID1, 'diary', dirs)).toBe(false)
    })

    test('returns true when failed and mtime is recent (within retryAfterMs)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      // Just failed - should still be considered failed (too soon to retry)
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1000 })).toBe(true)
    })

    test('returns false when retryCount < maxRetries and mtime is old enough (auto-retry)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)

      // Set mtime to the past to simulate time passing
      const { utimesSync } = await import('node:fs')
      const oldTime = new Date(Date.now() - 2000)
      utimesSync(join(dirs.failedDir, `${SID1}.diary`), oldTime, oldTime)

      // retryCount=1, maxRetries=3, mtime is 2s ago, retryAfterMs=1000ms => should retry
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1000, maxRetries: 3 })).toBe(false)
    })

    test('returns true when retryCount >= maxRetries (permanent-failed)', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=1
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=2
      await markFailed(`${SID1}.diary`, undefined, dirs) // retryCount=3

      // Set mtime to the past
      const { utimesSync } = await import('node:fs')
      const oldTime = new Date(Date.now() - 100000)
      utimesSync(join(dirs.failedDir, `${SID1}.diary`), oldTime, oldTime)

      // retryCount=3, maxRetries=3 => permanent-failed, always true
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1, maxRetries: 3 })).toBe(true)
    })

    test('treats legacy empty file as retryCount 0 (always retryable after delay)', async () => {
      // Simulate legacy empty failed file
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dirs.failedDir, { recursive: true })
      await Bun.write(join(dirs.failedDir, `${SID1}.diary`), '')

      // Set mtime to the past
      const { utimesSync } = await import('node:fs')
      const oldTime = new Date(Date.now() - 2000)
      utimesSync(join(dirs.failedDir, `${SID1}.diary`), oldTime, oldTime)

      // retryCount=0, maxRetries=3, mtime old => should retry
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 1000, maxRetries: 3 })).toBe(false)
    })

    test('returns true for legacy empty file when mtime is recent', async () => {
      // Simulate legacy empty failed file
      const { mkdir } = await import('node:fs/promises')
      await mkdir(dirs.failedDir, { recursive: true })
      await Bun.write(join(dirs.failedDir, `${SID1}.diary`), '')

      // retryCount=0, maxRetries=3, mtime is now => too soon
      expect(await isFailed(SID1, 'diary', dirs, { retryAfterMs: 60000, maxRetries: 3 })).toBe(true)
    })

    test('uses default retryAfterMs and maxRetries when not specified', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      // With defaults (24h, 3 retries), just-failed should return true
      expect(await isFailed(SID1, 'diary', dirs)).toBe(true)
    })
  })

  describe('retry', () => {
    test('moves file from failedDir to queueDir', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      await retry(`${SID1}.diary`, dirs)

      const queueFile = Bun.file(join(dirs.queueDir, `${SID1}.diary`))
      expect(await queueFile.exists()).toBe(true)

      const failedFile = Bun.file(join(dirs.failedDir, `${SID1}.diary`))
      expect(await failedFile.exists()).toBe(false)
    })
  })

  describe('getStatus', () => {
    test('returns counts for each directory', async () => {
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

    test('returns zeros when directories are empty or do not exist', async () => {
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

    test('returns 0 when failedDir is empty', async () => {
      const isSessionExists = async (_sid: string) => false
      const removed = await cleanup(isSessionExists, dirs)
      expect(removed).toBe(0)
    })

    test('ignores .log files in failed directory', async () => {
      await enqueue(SID1, 'diary', dirs)
      await markFailed(`${SID1}.diary`, undefined, dirs)
      // Simulate a .log file
      await Bun.write(join(dirs.failedDir, `${SID1}.diary.log`), 'error log')

      const isSessionExists = async (_sid: string) => false
      const removed = await cleanup(isSessionExists, dirs)
      // Only the queue entry is counted, not the .log
      expect(removed).toBe(1)
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
})
