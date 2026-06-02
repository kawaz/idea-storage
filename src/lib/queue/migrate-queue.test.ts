import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb } from "./queue.ts";
import { migrateIfNeeded } from "./migrate-queue.ts";

const SID1 = "00000000-0000-4000-a000-000000000001";
const SID2 = "00000000-0000-4000-a000-000000000002";
const SID3 = "00000000-0000-4000-a000-000000000003";

describe("migrateIfNeeded", () => {
  let tempDir: string;
  let stateDir: string;
  let queueDir: string;
  let doneDir: string;
  let failedDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "migrate-test-"));
    // DR-0009 Phase 7: legacy dirs are resolved from getStateDir(), so we
    // override XDG_STATE_HOME to anchor the legacy layout under tempDir.
    savedEnv = {
      HOME: process.env.HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    };
    process.env.HOME = tempDir;
    process.env.XDG_STATE_HOME = join(tempDir, "state");
    stateDir = join(tempDir, "state", "idea-storage");
    queueDir = join(stateDir, "queue") + "/";
    doneDir = join(stateDir, "done") + "/";
    failedDir = join(stateDir, "failed") + "/";
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("queue, done, failed ディレクトリがない場合は null を返す", async () => {
    const result = await migrateIfNeeded();
    expect(result).toBeNull();
  });

  test("queue.bak が既に存在する場合はスキップして null を返す", async () => {
    await mkdir(stateDir, { recursive: true });
    await mkdir(join(stateDir, "queue.bak"));
    await mkdir(queueDir, { recursive: true });
    await Bun.write(join(queueDir, `${SID1}.diary`), "");

    const result = await migrateIfNeeded();
    expect(result).toBeNull();
  });

  test("queue ファイルを SQLite (v1) に移行する", async () => {
    await mkdir(queueDir, { recursive: true });
    await Bun.write(join(queueDir, `${SID1}.diary`), "");
    await Bun.write(join(queueDir, `${SID2}.report`), "");

    const result = await migrateIfNeeded();
    expect(result).toBe(2);

    const db = getDb();
    const rows = db
      .query(
        `SELECT s.uuid, r.name, qe.status FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
           INNER JOIN recipes r ON r.pk = qe.recipe_pk
         WHERE qe.status = 'queued'
         ORDER BY s.uuid`,
      )
      .all() as { uuid: string; name: string; status: string }[];
    db.close();
    expect(rows).toEqual([
      { uuid: SID1, name: "diary", status: "queued" },
      { uuid: SID2, name: "report", status: "queued" },
    ]);
  });

  test("done ファイルを SQLite に移行する", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(doneDir, { recursive: true });
    await Bun.write(join(doneDir, `${SID1}.diary`), "42");

    const result = await migrateIfNeeded();
    expect(result).toBe(1);

    const db = getDb();
    const row = db
      .query(
        `SELECT qe.line_count FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
           INNER JOIN recipes r ON r.pk = qe.recipe_pk
         WHERE s.uuid = ? AND r.name = ? AND qe.status = 'done'`,
      )
      .get(SID1, "diary") as { line_count: number } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(row!.line_count).toBe(42);
  });

  test("failed ファイル（JSON）を SQLite に移行する", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });
    await Bun.write(
      join(failedDir, `${SID1}.diary`),
      JSON.stringify({ retryCount: 2, reason: "timeout" }),
    );

    const result = await migrateIfNeeded();
    expect(result).toBe(1);

    const db = getDb();
    const row = db
      .query(
        `SELECT qe.retry_count, qe.reason FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
           INNER JOIN recipes r ON r.pk = qe.recipe_pk
         WHERE s.uuid = ? AND r.name = ? AND qe.status = 'failed'`,
      )
      .get(SID1, "diary") as { retry_count: number; reason: string | null } | null;
    db.close();
    expect(row).not.toBeNull();
    expect(row!.retry_count).toBe(2);
    expect(row!.reason).toBe("timeout");
  });

  test("failed の空ファイルは retryCount=0 で移行する", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });
    await Bun.write(join(failedDir, `${SID1}.diary`), "");

    await migrateIfNeeded();

    const db = getDb();
    const row = db
      .query(
        `SELECT qe.retry_count FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
         WHERE s.uuid = ?`,
      )
      .get(SID1) as { retry_count: number } | null;
    db.close();
    expect(row!.retry_count).toBe(0);
  });

  test("failed の .log ファイルは無視する", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });
    await Bun.write(join(failedDir, "some.log"), "error log");
    await Bun.write(join(failedDir, `${SID1}.diary`), JSON.stringify({ retryCount: 1 }));

    const result = await migrateIfNeeded();
    expect(result).toBe(1); // .log は無視
  });

  test("done と queue の重複がある場合 done を優先する", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(doneDir, { recursive: true });
    await Bun.write(join(queueDir, `${SID1}.diary`), "");
    await Bun.write(join(doneDir, `${SID1}.diary`), "100");

    await migrateIfNeeded();

    const db = getDb();
    const row = db
      .query(
        `SELECT qe.status, qe.line_count FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
         WHERE s.uuid = ?`,
      )
      .get(SID1) as { status: string; line_count: number | null } | null;
    db.close();
    expect(row!.status).toBe("done");
    expect(row!.line_count).toBe(100);
  });

  test("移行後に queue, done, failed ディレクトリが .bak にリネームされる", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(doneDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });
    await Bun.write(join(queueDir, `${SID1}.diary`), "");

    await migrateIfNeeded();

    // .bak が存在する
    const queueBak = await stat(join(stateDir, "queue.bak")).catch(() => null);
    expect(queueBak).not.toBeNull();

    // 元のディレクトリは存在しない
    const queueLeft = await stat(queueDir.replace(/\/$/, "")).catch(() => null);
    expect(queueLeft).toBeNull();
  });

  test("混合データの移行", async () => {
    await mkdir(queueDir, { recursive: true });
    await mkdir(doneDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });
    await Bun.write(join(queueDir, `${SID1}.diary`), "");
    await Bun.write(join(doneDir, `${SID2}.report`), "75");
    await Bun.write(
      join(failedDir, `${SID3}.summary`),
      JSON.stringify({ retryCount: 1, reason: "api error" }),
    );

    const result = await migrateIfNeeded();
    expect(result).toBe(3);

    const db = getDb();
    const all = db
      .query(
        `SELECT s.uuid, r.name, qe.status FROM queue_entries qe
           INNER JOIN sessions s ON s.pk = qe.session_pk
           INNER JOIN recipes r ON r.pk = qe.recipe_pk
         ORDER BY s.uuid`,
      )
      .all() as { uuid: string; name: string; status: string }[];
    db.close();
    expect(all).toEqual([
      { uuid: SID1, name: "diary", status: "queued" },
      { uuid: SID2, name: "report", status: "done" },
      { uuid: SID3, name: "summary", status: "failed" },
    ]);
  });
});
