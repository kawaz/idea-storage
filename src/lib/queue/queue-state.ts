import { DEFAULT_MAX_RETRIES } from "../constants.ts";
import {
  DEFAULT_RETRY_AFTER_MS,
  formatLogKey,
  getDb,
  lookupRecipePk,
  lookupSessionPk,
  validateRecipeName,
  validateSessionId,
} from "./queue-internal.ts";
import type {
  FailedMeta,
  QueueDirs,
  QueueStatus,
  RetryOptions,
  SkippedMeta,
} from "./queue-internal.ts";

/**
 * Read-only view of queue state.
 *
 * Functions in this module only SELECT from queue.db; they never mutate.
 * Mutation lives in `queue.ts`.
 */

/** Default poll interval for waitForCompletion (ms). */
export const DEFAULT_WAIT_POLL_INTERVAL_MS = 1000;
/** Default timeout for waitForCompletion (ms). 30 minutes. */
export const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

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
  skipped: Map<string, SkippedMeta>;
}

export type WaitForCompletionResult =
  | { status: "done"; lineCount: number }
  | { status: "failed"; reason: string | null }
  | { status: "skipped"; reason: string | null }
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
 * Poll until the entry transitions to a terminal status (done/failed/skipped),
 * or the timeout expires.
 */
export async function waitForCompletion(
  sessionId: string,
  recipeName: string,
  options: WaitForCompletionOptions = {},
  dirs?: QueueDirs,
): Promise<WaitForCompletionResult> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());

  const start = now();

  while (true) {
    const db = getDb(dirs);
    let row: { status: QueueStatus; line_count: number | null; reason: string | null } | null;
    try {
      const sessionPk = lookupSessionPk(db, sessionId);
      const recipePk = lookupRecipePk(db, recipeName);
      if (sessionPk === null || recipePk === null) {
        row = null;
      } else {
        row = db
          .query(
            `SELECT status, line_count, reason FROM queue_entries
             WHERE session_pk = ? AND recipe_pk = ?`,
          )
          .get(sessionPk, recipePk) as {
          status: QueueStatus;
          line_count: number | null;
          reason: string | null;
        } | null;
      }
    } finally {
      db.close();
    }

    if (row) {
      if (row.status === "done") {
        return { status: "done", lineCount: row.line_count ?? 0 };
      }
      if (row.status === "failed") {
        return { status: "failed", reason: row.reason };
      }
      if (row.status === "skipped") {
        return { status: "skipped", reason: row.reason };
      }
    }

    if (now() - start >= timeoutMs) {
      return { status: "timeout" };
    }

    await sleep(pollIntervalMs);
  }
}

