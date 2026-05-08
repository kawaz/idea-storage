import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { getStateDir } from "./paths.ts";
import type { QueueEntry } from "../types/index.ts";

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Default poll interval for waitForCompletion (ms). */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 1000;
/** Default timeout for waitForCompletion (ms). 30 minutes. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

export interface FailedMeta {
  retryCount: number;
  reason?: string;
}

export interface RetryOptions {
  retryAfterMs?: number;
  maxRetries?: number;
}

export interface QueueDirs {
  queueDir: string;
  doneDir: string;
  failedDir: string;
}

export interface QueueStateFailedEntry {
  meta: FailedMeta;
  mtimeMs: number;
}

export interface QueueState {
  queued: Set<string>;
  /** Entries currently being processed by a worker / convert. */
  processing: Set<string>;
  done: Map<string, { lineCount: number }>;
  failed: Map<string, QueueStateFailedEntry>;
}

export type QueueStatus = "queued" | "processing" | "done" | "failed";

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECIPE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId: "${sessionId}" (must be UUID format)`);
  }
}

export function validateRecipeName(recipeName: string): void {
  if (!RECIPE_NAME_RE.test(recipeName)) {
    throw new Error(`Invalid recipeName: "${recipeName}" (must match ${RECIPE_NAME_RE})`);
  }
}

function makeKey(sessionId: string, recipeName: string): string {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  return `${sessionId}.${recipeName}`;
}

function parseKey(key: string): { sessionId: string; recipeName: string } {
  const firstDot = key.indexOf(".");
  return {
    sessionId: key.slice(0, firstDot),
    recipeName: key.slice(firstDot + 1),
  };
}

function resolveDbPath(dirs?: QueueDirs): string {
  if (dirs) {
    // dirs.queueDir may have a trailing slash; strip it, then go to parent
    const parent = dirname(dirs.queueDir.replace(/\/$/, ""));
    return join(parent, "queue.db");
  }
  return join(getStateDir(), "queue.db");
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
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_status ON queue_entries(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_status_updated ON queue_entries(status, updated_at)`);
}

export function getDb(dirs?: QueueDirs): Database {
  const dbPath = resolveDbPath(dirs);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  initSchema(db);
  return db;
}

/**
 * 複数のエントリを1トランザクションで一括 enqueue する。
 * 既に存在する key は無視（INSERT OR IGNORE）。
 * バリデーションはトランザクション開始前に全件チェックするため、
 * 1件でも不正があればどのエントリも挿入されない。
 */
