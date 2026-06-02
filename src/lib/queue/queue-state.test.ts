import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { QueueDirs } from "./queue.ts";
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
  let dirs: QueueDirs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-state-test-"));
    dirs = {
      queueDir: join(tempDir, "queue") + "/",
      doneDir: join(tempDir, "done") + "/",
      failedDir: join(tempDir, "failed") + "/",
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("isDone", () => {
    test("returns true when done and lineCount >= currentLineCount", async () => {
      await markDone(SID1, "diary", 100, null, dirs);
      expect(await isDone(SID1, "diary", 100, dirs)).toBe(true);
      expect(await isDone(SID1, "diary", 50, dirs)).toBe(true);
    });

    test("returns false when done but fewer lines than currentLineCount", async () => {
      await markDone(SID1, "diary", 50, null, dirs);
      expect(await isDone(SID1, "diary", 100, dirs)).toBe(false);
    });

    test("returns false when entry does not exist", async () => {
      expect(await isDone(SID1, "diary", 10, dirs)).toBe(false);
    });
  });

  describe("isFailed", () => {
    test("returns false when entry does not exist", async () => {
      expect(await isFailed(SID1, "diary", dirs)).toBe(false);
    });

    test("returns true when failed and updated_at is recent", async () => {
      await markFailed(SID1, "diary", undefined, dirs);
      expect(await isFailed(SID1, "diary", dirs, { retryAfterMs: 1000 })).toBe(true);
    });

    test("returns false when retryable (retryCount < maxRetries, updated_at old)", async () => {
      await markFailed(SID1, "diary", undefined, dirs);

      const db = getDb(dirs);
      db.run(
        `UPDATE queue_entries SET updated_at = ? WHERE pk =
           (SELECT qe.pk FROM queue_entries qe
              INNER JOIN sessions s ON s.pk = qe.session_pk
            WHERE s.uuid = ?)`,
        [Date.now() - 2000, SID1],
      );
      db.close();

      expect(await isFailed(SID1, "diary", dirs, { retryAfterMs: 1000, maxRetries: 3 })).toBe(
        false,
      );
    });

    test("returns true when retryCount >= maxRetries (permanent-failed)", async () => {
      await markFailed(SID1, "diary", undefined, dirs);
      await markFailed(SID1, "diary", undefined, dirs);
      await markFailed(SID1, "diary", undefined, dirs);

      const db = getDb(dirs);
      db.run(
        `UPDATE queue_entries SET updated_at = ? WHERE pk =
           (SELECT qe.pk FROM queue_entries qe
              INNER JOIN sessions s ON s.pk = qe.session_pk
            WHERE s.uuid = ?)`,
        [Date.now() - 100000, SID1],
      );
      db.close();

      expect(await isFailed(SID1, "diary", dirs, { retryAfterMs: 1, maxRetries: 3 })).toBe(true);
    });
  });

  describe("getStatus", () => {
    test("returns counts for each status including skipped", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await enqueue(SID2, "diary", 10, dirs);
      await markDone(SID3, "diary", 10, null, dirs);
      await markFailed(SID4, "diary", undefined, dirs);
      await markSkipped(SID5, "diary", "empty", 10, dirs);

      const status = await getStatus(dirs);
      expect(status.queued).toBe(2);
      expect(status.done).toBe(1);
      expect(status.failed).toBe(1);
      expect(status.skipped).toBe(1);
    });

    test("returns zeros when database is empty", async () => {
      const status = await getStatus(dirs);
      expect(status.queued).toBe(0);
      expect(status.done).toBe(0);
      expect(status.failed).toBe(0);
      expect(status.skipped).toBe(0);
    });
  });

  describe("loadQueueState", () => {
    test("returns empty state on empty database", async () => {
      const state = await loadQueueState(dirs);
      expect(state.queued.size).toBe(0);
      expect(state.done.size).toBe(0);
      expect(state.failed.size).toBe(0);
      expect(state.skipped.size).toBe(0);
    });

    test("loads mixed state including skipped", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await markDone(SID2, "recipe-a", 75, null, dirs);
      await markFailed(SID3, "diary", "timeout", dirs);
      await markSkipped(SID4, "diary", "empty", 10, dirs);

      const state = await loadQueueState(dirs);
      expect(state.queued.has(formatLogKey(SID1, "diary"))).toBe(true);
      expect(state.done.get(formatLogKey(SID2, "recipe-a"))).toEqual({ lineCount: 75 });
      expect(state.failed.get(formatLogKey(SID3, "diary"))!.meta.reason).toBe("timeout");
      expect(state.skipped.get(formatLogKey(SID4, "diary"))!.reason).toBe("empty");
    });
  });

  describe("isFailedByState", () => {
    test("returns false when key is not in failed map", async () => {
      const state = await loadQueueState(dirs);
      expect(isFailedByState(state, formatLogKey(SID1, "diary"))).toBe(false);
    });

    test("returns true for recently failed", async () => {
      await markFailed(SID1, "diary", undefined, dirs);
      const state = await loadQueueState(dirs);
      expect(
        isFailedByState(state, formatLogKey(SID1, "diary"), {
          retryAfterMs: 60000,
          maxRetries: 3,
        }),
      ).toBe(true);
    });
  });
});