export async function getDoneLineCount(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<number | null> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const db = getDb(dirs);
  try {
    const sessionPk = lookupSessionPk(db, sessionId);
    const recipePk = lookupRecipePk(db, recipeName);
    if (sessionPk === null || recipePk === null) return null;
    const row = db
      .query(
        `SELECT line_count FROM queue_entries
         WHERE session_pk = ? AND recipe_pk = ? AND status = 'done'`,
      )
      .get(sessionPk, recipePk) as { line_count: number | null } | null;

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
  const lineCount = await getDoneLineCount(sessionId, recipeName, dirs);
  if (lineCount === null) return false;
  return lineCount >= currentLineCount;
}

export async function isQueued(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<boolean> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const db = getDb(dirs);
  try {
    const sessionPk = lookupSessionPk(db, sessionId);
    const recipePk = lookupRecipePk(db, recipeName);
    if (sessionPk === null || recipePk === null) return false;
    const row = db
      .query(
        `SELECT 1 FROM queue_entries
         WHERE session_pk = ? AND recipe_pk = ? AND status = 'queued'`,
      )
      .get(sessionPk, recipePk);
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
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const db = getDb(dirs);
  try {
    const sessionPk = lookupSessionPk(db, sessionId);
    const recipePk = lookupRecipePk(db, recipeName);
    if (sessionPk === null || recipePk === null) return false;
    const row = db
      .query(
        `SELECT retry_count, updated_at FROM queue_entries
         WHERE session_pk = ? AND recipe_pk = ? AND status = 'failed'`,
      )
      .get(sessionPk, recipePk) as { retry_count: number; updated_at: number } | null;

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

export async function getStatus(dirs?: QueueDirs): Promise<{
  queued: number;
  processing: number;
  done: number;
  failed: number;
  skipped: number;
}> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(`SELECT status, COUNT(*) as count FROM queue_entries GROUP BY status`)
      .all() as { status: string; count: number }[];

    const result = { queued: 0, processing: 0, done: 0, failed: 0, skipped: 0 };
    for (const row of rows) {
      if (row.status === "queued") result.queued = row.count;
      else if (row.status === "processing") result.processing = row.count;
      else if (row.status === "done") result.done = row.count;
      else if (row.status === "failed") result.failed = row.count;
      else if (row.status === "skipped") result.skipped = row.count;
    }
    return result;
  } finally {
    db.close();
  }
}

/**
 * DR-0008 §11: skipped breakdown by reason.
 *
 * Categories follow DR-0008 conventions (PR②/PR③/PR④):
 * - no_effective_turn   — Phase 1 filter (PR②)
 * - dispatcher_rejected — Phase 2 dispatcher rejection (PR③)
 * - quality_rejected    — Phase 3 quality gate rejection (PR④)
 * - other               — earlier skipped reasons (empty_session, already_processed, ...)
 *
 * Returns absolute counts across all-time skipped entries. A bounded
 * 30-day window can be layered later by adding a `sinceTs` filter.
 */
export async function getSkippedBreakdown(dirs?: QueueDirs): Promise<{
  no_effective_turn: number;
  dispatcher_rejected: number;
  quality_rejected: number;
  other: number;
}> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(
        `SELECT reason, COUNT(*) as count
           FROM queue_entries
           WHERE status = 'skipped'
           GROUP BY reason`,
      )
      .all() as { reason: string | null; count: number }[];

    const result = {
      no_effective_turn: 0,
      dispatcher_rejected: 0,
      quality_rejected: 0,
      other: 0,
    };
    for (const row of rows) {
      switch (row.reason) {
        case "no_effective_turn":
          result.no_effective_turn = row.count;
          break;
        case "dispatcher_rejected":
          result.dispatcher_rejected = row.count;
          break;
        case "quality_rejected":
          result.quality_rejected = row.count;
          break;
        default:
          result.other += row.count;
      }
    }
    return result;
  } finally {
    db.close();
  }
}

export async function loadQueueState(dirs?: QueueDirs): Promise<QueueState> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(
        `SELECT s.uuid AS session_id, r.name AS recipe_name,
                qe.status, qe.line_count, qe.retry_count, qe.reason, qe.updated_at
         FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
           INNER JOIN recipes r ON r.pk = qe.recipe_pk`,
      )
      .all() as {
      session_id: string;
      recipe_name: string;
      status: string;
      line_count: number | null;
      retry_count: number;
      reason: string | null;
      updated_at: number;
    }[];

    const queued = new Set<string>();
    const processing = new Set<string>();
    const done = new Map<string, { lineCount: number }>();
    const failed = new Map<string, QueueStateFailedEntry>();
    const skipped = new Map<string, SkippedMeta>();

    for (const row of rows) {
      const key = formatLogKey(row.session_id, row.recipe_name);
      if (row.status === "queued") {
        queued.add(key);
      } else if (row.status === "processing") {
        processing.add(key);
      } else if (row.status === "done") {
        done.set(key, { lineCount: row.line_count ?? 0 });
      } else if (row.status === "failed") {
        const meta: FailedMeta = {
          retryCount: row.retry_count,
          ...(row.reason !== null ? { reason: row.reason } : {}),
        };
        failed.set(key, { meta, mtimeMs: row.updated_at });
      } else if (row.status === "skipped") {
        const meta: SkippedMeta = row.reason !== null ? { reason: row.reason } : {};
        skipped.set(key, meta);
      }
    }

    return { queued, processing, done, failed, skipped };
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
