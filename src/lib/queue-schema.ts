import type { Database } from "bun:sqlite";

/**
 * Schema definitions and version-based migrations for queue.db.
 *
 * Public surface from this module is intentionally narrow — `applyMigrations`
 * is the only function called outside (by `queue-internal.getDb()`), and
 * `CURRENT_SCHEMA_VERSION` is exported so it can be referenced in error
 * messages. Everything else is private to this file.
 */

/** Current schema version. Bumped whenever sessions/recipes/queue_entries/history change. */
export const CURRENT_SCHEMA_VERSION = 1;

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

export function applyMigrations(db: Database): void {
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
