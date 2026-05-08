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

/** Current schema version. Bumped whenever sessions/recipes/queue_entries/history change. */
export const CURRENT_SCHEMA_VERSION = 1;

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
  skipped: Map<string, SkippedMeta>;
}

export type QueueStatus = "queued" | "processing" | "done" | "failed" | "skipped";

/**
 * History action vocabulary.
 *
 * Mapping to queue_entries.status:
 * - enqueued  → queued
 * - claimed   → processing
 * - completed → done
 * - failed    → failed
 * - skipped   → skipped
 * - reset     → queued
 */
export type HistoryAction = "enqueued" | "claimed" | "completed" | "failed" | "skipped" | "reset";

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

function resolveDbPath(dirs?: QueueDirs): string {
  if (dirs) {
    // dirs.queueDir may have a trailing slash; strip it, then go to parent
    const parent = dirname(dirs.queueDir.replace(/\/$/, ""));
    return join(parent, "queue.db");
  }
  return join(getStateDir(), "queue.db");
}

function createSchemaV1(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(uuid)`);

  db.run(`CREATE TABLE IF NOT EXISTS recipes (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name)`);

  db.run(`CREATE TABLE IF NOT EXISTS queue_entries (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    session_pk INTEGER NOT NULL REFERENCES sessions(pk),
    recipe_pk INTEGER NOT NULL REFERENCES recipes(pk),
    status TEXT NOT NULL DEFAULT 'queued',
    reason TEXT,
    line_count INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_pk, recipe_pk)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_entries(status)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_queue_status_updated ON queue_entries(status, updated_at)`,
  );

  db.run(`CREATE TABLE IF NOT EXISTS history (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    session_pk INTEGER NOT NULL REFERENCES sessions(pk),
    recipe_pk INTEGER NOT NULL REFERENCES recipes(pk),
    action TEXT NOT NULL,
    message TEXT
  )`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_history_session_recipe ON history(session_pk, recipe_pk, timestamp)`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_action ON history(action, timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp)`);
}

/**
 * Migrate the legacy v0 single-table schema (key TEXT PRIMARY KEY, fail_reason)
 * to the v1 normalized schema (sessions/recipes/queue_entries/history).
 *
 * Caller must ensure this is invoked inside a transaction.
 */
function migrateV0ToV1(db: Database): void {
  // 1. Create v1 tables alongside legacy queue_entries.
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(uuid)`);

  db.run(`CREATE TABLE IF NOT EXISTS recipes (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_recipes_name ON recipes(name)`);

  db.run(`CREATE TABLE queue_entries_v1 (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    session_pk INTEGER NOT NULL REFERENCES sessions(pk),
    recipe_pk INTEGER NOT NULL REFERENCES recipes(pk),
    status TEXT NOT NULL DEFAULT 'queued',
    reason TEXT,
    line_count INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_pk, recipe_pk)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS history (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    session_pk INTEGER NOT NULL REFERENCES sessions(pk),
    recipe_pk INTEGER NOT NULL REFERENCES recipes(pk),
    action TEXT NOT NULL,
    message TEXT
  )`);

  // 2. Copy data from legacy queue_entries.
  const legacyRows = db
    .query(
      `SELECT key, session_id, recipe_name, status, line_count, retry_count, fail_reason,
              created_at, updated_at
       FROM queue_entries`,
    )
    .all() as {
    key: string;
    session_id: string;
    recipe_name: string;
    status: string;
    line_count: number | null;
    retry_count: number;
    fail_reason: string | null;
    created_at: number;
    updated_at: number;
  }[];

  const insertSession = db.prepare(`INSERT OR IGNORE INTO sessions (uuid) VALUES (?)`);
  const selectSessionPk = db.prepare(`SELECT pk FROM sessions WHERE uuid = ?`);
  const insertRecipe = db.prepare(`INSERT OR IGNORE INTO recipes (name) VALUES (?)`);
  const selectRecipePk = db.prepare(`SELECT pk FROM recipes WHERE name = ?`);
  const insertEntry = db.prepare(
    `INSERT INTO queue_entries_v1
       (session_pk, recipe_pk, status, reason, line_count, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of legacyRows) {
    insertSession.run(row.session_id);
    const sessionPk = (selectSessionPk.get(row.session_id) as { pk: number }).pk;
    insertRecipe.run(row.recipe_name);
    const recipePk = (selectRecipePk.get(row.recipe_name) as { pk: number }).pk;

    insertEntry.run(
      sessionPk,
      recipePk,
      row.status,
      row.fail_reason,
      row.line_count,
      row.retry_count,
      row.created_at,
      row.updated_at,
    );
  }

  // 3. Drop legacy and rename v1 → queue_entries.
  db.run(`DROP TABLE queue_entries`);
  db.run(`ALTER TABLE queue_entries_v1 RENAME TO queue_entries`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_entries(status)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_queue_status_updated ON queue_entries(status, updated_at)`,
  );

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_history_session_recipe ON history(session_pk, recipe_pk, timestamp)`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_action ON history(action, timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp)`);
}

