import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb } from "./queue.ts";

const SID1 = "00000000-0000-4000-a000-000000000001";
const SID2 = "00000000-0000-4000-a000-000000000002";
const SID3 = "00000000-0000-4000-a000-000000000003";

describe("schema migration v0 → v1 → v2", () => {
  let tempDir: string;
  let dbPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-migrate-test-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = tempDir;
    process.env.XDG_STATE_HOME = join(tempDir, "state");
    const stateDir = join(tempDir, "state", "idea-storage");
    await mkdir(stateDir, { recursive: true });
    dbPath = join(stateDir, "queue.db");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("migrates legacy v0 data to v1 normalized schema", async () => {
    // Manually create a legacy v0 DB
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(dbPath);
    legacy.run(`CREATE TABLE queue_entries (
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
    legacy.run(`PRAGMA user_version = 0`);
    const now = Date.now();
    legacy.run(
      `INSERT INTO queue_entries
         (key, session_id, recipe_name, status, line_count, retry_count, fail_reason, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', NULL, 0, NULL, ?, ?)`,
      [`${SID1}.diary`, SID1, "diary", now, now],
    );
    legacy.run(
      `INSERT INTO queue_entries
         (key, session_id, recipe_name, status, line_count, retry_count, fail_reason, created_at, updated_at)
       VALUES (?, ?, ?, 'done', 42, 0, NULL, ?, ?)`,
      [`${SID2}.diary`, SID2, "diary", now, now],
    );
    legacy.run(
      `INSERT INTO queue_entries
         (key, session_id, recipe_name, status, line_count, retry_count, fail_reason, created_at, updated_at)
       VALUES (?, ?, ?, 'failed', NULL, 2, 'old error', ?, ?)`,
      [`${SID3}.report`, SID3, "report", now, now],
    );
    legacy.close();

    // Open via getDb → should auto-migrate
    const db = getDb();
    try {
      // Verify user_version bumped
      const v = db.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(2);

      // Verify sessions table populated
      const sessionCount = db.query(`SELECT COUNT(*) as c FROM sessions`).get() as { c: number };
      expect(sessionCount.c).toBe(3);

      // Verify recipes deduplicated (diary appears twice in legacy → 1 in recipes)
      const recipeCount = db.query(`SELECT COUNT(*) as c FROM recipes`).get() as { c: number };
      expect(recipeCount.c).toBe(2); // diary, report

      // Verify queue_entries copied with reason
      const queued = db
        .query(
          `SELECT qe.status, qe.line_count, qe.retry_count, qe.reason, s.uuid, r.name
           FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
           ORDER BY s.uuid`,
        )
        .all() as {
        status: string;
        line_count: number | null;
        retry_count: number;
        reason: string | null;
        uuid: string;
        name: string;
      }[];

      expect(queued).toEqual([
        {
          status: "queued",
          line_count: null,
          retry_count: 0,
          reason: null,
          uuid: SID1,
          name: "diary",
        },
        {
          status: "done",
          line_count: 42,
          retry_count: 0,
          reason: null,
          uuid: SID2,
          name: "diary",
        },
        {
          status: "failed",
          line_count: null,
          retry_count: 2,
          reason: "old error",
          uuid: SID3,
          name: "report",
        },
      ]);

      // Verify legacy `key` column is gone
      const cols = db.query(`PRAGMA table_info(queue_entries)`).all() as { name: string }[];
      expect(cols.some((c) => c.name === "key")).toBe(false);
      expect(cols.some((c) => c.name === "fail_reason")).toBe(false);
      expect(cols.some((c) => c.name === "reason")).toBe(true);
      expect(cols.some((c) => c.name === "session_pk")).toBe(true);
    } finally {
      db.close();
    }
  });

  test("fresh DB starts directly at v2 (= rate_limits 含む)", async () => {
    const db = getDb();
    try {
      const v = db.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(2);

      // Tables exist
      const tables = db
        .query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain("sessions");
      expect(names).toContain("recipes");
      expect(names).toContain("queue_entries");
      expect(names).toContain("history");
      // DR-0009 Phase 2: rate_limits も同 schema 管理者の下に統合
      expect(names).toContain("rate_limits");
    } finally {
      db.close();
    }
  });

  test("DR-0009 Phase 2: v1 → v2 migration で rate_limits テーブルが追加される", async () => {
    // 既存 v1 DB (= legacy initSchema 経由で rate_limits が無い状態) を再現
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(dbPath);
    legacy.run(
      `CREATE TABLE sessions (pk INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE)`,
    );
    legacy.run(
      `CREATE TABLE recipes (pk INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`,
    );
    legacy.run(`CREATE TABLE queue_entries (
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
    legacy.run(`CREATE TABLE history (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_pk INTEGER NOT NULL REFERENCES sessions(pk),
      recipe_pk INTEGER NOT NULL REFERENCES recipes(pk),
      action TEXT NOT NULL,
      message TEXT
    )`);
    legacy.run(`PRAGMA user_version = 1`);
    legacy.close();

    const db = getDb();
    try {
      const v = db.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(2);
      const tables = db
        .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='rate_limits'`)
        .all() as { name: string }[];
      expect(tables.length).toBe(1);
    } finally {
      db.close();
    }
  });

  test("DR-0009 Phase 2: v1 → v2 migration で既存 rate_limits 行は温存される", async () => {
    // legacy initSchema (旧 rate-limit-store) で v1 DB に rate_limits を作って行を入れる
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(dbPath);
    legacy.run(
      `CREATE TABLE sessions (pk INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT NOT NULL UNIQUE)`,
    );
    legacy.run(
      `CREATE TABLE recipes (pk INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)`,
    );
    legacy.run(`CREATE TABLE queue_entries (
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
    legacy.run(`CREATE TABLE history (
      pk INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      session_pk INTEGER NOT NULL REFERENCES sessions(pk),
      recipe_pk INTEGER NOT NULL REFERENCES recipes(pk),
      action TEXT NOT NULL,
      message TEXT
    )`);
    // 旧 rate-limit-store.initSchema 相当 (= user_version 管理外で作られた)
    legacy.run(`CREATE TABLE rate_limits (
      ts INTEGER PRIMARY KEY,
      five_hour_util REAL,
      five_hour_reset INTEGER,
      five_hour_status TEXT,
      seven_day_util REAL,
      seven_day_reset INTEGER,
      seven_day_status TEXT,
      source TEXT NOT NULL
    )`);
    legacy.run(
      `INSERT INTO rate_limits (ts, five_hour_util, five_hour_reset, five_hour_status,
         seven_day_util, seven_day_reset, seven_day_status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [1776046000, 0.5, 1776056400, "allowed", 0.1, 1776646800, "allowed", "worker"],
    );
    legacy.run(`PRAGMA user_version = 1`);
    legacy.close();

    const db = getDb();
    try {
      const rows = db.query(`SELECT * FROM rate_limits WHERE ts = ?`).all(1776046000) as Array<{
        ts: number;
        five_hour_util: number;
        source: string;
      }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.five_hour_util).toBe(0.5);
      expect(rows[0]!.source).toBe("worker");
      const v = db.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(2);
    } finally {
      db.close();
    }
  });

  test("idempotent: running migration on already-migrated DB is a no-op", async () => {
    // First open creates v1 schema
    const db1 = getDb();
    db1.close();

    // Second open: no migration runs (user_version already 2)
    const db2 = getDb();
    try {
      const v = db2.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(2);
    } finally {
      db2.close();
    }
  });

  test("rejects DB with future schema version", async () => {
    // Create fresh, then bump version to a future value
    const db1 = getDb();
    db1.run(`PRAGMA user_version = 99`);
    db1.close();

    expect(() => {
      const db2 = getDb();
      db2.close();
    }).toThrow(/schema version 99 is newer/);
  });
});
