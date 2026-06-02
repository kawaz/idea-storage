import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { getStateDir } from "../paths.ts";
import { applyMigrations } from "./queue-schema.ts";

/**
 * DR-0009 Phase 7: queue DB path is derived purely from `getStateDir()`
 * (= XDG_STATE_HOME/idea-storage). Tests override paths via
 * `withIsolatedIdeaStorageEnv`, not by passing per-call directories.
 */

/**
 * Internal helpers shared between the queue write API (queue.ts) and the
 * state-reading API (queue-state.ts). Not part of the public surface — the
 * stable entry point is `queue.ts`, which re-exports the items consumers need.
 *
 * Design rationale: extracted to break a would-be circular import between
 * `queue.ts` and `queue-state.ts`. Both layers need `getDb`, the validators,
 * and the pk lookup helpers; placing them here keeps either file free of
 * sibling dependencies.
 */

export const DEFAULT_RETRY_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface FailedMeta {
  retryCount: number;
  reason?: string;
}

export interface SkippedMeta {
  reason?: string;
}

export interface RetryOptions {
  retryAfterMs?: number;
  maxRetries?: number;
}

export type QueueStatus = "queued" | "processing" | "done" | "failed" | "skipped";

/**
 * History action vocabulary.
 *
 * Mapping to queue_entries.status:
 * - enqueued        → queued
 * - claimed         → processing
 * - completed       → done
 * - failed          → failed
 * - skipped         → skipped
 * - reset           → queued
 * - dispatch_decided → (no status change; emitted from the dispatcher run to
 *                       record the chosen / rejected recipes JSON, see DR-0008 §6)
 */
export type HistoryAction =
  | "enqueued"
  | "claimed"
  | "completed"
  | "failed"
  | "skipped"
  | "reset"
  | "dispatch_decided";

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

/**
 * Build a log-friendly key string for grep-able log lines.
 *
 * Design rationale: queue_entries no longer stores a string `key` column. The
 * `${sessionId}.${recipeName}` format is kept only as a logging convention for
 * grep-ability, not as a data identifier. Validation is the caller's responsibility
 * (this function does not validate to keep logging cheap).
 */
export function formatLogKey(sessionId: string, recipeName: string): string {
  return `${sessionId}.${recipeName}`;
}

function resolveDbPath(): string {
  return join(getStateDir(), "queue.db");
}

export function getDb(): Database {
  const dbPath = resolveDbPath();
  // Newly-created state dirs get owner-only mode. Existing dirs are left
  // untouched per DR-0009 Phase 1 (no retroactive migration).
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  // queue.db is touched on every getDb() call; chmod is idempotent so always
  // enforce owner-only. Multi-user host protection: prevent another local
  // user from reading queue / history / rate_limit observations.
  chmodSync(dbPath, 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  applyMigrations(db);
  // WAL/SHM ファイルも owner-only に。applyMigrations の DDL で write が走り
  // queue.db-wal / queue.db-shm が生成されているのでここで chmod。
  // ファイル不在時 (= 完全 empty 状態) は ENOENT を投げるので ignore (codex review #5)。
  chmodIfExists(`${dbPath}-wal`, 0o600);
  chmodIfExists(`${dbPath}-shm`, 0o600);
  return db;
}

function chmodIfExists(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// --- Internal helpers for pk lookup / creation ---

export function getOrCreateSessionPk(db: Database, sessionId: string): number {
  validateSessionId(sessionId);
  db.run(`INSERT OR IGNORE INTO sessions (uuid) VALUES (?)`, [sessionId]);
  const row = db.query(`SELECT pk FROM sessions WHERE uuid = ?`).get(sessionId) as {
    pk: number;
  };
  return row.pk;
}

export function getOrCreateRecipePk(db: Database, recipeName: string): number {
  validateRecipeName(recipeName);
  db.run(`INSERT OR IGNORE INTO recipes (name) VALUES (?)`, [recipeName]);
  const row = db.query(`SELECT pk FROM recipes WHERE name = ?`).get(recipeName) as {
    pk: number;
  };
  return row.pk;
}

export function lookupSessionPk(db: Database, sessionId: string): number | null {
  const row = db.query(`SELECT pk FROM sessions WHERE uuid = ?`).get(sessionId) as {
    pk: number;
  } | null;
  return row?.pk ?? null;
}

export function lookupRecipePk(db: Database, recipeName: string): number | null {
  const row = db.query(`SELECT pk FROM recipes WHERE name = ?`).get(recipeName) as {
    pk: number;
  } | null;
  return row?.pk ?? null;
}

export function recordHistory(
  db: Database,
  sessionPk: number,
  recipePk: number,
  action: HistoryAction,
  message: string | null,
  timestamp: number,
): void {
  db.run(
    `INSERT INTO history (timestamp, session_pk, recipe_pk, action, message)
     VALUES (?, ?, ?, ?, ?)`,
    [timestamp, sessionPk, recipePk, action, message],
  );
}