/**
 * Detect whether a legacy v0 queue_entries table exists in the DB.
 * v0 table has `key` column as PRIMARY KEY; v1 doesn't.
 */
function hasLegacyV0Schema(db: Database): boolean {
  const row = db
    .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='queue_entries'`)
    .get() as { name: string } | null;
  if (!row) return false;
  // Probe for legacy `key` column.
  const cols = db.query(`PRAGMA table_info(queue_entries)`).all() as { name: string }[];
  return cols.some((c) => c.name === "key");
}

function applyMigrations(db: Database): void {
  const versionRow = db.query(`PRAGMA user_version`).get() as { user_version: number };
  let version = versionRow.user_version;

  if (version === 0) {
    // Either a fresh DB (no tables) or a legacy v0 DB. Distinguish by probing.
    if (hasLegacyV0Schema(db)) {
      const tx = db.transaction(() => {
        migrateV0ToV1(db);
      });
      tx();
    } else {
      // Fresh DB — create v1 schema directly.
      const tx = db.transaction(() => {
        createSchemaV1(db);
      });
      tx();
    }
    db.run(`PRAGMA user_version = 1`);
    version = 1;
  }

  // Future: if (version === 1) migrate to v2, etc.
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `queue.db schema version ${version} is newer than supported ${CURRENT_SCHEMA_VERSION}. ` +
        `Please update idea-storage.`,
    );
  }
}

export function getDb(dirs?: QueueDirs): Database {
  const dbPath = resolveDbPath(dirs);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  applyMigrations(db);
  return db;
}

// --- Internal helpers for pk lookup / creation ---

function getOrCreateSessionPk(db: Database, sessionId: string): number {
  validateSessionId(sessionId);
  db.run(`INSERT OR IGNORE INTO sessions (uuid) VALUES (?)`, [sessionId]);
  const row = db.query(`SELECT pk FROM sessions WHERE uuid = ?`).get(sessionId) as {
    pk: number;
  };
  return row.pk;
}

function getOrCreateRecipePk(db: Database, recipeName: string): number {
  validateRecipeName(recipeName);
  db.run(`INSERT OR IGNORE INTO recipes (name) VALUES (?)`, [recipeName]);
  const row = db.query(`SELECT pk FROM recipes WHERE name = ?`).get(recipeName) as {
    pk: number;
  };
  return row.pk;
}

function lookupSessionPk(db: Database, sessionId: string): number | null {
  const row = db.query(`SELECT pk FROM sessions WHERE uuid = ?`).get(sessionId) as {
    pk: number;
  } | null;
  return row?.pk ?? null;
}

function lookupRecipePk(db: Database, recipeName: string): number | null {
  const row = db.query(`SELECT pk FROM recipes WHERE name = ?`).get(recipeName) as {
    pk: number;
  } | null;
  return row?.pk ?? null;
}

function recordHistory(
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

// --- Queue API (all functions take sessionId/recipeName, no string keys) ---

/**
 * 複数のエントリを1トランザクションで一括 enqueue する。
 * 既に存在する (session_pk, recipe_pk) は無視（INSERT OR IGNORE）。
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
  for (const { sessionId, recipeName } of entries) {
    validateSessionId(sessionId);
    validateRecipeName(recipeName);
  }
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const tx = db.transaction(() => {
      for (const { sessionId, recipeName } of entries) {
        const sessionPk = getOrCreateSessionPk(db, sessionId);
        const recipePk = getOrCreateRecipePk(db, recipeName);
        const result = db.run(
          `INSERT OR IGNORE INTO queue_entries
             (session_pk, recipe_pk, status, created_at, updated_at)
           VALUES (?, ?, 'queued', ?, ?)`,
          [sessionPk, recipePk, now, now],
        );
        if (result.changes > 0) {
          recordHistory(db, sessionPk, recipePk, "enqueued", null, now);
        }
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
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);
      const result = db.run(
        `INSERT OR IGNORE INTO queue_entries
           (session_pk, recipe_pk, status, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?)`,
        [sessionPk, recipePk, now, now],
      );
      if (result.changes > 0) {
        recordHistory(db, sessionPk, recipePk, "enqueued", null, now);
      }
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Dequeue the newest queued entry by transitioning it from 'queued' to 'processing'.
 *
 * Design rationale: 以前は SELECT → DELETE していたが、processing 状態を残すことで
 * 同一 (session, recipe) を別プロセス（worker, convert, または並行 worker）が
 * 二重処理しないよう排他制御できる。エントリは処理完了時に
 * markDone/markFailed/markSkipped で遷移する。
 *
 * UPDATE には WHERE status='queued' ガードを入れ、レース時に他プロセスが先行していたら
 * 0行更新となり null を返す（呼び出し側は empty 扱い）。
 *
 * dequeue 順は新しいもの優先（updated_at DESC）。これは ユーザの意向に基づく設計判断:
 * 新規 enqueue 分を先に処理することで、最新のセッションがすぐに処理される利点がある。
 */
export async function dequeue(dirs?: QueueDirs): Promise<QueueEntry | null> {
  const db = getDb(dirs);
  try {
    const now = Date.now();
    let claimed: QueueEntry | null = null;
    const tx = db.transaction(() => {
      const row = db
        .query(
          `SELECT qe.pk, s.uuid AS session_id, r.name AS recipe_name,
                  qe.session_pk, qe.recipe_pk
           FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
           WHERE qe.status = 'queued'
           ORDER BY qe.updated_at DESC
           LIMIT 1`,
        )
        .get() as {
        pk: number;
        session_id: string;
        recipe_name: string;
        session_pk: number;
        recipe_pk: number;
      } | null;

      if (!row) return;

      // Defensive UPDATE with status guard: if another tx already moved it
      // out of 'queued', changes will be 0 and we skip the claim.
      const result = db.run(
        `UPDATE queue_entries SET status = 'processing', updated_at = ?
         WHERE pk = ? AND status = 'queued'`,
        [now, row.pk],
      );
      if (result.changes === 0) return;

      recordHistory(db, row.session_pk, row.recipe_pk, "claimed", "prevStatus: queued", now);

      claimed = {
        sessionId: row.session_id,
        recipeName: row.recipe_name,
        key: formatLogKey(row.session_id, row.recipe_name),
      };
    });
    tx();
    return claimed;
  } finally {
    db.close();
  }
}

export interface ClaimResult {
  /** True if this caller successfully claimed processing ownership. */
  claimed: boolean;
  /** Status before the claim (null if entry did not exist). */
  prevStatus: QueueStatus | null;
}

/**
 * Atomically claim a (session, recipe) pair for processing.
 *
 * - Entry absent → INSERT with status='processing'. Returns claimed=true, prevStatus=null.
 * - Entry queued / done / failed / skipped → UPDATE to status='processing'.
 *   Returns claimed=true, prevStatus=<old>.
 * - Entry already 'processing' → no change. Returns claimed=false, prevStatus='processing'.
 *
 * 重複処理の排他制御を提供する。Convert コマンドは claim に成功した場合に処理を実行し、
 * 失敗した場合は waitForCompletion で他プロセスの完了を待つ。
 *
 * UPDATE には WHERE status=<expected> ガードを入れ、レース時に他プロセスが先に
 * processing 化していたら 0行更新で claim 失敗と扱う。
 */
export async function claim(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<ClaimResult> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    let result: ClaimResult = { claimed: false, prevStatus: null };
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);

      const row = db
        .query(`SELECT status FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
        .get(sessionPk, recipePk) as { status: QueueStatus } | null;

      if (!row) {
        // Entry absent: INSERT with status='processing'. UNIQUE(session_pk,recipe_pk)
        // guarantees no duplicate. Use INSERT OR IGNORE to be safe against races.
        const ins = db.run(
          `INSERT OR IGNORE INTO queue_entries
             (session_pk, recipe_pk, status, created_at, updated_at)
           VALUES (?, ?, 'processing', ?, ?)`,
          [sessionPk, recipePk, now, now],
        );
        if (ins.changes === 0) {
          // Race: another tx inserted between our SELECT and INSERT. Re-fetch.
          const r2 = db
            .query(`SELECT status FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
            .get(sessionPk, recipePk) as { status: QueueStatus } | null;
          result = { claimed: false, prevStatus: r2?.status ?? null };
          return;
        }
        recordHistory(db, sessionPk, recipePk, "claimed", "prevStatus: absent", now);
        result = { claimed: true, prevStatus: null };
        return;
      }

      if (row.status === "processing") {
        result = { claimed: false, prevStatus: "processing" };
        return;
      }

      // Defensive UPDATE: only succeed if status is still what we observed.
      const upd = db.run(
        `UPDATE queue_entries SET status = 'processing', updated_at = ?
         WHERE session_pk = ? AND recipe_pk = ? AND status = ?`,
        [now, sessionPk, recipePk, row.status],
      );
      if (upd.changes === 0) {
        // Race: status changed between SELECT and UPDATE. Treat as claim failure.
        const r2 = db
          .query(`SELECT status FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
          .get(sessionPk, recipePk) as { status: QueueStatus } | null;
        result = { claimed: false, prevStatus: r2?.status ?? null };
        return;
      }
      recordHistory(db, sessionPk, recipePk, "claimed", `prevStatus: ${row.status}`, now);
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

/**
 * Mark an entry as done. Idempotent: existing entries are upserted.
 *
 * @param outputFile path to the produced output file (recorded in history.message).
 *                   Pass `null` if no file was produced (e.g. internal mark).
 */
export async function markDone(
  sessionId: string,
  recipeName: string,
  lineCount: number,
  outputFile: string | null,
  dirs?: QueueDirs,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);
      db.run(
        `INSERT INTO queue_entries
           (session_pk, recipe_pk, status, line_count, reason, created_at, updated_at)
         VALUES (?, ?, 'done', ?, NULL, ?, ?)
         ON CONFLICT(session_pk, recipe_pk) DO UPDATE SET
           status = 'done',
           line_count = excluded.line_count,
           reason = NULL,
           updated_at = excluded.updated_at`,
        [sessionPk, recipePk, lineCount, now, now],
      );
      recordHistory(db, sessionPk, recipePk, "completed", outputFile, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Mark an entry as failed. Increments retry_count.
 * If the entry does not exist, it is created with retry_count=1.
 */
export async function markFailed(
  sessionId: string,
  recipeName: string,
  reason: string | undefined,
  dirs?: QueueDirs,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);

      const existing = db
        .query(`SELECT retry_count FROM queue_entries WHERE session_pk = ? AND recipe_pk = ?`)
        .get(sessionPk, recipePk) as { retry_count: number } | null;
      const retryCount = (existing?.retry_count ?? 0) + 1;

      db.run(
        `INSERT INTO queue_entries
           (session_pk, recipe_pk, status, retry_count, reason, created_at, updated_at)
         VALUES (?, ?, 'failed', ?, ?, ?, ?)
         ON CONFLICT(session_pk, recipe_pk) DO UPDATE SET
           status = 'failed',
           retry_count = excluded.retry_count,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
        [sessionPk, recipePk, retryCount, reason ?? null, now, now],
      );
      recordHistory(db, sessionPk, recipePk, "failed", reason ?? null, now);
    });
    tx();
  } finally {
    db.close();
  }
}

/**
 * Mark an entry as skipped (deliberately not processed; not an error).
 *
 * Design rationale: skipped is a normal terminal state (e.g. empty session,
 * already processed). retry_count is NOT incremented because skipped is not
 * a failure that needs retry-after backoff.
 *
 * Reason prefix conventions used by callers:
 *   empty_session, no_user_turns, no_conversation,
 *   fork_no_new_conversation, already_processed
 */
export async function markSkipped(
  sessionId: string,
  recipeName: string,
  reason: string | undefined,
  dirs?: QueueDirs,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const tx = db.transaction(() => {
      const sessionPk = getOrCreateSessionPk(db, sessionId);
      const recipePk = getOrCreateRecipePk(db, recipeName);
      db.run(
        `INSERT INTO queue_entries
           (session_pk, recipe_pk, status, reason, created_at, updated_at)
         VALUES (?, ?, 'skipped', ?, ?, ?)
         ON CONFLICT(session_pk, recipe_pk) DO UPDATE SET
           status = 'skipped',
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
        [sessionPk, recipePk, reason ?? null, now, now],
      );
      recordHistory(db, sessionPk, recipePk, "skipped", reason ?? null, now);
    });
    tx();
  } finally {
    db.close();
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

/**
 * Reset an entry (failed or skipped) back to queued so it can be retried.
 * Only entries currently in failed/skipped status are moved; any other status is a no-op.
 */
export async function retry(
  sessionId: string,
  recipeName: string,
  dirs?: QueueDirs,
): Promise<void> {
  validateSessionId(sessionId);
  validateRecipeName(recipeName);
  const now = Date.now();
  const db = getDb(dirs);
  try {
    const tx = db.transaction(() => {
      const sessionPk = lookupSessionPk(db, sessionId);
      const recipePk = lookupRecipePk(db, recipeName);
      if (sessionPk === null || recipePk === null) return;
      const result = db.run(
        `UPDATE queue_entries SET status = 'queued', updated_at = ?
         WHERE session_pk = ? AND recipe_pk = ? AND status IN ('failed', 'skipped')`,
        [now, sessionPk, recipePk],
      );
      if (result.changes > 0) {
        recordHistory(db, sessionPk, recipePk, "reset", null, now);
      }
    });
    tx();
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
 * Remove failed entries whose underlying session file no longer exists.
 *
 * Note: skipped/done entries are intentionally NOT cleaned up here — they form
 * the historical record of which sessions have been considered.
 */
export async function cleanup(
  isSessionExists: (sid: string) => Promise<boolean>,
  dirs?: QueueDirs,
): Promise<number> {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(
        `SELECT qe.pk, s.uuid AS session_id
         FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
         WHERE qe.status = 'failed'`,
      )
      .all() as { pk: number; session_id: string }[];

    let removed = 0;
    for (const row of rows) {
      const exists = await isSessionExists(row.session_id);
      if (!exists) {
        db.run(`DELETE FROM queue_entries WHERE pk = ?`, [row.pk]);
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
