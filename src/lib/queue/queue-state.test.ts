import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enqueue,
  markDone,
  markFailed,
  markSkipped,
  loadQueueState,
  isFailedByState,
  isDone,
  isFailed,
  getStatus,
  getDb,
  formatLogKey,
} from "./queue.ts";

// Test UUIDs
const SID1 = "00000000-0000-4000-a000-000000000001";
const SID2 = "00000000-0000-4000-a000-000000000002";
const SID3 = "00000000-0000-4000-a000-000000000003";
const SID4 = "00000000-0000-4000-a000-000000000004";
const SID5 = "00000000-0000-4000-a000-000000000005";

describe("queue state readers", () => {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-state-test-"));
    savedEnv = {
      HOME: process.env.HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = tempDir;
    process.env.XDG_STATE_HOME = join(tempDir, "state");
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("isDone", () => {
    test("returns true when done and lineCount >= currentLineCount", async () => {
      await markDone(SID1, "diary", 100, null);
      expect(await isDone(SID1, "diary", 100)).toBe(true);
      expect(await isDone(SID1, "diary", 50)).toBe(true);
    });

    test("returns false when done but fewer lines than currentLineCount", async () => {
      await markDone(SID1, "diary", 50, null);
      expect(await isDone(SID1, "diary", 100)).toBe(false);
    });

    test("returns false when entry does not exist", async () => {
      expect(await isDone(SID1, "diary", 10)).toBe(false);
    });
  });

  describe("isFailed", () => {
    test("returns false when entry does not exist", async () => {
      expect(await isFailed(SID1, "diary")).toBe(false);
    });

    test("returns true when failed and updated_at is recent", async () => {
      await markFailed(SID1, "diary", undefined);
      expect(await isFailed(SID1, "diary", { retryAfterMs: 1000 })).toBe(true);
    });

    test("returns false when retryable (retryCount < maxRetries, updated_at old)", async () => {
      await markFailed(SID1, "diary", undefined);

      const db = getDb();
      db.run(
        `UPDATE queue_entries SET updated_at = ? WHERE pk =
           (SELECT qe.pk FROM queue_entries qe
              INNER JOIN sessions s ON s.pk = qe.session_pk
            WHERE s.uuid = ?)`,
        [Date.now() - 2000, SID1],
      );
      db.close();

      expect(await isFailed(SID1, "diary", { retryAfterMs: 1000, maxRetries: 3 })).toBe(false);
    });

    test("returns true when retryCount >= maxRetries (permanent-failed)", async () => {
      await markFailed(SID1, "diary", undefined);
      await markFailed(SID1, "diary", undefined);
      await markFailed(SID1, "diary", undefined);

      const db = getDb();
      db.run(
        `UPDATE queue_entries SET updated_at = ? WHERE pk =
           (SELECT qe.pk FROM queue_entries qe
              INNER JOIN sessions s ON s.pk = qe.session_pk
            WHERE s.uuid = ?)`,
        [Date.now() - 100000, SID1],
      );
      db.close();

      expect(await isFailed(SID1, "diary", { retryAfterMs: 1, maxRetries: 3 })).toBe(true);
    });
  });

  describe("getStatus", () => {
    test("returns counts for each status including skipped", async () => {
      await enqueue(SID1, "diary", 10);
      await enqueue(SID2, "diary", 10);
      await markDone(SID3, "diary", 10, null);
      await markFailed(SID4, "diary", undefined);
      await markSkipped(SID5, "diary", "empty", 10);

      const status = await getStatus();
      expect(status.queued).toBe(2);
      expect(status.done).toBe(1);
      expect(status.failed).toBe(1);
      expect(status.skipped).toBe(1);
    });

    test("returns zeros when database is empty", async () => {
      const status = await getStatus();
      expect(status.queued).toBe(0);
      expect(status.done).toBe(0);
      expect(status.failed).toBe(0);
      expect(status.skipped).toBe(0);
    });
  });

  describe("loadQueueState", () => {
    test("returns empty state on empty database", async () => {
      const state = await loadQueueState();
      expect(state.queued.size).toBe(0);
      expect(state.done.size).toBe(0);
      expect(state.failed.size).toBe(0);
      expect(state.skipped.size).toBe(0);
    });

    test("loads mixed state including skipped", async () => {
      await enqueue(SID1, "diary", 10);
      await markDone(SID2, "recipe-a", 75, null);
      await markFailed(SID3, "diary", "timeout");
      await markSkipped(SID4, "diary", "empty", 10);

      const state = await loadQueueState();
      expect(state.queued.has(formatLogKey(SID1, "diary"))).toBe(true);
      expect(state.done.get(formatLogKey(SID2, "recipe-a"))).toEqual({ lineCount: 75 });
      expect(state.failed.get(formatLogKey(SID3, "diary"))!.meta.reason).toBe("timeout");
      expect(state.skipped.get(formatLogKey(SID4, "diary"))!.reason).toBe("empty");
    });
  });

  describe("isFailedByState", () => {
    test("returns false when key is not in failed map", async () => {
      const state = await loadQueueState();
      expect(isFailedByState(state, formatLogKey(SID1, "diary"))).toBe(false);
    });

    test("returns true for recently failed", async () => {
      await markFailed(SID1, "diary", undefined);
      const state = await loadQueueState();
      expect(
        isFailedByState(state, formatLogKey(SID1, "diary"), {
          retryAfterMs: 60000,
          maxRetries: 3,
        }),
      ).toBe(true);
    });
  });
});
