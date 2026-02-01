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
} from './queue.ts'

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
      await enqueue('abc-123', 'diary', dirs)
      const file = Bun.file(join(dirs.queueDir, 'abc-123.diary'))
      expect(await file.exists()).toBe(true)
    })

    test('creates queueDir if it does not exist', async () => {
      await enqueue('abc-123', 'diary', dirs)
      const file = Bun.file(join(dirs.queueDir, 'abc-123.diary'))
      expect(await file.exists()).toBe(true)
    })

    test('creates an empty file (touch)', async () => {
      await enqueue('abc-123', 'diary', dirs)
      const file = Bun.file(join(dirs.queueDir, 'abc-123.diary'))
      expect(await file.text()).toBe('')
    })
  })

  describe('dequeue', () => {
    test('returns null when queue is empty', async () => {
      const entry = await dequeue(dirs)
      expect(entry).toBeNull()
    })

    test('returns the oldest entry and removes the file', async () => {
      // enqueue two items with a small delay to ensure different mtimes
      await enqueue('sid-1', 'recipe-a', dirs)
      // Touch with older mtime to guarantee ordering
      const { utimesSync } = await import('node:fs')
      const oldTime = new Date(Date.now() - 10000)
      utimesSync(join(dirs.queueDir, 'sid-1.recipe-a'), oldTime, oldTime)

      await enqueue('sid-2', 'recipe-b', dirs)

      const entry = await dequeue(dirs)
      expect(entry).not.toBeNull()
      expect(entry!.sessionId).toBe('sid-1')
      expect(entry!.recipeName).toBe('recipe-a')
      expect(entry!.key).toBe('sid-1.recipe-a')

      // File should be removed
      const file = Bun.file(join(dirs.queueDir, 'sid-1.recipe-a'))
      expect(await file.exists()).toBe(false)

      // Second entry should still exist
      const file2 = Bun.file(join(dirs.queueDir, 'sid-2.recipe-b'))
      expect(await file2.exists()).toBe(true)
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

  describe('markDone', () => {
    test('creates doneDir/{key} with lineCount and removes queueDir/{key}', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await markDone('sid-1.diary', 42, dirs)

      const doneFile = Bun.file(join(dirs.doneDir, 'sid-1.diary'))
      expect(await doneFile.exists()).toBe(true)
      expect(await doneFile.text()).toBe('42')

      const queueFile = Bun.file(join(dirs.queueDir, 'sid-1.diary'))
      expect(await queueFile.exists()).toBe(false)
    })

    test('creates doneDir if it does not exist', async () => {
      await markDone('sid-1.diary', 100, dirs)
      const doneFile = Bun.file(join(dirs.doneDir, 'sid-1.diary'))
      expect(await doneFile.exists()).toBe(true)
    })
  })

  describe('markFailed', () => {
    test('moves file from queueDir to failedDir', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)

      const failedFile = Bun.file(join(dirs.failedDir, 'sid-1.diary'))
      expect(await failedFile.exists()).toBe(true)

      const queueFile = Bun.file(join(dirs.queueDir, 'sid-1.diary'))
      expect(await queueFile.exists()).toBe(false)
    })

    test('creates failedDir if it does not exist', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)
      const failedFile = Bun.file(join(dirs.failedDir, 'sid-1.diary'))
      expect(await failedFile.exists()).toBe(true)
    })
  })

  describe('isDone', () => {
    test('returns true when done file exists and lineCount >= currentLineCount', async () => {
      await markDone('sid-1.diary', 100, dirs)
      expect(await isDone('sid-1', 'diary', 100, dirs)).toBe(true)
      expect(await isDone('sid-1', 'diary', 50, dirs)).toBe(true)
    })

    test('returns false when done file has fewer lines than currentLineCount', async () => {
      await markDone('sid-1.diary', 50, dirs)
      expect(await isDone('sid-1', 'diary', 100, dirs)).toBe(false)
    })

    test('returns false when done file does not exist', async () => {
      expect(await isDone('sid-1', 'diary', 10, dirs)).toBe(false)
    })
  })

  describe('isQueued', () => {
    test('returns true when entry is in queue', async () => {
      await enqueue('sid-1', 'diary', dirs)
      expect(await isQueued('sid-1', 'diary', dirs)).toBe(true)
    })

    test('returns false when entry is not in queue', async () => {
      expect(await isQueued('sid-1', 'diary', dirs)).toBe(false)
    })
  })

  describe('isFailed', () => {
    test('returns true when entry is in failed', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)
      expect(await isFailed('sid-1', 'diary', dirs)).toBe(true)
    })

    test('returns false when entry is not in failed', async () => {
      expect(await isFailed('sid-1', 'diary', dirs)).toBe(false)
    })
  })

  describe('retry', () => {
    test('moves file from failedDir to queueDir', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)
      await retry('sid-1.diary', dirs)

      const queueFile = Bun.file(join(dirs.queueDir, 'sid-1.diary'))
      expect(await queueFile.exists()).toBe(true)

      const failedFile = Bun.file(join(dirs.failedDir, 'sid-1.diary'))
      expect(await failedFile.exists()).toBe(false)
    })
  })

  describe('getStatus', () => {
    test('returns counts for each directory', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await enqueue('sid-2', 'diary', dirs)
      await markDone('sid-3.diary', 10, dirs)
      await enqueue('sid-4', 'diary', dirs)
      await markFailed('sid-4.diary', dirs)

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
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)
      await enqueue('sid-2', 'diary', dirs)
      await markFailed('sid-2.diary', dirs)

      const isSessionExists = async (sid: string) => sid === 'sid-1'
      const removed = await cleanup(isSessionExists, dirs)

      expect(removed).toBe(1)
      expect(await isFailed('sid-1', 'diary', dirs)).toBe(true)
      expect(await isFailed('sid-2', 'diary', dirs)).toBe(false)
    })

    test('returns 0 when all sessions exist', async () => {
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)

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
      await enqueue('sid-1', 'diary', dirs)
      await markFailed('sid-1.diary', dirs)
      // Simulate a .log file
      await Bun.write(join(dirs.failedDir, 'sid-1.diary.log'), 'error log')

      const isSessionExists = async (_sid: string) => false
      const removed = await cleanup(isSessionExists, dirs)
      // Only the queue entry is counted, not the .log
      expect(removed).toBe(1)
    })
  })
})
