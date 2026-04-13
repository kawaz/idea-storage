import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { getStateDir } from "./paths.ts";
import type { BucketObservation } from "./rate-limit-parser.ts";

export interface RateLimitStoreDirs {
  /** state dir that contains queue.db (e.g., ~/.local/share/idea-storage) */
  stateDir: string;
}

export type ObservationSource = "worker" | "probe";

export interface RecordInput {
  ts: number; // unix epoch seconds
  fiveHour: BucketObservation | null;
  sevenDay: BucketObservation | null;
  source: ObservationSource;
}

export interface ObservationRow {
  ts: number;
  fiveHourUtil: number | null;
  fiveHourReset: number | null;
  fiveHourStatus: string | null;
  sevenDayUtil: number | null;
  sevenDayReset: number | null;
  sevenDayStatus: string | null;
  source: ObservationSource;
}

function resolveDbPath(dirs?: RateLimitStoreDirs): string {
  if (dirs) {
    return join(dirs.stateDir, "queue.db");
  }
  return join(getStateDir(), "queue.db");
}

function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS rate_limits (
    ts INTEGER PRIMARY KEY,
    five_hour_util REAL,
    five_hour_reset INTEGER,
    five_hour_status TEXT,
    seven_day_util REAL,
    seven_day_reset INTEGER,
    seven_day_status TEXT,
    source TEXT NOT NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_rl_ts ON rate_limits(ts DESC)`);
}

function getDb(dirs?: RateLimitStoreDirs): Database {
  const dbPath = resolveDbPath(dirs);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  initSchema(db);
  return db;
}

export function recordObservation(input: RecordInput, dirs?: RateLimitStoreDirs): void {
  const db = getDb(dirs);
  try {
    db.run(
      `INSERT OR IGNORE INTO rate_limits
         (ts, five_hour_util, five_hour_reset, five_hour_status,
          seven_day_util, seven_day_reset, seven_day_status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.ts,
        input.fiveHour?.util ?? null,
        input.fiveHour?.reset ?? null,
        input.fiveHour?.status ?? null,
        input.sevenDay?.util ?? null,
        input.sevenDay?.reset ?? null,
        input.sevenDay?.status ?? null,
        input.source,
      ],
    );
  } finally {
    db.close();
  }
}

export function getLatestObservations(limit: number, dirs?: RateLimitStoreDirs): ObservationRow[] {
  const db = getDb(dirs);
  try {
    const rows = db
      .query(
        `SELECT ts, five_hour_util, five_hour_reset, five_hour_status,
                seven_day_util, seven_day_reset, seven_day_status, source
         FROM rate_limits ORDER BY ts DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      ts: number;
      five_hour_util: number | null;
      five_hour_reset: number | null;
      five_hour_status: string | null;
      seven_day_util: number | null;
      seven_day_reset: number | null;
      seven_day_status: string | null;
      source: string;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      fiveHourUtil: r.five_hour_util,
      fiveHourReset: r.five_hour_reset,
      fiveHourStatus: r.five_hour_status,
      sevenDayUtil: r.seven_day_util,
      sevenDayReset: r.seven_day_reset,
      sevenDayStatus: r.seven_day_status,
      source: r.source as ObservationSource,
    }));
  } finally {
    db.close();
  }
}

/**
 * 2段階保持:
 *   - 8日 (8*86400秒) より古いものは削除
 *   - 24時間〜8日の区間は1時間に1サンプル (各 hour bucket で最新の ts のみ残す) に集約
 *   - 24時間以内は全件保持
 *
 * @param nowSec 現在時刻 (Unix epoch seconds)。テスト時に固定値を渡せる。
 */
export function cleanupOldObservations(nowSec: number, dirs?: RateLimitStoreDirs): void {
  const db = getDb(dirs);
  try {
    const eightDaysAgo = nowSec - 8 * 86400;
    const oneDayAgo = nowSec - 86400;

    const tx = db.transaction(() => {
      // Stage 1: delete rows older than 8d
      db.run(`DELETE FROM rate_limits WHERE ts < ?`, [eightDaysAgo]);

      // Stage 2: in the 1d..8d range, keep only the latest ts per 1-hour bucket
      db.run(
        `DELETE FROM rate_limits
         WHERE ts < ?
           AND ts NOT IN (
             SELECT MAX(ts) FROM rate_limits
             WHERE ts < ?
             GROUP BY ts / 3600
           )`,
        [oneDayAgo, oneDayAgo],
      );
    });
    tx();
  } finally {
    db.close();
  }
}
