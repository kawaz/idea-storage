import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  withIsolatedIdeaStorageEnv,
  writeConfigFixture,
  writeRecipeFixtures,
  writeSessionFixture,
} from "../lib/test-fixtures.ts";

// Policy: no mock.module() anywhere in this file. config / recipe / paths /
// queue / rate-limit / spawn-timeout (= CSA spawn) are all real modules
// exercised against a temp on-disk state. claude-runner — the only true
// external API — is injected via the `_runClaude?: ClaudeRunner` DI hook on
// ProcessSessionInput / processChunked (DR-0009 Phase 3 step 3-e). This
// avoids the bun-test 1.3.x dynamic-import mock leak documented in
// docs/journal/2026-05-31-mock-removal-real-cause.md.
//
// DR-0009 Phase 4: this file is now the runProcess() E2E driver test only.
// Sibling files cover the focused units:
//   - session-process.prompts.test.ts   buildSectionPrompt / buildSynthesisPrompt
//   - session-process.chunked.test.ts   processChunked (success/retry/abort/single)
//   - session-process.timeline.test.ts  trimTimelineForFork + CSA timeline validators
//   - session-process.session.test.ts   processSession (redact / fork-guard / 0600)

// Use valid UUID-format session IDs for the new validation logic.
const MISSING_SID = "11111111-1111-4111-a111-111111111111";
const EMPTY_SID = "22222222-2222-4222-a222-222222222222";
const NORECIPE_SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface ReadEntry {
  sessionId: string;
  recipeName: string;
  status: string;
  reason: string | null;
  lineCount: number | null;
}

describe("session-process", () => {
  let tempDir: string;
  let claudeDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "session-process-test-"));
    claudeDir = join(tempDir, ".claude");
    await mkdir(join(claudeDir, "projects"), { recursive: true });
    await Bun.write(join(claudeDir, "settings.json"), "{}");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Read queue_entries for a given session. */
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

  async function enqueueDirect(
    sessionId: string,
    recipeName: string,
    lineCount = 1,
  ): Promise<void> {
    const { enqueue } = await import("../lib/queue/queue.ts");
    await enqueue(sessionId, recipeName, lineCount);
  }

  async function runProcessIsolated(
    opts: {
      setup?: () => Promise<void>;
      recipes?: Array<{ name: string; prompt?: string }>;
      /**
       * When true, neither config.ts nor recipe-*.md files are written under
       * <tempDir>/.config/idea-storage/. The config dir thus doesn't exist at
       * all, so the real loadRecipesOrFail() throws CliError (matching the
       * production "missing config dir" scenario).
       */
      noRecipeDir?: boolean;
    } = {},
  ): Promise<Awaited<ReturnType<typeof import("./session-process.ts").runProcess>>> {
    const recipes = opts.recipes ?? [{ name: "diary", prompt: "Write a diary" }];
    return await withIsolatedIdeaStorageEnv(tempDir, async () => {
      if (!opts.noRecipeDir) {
        await writeConfigFixture(tempDir, {
          claudeDirs: [claudeDir],
          minAgeMinutes: 0,
        });
        await writeRecipeFixtures(tempDir, recipes);
      }
      // When noRecipeDir is true, leave <tempDir>/.config absent so
      // loadConfig falls back to defaults (claudeDirs=[$HOME/.claude] which
      // = our tempDir/.claude) and loadRecipes throws ENOENT → CliError.
      if (opts.setup) await opts.setup();
      const { runProcess } = await import("./session-process.ts");
      return await runProcess();
    });
  }

  async function inspect<T>(fn: () => Promise<T>): Promise<T> {
    return await withIsolatedIdeaStorageEnv(tempDir, fn);
  }

  test("calls markFailed when session file is not found", async () => {
    // Enqueue a (session, recipe) row for a session whose JSONL file doesn't
    // exist. runProcess should pull it, fail to locate the file, and markFailed.
    const result = await runProcessIsolated({
      setup: async () => {
        await enqueueDirect(MISSING_SID, "diary", 1);
      },
    });
    expect(result).toBe("failed");

    await inspect(async () => {
      const entries = await readEntries(MISSING_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("failed");
    });
  });

  test("レシピが見つからない場合のエラーメッセージに次のアクション案内が含まれる", async () => {
    // Make a real session file, enqueue it, but provide no recipes dir.
    await writeSessionFixture(claudeDir, {
      sessionId: NORECIPE_SID,
      projectSlug: "test-project",
      cwd: "/tmp/test-project",
      userTurns: 1,
      assistantTurns: 2,
      ageMs: 3 * 60 * 60 * 1000,
    });

    try {
      await runProcessIsolated({
        noRecipeDir: true,
        setup: async () => {
          await enqueueDirect(NORECIPE_SID, "diary", 1);
        },
      });
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("recipe-*.md");
      expect((err as Error).message).toContain("config-examples/");
    }
  });

  test("calls markSkipped with empty_session when session file is empty (0 lines)", async () => {
    // Create empty session JSONL file (0 bytes).
    const projectDir = join(claudeDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${EMPTY_SID}.jsonl`), "");

    // Note: no claude-runner mock needed — processSession short-circuits on
    // empty_session (meta.lineCount === 0) before any LLM call. Avoiding
    // mock.module here also prevents the dynamic-import leak documented in
    // docs/journal/2026-05-31-mock-removal-real-cause.md.

    const result = await runProcessIsolated({
      setup: async () => {
        await enqueueDirect(EMPTY_SID, "diary", 1);
      },
    });

    expect(result).toBe("processed");
    await inspect(async () => {
      const entries = await readEntries(EMPTY_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("skipped");
      expect(entries[0]!.reason).toBe("empty_session");
    });
  });

  test("returns empty when queue is empty", async () => {
    const result = await runProcessIsolated();
    expect(result).toBe("empty");
  });
});
