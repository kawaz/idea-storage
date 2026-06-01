import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { QueueDirs } from "./queue.ts";
import {
  enqueue,
  enqueueBatch,
  dequeue,
  markDone,
  markFailed,
  markSkipped,
  isDone,
  isQueued,
  isFailed,
  retry,
  getStatus,
  cleanup,
  validateSessionId,
  validateRecipeName,
  loadQueueState,
  isFailedByState,
  getDb,
  claim,
  waitForCompletion,
  formatLogKey,
} from "./queue.ts";

// Test UUIDs
const SID1 = "00000000-0000-4000-a000-000000000001";
const SID2 = "00000000-0000-4000-a000-000000000002";
const SID3 = "00000000-0000-4000-a000-000000000003";
const SID4 = "00000000-0000-4000-a000-000000000004";
const SID5 = "00000000-0000-4000-a000-000000000005";
const SID_ABC = "00000000-0000-4000-a000-00000000abc0";

describe("queue", () => {
  let dirs: QueueDirs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-test-"));
    dirs = {
      queueDir: join(tempDir, "queue") + "/",
      doneDir: join(tempDir, "done") + "/",
      failedDir: join(tempDir, "failed") + "/",
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("DR-0009 Phase 1 S3: db file permission", () => {
    test("getDb で作成された queue.db は mode 0600 (owner-only)", async () => {
      const db = getDb(dirs);
      db.close();
      const { statSync } = await import("node:fs");
      const dbPath = join(tempDir, "queue.db");
      const s = statSync(dbPath);
      expect(s.mode & 0o777).toBe(0o600);
    });
  });

  describe("enqueue", () => {
    test("creates a queued entry", async () => {
      await enqueue(SID_ABC, "diary", 10, dirs);
      expect(await isQueued(SID_ABC, "diary", dirs)).toBe(true);
    });

    test("does not duplicate an existing queued entry", async () => {
      await enqueue(SID_ABC, "diary", 10, dirs);
      await enqueue(SID_ABC, "diary", 10, dirs); // same lineCount → no-op
      const status = await getStatus(dirs);
      expect(status.queued).toBe(1);
    });

    test("records history with action='enqueued' on first insert only", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await enqueue(SID1, "diary", 10, dirs); // duplicate

      const db = getDb(dirs);
      const rows = db
        .query(
          `SELECT h.action FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? ORDER BY h.timestamp`,
        )
        .all(SID1) as { action: string }[];
      db.close();
      expect(rows.map((r) => r.action)).toEqual(["enqueued"]);
    });
  });

  describe("enqueueBatch", () => {
    test("複数エントリを一括で enqueue する", async () => {
      enqueueBatch(
        [
          { sessionId: SID1, recipeName: "diary", lineCount: 5 },
          { sessionId: SID2, recipeName: "report", lineCount: 7 },
        ],
        dirs,
      );

      expect(await isQueued(SID1, "diary", dirs)).toBe(true);
      expect(await isQueued(SID2, "report", dirs)).toBe(true);
    });

    test("空配列でもエラーにならない", async () => {
      enqueueBatch([], dirs);
      const status = await getStatus(dirs);
      expect(status.queued).toBe(0);
    });

    test("既に queued の同一キーは触らない", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      enqueueBatch(
        [
          { sessionId: SID1, recipeName: "diary", lineCount: 10 }, // duplicate
          { sessionId: SID2, recipeName: "report", lineCount: 7 },
        ],
        dirs,
      );

      const status = await getStatus(dirs);
      expect(status.queued).toBe(2);
    });

    test("無効な sessionId でバリデーションエラー", () => {
      expect(() =>
        enqueueBatch([{ sessionId: "invalid", recipeName: "diary", lineCount: 1 }], dirs),
      ).toThrow(/Invalid sessionId/);
    });

    test("無効な recipeName でバリデーションエラー", () => {
      expect(() =>
        enqueueBatch([{ sessionId: SID1, recipeName: "../bad", lineCount: 1 }], dirs),
      ).toThrow(/Invalid recipeName/);
    });

    test("バリデーションエラー時はどのエントリも挿入されない", async () => {
      try {
        enqueueBatch(
          [
            { sessionId: SID1, recipeName: "diary", lineCount: 1 },
            { sessionId: "invalid", recipeName: "diary", lineCount: 1 },
          ],
          dirs,
        );
      } catch {
        /* expected */
      }
      const status = await getStatus(dirs);
      expect(status.queued).toBe(0);
    });
  });

  // Helper to assert queue_entries row state (status / reason / line_count).
  function readEntry(
    sid: string,
    name: string,
  ): { status: string; reason: string | null; line_count: number | null } | null {
    const db = getDb(dirs);
    try {
      const row = db
        .query(
          `SELECT qe.status, qe.reason, qe.line_count
             FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
             WHERE s.uuid = ? AND r.name = ?`,
        )
        .get(sid, name) as {
        status: string;
        reason: string | null;
        line_count: number | null;
      } | null;
      return row;
    } finally {
      db.close();
    }
  }

  describe("enqueueBatch transitions (DR-0008 §5.1)", () => {
    // §5.1: 既存 status と line_count を見て、再 enqueue の可否を分岐させる。
    // 表の各セルを 1 テストで網羅する。

    test("行なし: 新規 queued を line_count 付きで作る", async () => {
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 12 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(12);
      expect(row?.reason).toBeNull();
    });

    test("queued: 触らない (no-op)", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      // 既に queued の場合は line_count を更新しない (既存 queued を保持)
      expect(row?.line_count).toBe(10);
    });

    test("processing: 触らない", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await claim(SID1, "diary", dirs); // queued → processing
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("processing");
    });

    test("done, new > old: queued に再遷移して line_count 更新", async () => {
      await markDone(SID1, "diary", 10, null, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(20);
      expect(row?.reason).toBeNull();
    });

    test("done, new == old: 触らない", async () => {
      await markDone(SID1, "diary", 10, null, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("done");
      expect(row?.line_count).toBe(10);
    });

    test("done, new < old: 触らない (退行防止)", async () => {
      await markDone(SID1, "diary", 100, null, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("done");
      expect(row?.line_count).toBe(100);
    });

    test("failed: 触らない (既存 retry 機構が別途処理)", async () => {
      await markFailed(SID1, "diary", "boom", dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("failed");
    });

    test("skipped(no_effective_turn), new > old: queued に再遷移", async () => {
      await markSkipped(SID1, "diary", "no_effective_turn", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 25 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(25);
      expect(row?.reason).toBeNull();
    });

    test("skipped(no_effective_turn), new == old: 触らない", async () => {
      await markSkipped(SID1, "diary", "no_effective_turn", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
      expect(row?.reason).toBe("no_effective_turn");
      expect(row?.line_count).toBe(10);
    });

    test("skipped(quality_rejected): 触らない (PR③ 専用、自動復帰しない)", async () => {
      await markSkipped(SID1, "diary", "quality_rejected", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 100 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
      expect(row?.reason).toBe("quality_rejected");
      expect(row?.line_count).toBe(10);
    });

    test("skipped(dispatcher_rejected), new > old: queued に再遷移 (Phase 2 で復帰対象)", async () => {
      // PR③ (Phase 2): dispatcher 導入に伴い dispatcher_rejected は
      // REENQUEUABLE_SKIPPED_REASONS に追加。追記でセッションの性質が変わった
      // 可能性があるので再 dispatch のために queued に戻す。
      await markSkipped(SID1, "diary", "dispatcher_rejected", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 100 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(100);
      expect(row?.reason).toBeNull();
    });

    test("skipped(dispatcher_rejected), new == old: 触らない", async () => {
      await markSkipped(SID1, "diary", "dispatcher_rejected", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
      expect(row?.reason).toBe("dispatcher_rejected");
    });

    test("skipped(unknown reason): 触らない (デフォルト保守)", async () => {
      await markSkipped(SID1, "diary", "something_else", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 100 }], dirs);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
    });

    test("skipped → queued 復帰時は history に reset が記録される", async () => {
      await markSkipped(SID1, "diary", "no_effective_turn", 10, dirs);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 25 }], dirs);

      const db = getDb(dirs);
      const actions = (
        db
          .query(
            `SELECT h.action FROM history h
               INNER JOIN sessions s ON s.pk = h.session_pk
             WHERE s.uuid = ? ORDER BY h.timestamp`,
          )
          .all(SID1) as { action: string }[]
      ).map((r) => r.action);
      db.close();
      // markSkipped → reset (skipped から queued への復帰)
      expect(actions).toEqual(["skipped", "reset"]);
    });
  });

  describe("dequeue", () => {
    /** Helper to set updated_at via uuid+name (joins sessions/recipes/queue_entries) */
    function setUpdatedAt(sid: string, name: string, ts: number): void {
      const db = getDb(dirs);
      db.run(
        `UPDATE queue_entries SET updated_at = ? WHERE pk =
           (SELECT qe.pk FROM queue_entries qe
              INNER JOIN sessions s ON s.pk = qe.session_pk
              INNER JOIN recipes r ON r.pk = qe.recipe_pk
            WHERE s.uuid = ? AND r.name = ?)`,
        [ts, sid, name],
      );
      db.close();
    }

    test("returns null when queue is empty", async () => {
      const entry = await dequeue(dirs);
      expect(entry).toBeNull();
    });

    test("returns the newest entry first and transitions it to processing", async () => {
      await enqueue(SID1, "recipe-a", 10, dirs);
      setUpdatedAt(SID1, "recipe-a", Date.now() - 10000);
      await enqueue(SID2, "recipe-b", 10, dirs);

      const entry = await dequeue(dirs);
      expect(entry).not.toBeNull();
      expect(entry!.sessionId).toBe(SID2);
      expect(entry!.recipeName).toBe("recipe-b");
      expect(entry!.key).toBe(formatLogKey(SID2, "recipe-b"));

      // Dequeued entry should no longer be queued (now processing)
      expect(await isQueued(SID2, "recipe-b", dirs)).toBe(false);

      // Older entry should still be queued
      expect(await isQueued(SID1, "recipe-a", dirs)).toBe(true);
    });

    test("dequeues in newest-first order", async () => {
      await enqueue(SID1, "recipe-a", 10, dirs);
      await enqueue(SID2, "recipe-b", 10, dirs);
      await enqueue(SID3, "recipe-c", 10, dirs);
      setUpdatedAt(SID1, "recipe-a", 1000);
      setUpdatedAt(SID2, "recipe-b", 2000);
      setUpdatedAt(SID3, "recipe-c", 3000);

      const first = await dequeue(dirs);
      expect(first!.sessionId).toBe(SID3);

      const second = await dequeue(dirs);
      expect(second!.sessionId).toBe(SID2);

      const third = await dequeue(dirs);
      expect(third!.sessionId).toBe(SID1);

      const fourth = await dequeue(dirs);
      expect(fourth).toBeNull();
    });

    test("records history with action='claimed' on dequeue", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await dequeue(dirs);

      const db = getDb(dirs);
      const rows = db
        .query(
          `SELECT h.action, h.message FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? ORDER BY h.timestamp`,
        )
        .all(SID1) as { action: string; message: string | null }[];
      db.close();
      expect(rows.map((r) => r.action)).toEqual(["enqueued", "claimed"]);
      expect(rows[1]!.message).toBe("prevStatus: queued");
    });
  });

  describe("recipe names with dots", () => {
    test("correctly handles recipe name containing dots", async () => {
      await enqueue(SID_ABC, "my.diary", 10, dirs);

      const entry = await dequeue(dirs);
      expect(entry).not.toBeNull();
      expect(entry!.sessionId).toBe(SID_ABC);
      expect(entry!.recipeName).toBe("my.diary");
    });

    test("isDone works with dotted recipe name", async () => {
      await markDone(SID_ABC, "my.diary", 50, "/tmp/out.md", dirs);
      expect(await isDone(SID_ABC, "my.diary", 50, dirs)).toBe(true);
    });
  });

  describe("markDone", () => {
    test("marks entry as done with lineCount and removes from queued", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await markDone(SID1, "diary", 42, "/tmp/diary.md", dirs);

      expect(await isDone(SID1, "diary", 42, dirs)).toBe(true);
      expect(await isQueued(SID1, "diary", dirs)).toBe(false);
    });

    test("works even when entry did not exist before", async () => {
      await markDone(SID1, "diary", 100, null, dirs);
      expect(await isDone(SID1, "diary", 100, dirs)).toBe(true);
    });

    test("records history with action='completed' and outputFile in message", async () => {
      await markDone(SID1, "diary", 42, "/tmp/output.md", dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT h.action, h.message FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? AND h.action = 'completed'`,
        )
        .get(SID1) as { action: string; message: string };
      db.close();
      expect(row.action).toBe("completed");
      expect(row.message).toBe("/tmp/output.md");
    });

    test("clears reason on transition from failed → done", async () => {
      await markFailed(SID1, "diary", "boom", dirs);
      await markDone(SID1, "diary", 10, null, dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT qe.reason FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
           WHERE s.uuid = ?`,
        )
        .get(SID1) as { reason: string | null };
      db.close();
      expect(row.reason).toBeNull();
    });
  });

  describe("markFailed", () => {
    test("marks entry as failed and removes from queued", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await markFailed(SID1, "diary", undefined, dirs);

      expect(await isFailed(SID1, "diary", dirs)).toBe(true);
      expect(await isQueued(SID1, "diary", dirs)).toBe(false);
    });

    test("works after dequeue (entry transitions processing → failed)", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      const entry = await dequeue(dirs);
      expect(entry).not.toBeNull();

      await markFailed(SID1, "diary", undefined, dirs);
      expect(await isFailed(SID1, "diary", dirs)).toBe(true);
    });

    test("increments retryCount on subsequent calls", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await markFailed(SID1, "diary", undefined, dirs);
      await markFailed(SID1, "diary", undefined, dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT qe.retry_count FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
           WHERE s.uuid = ?`,
        )
        .get(SID1) as { retry_count: number };
      db.close();
      expect(row.retry_count).toBe(2);
    });

    test("records reason in queue_entries.reason", async () => {
      await markFailed(SID1, "diary", "claude exited with code 1", dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT qe.reason FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
           WHERE s.uuid = ?`,
        )
        .get(SID1) as { reason: string };
      db.close();
      expect(row.reason).toBe("claude exited with code 1");
    });

    test("records history with action='failed' and reason in message", async () => {
      await markFailed(SID1, "diary", "boom", dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT h.action, h.message FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? AND h.action = 'failed'`,
        )
        .get(SID1) as { action: string; message: string };
      db.close();
      expect(row.action).toBe("failed");
      expect(row.message).toBe("boom");
    });
  });

  describe("markSkipped", () => {
    test("marks entry as skipped", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await markSkipped(SID1, "diary", "empty_session", 10, dirs);

      const status = await getStatus(dirs);
      expect(status.skipped).toBe(1);
      expect(status.queued).toBe(0);
    });

    test("does NOT increment retry_count (skipped is not failure)", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await markSkipped(SID1, "diary", "no_user_turns", 10, dirs);
      await markSkipped(SID1, "diary", "no_user_turns", 10, dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT qe.retry_count FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
           WHERE s.uuid = ?`,
        )
        .get(SID1) as { retry_count: number };
      db.close();
      expect(row.retry_count).toBe(0);
    });

    test("records reason", async () => {
      await markSkipped(SID1, "diary", "fork_no_new_conversation", 10, dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT qe.reason FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
           WHERE s.uuid = ?`,
        )
        .get(SID1) as { reason: string };
      db.close();
      expect(row.reason).toBe("fork_no_new_conversation");
    });

    test("records history with action='skipped'", async () => {
      await markSkipped(SID1, "diary", "already_processed", 10, dirs);

      const db = getDb(dirs);
      const row = db
        .query(
          `SELECT h.action, h.message FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? AND h.action = 'skipped'`,
        )
        .get(SID1) as { action: string; message: string };
      db.close();
      expect(row.action).toBe("skipped");
      expect(row.message).toBe("already_processed");
    });

    test("works after dequeue (processing → skipped)", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await dequeue(dirs);
      await markSkipped(SID1, "diary", "empty_session", 10, dirs);

      const status = await getStatus(dirs);
      expect(status.skipped).toBe(1);
      expect(status.processing).toBe(0);
    });
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

  describe("retry", () => {
    test("moves entry from failed to queued", async () => {
      await markFailed(SID1, "diary", undefined, dirs);
      await retry(SID1, "diary", dirs);

      expect(await isQueued(SID1, "diary", dirs)).toBe(true);
      expect(await isFailed(SID1, "diary", dirs)).toBe(false);
    });

    test("moves entry from skipped to queued", async () => {
      await markSkipped(SID1, "diary", "empty_session", 10, dirs);
      await retry(SID1, "diary", dirs);

      expect(await isQueued(SID1, "diary", dirs)).toBe(true);
      const status = await getStatus(dirs);
      expect(status.skipped).toBe(0);
    });

    test("no-op for done entries (status guard)", async () => {
      await markDone(SID1, "diary", 50, null, dirs);
      await retry(SID1, "diary", dirs);

      expect(await isDone(SID1, "diary", 50, dirs)).toBe(true);
      expect(await isQueued(SID1, "diary", dirs)).toBe(false);
    });

    test("no-op for processing entries (status guard)", async () => {
      await claim(SID1, "diary", dirs);
      await retry(SID1, "diary", dirs);

      const status = await getStatus(dirs);
      expect(status.processing).toBe(1);
      expect(status.queued).toBe(0);
    });

    test("records history with action='reset' on successful reset", async () => {
      await markFailed(SID1, "diary", undefined, dirs);
      await retry(SID1, "diary", dirs);

      const db = getDb(dirs);
      const rows = db
        .query(
          `SELECT h.action FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? AND h.action = 'reset'`,
        )
        .all(SID1) as { action: string }[];
      db.close();
      expect(rows.length).toBe(1);
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

  describe("cleanup", () => {
    test("removes failed entries whose session no longer exists", async () => {
      await markFailed(SID1, "diary", undefined, dirs);
      await markFailed(SID2, "diary", undefined, dirs);

      const isSessionExists = async (sid: string) => sid === SID1;
      const removed = await cleanup(isSessionExists, dirs);

      expect(removed).toBe(1);
      expect(await isFailed(SID1, "diary", dirs)).toBe(true);
      expect(await isFailed(SID2, "diary", dirs)).toBe(false);
    });

    test("does not remove skipped entries even when session is gone", async () => {
      await markSkipped(SID1, "diary", "empty", 10, dirs);

      const isSessionExists = async () => false;
      const removed = await cleanup(isSessionExists, dirs);
      expect(removed).toBe(0);

      const status = await getStatus(dirs);
      expect(status.skipped).toBe(1);
    });
  });

  describe("normalization (sessions/recipes tables)", () => {
    test("reuses session_pk for the same uuid", async () => {
      await enqueue(SID1, "recipe-a", 10, dirs);
      await enqueue(SID1, "recipe-b", 10, dirs);

      const db = getDb(dirs);
      const count = db.query(`SELECT COUNT(*) as c FROM sessions WHERE uuid = ?`).get(SID1) as {
        c: number;
      };
      db.close();
      expect(count.c).toBe(1);
    });

    test("reuses recipe_pk for the same name", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await enqueue(SID2, "diary", 10, dirs);

      const db = getDb(dirs);
      const count = db.query(`SELECT COUNT(*) as c FROM recipes WHERE name = ?`).get("diary") as {
        c: number;
      };
      db.close();
      expect(count.c).toBe(1);
    });

    test("UNIQUE(session_pk, recipe_pk) prevents duplicates", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await enqueue(SID1, "diary", 10, dirs);
      await enqueue(SID1, "diary", 10, dirs);

      const db = getDb(dirs);
      const count = db
        .query(
          `SELECT COUNT(*) as c FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
           WHERE s.uuid = ? AND r.name = ?`,
        )
        .get(SID1, "diary") as { c: number };
      db.close();
      expect(count.c).toBe(1);
    });
  });

  describe("validateSessionId", () => {
    test("accepts valid UUID", () => {
      expect(() => validateSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
    });

    test("rejects empty string", () => {
      expect(() => validateSessionId("")).toThrow(/Invalid sessionId/);
    });

    test("rejects path traversal", () => {
      expect(() => validateSessionId("../etc/passwd")).toThrow(/Invalid sessionId/);
    });
  });

  describe("validateRecipeName", () => {
    test("accepts valid recipe names", () => {
      expect(() => validateRecipeName("diary")).not.toThrow();
      expect(() => validateRecipeName("my-recipe")).not.toThrow();
      expect(() => validateRecipeName("my.recipe")).not.toThrow();
    });

    test("rejects path traversal", () => {
      expect(() => validateRecipeName("../etc/passwd")).toThrow(/Invalid recipeName/);
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

  describe("claim", () => {
    test("inserts a new processing entry when key is absent", async () => {
      const result = await claim(SID1, "diary", dirs);
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBeNull();

      const status = await getStatus(dirs);
      expect(status.processing).toBe(1);
    });

    test("transitions queued entry to processing", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      const result = await claim(SID1, "diary", dirs);
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("queued");
      expect(await isQueued(SID1, "diary", dirs)).toBe(false);
    });

    test("transitions done entry back to processing", async () => {
      await markDone(SID1, "diary", 50, null, dirs);
      const result = await claim(SID1, "diary", dirs);
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("done");
      expect(await isDone(SID1, "diary", 50, dirs)).toBe(false);
    });

    test("transitions failed entry back to processing", async () => {
      await markFailed(SID1, "diary", "boom", dirs);
      const result = await claim(SID1, "diary", dirs);
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("failed");
      expect(await isFailed(SID1, "diary", dirs)).toBe(false);
    });

    test("transitions skipped entry back to processing", async () => {
      await markSkipped(SID1, "diary", "empty", 10, dirs);
      const result = await claim(SID1, "diary", dirs);
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("skipped");
    });

    test("returns claimed=false when entry is already processing", async () => {
      const r1 = await claim(SID1, "diary", dirs);
      expect(r1.claimed).toBe(true);

      const r2 = await claim(SID1, "diary", dirs);
      expect(r2.claimed).toBe(false);
      expect(r2.prevStatus).toBe("processing");
    });

    test("records history with action='claimed' and prevStatus in message", async () => {
      await enqueue(SID1, "diary", 10, dirs);
      await claim(SID1, "diary", dirs);

      const db = getDb(dirs);
      const rows = db
        .query(
          `SELECT h.action, h.message FROM history h
             INNER JOIN sessions s ON s.pk = h.session_pk
           WHERE s.uuid = ? ORDER BY h.timestamp`,
        )
        .all(SID1) as { action: string; message: string | null }[];
      db.close();
      expect(rows[0]).toEqual({ action: "enqueued", message: null });
      expect(rows[1]).toEqual({ action: "claimed", message: "prevStatus: queued" });
    });

    test("rejects invalid sessionId / recipeName", async () => {
      await expect(claim("../etc", "diary", dirs)).rejects.toThrow(/Invalid sessionId/);
      await expect(claim("550e8400-e29b-41d4-a716-446655440000", "../etc", dirs)).rejects.toThrow(
        /Invalid recipeName/,
      );
    });
  });

  describe("waitForCompletion", () => {
    test("returns done with lineCount when entry transitions to done", async () => {
      await markDone(SID1, "diary", 42, null, dirs);

      const result = await waitForCompletion(
        SID1,
        "diary",
        { pollIntervalMs: 1, timeoutMs: 1000 },
        dirs,
      );
      expect(result.status).toBe("done");
      if (result.status === "done") {
        expect(result.lineCount).toBe(42);
      }
    });

    test("returns failed with reason when entry transitions to failed", async () => {
      await markFailed(SID1, "diary", "boom", dirs);

      const result = await waitForCompletion(
        SID1,
        "diary",
        { pollIntervalMs: 1, timeoutMs: 1000 },
        dirs,
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason).toBe("boom");
      }
    });

    test("returns skipped with reason when entry transitions to skipped", async () => {
      await markSkipped(SID1, "diary", "empty_session", 10, dirs);

      const result = await waitForCompletion(
        SID1,
        "diary",
        { pollIntervalMs: 1, timeoutMs: 1000 },
        dirs,
      );
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("empty_session");
      }
    });

    test("returns timeout when entry remains in processing past timeout", async () => {
      await claim(SID1, "diary", dirs);

      let nowMs = 1_000_000;
      const sleep = async () => {
        nowMs += 100;
      };
      const now = () => nowMs;

      const result = await waitForCompletion(
        SID1,
        "diary",
        { pollIntervalMs: 50, timeoutMs: 50, sleep, now },
        dirs,
      );
      expect(result.status).toBe("timeout");
    });

    test("polls until status changes", async () => {
      await claim(SID1, "diary", dirs);

      let pollCount = 0;
      const sleep = async () => {
        pollCount++;
        if (pollCount === 2) {
          await markDone(SID1, "diary", 100, null, dirs);
        }
      };
      const now = () => 0;

      const result = await waitForCompletion(
        SID1,
        "diary",
        { pollIntervalMs: 1, timeoutMs: 60_000, sleep, now },
        dirs,
      );
      expect(result.status).toBe("done");
      if (result.status === "done") {
        expect(result.lineCount).toBe(100);
      }
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("formatLogKey", () => {
    test("builds the conventional log key string", () => {
      expect(formatLogKey(SID1, "diary")).toBe(`${SID1}.diary`);
      expect(formatLogKey(SID1, "my.recipe")).toBe(`${SID1}.my.recipe`);
    });
  });
});

describe("schema migration v0 → v1", () => {
  let dirs: QueueDirs;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-migrate-test-"));
    dirs = {
      queueDir: join(tempDir, "queue") + "/",
      doneDir: join(tempDir, "done") + "/",
      failedDir: join(tempDir, "failed") + "/",
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("migrates legacy v0 data to v1 normalized schema", async () => {
    // Manually create a legacy v0 DB
    const { Database } = await import("bun:sqlite");
    const dbPath = join(tempDir, "queue.db");
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
    const db = getDb(dirs);
    try {
      // Verify user_version bumped
      const v = db.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(1);

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

  test("fresh DB starts directly at v1", async () => {
    const db = getDb(dirs);
    try {
      const v = db.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(1);

      // Tables exist
      const tables = db
        .query(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain("sessions");
      expect(names).toContain("recipes");
      expect(names).toContain("queue_entries");
      expect(names).toContain("history");
    } finally {
      db.close();
    }
  });

  test("idempotent: running migration on already-migrated DB is a no-op", async () => {
    // First open creates v1 schema
    const db1 = getDb(dirs);
    db1.close();

    // Second open: no migration runs (user_version already 1)
    const db2 = getDb(dirs);
    try {
      const v = db2.query(`PRAGMA user_version`).get() as { user_version: number };
      expect(v.user_version).toBe(1);
    } finally {
      db2.close();
    }
  });

  test("rejects DB with future schema version", async () => {
    // Create fresh, then bump version to a future value
    const db1 = getDb(dirs);
    db1.run(`PRAGMA user_version = 99`);
    db1.close();

    expect(() => {
      const db2 = getDb(dirs);
      db2.close();
    }).toThrow(/schema version 99 is newer/);
  });
});
