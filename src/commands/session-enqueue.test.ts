import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  withIsolatedIdeaStorageEnv,
  writeConfigFixture,
  writeRecipeFixtures,
  writeSessionFixture,
  type RecipeFixtureSpec,
} from "../lib/test-fixtures.ts";

// No mock.module(...) anywhere. Every module the SUT touches is the real
// one, exercised against a temp on-disk state.
//
// - config.ts:    real loadConfig() reads <tempDir>/.config/idea-storage/config.ts
// - recipe.ts:    real loadRecipes() reads recipe-*.md from the same dir
// - paths.ts:     real getStateDir() etc. resolve via XDG_*_HOME
// - queue.ts:     real queue.db sits at <tempDir>/state/idea-storage/queue.db
// - CSA spawn:    real claude-session-analysis bin reads fixture jsonl files
//                 placed under <tempDir>/.claude/projects/<slug>/
// (claude-runner mock is not needed here — runEnqueue does not call claude.)

interface ReadEntry {
  sessionId: string;
  recipeName: string;
  status: string;
  reason: string | null;
  lineCount: number | null;
}

describe("session-enqueue", () => {
  let tempDir: string;
  let claudeDir: string;
  let dotClaude: string;

  /** Read the queue_entries rows for a given session, joined with sessions/recipes. */
  async function readEntries(sessionId: string): Promise<ReadEntry[]> {
    const { getDb } = await import("../lib/queue/queue.ts");
    const db = getDb();
    try {
      const rows = db
        .query(
          `SELECT s.uuid AS session_id, r.name AS recipe_name,
                  qe.status, qe.reason, qe.line_count
             FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
             WHERE s.uuid = ?
             ORDER BY r.name`,
        )
        .all(sessionId) as Array<{
        session_id: string;
        recipe_name: string;
        status: string;
        reason: string | null;
        line_count: number | null;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        recipeName: r.recipe_name,
        status: r.status,
        reason: r.reason,
        lineCount: r.line_count,
      }));
    } finally {
      db.close();
    }
  }

  async function readAllEntries(): Promise<ReadEntry[]> {
    const { getDb } = await import("../lib/queue/queue.ts");
    const db = getDb();
    try {
      const rows = db
        .query(
          `SELECT s.uuid AS session_id, r.name AS recipe_name,
                  qe.status, qe.reason, qe.line_count
             FROM queue_entries qe
             INNER JOIN sessions s ON s.pk = qe.session_pk
             INNER JOIN recipes r ON r.pk = qe.recipe_pk
             ORDER BY s.uuid, r.name`,
        )
        .all() as Array<{
        session_id: string;
        recipe_name: string;
        status: string;
        reason: string | null;
        line_count: number | null;
      }>;
      return rows.map((r) => ({
        sessionId: r.session_id,
        recipeName: r.recipe_name,
        status: r.status,
        reason: r.reason,
        lineCount: r.line_count,
      }));
    } finally {
      db.close();
    }
  }

  /** Pre-seed the queue with an existing (session, recipe) row at the given status. */
  async function preSeed(
    sessionId: string,
    recipeName: string,
    status: "queued" | "done" | "failed" | "skipped",
    lineCount: number,
    reason?: string,
  ): Promise<void> {
    const { enqueue, markDone, markFailed, markSkipped } = await import("../lib/queue/queue.ts");
    if (status === "queued") await enqueue(sessionId, recipeName, lineCount);
    else if (status === "done") await markDone(sessionId, recipeName, lineCount, null);
    else if (status === "failed") await markFailed(sessionId, recipeName, reason);
    else await markSkipped(sessionId, recipeName, reason, lineCount);
  }

  /**
   * Thin wrapper over the shared {@link writeSessionFixture} helper. Kept for
   * caller readability; derives the fixture base (= dir containing `projects/`)
   * from the legacy `projectsDir` arg. The `noEffectiveTurn` knob maps to
   * `effectiveUserTurns: 0`, which makes CSA classify the lone user turn as
   * SHORT_ASCII.
   */
  async function createSessionFile(
    projectsDir: string,
    sessionId: string,
    opts: {
      project?: string;
      lines?: number;
      ageMs?: number;
      subDir?: string;
      /** Set true to make the user turn SHORT_ASCII (effectiveUserTurns=0). */
      noEffectiveTurn?: boolean;
    } = {},
  ): Promise<string> {
    const lines = opts.lines ?? 5;
    return await writeSessionFixture(dirname(projectsDir), {
      sessionId,
      projectSlug: opts.subDir ?? "default-project",
      cwd: opts.project ?? "/tmp/test-project",
      userTurns: 1,
      effectiveUserTurns: opts.noEffectiveTurn ? 0 : 1,
      assistantTurns: Math.max(0, lines - 1),
      ageMs: opts.ageMs ?? 3 * 60 * 60 * 1000,
    });
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "session-enqueue-test-"));
    claudeDir = join(tempDir, ".claude");
    dotClaude = claudeDir;
    await mkdir(join(claudeDir, "projects"), { recursive: true });
    await Bun.write(join(claudeDir, "settings.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Run the real runEnqueue() against a fully-isolated environment.
   * `setup` runs inside the same env scope so any preSeed / fixture writes
   * see the same tempDir / queue.db as the SUT.
   */
  async function runEnqueueIsolated(
    opts: {
      claudeDirs?: string[];
      minAgeMinutes?: number;
      recipes?: RecipeFixtureSpec[];
      setup?: () => Promise<void>;
    } = {},
  ): Promise<void> {
    const recipes = opts.recipes ?? [{ name: "diary" }];
    await withIsolatedIdeaStorageEnv(tempDir, async () => {
      await writeConfigFixture(tempDir, {
        claudeDirs: opts.claudeDirs ?? [dotClaude],
        minAgeMinutes: opts.minAgeMinutes ?? 120,
      });
      await writeRecipeFixtures(tempDir, recipes);
      if (opts.setup) await opts.setup();
      const { runEnqueue } = await import("./session-enqueue.ts");
      await runEnqueue();
    });
  }

  /** Read entries inside the isolated env (so getStateDir resolves correctly). */
  async function inspect<T>(fn: () => Promise<T>): Promise<T> {
    return await withIsolatedIdeaStorageEnv(tempDir, fn);
  }

  test("claudeDirs の projects ディレクトリが存在しない場合、何もエンキューしない", async () => {
    await runEnqueueIsolated({ claudeDirs: [join(tempDir, "nonexistent")] });
    await inspect(async () => {
      expect(await readAllEntries()).toHaveLength(0);
    });
  });

  test("UUID形式以外のファイル名がフィルタリングされる", async () => {
    const projectsDir = join(claudeDir, "projects");
    const subDir = join(projectsDir, "test-project");
    await mkdir(subDir, { recursive: true });
    await Bun.write(join(subDir, "not-a-uuid.jsonl"), '{"type":"user"}\n');
    await Bun.write(join(subDir, "readme.md"), "# README\n");
    await Bun.write(join(subDir, "abc.jsonl"), '{"type":"user"}\n');
    const validUuid = "12345678-1234-1234-1234-123456789abc";
    await createSessionFile(projectsDir, validUuid, { subDir: "test-project" });

    await runEnqueueIsolated();

    await inspect(async () => {
      const entries = await readAllEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.sessionId).toBe(validUuid);
      expect(entries[0]!.recipeName).toBe("dispatcher");
      expect(entries[0]!.status).toBe("queued");
    });
  });

  test("既に queued の dispatcher エントリは触らない", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId);

    await runEnqueueIsolated({
      setup: async () => {
        await preSeed(sessionId, "dispatcher", "queued", 5);
      },
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("queued");
      expect(entries[0]!.lineCount).toBe(5);
    });
  });

  test("done(dispatcher, 同一行数以上)は触らない", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { lines: 5 });

    await runEnqueueIsolated({
      setup: async () => {
        await preSeed(sessionId, "dispatcher", "done", 5);
      },
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("done");
      expect(entries[0]!.lineCount).toBe(5);
    });
  });

  test("done だが行数が増えたセッションは dispatcher を queued に復帰させる", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { lines: 10 });

    await runEnqueueIsolated({
      setup: async () => {
        await preSeed(sessionId, "dispatcher", "done", 5);
      },
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("queued");
      expect(entries[0]!.lineCount).toBe(10);
    });
  });

  test("failed(dispatcher)は触らない (retry 機構に委譲)", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId);

    await runEnqueueIsolated({
      setup: async () => {
        await preSeed(sessionId, "dispatcher", "failed", 0, "boom");
      },
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("failed");
    });
  });

  test("正常な enqueue は (session, 'dispatcher') を 1 件 queued する", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId);

    await runEnqueueIsolated();

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.recipeName).toBe("dispatcher");
      expect(entries[0]!.status).toBe("queued");
      expect(entries[0]!.lineCount).toBe(5);
    });
  });

  test("effectiveUserTurns=0 セッションは全 matchesRecipe について markSkipped(no_effective_turn) を記録する", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { noEffectiveTurn: true, lines: 3 });

    await runEnqueueIsolated({
      recipes: [{ name: "diary" }, { name: "review" }],
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries.map((e) => e.recipeName).sort()).toEqual(["diary", "review"]);
      for (const e of entries) {
        expect(e.status).toBe("skipped");
        expect(e.reason).toBe("no_effective_turn");
        expect(e.lineCount).toBe(3);
      }
    });
  });

  test("effectiveUserTurns=0 でも既に done(diary, lineCount>=session) なら触らない (事前フィルタ)", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { noEffectiveTurn: true, lines: 5 });

    await runEnqueueIsolated({
      setup: async () => {
        await preSeed(sessionId, "diary", "done", 5);
      },
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.recipeName).toBe("diary");
      expect(entries[0]!.status).toBe("done");
    });
  });

  test("matchesRecipe を通過する recipe が 1 つもないセッションは何もエンキューしない", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, {
      project: "/home/user/other-project",
    });

    await runEnqueueIsolated({
      recipes: [{ name: "diary", match: { project: "**/special-project/**" } }],
    });

    await inspect(async () => {
      expect(await readAllEntries()).toHaveLength(0);
    });
  });

  test("minAge 未満のセッションは何もエンキューしない", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { ageMs: 30 * 60 * 1000 });

    await runEnqueueIsolated({ minAgeMinutes: 120 });

    await inspect(async () => {
      expect(await readAllEntries()).toHaveLength(0);
    });
  });

  test("複数セッション x 複数レシピは dispatcher 1 件/session に集約される", async () => {
    const projectsDir = join(claudeDir, "projects");
    const session1 = "11111111-1111-1111-1111-111111111111";
    const session2 = "22222222-2222-2222-2222-222222222222";
    await createSessionFile(projectsDir, session1, { subDir: "proj-a" });
    await createSessionFile(projectsDir, session2, { subDir: "proj-b" });

    await runEnqueueIsolated({
      recipes: [{ name: "diary" }, { name: "review" }],
    });

    await inspect(async () => {
      const entries = await readAllEntries();
      expect(entries).toHaveLength(2);
      const keys = entries.map((e) => `${e.sessionId}.${e.recipeName}`).sort();
      expect(keys).toEqual([`${session1}.dispatcher`, `${session2}.dispatcher`]);
      for (const e of entries) expect(e.status).toBe("queued");
    });
  });

  test("レシピが空の場合は CliError を throw する", async () => {
    await expect(runEnqueueIsolated({ recipes: [] })).rejects.toThrow(/recipe/);
  });

  test("レシピが空の場合のエラーメッセージに次のアクション案内が含まれる", async () => {
    try {
      await runEnqueueIsolated({ recipes: [] });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("recipe-*.md");
      expect((err as Error).message).toContain("config-examples/");
    }
  });

  test("複数のclaudeDirsを走査する", async () => {
    const claudeDir2 = join(tempDir, ".claude2");
    await mkdir(join(claudeDir2, "projects"), { recursive: true });
    await Bun.write(join(claudeDir2, "settings.json"), "{}");

    const session1 = "11111111-1111-1111-1111-111111111111";
    const session2 = "22222222-2222-2222-2222-222222222222";
    await createSessionFile(join(claudeDir, "projects"), session1, { subDir: "proj-a" });
    await createSessionFile(join(claudeDir2, "projects"), session2, { subDir: "proj-b" });

    await runEnqueueIsolated({ claudeDirs: [claudeDir, claudeDir2] });

    await inspect(async () => {
      const sessionIds = (await readAllEntries()).map((e) => e.sessionId).sort();
      expect(sessionIds).toContain(session1);
      expect(sessionIds).toContain(session2);
    });
  });

  test("done(dispatcher) の行数が多い場合はスキップされる（doneLines >= sessionLines）", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { lines: 5 });

    await runEnqueueIsolated({
      setup: async () => {
        await preSeed(sessionId, "dispatcher", "done", 100);
      },
    });

    await inspect(async () => {
      const entries = await readEntries(sessionId);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("done");
      expect(entries[0]!.lineCount).toBe(100);
    });
  });

  test("レシピのminTurns条件でフィルタリングされる", async () => {
    const projectsDir = join(claudeDir, "projects");
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await createSessionFile(projectsDir, sessionId, { lines: 5 });

    await runEnqueueIsolated({
      recipes: [{ name: "diary", match: { min_turns: 10 } }],
    });

    await inspect(async () => {
      expect(await readAllEntries()).toHaveLength(0);
    });
  });
});
