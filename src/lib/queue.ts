import { Database } from 'bun:sqlite'
import { dirname, join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getStateDir } from './paths.ts'
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

function resolveDbPath(dirs?: QueueDirs): string {
  if (dirs) {
    // dirs.queueDir may have a trailing slash; strip it, then go to parent
    const parent = dirname(dirs.queueDir.replace(/\/$/, ''))
    return join(parent, 'queue.db')
  }
  return join(getStateDir(), 'queue.db')
}

function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS queue_entries (
    key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    recipe_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    line_count INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    fail_reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_status ON queue_entries(status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_status_updated ON queue_entries(status, updated_at)`)
}

export function getDb(dirs?: QueueDirs): Database {
  const dbPath = resolveDbPath(dirs)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA busy_timeout = 5000')
  initSchema(db)
  return db
}

export async function enqueue(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<void> {
  const key = makeKey(sessionId, recipeName)
  const now = Date.now()
  const db = getDb(dirs)
  try {
    db.run(
      `INSERT OR IGNORE INTO queue_entries (key, session_id, recipe_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [key, sessionId, recipeName, now, now],
    )
  } finally {
    db.close()
  }
}

export async function dequeue(dirs?: QueueDirs): Promise<QueueEntry | null> {
  const db = getDb(dirs)
  try {
    const row = db.query(
      `SELECT key, session_id, recipe_name FROM queue_entries
       WHERE status = 'queued'
       ORDER BY updated_at DESC
       LIMIT 1`,
    ).get() as { key: string; session_id: string; recipe_name: string } | null

    if (!row) return null

    db.run(`DELETE FROM queue_entries WHERE key = ?`, [row.key])

    return {
      sessionId: row.session_id,
      recipeName: row.recipe_name,
      key: row.key,
    }
  } finally {
    db.close()
  }
}

export async function markDone(key: string, lineCount: number, dirs?: QueueDirs): Promise<void> {
  const { sessionId, recipeName } = parseKey(key)
  const now = Date.now()
  const db = getDb(dirs)
  try {
    db.run(
      `INSERT INTO queue_entries (key, session_id, recipe_name, status, line_count, created_at, updated_at)
       VALUES (?, ?, ?, 'done', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         status = 'done',
         line_count = excluded.line_count,
         updated_at = excluded.updated_at`,
      [key, sessionId, recipeName, lineCount, now, now],
    )
  } finally {
    db.close()
  }
}

export async function markFailed(key: string, reason?: string, dirs?: QueueDirs): Promise<void> {
  const { sessionId, recipeName } = parseKey(key)
  const now = Date.now()
  const db = getDb(dirs)
  try {
    // Get existing retry_count if any
    const existing = db.query(
      `SELECT retry_count FROM queue_entries WHERE key = ?`,
    ).get(key) as { retry_count: number } | null
    const retryCount = (existing?.retry_count ?? 0) + 1

    db.run(
      `INSERT INTO queue_entries (key, session_id, recipe_name, status, retry_count, fail_reason, created_at, updated_at)
       VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         status = 'failed',
         retry_count = excluded.retry_count,
         fail_reason = excluded.fail_reason,
         updated_at = excluded.updated_at`,
      [key, sessionId, recipeName, retryCount, reason ?? null, now, now],
    )
  } finally {
    db.close()
  }
}

export async function isDone(sessionId: string, recipeName: string, currentLineCount: number, dirs?: QueueDirs): Promise<boolean> {
  const key = makeKey(sessionId, recipeName)
  const db = getDb(dirs)
  try {
    const row = db.query(
      `SELECT line_count FROM queue_entries WHERE key = ? AND status = 'done'`,
    ).get(key) as { line_count: number | null } | null

    if (!row || row.line_count === null) return false
    return row.line_count >= currentLineCount
  } finally {
    db.close()
  }
}

export async function isQueued(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<boolean> {
  const key = makeKey(sessionId, recipeName)
  const db = getDb(dirs)
  try {
    const row = db.query(
      `SELECT 1 FROM queue_entries WHERE key = ? AND status = 'queued'`,
    ).get(key)
    return row !== null
  } finally {
    db.close()
  }
}

export async function isFailed(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
  retryOpts?: RetryOptions,
): Promise<boolean> {
  const key = makeKey(sessionId, recipeName)
  const db = getDb(dirs)
  try {
    const row = db.query(
      `SELECT retry_count, updated_at FROM queue_entries WHERE key = ? AND status = 'failed'`,
    ).get(key) as { retry_count: number; updated_at: number } | null

    if (!row) return false

    const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES
    const retryAfterMs = retryOpts?.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS

    // Permanent-failed: retryCount >= maxRetries
    if (row.retry_count >= maxRetries) return true

    // Check updated_at: if old enough, allow retry (return false)
    const elapsed = Date.now() - row.updated_at
    if (elapsed >= retryAfterMs) return false

    return true
  } finally {
    db.close()
  }
}

export async function retry(key: string, dirs?: QueueDirs): Promise<void> {
  const now = Date.now()
  const db = getDb(dirs)
  try {
    db.run(
      `UPDATE queue_entries SET status = 'queued', updated_at = ? WHERE key = ?`,
      [now, key],
    )
  } finally {
    db.close()
  }
}

export async function getStatus(dirs?: QueueDirs): Promise<{ queued: number; done: number; failed: number }> {
  const db = getDb(dirs)
  try {
    const rows = db.query(
      `SELECT status, COUNT(*) as count FROM queue_entries GROUP BY status`,
    ).all() as { status: string; count: number }[]

    const result = { queued: 0, done: 0, failed: 0 }
    for (const row of rows) {
      if (row.status === 'queued') result.queued = row.count
      else if (row.status === 'done') result.done = row.count
      else if (row.status === 'failed') result.failed = row.count
    }
    return result
  } finally {
    db.close()
  }
}

export async function cleanup(
  isSessionExists: (sid: string) => Promise<boolean>,
  dirs?: QueueDirs,
): Promise<number> {
  const db = getDb(dirs)
  try {
    const rows = db.query(
      `SELECT key, session_id FROM queue_entries WHERE status = 'failed'`,
    ).all() as { key: string; session_id: string }[]

    let removed = 0
    for (const row of rows) {
      const exists = await isSessionExists(row.session_id)
      if (!exists) {
        db.run(`DELETE FROM queue_entries WHERE key = ?`, [row.key])
        removed++
      }
    }
    return removed
  } finally {
    db.close()
  }
}

export async function loadQueueState(dirs?: QueueDirs): Promise<QueueState> {
  const db = getDb(dirs)
  try {
    const rows = db.query(
      `SELECT key, status, line_count, retry_count, fail_reason, updated_at FROM queue_entries`,
    ).all() as {
      key: string
      status: string
      line_count: number | null
      retry_count: number
      fail_reason: string | null
      updated_at: number
    }[]

    const queued = new Set<string>()
    const done = new Map<string, { lineCount: number }>()
    const failed = new Map<string, QueueStateFailedEntry>()

    for (const row of rows) {
      if (row.status === 'queued') {
        queued.add(row.key)
      } else if (row.status === 'done') {
        done.set(row.key, { lineCount: row.line_count ?? 0 })
      } else if (row.status === 'failed') {
        const meta: FailedMeta = {
          retryCount: row.retry_count,
          ...(row.fail_reason !== null ? { reason: row.fail_reason } : {}),
        }
        failed.set(row.key, { meta, mtimeMs: row.updated_at })
      }
    }

    return { queued, done, failed }
  } finally {
    db.close()
  }
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
