import { mkdir, readdir, unlink, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getQueueDir, getDoneDir, getFailedDir } from './paths.ts'
import type { QueueEntry } from '../types/index.ts'

export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000 // 24 hours

export interface FailedMeta {
  retryCount: number
  reason?: string
}

export interface RetryOptions {
  retryAfterMs?: number
  maxRetries?: number
}

export interface QueueDirs {
  queueDir: string
  doneDir: string
  failedDir: string
}

function defaultDirs(): QueueDirs {
  return {
    queueDir: getQueueDir(),
    doneDir: getDoneDir(),
    failedDir: getFailedDir(),
  }
}

function makeKey(sessionId: string, recipeName: string): string {
  return `${sessionId}.${recipeName}`
}

function parseKey(key: string): { sessionId: string; recipeName: string } {
  const firstDot = key.indexOf('.')
  return {
    sessionId: key.slice(0, firstDot),
    recipeName: key.slice(firstDot + 1),
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function readFailedMeta(filePath: string): Promise<FailedMeta> {
  try {
    const file = Bun.file(filePath)
    const text = await file.text()
    if (!text.trim()) {
      // Legacy empty file: treat as retryCount 0
      return { retryCount: 0 }
    }
    return JSON.parse(text) as FailedMeta
  } catch {
    return { retryCount: 0 }
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function enqueue(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.queueDir)
  const key = makeKey(sessionId, recipeName)
  await Bun.write(join(d.queueDir, key), '')
}

export async function dequeue(dirs?: QueueDirs): Promise<QueueEntry | null> {
  const d = dirs ?? defaultDirs()
  const files = await listFiles(d.queueDir)
  if (files.length === 0) return null

  // Find the oldest file by mtime (FIFO: process oldest first)
  let oldest: { name: string; mtime: number } | null = null
  for (const name of files) {
    try {
      const s = await stat(join(d.queueDir, name))
      if (oldest === null || s.mtimeMs < oldest.mtime) {
        oldest = { name, mtime: s.mtimeMs }
      }
    } catch {
      // File may have been removed concurrently
    }
  }

  if (oldest === null) return null

  const { sessionId, recipeName } = parseKey(oldest.name)
  await unlink(join(d.queueDir, oldest.name))

  return { sessionId, recipeName, key: oldest.name }
}

export async function markDone(key: string, lineCount: number, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.doneDir)
  await Bun.write(join(d.doneDir, key), String(lineCount))
  // Remove from queue if present
  try {
    await unlink(join(d.queueDir, key))
  } catch {
    // May not exist in queue
  }
}

export async function markFailed(key: string, reason?: string, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.failedDir)
  const failedPath = join(d.failedDir, key)

  // Read existing metadata (if any) to increment retryCount
  const existing = await readFailedMeta(failedPath)
  const meta: FailedMeta = {
    retryCount: existing.retryCount + 1,
    ...(reason !== undefined ? { reason } : {}),
  }

  // Remove queue file if present (best effort)
  try {
    await unlink(join(d.queueDir, key))
  } catch {
    // May not exist (already dequeued)
  }

  await Bun.write(failedPath, JSON.stringify(meta))
}

export async function isDone(sessionId: string, recipeName: string, currentLineCount: number, dirs?: QueueDirs): Promise<boolean> {
  const d = dirs ?? defaultDirs()
  const key = makeKey(sessionId, recipeName)
  try {
    const file = Bun.file(join(d.doneDir, key))
    const content = await file.text()
    const doneLines = parseInt(content, 10)
    return !isNaN(doneLines) && doneLines >= currentLineCount
  } catch {
    return false
  }
}

export async function isQueued(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<boolean> {
  const d = dirs ?? defaultDirs()
  const key = makeKey(sessionId, recipeName)
  const file = Bun.file(join(d.queueDir, key))
  return file.exists()
}

export async function isFailed(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
  retryOpts?: RetryOptions,
): Promise<boolean> {
  const d = dirs ?? defaultDirs()
  const key = makeKey(sessionId, recipeName)
  const failedPath = join(d.failedDir, key)
  const file = Bun.file(failedPath)

  if (!(await file.exists())) return false

  const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES
  const retryAfterMs = retryOpts?.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS

  const meta = await readFailedMeta(failedPath)

  // Permanent-failed: retryCount >= maxRetries
  if (meta.retryCount >= maxRetries) return true

  // Check mtime: if old enough, allow retry (return false)
  try {
    const s = await stat(failedPath)
    const elapsed = Date.now() - s.mtimeMs
    if (elapsed >= retryAfterMs) return false
  } catch {
    // stat failed, treat as still failed
  }

  return true
}

export async function retry(key: string, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.queueDir)
  await rename(join(d.failedDir, key), join(d.queueDir, key))
}

export async function getStatus(dirs?: QueueDirs): Promise<{ queued: number; done: number; failed: number }> {
  const d = dirs ?? defaultDirs()
  const [queueFiles, doneFiles, failedFiles] = await Promise.all([
    listFiles(d.queueDir),
    listFiles(d.doneDir),
    listFiles(d.failedDir),
  ])
  return {
    queued: queueFiles.length,
    done: doneFiles.length,
    // Exclude .log files from failed count (matching shell script behavior)
    failed: failedFiles.filter(f => !f.endsWith('.log')).length,
  }
}

export async function cleanup(
  isSessionExists: (sid: string) => Promise<boolean>,
  dirs?: QueueDirs,
): Promise<number> {
  const d = dirs ?? defaultDirs()
  const files = await listFiles(d.failedDir)
  let removed = 0

  for (const name of files) {
    // Skip .log files
    if (name.endsWith('.log')) continue

    const { sessionId } = parseKey(name)
    const exists = await isSessionExists(sessionId)
    if (!exists) {
      await unlink(join(d.failedDir, name))
      removed++
    }
  }

  return removed
}
