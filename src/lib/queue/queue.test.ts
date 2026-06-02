import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
  validateStoredSessionId,
  validateStoredRecipeName,
  getDb,
  claim,
  waitForCompletion,
  formatLogKey,
} from "./queue.ts";

// Test UUIDs
const SID1 = "00000000-0000-4000-a000-000000000001";
const SID2 = "00000000-0000-4000-a000-000000000002";
const SID3 = "00000000-0000-4000-a000-000000000003";
const SID_ABC = "00000000-0000-4000-a000-00000000abc0";

describe("queue", () => {
  let tempDir: string;
  let dbPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "queue-test-"));
    // DR-0009 Phase 7: queue.db path is derived from XDG_STATE_HOME.
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
    test("getDb で作成された queue.db は mode 0600 (owner-only)", async () => {
      const db = getDb();
      db.close();
      const { statSync } = await import("node:fs");
      const s = statSync(dbPath);
      expect(s.mode & 0o777).toBe(0o600);
    });

    test("WAL / SHM ファイルも mode 0600 (codex review #5)", async () => {
      const db = getDb();
      // applyMigrations 後に WAL/SHM が生成されている前提
      const { statSync, existsSync } = await import("node:fs");
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (existsSync(walPath)) {
        expect(statSync(walPath).mode & 0o777).toBe(0o600);
      }
      if (existsSync(shmPath)) {
        expect(statSync(shmPath).mode & 0o777).toBe(0o600);
      }
      db.close();
    });
  });

  describe("enqueue", () => {
    test("creates a queued entry", async () => {
      await enqueue(SID_ABC, "diary", 10);
      expect(await isQueued(SID_ABC, "diary")).toBe(true);
    });

    test("does not duplicate an existing queued entry", async () => {
      await enqueue(SID_ABC, "diary", 10);
      await enqueue(SID_ABC, "diary", 10); // same lineCount → no-op
      const status = await getStatus();
      expect(status.queued).toBe(1);
    });

    test("records history with action='enqueued' on first insert only", async () => {
      await enqueue(SID1, "diary", 10);
      await enqueue(SID1, "diary", 10); // duplicate

      const db = getDb();
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
      enqueueBatch([
        { sessionId: SID1, recipeName: "diary", lineCount: 5 },
        { sessionId: SID2, recipeName: "report", lineCount: 7 },
      ]);

      expect(await isQueued(SID1, "diary")).toBe(true);
      expect(await isQueued(SID2, "report")).toBe(true);
    });

    test("空配列でもエラーにならない", async () => {
      enqueueBatch([]);
      const status = await getStatus();
      expect(status.queued).toBe(0);
    });

    test("既に queued の同一キーは触らない", async () => {
      await enqueue(SID1, "diary", 10);
      enqueueBatch([
        { sessionId: SID1, recipeName: "diary", lineCount: 10 }, // duplicate
        { sessionId: SID2, recipeName: "report", lineCount: 7 },
      ]);

      const status = await getStatus();
      expect(status.queued).toBe(2);
    });

    test("無効な sessionId でバリデーションエラー", () => {
      expect(() =>
        enqueueBatch([{ sessionId: "invalid", recipeName: "diary", lineCount: 1 }]),
      ).toThrow(/Invalid sessionId/);
    });

    test("無効な recipeName でバリデーションエラー", () => {
      expect(() => enqueueBatch([{ sessionId: SID1, recipeName: "../bad", lineCount: 1 }])).toThrow(
        /Invalid recipeName/,
      );
    });

    test("バリデーションエラー時はどのエントリも挿入されない", async () => {
      try {
        enqueueBatch([
          { sessionId: SID1, recipeName: "diary", lineCount: 1 },
          { sessionId: "invalid", recipeName: "diary", lineCount: 1 },
        ]);
      } catch {
        /* expected */
      }
      const status = await getStatus();
      expect(status.queued).toBe(0);
    });
  });

  // Helper to assert queue_entries row state (status / reason / line_count).
  function readEntry(
    sid: string,
    name: string,
  ): { status: string; reason: string | null; line_count: number | null } | null {
    const db = getDb();
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
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 12 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(12);
      expect(row?.reason).toBeNull();
    });

    test("queued: 触らない (no-op)", async () => {
      await enqueue(SID1, "diary", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      // 既に queued の場合は line_count を更新しない (既存 queued を保持)
      expect(row?.line_count).toBe(10);
    });

    test("processing: 触らない", async () => {
      await enqueue(SID1, "diary", 10);
      await claim(SID1, "diary"); // queued → processing
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("processing");
    });

    test("done, new > old: queued に再遷移して line_count 更新", async () => {
      await markDone(SID1, "diary", 10, null);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(20);
      expect(row?.reason).toBeNull();
    });

    test("done, new == old: 触らない", async () => {
      await markDone(SID1, "diary", 10, null);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("done");
      expect(row?.line_count).toBe(10);
    });

    test("done, new < old: 触らない (退行防止)", async () => {
      await markDone(SID1, "diary", 100, null);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("done");
      expect(row?.line_count).toBe(100);
    });

    test("failed: 触らない (既存 retry 機構が別途処理)", async () => {
      await markFailed(SID1, "diary", "boom");
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 20 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("failed");
    });

    test("skipped(no_effective_turn), new > old: queued に再遷移", async () => {
      await markSkipped(SID1, "diary", "no_effective_turn", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 25 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(25);
      expect(row?.reason).toBeNull();
    });

    test("skipped(no_effective_turn), new == old: 触らない", async () => {
      await markSkipped(SID1, "diary", "no_effective_turn", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
      expect(row?.reason).toBe("no_effective_turn");
      expect(row?.line_count).toBe(10);
    });

    test("skipped(quality_rejected): 触らない (PR③ 専用、自動復帰しない)", async () => {
      await markSkipped(SID1, "diary", "quality_rejected", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 100 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
      expect(row?.reason).toBe("quality_rejected");
      expect(row?.line_count).toBe(10);
    });

    test("skipped(dispatcher_rejected), new > old: queued に再遷移 (Phase 2 で復帰対象)", async () => {
      // PR③ (Phase 2): dispatcher 導入に伴い dispatcher_rejected は
      // REENQUEUABLE_SKIPPED_REASONS に追加。追記でセッションの性質が変わった
      // 可能性があるので再 dispatch のために queued に戻す。
      await markSkipped(SID1, "diary", "dispatcher_rejected", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 100 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("queued");
      expect(row?.line_count).toBe(100);
      expect(row?.reason).toBeNull();
    });

    test("skipped(dispatcher_rejected), new == old: 触らない", async () => {
      await markSkipped(SID1, "diary", "dispatcher_rejected", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 10 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
      expect(row?.reason).toBe("dispatcher_rejected");
    });

    test("skipped(unknown reason): 触らない (デフォルト保守)", async () => {
      await markSkipped(SID1, "diary", "something_else", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 100 }]);
      const row = readEntry(SID1, "diary");
      expect(row?.status).toBe("skipped");
    });

    test("skipped → queued 復帰時は history に reset が記録される", async () => {
      await markSkipped(SID1, "diary", "no_effective_turn", 10);
      enqueueBatch([{ sessionId: SID1, recipeName: "diary", lineCount: 25 }]);

      const db = getDb();
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
      const db = getDb();
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
      const entry = await dequeue();
      expect(entry).toBeNull();
    });

    test("returns the newest entry first and transitions it to processing", async () => {
      await enqueue(SID1, "recipe-a", 10);
      setUpdatedAt(SID1, "recipe-a", Date.now() - 10000);
      await enqueue(SID2, "recipe-b", 10);

      const entry = await dequeue();
      expect(entry).not.toBeNull();
      expect(entry!.sessionId).toBe(SID2);
      expect(entry!.recipeName).toBe("recipe-b");
      expect(entry!.key).toBe(formatLogKey(SID2, "recipe-b"));

      // Dequeued entry should no longer be queued (now processing)
      expect(await isQueued(SID2, "recipe-b")).toBe(false);

      // Older entry should still be queued
      expect(await isQueued(SID1, "recipe-a")).toBe(true);
    });

    test("dequeues in newest-first order", async () => {
      await enqueue(SID1, "recipe-a", 10);
      await enqueue(SID2, "recipe-b", 10);
      await enqueue(SID3, "recipe-c", 10);
      setUpdatedAt(SID1, "recipe-a", 1000);
      setUpdatedAt(SID2, "recipe-b", 2000);
      setUpdatedAt(SID3, "recipe-c", 3000);

      const first = await dequeue();
      expect(first!.sessionId).toBe(SID3);

      const second = await dequeue();
      expect(second!.sessionId).toBe(SID2);

      const third = await dequeue();
      expect(third!.sessionId).toBe(SID1);

      const fourth = await dequeue();
      expect(fourth).toBeNull();
    });

    test("records history with action='claimed' on dequeue", async () => {
      await enqueue(SID1, "diary", 10);
      await dequeue();

      const db = getDb();
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
      await enqueue(SID_ABC, "my.diary", 10);

      const entry = await dequeue();
      expect(entry).not.toBeNull();
      expect(entry!.sessionId).toBe(SID_ABC);
      expect(entry!.recipeName).toBe("my.diary");
    });

    test("isDone works with dotted recipe name", async () => {
      await markDone(SID_ABC, "my.diary", 50, "/tmp/out.md");
      expect(await isDone(SID_ABC, "my.diary", 50)).toBe(true);
    });
  });

  describe("markDone", () => {
    test("marks entry as done with lineCount and removes from queued", async () => {
      await enqueue(SID1, "diary", 10);
      await markDone(SID1, "diary", 42, "/tmp/diary.md");

      expect(await isDone(SID1, "diary", 42)).toBe(true);
      expect(await isQueued(SID1, "diary")).toBe(false);
    });

    test("works even when entry did not exist before", async () => {
      await markDone(SID1, "diary", 100, null);
      expect(await isDone(SID1, "diary", 100)).toBe(true);
    });

    test("records history with action='completed' and outputFile in message", async () => {
      await markDone(SID1, "diary", 42, "/tmp/output.md");

      const db = getDb();
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
      await markFailed(SID1, "diary", "boom");
      await markDone(SID1, "diary", 10, null);

      const db = getDb();
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
      await enqueue(SID1, "diary", 10);
      await markFailed(SID1, "diary", undefined);

      expect(await isFailed(SID1, "diary")).toBe(true);
      expect(await isQueued(SID1, "diary")).toBe(false);
    });

    test("works after dequeue (entry transitions processing → failed)", async () => {
      await enqueue(SID1, "diary", 10);
      const entry = await dequeue();
      expect(entry).not.toBeNull();

      await markFailed(SID1, "diary", undefined);
      expect(await isFailed(SID1, "diary")).toBe(true);
    });

    test("increments retryCount on subsequent calls", async () => {
      await enqueue(SID1, "diary", 10);
      await markFailed(SID1, "diary", undefined);
      await markFailed(SID1, "diary", undefined);

      const db = getDb();
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
      await markFailed(SID1, "diary", "claude exited with code 1");

      const db = getDb();
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
      await markFailed(SID1, "diary", "boom");

      const db = getDb();
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
      await enqueue(SID1, "diary", 10);
      await markSkipped(SID1, "diary", "empty_session", 10);

      const status = await getStatus();
      expect(status.skipped).toBe(1);
      expect(status.queued).toBe(0);
    });

    test("does NOT increment retry_count (skipped is not failure)", async () => {
      await enqueue(SID1, "diary", 10);
      await markSkipped(SID1, "diary", "no_user_turns", 10);
      await markSkipped(SID1, "diary", "no_user_turns", 10);

      const db = getDb();
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
      await markSkipped(SID1, "diary", "fork_no_new_conversation", 10);

      const db = getDb();
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
      await markSkipped(SID1, "diary", "already_processed", 10);

      const db = getDb();
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
      await enqueue(SID1, "diary", 10);
      await dequeue();
      await markSkipped(SID1, "diary", "empty_session", 10);

      const status = await getStatus();
      expect(status.skipped).toBe(1);
      expect(status.processing).toBe(0);
    });
  });

  describe("retry", () => {
    test("moves entry from failed to queued", async () => {
      await markFailed(SID1, "diary", undefined);
      await retry(SID1, "diary");

      expect(await isQueued(SID1, "diary")).toBe(true);
      expect(await isFailed(SID1, "diary")).toBe(false);
    });

    test("moves entry from skipped to queued", async () => {
      await markSkipped(SID1, "diary", "empty_session", 10);
      await retry(SID1, "diary");

      expect(await isQueued(SID1, "diary")).toBe(true);
      const status = await getStatus();
      expect(status.skipped).toBe(0);
    });

    test("no-op for done entries (status guard)", async () => {
      await markDone(SID1, "diary", 50, null);
      await retry(SID1, "diary");

      expect(await isDone(SID1, "diary", 50)).toBe(true);
      expect(await isQueued(SID1, "diary")).toBe(false);
    });

    test("no-op for processing entries (status guard)", async () => {
      await claim(SID1, "diary");
      await retry(SID1, "diary");

      const status = await getStatus();
      expect(status.processing).toBe(1);
      expect(status.queued).toBe(0);
    });

    test("records history with action='reset' on successful reset", async () => {
      await markFailed(SID1, "diary", undefined);
      await retry(SID1, "diary");

      const db = getDb();
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

  describe("cleanup", () => {
    test("removes failed entries whose session no longer exists", async () => {
      await markFailed(SID1, "diary", undefined);
      await markFailed(SID2, "diary", undefined);

      const isSessionExists = async (sid: string) => sid === SID1;
      const removed = await cleanup(isSessionExists);

      expect(removed).toBe(1);
      expect(await isFailed(SID1, "diary")).toBe(true);
      expect(await isFailed(SID2, "diary")).toBe(false);
    });

    test("does not remove skipped entries even when session is gone", async () => {
      await markSkipped(SID1, "diary", "empty", 10);

      const isSessionExists = async () => false;
      const removed = await cleanup(isSessionExists);
      expect(removed).toBe(0);

      const status = await getStatus();
      expect(status.skipped).toBe(1);
    });
  });

  describe("normalization (sessions/recipes tables)", () => {
    test("reuses session_pk for the same uuid", async () => {
      await enqueue(SID1, "recipe-a", 10);
      await enqueue(SID1, "recipe-b", 10);

      const db = getDb();
      const count = db.query(`SELECT COUNT(*) as c FROM sessions WHERE uuid = ?`).get(SID1) as {
        c: number;
      };
      db.close();
      expect(count.c).toBe(1);
    });

    test("reuses recipe_pk for the same name", async () => {
      await enqueue(SID1, "diary", 10);
      await enqueue(SID2, "diary", 10);

      const db = getDb();
      const count = db.query(`SELECT COUNT(*) as c FROM recipes WHERE name = ?`).get("diary") as {
        c: number;
      };
      db.close();
      expect(count.c).toBe(1);
    });

    test("UNIQUE(session_pk, recipe_pk) prevents duplicates", async () => {
      await enqueue(SID1, "diary", 10);
      await enqueue(SID1, "diary", 10);
      await enqueue(SID1, "diary", 10);

      const db = getDb();
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

  describe("validateStoredSessionId", () => {
    test("accepts valid UUID", () => {
      expect(() => validateStoredSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
    });

    test("rejects empty string", () => {
      expect(() => validateStoredSessionId("")).toThrow(/Invalid sessionId/);
    });

    test("rejects path traversal", () => {
      expect(() => validateStoredSessionId("../etc/passwd")).toThrow(/Invalid sessionId/);
    });
  });

  describe("validateStoredRecipeName", () => {
    test("accepts valid recipe names", () => {
      expect(() => validateStoredRecipeName("diary")).not.toThrow();
      expect(() => validateStoredRecipeName("my-recipe")).not.toThrow();
      expect(() => validateStoredRecipeName("my.recipe")).not.toThrow();
    });

    test("rejects path traversal", () => {
      expect(() => validateStoredRecipeName("../etc/passwd")).toThrow(/Invalid recipeName/);
    });
  });

  describe("claim", () => {
    test("inserts a new processing entry when key is absent", async () => {
      const result = await claim(SID1, "diary");
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBeNull();

      const status = await getStatus();
      expect(status.processing).toBe(1);
    });

    test("transitions queued entry to processing", async () => {
      await enqueue(SID1, "diary", 10);
      const result = await claim(SID1, "diary");
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("queued");
      expect(await isQueued(SID1, "diary")).toBe(false);
    });

    test("transitions done entry back to processing", async () => {
      await markDone(SID1, "diary", 50, null);
      const result = await claim(SID1, "diary");
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("done");
      expect(await isDone(SID1, "diary", 50)).toBe(false);
    });

    test("transitions failed entry back to processing", async () => {
      await markFailed(SID1, "diary", "boom");
      const result = await claim(SID1, "diary");
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("failed");
      expect(await isFailed(SID1, "diary")).toBe(false);
    });

    test("transitions skipped entry back to processing", async () => {
      await markSkipped(SID1, "diary", "empty", 10);
      const result = await claim(SID1, "diary");
      expect(result.claimed).toBe(true);
      expect(result.prevStatus).toBe("skipped");
    });

    test("returns claimed=false when entry is already processing", async () => {
      const r1 = await claim(SID1, "diary");
      expect(r1.claimed).toBe(true);

      const r2 = await claim(SID1, "diary");
      expect(r2.claimed).toBe(false);
      expect(r2.prevStatus).toBe("processing");
    });

    test("records history with action='claimed' and prevStatus in message", async () => {
      await enqueue(SID1, "diary", 10);
      await claim(SID1, "diary");

      const db = getDb();
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
      await expect(claim("../etc", "diary")).rejects.toThrow(/Invalid sessionId/);
      await expect(claim("550e8400-e29b-41d4-a716-446655440000", "../etc")).rejects.toThrow(
        /Invalid recipeName/,
      );
    });
  });

  describe("waitForCompletion", () => {
    test("returns done with lineCount when entry transitions to done", async () => {
      await markDone(SID1, "diary", 42, null);

      const result = await waitForCompletion(SID1, "diary", {
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });
      expect(result.status).toBe("done");
      if (result.status === "done") {
        expect(result.lineCount).toBe(42);
      }
    });

    test("returns failed with reason when entry transitions to failed", async () => {
      await markFailed(SID1, "diary", "boom");

      const result = await waitForCompletion(SID1, "diary", {
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason).toBe("boom");
      }
    });

    test("returns skipped with reason when entry transitions to skipped", async () => {
      await markSkipped(SID1, "diary", "empty_session", 10);

      const result = await waitForCompletion(SID1, "diary", {
        pollIntervalMs: 1,
        timeoutMs: 1000,
      });
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe("empty_session");
      }
    });

    test("returns timeout when entry remains in processing past timeout", async () => {
      await claim(SID1, "diary");

      let nowMs = 1_000_000;
      const sleep = async () => {
        nowMs += 100;
      };
      const now = () => nowMs;

      const result = await waitForCompletion(SID1, "diary", {
        pollIntervalMs: 50,
        timeoutMs: 50,
        sleep,
        now,
      });
      expect(result.status).toBe("timeout");
    });

    test("polls until status changes", async () => {
      await claim(SID1, "diary");

      let pollCount = 0;
      const sleep = async () => {
        pollCount++;
        if (pollCount === 2) {
          await markDone(SID1, "diary", 100, null);
        }
      };
      const now = () => 0;

      const result = await waitForCompletion(SID1, "diary", {
        pollIntervalMs: 1,
        timeoutMs: 60_000,
        sleep,
        now,
      });
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