export function enqueueBatch(
  entries: Array<{ sessionId: string; recipeName: string }>,
  dirs?: QueueDirs,
): void {
  if (entries.length === 0) return;
  // Validate all entries upfront (before opening DB) so invalid input
  // causes no partial inserts even without relying on transaction rollback.
  const validated = entries.map(({ sessionId, recipeName }) => ({
    key: makeKey(sessionId, recipeName), // validates inputs
    sessionId,
    recipeName,
  }));
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO queue_entries (key, session_id, recipe_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (const { key, sessionId, recipeName } of validated) {
        stmt.run(key, sessionId, recipeName, now, now);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

export async function enqueue(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<void> {
  const key = makeKey(sessionId, recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    db.run(
      `INSERT OR IGNORE INTO queue_entries (key, session_id, recipe_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?)`,
      [key, sessionId, recipeName, now, now],
    );
  } finally {
    db.close();
  }
}

/**
 * Dequeue the newest queued entry by transitioning it from 'queued' to 'processing'.
 *
 * Design rationale: 以前は SELECT → DELETE していたが、processing 状態を残すことで
 * 同一 key を別プロセス（worker, convert, または並行 worker）が二重処理しないよう
 * 排他制御できる。エントリは処理完了時に markDone/markFailed で done/failed に遷移し、
 * 失敗したまま放置された orphan の回収は別タスクで実装予定。
 *
 * トランザクション内で SELECT + UPDATE を行い、複数 worker による同時 dequeue を排他する。
 */
export async function dequeue(dirs?: QueueDirs): Promise<QueueEntry | null> {
  const db = getDb(dirs);
  try {
    const now = Date.now();
    let claimed: QueueEntry | null = null;
    const tx = db.transaction(() => {
      const row = db
        .query(
          `SELECT key, session_id, recipe_name FROM queue_entries
           WHERE status = 'queued'
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get() as { key: string; session_id: string; recipe_name: string } | null;

      if (!row) return;

      db.run(`UPDATE queue_entries SET status = 'processing', updated_at = ? WHERE key = ?`, [
        now,
        row.key,
      ]);

      claimed = {
        sessionId: row.session_id,
        recipeName: row.recipe_name,
        key: row.key,
      };
    });
    tx();
    return claimed;
  } finally {
    db.close();
  }
}

export interface ClaimResult {
  /** True if this caller successfully claimed processing ownership of the key. */
  claimed: boolean;
  /** Status before the claim (null if entry did not exist). */
  prevStatus: QueueStatus | null;
}

/**
 * Atomically claim a key for processing.
 *
 * - Entry absent → INSERT with status='processing'. Returns claimed=true, prevStatus=null.
 * - Entry queued / done / failed → UPDATE to status='processing'. Returns claimed=true, prevStatus=<old>.
 * - Entry already 'processing' → no change. Returns claimed=false, prevStatus='processing'.
 *
 * 重複処理の排他制御を提供する。Convert コマンドは claim に成功した場合に処理を実行し、
 * 失敗した場合は waitForCompletion で他プロセスの完了を待つ。
 */
export async function claim(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<ClaimResult> {
  const key = makeKey(sessionId, recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    let result: ClaimResult = { claimed: false, prevStatus: null };
    const tx = db.transaction(() => {
      const row = db.query(`SELECT status FROM queue_entries WHERE key = ?`).get(key) as {
        status: QueueStatus;
      } | null;

      if (!row) {
        db.run(
          `INSERT INTO queue_entries (key, session_id, recipe_name, status, created_at, updated_at)
           VALUES (?, ?, ?, 'processing', ?, ?)`,
          [key, sessionId, recipeName, now, now],
        );
        result = { claimed: true, prevStatus: null };
        return;
      }

      if (row.status === "processing") {
        result = { claimed: false, prevStatus: "processing" };
        return;
      }

      db.run(`UPDATE queue_entries SET status = 'processing', updated_at = ? WHERE key = ?`, [
        now,
        key,
      ]);
      result = { claimed: true, prevStatus: row.status };
    });
    tx();
    return result;
  } finally {
    db.close();
  }
}

export type WaitForCompletionResult =
  | { status: "done"; lineCount: number }
  | { status: "failed"; failReason: string | null }
  | { status: "timeout" };

export interface WaitForCompletionOptions {
  /** Polling interval in ms. Default: DEFAULT_WAIT_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Total timeout in ms. Default: DEFAULT_WAIT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Custom sleep function (for testing). */
  sleep?: (ms: number) => Promise<void>;
  /** Custom now() function (for testing). */
  now?: () => number;
}

/**
 * Poll until the entry transitions to 'done' or 'failed', or the timeout expires.
 *
 * Returns:
 * - { status: 'done', lineCount }  when the entry reaches 'done'
 * - { status: 'failed', failReason }  when the entry reaches 'failed'
 * - { status: 'timeout' }  when timeoutMs elapses without completion
 *
 * If the entry disappears (deleted), this also returns 'timeout' eventually
 * (treated as no completion observed).
 */
export async function waitForCompletion(
  key: string,
  options: WaitForCompletionOptions = {},
  dirs?: QueueDirs,
): Promise<WaitForCompletionResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());

  const start = now();

  while (true) {
    const db = getDb(dirs);
    let row: { status: QueueStatus; line_count: number | null; fail_reason: string | null } | null;
    try {
      row = db
        .query(`SELECT status, line_count, fail_reason FROM queue_entries WHERE key = ?`)
        .get(key) as {
        status: QueueStatus;
        line_count: number | null;
        fail_reason: string | null;
      } | null;
    } finally {
      db.close();
    }

    if (row) {
      if (row.status === "done") {
        return { status: "done", lineCount: row.line_count ?? 0 };
      }
      if (row.status === "failed") {
        return { status: "failed", failReason: row.fail_reason };
      }
    }

    if (now() - start >= timeoutMs) {
      return { status: "timeout" };
    }

    await sleep(pollIntervalMs);
  }
}

export async function markDone(key: string, lineCount: number, dirs?: QueueDirs): Promise<void> {
  const { sessionId, recipeName } = parseKey(key);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    db.run(
      `INSERT INTO queue_entries (key, session_id, recipe_name, status, line_count, created_at, updated_at)
       VALUES (?, ?, ?, 'done', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         status = 'done',
         line_count = excluded.line_count,
         updated_at = excluded.updated_at`,
      [key, sessionId, recipeName, lineCount, now, now],
    );
  } finally {
    db.close();
  }
}

export async function markFailed(key: string, reason?: string, dirs?: QueueDirs): Promise<void> {
  const { sessionId, recipeName } = parseKey(key);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    // Get existing retry_count if any
    const existing = db.query(`SELECT retry_count FROM queue_entries WHERE key = ?`).get(key) as {
      retry_count: number;
    } | null;
    const retryCount = (existing?.retry_count ?? 0) + 1;

    db.run(
      `INSERT INTO queue_entries (key, session_id, recipe_name, status, retry_count, fail_reason, created_at, updated_at)
       VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         status = 'failed',
         retry_count = excluded.retry_count,
         fail_reason = excluded.fail_reason,
         updated_at = excluded.updated_at`,
      [key, sessionId, recipeName, retryCount, reason ?? null, now, now],
    );
  } finally {
    db.close();
  }
}

export async function getDoneLineCount(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<number | null> {
  const key = makeKey(sessionId, recipeName);
  const db = getDb(dirs);
  try {
    const row = db
      .query(`SELECT line_count FROM queue_entries WHERE key = ? AND status = 'done'`)
      .get(key) as { line_count: number | null } | null;

    if (!row || row.line_count === null) return null;
    return row.line_count;
  } finally {
    db.close();
  }
}

export async function isDone(
  sessionId: string,
  recipeName: string,
  currentLineCount: number,
  dirs?: QueueDirs,
): Promise<boolean> {
  const key = makeKey(sessionId, recipeName);
  const db = getDb(dirs);
  try {
    const row = db
      .query(`SELECT line_count FROM queue_entries WHERE key = ? AND status = 'done'`)
      .get(key) as { line_count: number | null } | null;

    if (!row || row.line_count === null) return false;
    return row.line_count >= currentLineCount;
  } finally {
    db.close();
  }
}

export async function isQueued(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<boolean> {
  const key = makeKey(sessionId, recipeName);
  const db = getDb(dirs);
  try {
    const row = db
      .query(`SELECT 1 FROM queue_entries WHERE key = ? AND status = 'queued'`)
      .get(key);
    return row !== null;
  } finally {
    db.close();
  }
}

export async function isFailed(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
  retryOpts?: RetryOptions,
): Promise<boolean> {
  const key = makeKey(sessionId, recipeName);
  const db = getDb(dirs);
  try {
    const row = db
      .query(
        `SELECT retry_count, updated_at FROM queue_entries WHERE key = ? AND status = 'failed'`,
      )
      .get(key) as { retry_count: number; updated_at: number } | null;

    if (!row) return false;

    const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryAfterMs = retryOpts?.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;

    // Permanent-failed: retryCount >= maxRetries
    if (row.retry_count >= maxRetries) return true;

    // Check updated_at: if old enough, allow retry (return false)
    const elapsed = Date.now() - row.updated_at;
    if (elapsed >= retryAfterMs) return false;

    return true;
  } finally {
    db.close();
  }
}

export async function retry(key: string, dirs?: QueueDirs): Promise<void> {
  const now = Date.now();
  const db = getDb(dirs);
  try {
    db.run(`UPDATE queue_entries SET status = 'queued', updated_at = ? WHERE key = ?`, [now, key]);
  } finally {
    db.close();
  }
}

export async function getStatus(
  dirs?: QueueDirs,
): Promise<{ queued: number; processing: number; done: number; failed: number }> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(`SELECT status, COUNT(*) as count FROM queue_entries GROUP BY status`)
      .all() as { status: string; count: number }[];

    const result = { queued: 0, processing: 0, done: 0, failed: 0 };
    for (const row of rows) {
      if (row.status === "queued") result.queued = row.count;
      else if (row.status === "processing") result.processing = row.count;
      else if (row.status === "done") result.done = row.count;
      else if (row.status === "failed") result.failed = row.count;
    }
    return result;
  } finally {
    db.close();
  }
}

export async function cleanup(
  isSessionExists: (sid: string) => Promise<boolean>,
  dirs?: QueueDirs,
): Promise<number> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(`SELECT key, session_id FROM queue_entries WHERE status = 'failed'`)
      .all() as { key: string; session_id: string }[];

    let removed = 0;
    for (const row of rows) {
      const exists = await isSessionExists(row.session_id);
      if (!exists) {
        db.run(`DELETE FROM queue_entries WHERE key = ?`, [row.key]);
        removed++;
      }
    }
    return removed;
  } finally {
    db.close();
  }
}

export async function loadQueueState(dirs?: QueueDirs): Promise<QueueState> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(
        `SELECT key, status, line_count, retry_count, fail_reason, updated_at FROM queue_entries`,
      )
      .all() as {
      key: string;
      status: string;
      line_count: number | null;
      retry_count: number;
      fail_reason: string | null;
      updated_at: number;
    }[];

    const queued = new Set<string>();
    const processing = new Set<string>();
    const done = new Map<string, { lineCount: number }>();
    const failed = new Map<string, QueueStateFailedEntry>();

    for (const row of rows) {
      if (row.status === "queued") {
        queued.add(row.key);
      } else if (row.status === "processing") {
        processing.add(row.key);
      } else if (row.status === "done") {
        done.set(row.key, { lineCount: row.line_count ?? 0 });
      } else if (row.status === "failed") {
        const meta: FailedMeta = {
          retryCount: row.retry_count,
          ...(row.fail_reason !== null ? { reason: row.fail_reason } : {}),
        };
        failed.set(row.key, { meta, mtimeMs: row.updated_at });
      }
    }

    return { queued, processing, done, failed };
  } finally {
    db.close();
  }
}

/** In-memory equivalent of isFailed() using pre-loaded QueueState */
export function isFailedByState(state: QueueState, key: string, retryOpts?: RetryOptions): boolean {
  const entry = state.failed.get(key);
  if (!entry) return false;

  const maxRetries = retryOpts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryAfterMs = retryOpts?.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;

  // Permanent-failed: retryCount >= maxRetries
  if (entry.meta.retryCount >= maxRetries) return true;

  // Check mtime: if old enough, allow retry (return false)
  const elapsed = Date.now() - entry.mtimeMs;
  if (elapsed >= retryAfterMs) return false;

  return true;
}
