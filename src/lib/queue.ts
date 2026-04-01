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

export interface QueueStateFailedEntry {
  meta: FailedMeta
  mtimeMs: number
}

export interface QueueState {
  queued: Set<string>
  done: Map<string, { lineCount: number }>
  failed: Map<string, QueueStateFailedEntry>
}

function defaultDirs(): QueueDirs {
  return {
    queueDir: getQueueDir(),
    doneDir: getDoneDir(),
    failedDir: getFailedDir(),
  }
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RECIPE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId: "${sessionId}" (must be UUID format)`)
  }
}

export function validateRecipeName(recipeName: string): void {
  if (!RECIPE_NAME_RE.test(recipeName)) {
    throw new Error(`Invalid recipeName: "${recipeName}" (must match ${RECIPE_NAME_RE})`)
  }
}

function makeKey(sessionId: string, recipeName: string): string {
  validateSessionId(sessionId)
  validateRecipeName(recipeName)
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

export async function loadQueueState(dirs?: QueueDirs): Promise<QueueState> {
  const d = dirs ?? defaultDirs()

  const [queueFiles, doneFiles, failedFiles] = await Promise.all([
    listFiles(d.queueDir),
    listFiles(d.doneDir),
    listFiles(d.failedDir),
  ])

  // Build queued set
  const queued = new Set<string>(queueFiles)

  // Build done map with lineCount
  const done = new Map<string, { lineCount: number }>()
  await Promise.all(
    doneFiles.map(async (name) => {
      try {
        const content = await Bun.file(join(d.doneDir, name)).text()
        const lineCount = parseInt(content, 10)
        done.set(name, { lineCount: isNaN(lineCount) ? 0 : lineCount })
      } catch {
        done.set(name, { lineCount: 0 })
      }
    }),
  )

  // Build failed map with meta and mtimeMs
  const failed = new Map<string, QueueStateFailedEntry>()
  await Promise.all(
    failedFiles.map(async (name) => {
      const filePath = join(d.failedDir, name)
      const [meta, s] = await Promise.all([
        readFailedMeta(filePath),
        stat(filePath).catch(() => null),
      ])
      failed.set(name, {
        meta,
        mtimeMs: s?.mtimeMs ?? 0,
      })
    }),
  )

  return { queued, done, failed }
}

/** In-memory equivalent of isFailed() using pre-loaded QueueState */
export function isFailedByState(
  state: QueueState,
  key: string,
  retryOpts?: RetryOptions,
): boolean {
  const entry = state.failed.get(key)
  if (!entry) return false

  const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES
  const retryAfterMs = retryOpts?.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS

  // Permanent-failed: retryCount >= maxRetries
  if (entry.meta.retryCount >= maxRetries) return true

  // Check mtime: if old enough, allow retry (return false)
  const elapsed = Date.now() - entry.mtimeMs
  if (elapsed >= retryAfterMs) return false

  return true
}
