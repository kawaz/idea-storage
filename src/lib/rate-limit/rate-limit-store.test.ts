import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordObservation,
  getLatestObservations,
  cleanupOldObservations,
} from "./rate-limit-store.ts";

describe("rate-limit-store", () => {
  let tempDir: string;
  let dbPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rl-store-test-"));
    // DR-0009 Phase 7: rate-limit-store now uses queue-internal getDb()
    // which derives its path from XDG_STATE_HOME.
    savedEnv = {
      HOME: process.env.HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = tempDir;
    process.env.XDG_STATE_HOME = join(tempDir, "state");
    dbPath = join(tempDir, "state", "idea-storage", "queue.db");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("DR-0009 Phase 1 S3: db file permission", () => {
    test("recordObservation 経由で作成された DB は mode 0600 (owner-only)", async () => {
      recordObservation({
        ts: 1776046000,
        fiveHour: null,
        sevenDay: null,
        source: "worker",
      });
      const { statSync } = await import("node:fs");
      const s = statSync(dbPath);
      expect(s.mode & 0o777).toBe(0o600);
    });
  });

  describe("recordObservation", () => {
    test("records a single observation", () => {
      const ts = 1776046000;
      recordObservation({
        ts,
        fiveHour: { util: 0.13, reset: 1776056400, status: "allowed" },
        sevenDay: { util: 0.02, reset: 1776646800, status: "allowed" },
        source: "worker",
      });
      const rows = getLatestObservations(10);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        ts,
        fiveHourUtil: 0.13,
        fiveHourReset: 1776056400,
        fiveHourStatus: "allowed",
        sevenDayUtil: 0.02,
        source: "worker",
      });
    });

    test("records observation with null buckets", () => {
      recordObservation({
        ts: 1776046000,
        fiveHour: { util: 0.5, reset: 1776056400, status: "allowed" },
        sevenDay: null,
        source: "probe",
      });
      const rows = getLatestObservations(10);
      expect(rows.length).toBe(1);
      expect(rows[0]!.sevenDayUtil).toBeNull();
      expect(rows[0]!.sevenDayReset).toBeNull();
      expect(rows[0]!.source).toBe("probe");
    });

    test("duplicate ts is ignored (INSERT OR IGNORE)", () => {
      const ts = 1776046000;
      recordObservation({
        ts,
        fiveHour: { util: 0.1, reset: 1, status: "allowed" },
        sevenDay: null,
        source: "worker",
      });
      recordObservation({
        ts,
        fiveHour: { util: 0.9, reset: 1, status: "allowed" },
        sevenDay: null,
        source: "worker",
      });
      const rows = getLatestObservations(10);
      expect(rows.length).toBe(1);
      expect(rows[0]!.fiveHourUtil).toBe(0.1); // 初回の値が残る
    });
  });

  describe("getLatestObservations", () => {
    test("returns rows ordered by ts DESC, up to limit", () => {
      for (const ts of [100, 200, 300, 400, 500]) {
        recordObservation({
          ts,
          fiveHour: { util: 0.1, reset: 1, status: "allowed" },
          sevenDay: null,
          source: "worker",
        });
      }
      const rows = getLatestObservations(3);
      expect(rows.map((r) => r.ts)).toEqual([500, 400, 300]);
    });

    test("returns empty array when no observations", () => {
      expect(getLatestObservations(10)).toEqual([]);
    });
  });

  describe("cleanupOldObservations", () => {
    test("deletes rows older than 8d", () => {
      const now = 1000000000;
      const eightDaysSec = 8 * 86400;
      // older than 8d
      recordObservation({
        ts: now - eightDaysSec - 10,
        fiveHour: { util: 0.1, reset: 1, status: "allowed" },
        sevenDay: null,
        source: "worker",
      });
      // within 8d but older than 1d
      recordObservation({
        ts: now - 86400 * 2,
        fiveHour: { util: 0.2, reset: 1, status: "allowed" },
        sevenDay: null,
        source: "worker",
      });
      // within 1d
      recordObservation({
        ts: now - 3600,
        fiveHour: { util: 0.3, reset: 1, status: "allowed" },
        sevenDay: null,
        source: "worker",
      });

      cleanupOldObservations(now);

      const rows = getLatestObservations(100);
      expect(rows.map((r) => r.ts).sort()).toEqual([now - 86400 * 2, now - 3600].sort());
    });

    test("aggregates 24h-8d range to 1 sample per hour (keeps newest in each hour bucket)", () => {
      const now = 1000000000;
      // Put 3 samples in the same 1-hour bucket, within 1d-8d range of `now`
      // now - 8d = 999_308_800, now - 1d = 999_913_600
      // Choose a bucket inside this range
      const hourBucket = 277700; // 277700 * 3600 = 999_720_000 (within 1d..8d)
      const base = hourBucket * 3600;
      for (let i = 0; i < 3; i++) {
        recordObservation({
          ts: base + i * 300, // 5 min apart
          fiveHour: { util: 0.1 + i * 0.1, reset: 1, status: "allowed" },
          sevenDay: null,
          source: "worker",
        });
      }

      cleanupOldObservations(now);

      const rows = getLatestObservations(100);
      // Only 1 sample in this hour bucket should remain (the latest = base + 600)
      const inBucket = rows.filter((r) => Math.floor(r.ts / 3600) === hourBucket);
      expect(inBucket.length).toBe(1);
      expect(inBucket[0]!.ts).toBe(base + 600);
    });

    test("preserves all rows within 24h (no aggregation)", () => {
      const now = 1000000000;
      // 5 samples in the past hour
      for (let i = 0; i < 5; i++) {
        recordObservation({
          ts: now - 60 * (i + 1),
          fiveHour: { util: 0.1, reset: 1, status: "allowed" },
          sevenDay: null,
          source: "worker",
        });
      }
      cleanupOldObservations(now);
      const rows = getLatestObservations(100);
      expect(rows.length).toBe(5);
    });
  });
});
