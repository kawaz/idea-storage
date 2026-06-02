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

// Policy: no mock.module() anywhere in this file. config / recipe / paths /
// queue / rate-limit-store / CSA spawn are all the real modules exercised
// against a temp on-disk state. The only external dependency we can't hit —
// the real claude CLI — is injected via the `_runClaude?: ClaudeRunner` DI
// hook on RunConvertInput (DR-0009 Phase 3 step 3-g), which runConvert
// forwards to processSession. mock.module() of claude-runner.ts was retired
// here for the same reason it was retired from session-process.test.ts:
// dynamic-import mock leaks across test files (see journal 2026-06-01).
//
// - config.ts:    real loadConfig() reads <tempDir>/.config/idea-storage/config.ts
// - recipe.ts:    real loadRecipes() reads recipe-*.md from the same dir
// - paths.ts:     real getStateDir() / getDataDir() resolve via XDG_*_HOME
// - queue.ts:     real queue.db at <tempDir>/state/idea-storage/queue.db
// - CSA spawn:    real claude-session-analysis bin reads fixture jsonl under
//                 <tempDir>/.claude/projects/<slug>/ (HOME / CLAUDE_CONFIG_DIR)
// - rate-limit:   real recordObservation / getLatestObservations on tempDir DB
// - claude-runner: replaced via _runClaude DI in runConvertIsolated below.

const fakeRunClaude = async () => "# Generated content\n## まとめ\nMocked\n";

const VALID_SID = "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";

interface ReadEntry {
  sessionId: string;
  recipeName: string;
  status: string;
  reason: string | null;
  lineCount: number | null;
}

describe("session-convert", () => {
  let tempDir: string;
  let claudeDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "session-convert-test-"));
    // Dotted name so CSA's `$HOME/.claude*/settings.json` glob picks it up.
    claudeDir = join(tempDir, ".claude");
    dataDir = join(tempDir, "data", "idea-storage");
    await mkdir(join(claudeDir, "projects"), { recursive: true });
    await Bun.write(join(claudeDir, "settings.json"), "{}");
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Read all queue_entries rows joined with sessions/recipes. */
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

  /** Pre-claim an entry to put it into 'processing' (only state in which real claim returns claimed=false). */
  async function preClaim(sessionId: string, recipeName: string): Promise<void> {
    const { claim } = await import("../lib/queue/queue.ts");
    const result = await claim(sessionId, recipeName);
    if (!result.claimed) {
      throw new Error(`preClaim failed to take ownership: prev=${result.prevStatus}`);
    }
  }

  /** Pre-record a rate-limit observation that triggers shouldSkip. */
  async function seedOverPaceObservation(): Promise<void> {
    const { recordObservation } = await import("../lib/rate-limit/rate-limit-store.ts");
    const nowSec = Math.floor(Date.now() / 1000);
    const fiveHourWindowSec = 5 * 3600;
    const elapsedRatio = 0.1;
    const reset = nowSec + fiveHourWindowSec * (1 - elapsedRatio);
    recordObservation({
      ts: nowSec,
      fiveHour: { util: 0.8, reset, status: "ok" },
      sevenDay: null,
      source: "worker",
    });
  }

  async function seedHealthyObservation(): Promise<void> {
    const { recordObservation } = await import("../lib/rate-limit/rate-limit-store.ts");
    const nowSec = Math.floor(Date.now() / 1000);
    recordObservation({
      ts: nowSec,
      fiveHour: { util: 0.05, reset: nowSec + 5 * 3600 * 0.5, status: "ok" },
      sevenDay: null,
      source: "worker",
    });
  }

  /**
   * Thin wrapper over the shared {@link writeSessionFixture} helper. Kept for
   * caller readability; derives the fixture base (= dir containing `projects/`)
   * from the legacy `projectsDir` arg.
   */
  async function createSessionFile(
    projectsDir: string,
    sessionId: string,
    opts: {
      project?: string;
      lines?: number;
      ageMs?: number;
      subDir?: string;
    } = {},
  ): Promise<string> {
    const lines = opts.lines ?? 5;
    return await writeSessionFixture(dirname(projectsDir), {
      sessionId,
      projectSlug: opts.subDir ?? "test-project",
      cwd: opts.project ?? "/tmp/test-project",
      userTurns: 1,
      assistantTurns: Math.max(0, lines - 1),
      ageMs: opts.ageMs ?? 3 * 60 * 60 * 1000,
    });
  }

  /**
   * Run runConvert against a fully-isolated env. Setup runs inside the same
   * env so any fixture writes (preClaim / seedObservation) see the same DB.
   */
  async function runConvertIsolated(
    args: { sessionId: string; recipeName: string; force?: boolean; waitTimeoutMs?: number },
    opts: {
      recipes?: RecipeFixtureSpec[];
      noRecipeDir?: boolean;
      setup?: () => Promise<void>;
    } = {},
  ): Promise<Awaited<ReturnType<typeof import("./session-convert.ts").runConvert>>> {
    const recipes = opts.recipes ?? [
      { name: "diary", onExisting: "skip", prompt: "Write a diary" },
    ];
    return await withIsolatedIdeaStorageEnv(tempDir, async () => {
      await writeConfigFixture(tempDir, {
        claudeDirs: [claudeDir],
        minAgeMinutes: 0,
      });
      if (!opts.noRecipeDir) {
        await writeRecipeFixtures(tempDir, recipes);
      }
      if (opts.setup) await opts.setup();
      const { runConvert } = await import("./session-convert.ts");
      return await runConvert({ ...args, _runClaude: fakeRunClaude });
    });
  }

  async function inspect<T>(fn: () => Promise<T>): Promise<T> {
    return await withIsolatedIdeaStorageEnv(tempDir, fn);
  }

  test("正常系: 引数で指定した session_id と recipe で処理が走り、出力ファイルが生成される", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated({ sessionId: VALID_SID, recipeName: "diary" });

    expect(result.kind).toBe("processed");
    if (result.kind === "processed") {
      // Output file path follows {dataDir}/{recipe}/YYYY/MM/DD/{ts}.{sid}.md
      expect(result.outputFile).toContain(`${dataDir}/diary/`);
      expect(result.outputFile).toContain(`.${VALID_SID}.md`);
      expect(await Bun.file(result.outputFile).exists()).toBe(true);
    }

    // markDone was recorded
    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.recipeName).toBe("diary");
      expect(entries[0]!.status).toBe("done");
    });
  });

  test("session_file が見つからない場合のエラー", async () => {
    // No session file created.
    await expect(runConvertIsolated({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(
      /session file not found/,
    );

    // No entry should have been claimed / created.
    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(0);
    });
  });

  test("recipe が見つからない場合のエラー", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    await expect(
      runConvertIsolated(
        { sessionId: VALID_SID, recipeName: "diary" },
        { recipes: [{ name: "other", prompt: "other" }] },
      ),
    ).rejects.toThrow(/recipe not found/);

    await inspect(async () => {
      expect(await readEntries(VALID_SID)).toHaveLength(0);
    });
  });

  test("recipe ディレクトリが存在しない場合は CliError", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const { CliError } = await import("../lib/errors.ts");
    await expect(
      runConvertIsolated({ sessionId: VALID_SID, recipeName: "diary" }, { noRecipeDir: true }),
    ).rejects.toThrow(CliError);
  });

  test("onExisting=skip でも強制実行される (forceProcess=true)", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);
    // recipe.onExisting defaults to 'skip' in our default fixture; convert
    // should still run.

    const result = await runConvertIsolated({ sessionId: VALID_SID, recipeName: "diary" });
    expect(result.kind).toBe("processed");

    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("done");
    });
  });

  /**
   * Wait until runConvert's claim() has run and observed the pre-seeded
   * 'processing' state, so we can deterministically transition the row to a
   * terminal state during convert's waitForCompletion poll loop.
   *
   * Detection trick: claim() records a 'claimed' history row only when it
   * succeeds. When it fails (entry already processing), it does not. So
   * "convert's claim attempted and failed" can be detected by polling the
   * queue_history table for a 'convert_wait_for_other' log... actually
   * simpler: poll the convert log via a synchronization variable. Here we
   * accept a small fixed delay (poll interval is 1s in waitForCompletion, so
   * 200ms+ gives convert enough time to reach the wait loop on average).
   */
  // claim() semantics: status='processing' fails the claim (→ wait flow);
  // status='done'/'failed'/'skipped' all SUCCEED (re-processing semantics).
  // The wait-loop's polling behavior is exercised by waitForCompletion's own
  // unit tests in queue-state.test.ts. Here we only assert what runConvert
  // does for each prior queue state. The timeout case is the one scenario
  // that doesn't need parallel coordination: preClaim leaves status=processing
  // and runConvert simply waits until the deadline.

  test("entry done 後の再 convert は正常パスで上書き処理する", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated(
      { sessionId: VALID_SID, recipeName: "diary" },
      {
        setup: async () => {
          await preClaim(VALID_SID, "diary");
          const { markDone } = await import("../lib/queue/queue.ts");
          await markDone(VALID_SID, "diary", 42, null);
        },
      },
    );

    expect(result.kind).toBe("processed");
    if (result.kind === "processed") {
      expect(result.outputFile).toContain(`${dataDir}/diary/`);
      expect(result.outputFile).toContain(`.${VALID_SID}.md`);
    }
  });

  test("entry failed 後の再 convert も claim 成功して再処理する", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated(
      { sessionId: VALID_SID, recipeName: "diary" },
      {
        setup: async () => {
          await preClaim(VALID_SID, "diary");
          const { markFailed } = await import("../lib/queue/queue.ts");
          await markFailed(VALID_SID, "diary", "boom");
        },
      },
    );

    expect(result.kind).toBe("processed");
  });

  test("claim 失敗（processing のまま）→ waitForCompletion で timeout → 例外", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    // No outside transition: the entry stays processing, poll times out.
    // This is the one wait-flow scenario that needs no parallel coordination.
    await expect(
      runConvertIsolated(
        { sessionId: VALID_SID, recipeName: "diary", waitTimeoutMs: 100 },
        {
          setup: async () => {
            await preClaim(VALID_SID, "diary");
          },
        },
      ),
    ).rejects.toThrow(/timeout/i);
  });

  test("空セッション (lineCount=0) は markSkipped で処理される (markFailed ではない)", async () => {
    const projectsDir = join(claudeDir, "projects");
    const dir = join(projectsDir, "test-project");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${VALID_SID}.jsonl`), "");

    const result = await runConvertIsolated({ sessionId: VALID_SID, recipeName: "diary" });

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("empty_session");
    }

    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("skipped");
      expect(entries[0]!.reason).toBe("empty_session");
    });
  });

  test("不正な session_id (非UUID) は CLI バリデータで CliError として弾かれる", async () => {
    const { validateSessionId } = await import("../lib/validate.ts");
    const { CliError } = await import("../lib/errors.ts");
    expect(() => validateSessionId("not-a-uuid")).toThrow(CliError);
    expect(() => validateSessionId("not-a-uuid")).toThrow(/Invalid session ID/);
  });

  test("不正な recipe 名は CLI バリデータで CliError として弾かれる", async () => {
    const { validateRecipeName } = await import("../lib/validate.ts");
    const { CliError } = await import("../lib/errors.ts");
    expect(() => validateRecipeName("BAD-RECIPE")).toThrow(CliError);
    expect(() => validateRecipeName("BAD-RECIPE")).toThrow(/Invalid recipe name/);
  });

  // --- Rate-limit gate tests ---

  test("rate-limit 該当時は CliError で弾かれ、entry は作成されない", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const { CliError } = await import("../lib/errors.ts");
    await expect(
      runConvertIsolated(
        { sessionId: VALID_SID, recipeName: "diary" },
        { setup: () => seedOverPaceObservation() },
      ),
    ).rejects.toThrow(CliError);

    // Should not have claimed (early bail) — no entry exists.
    await inspect(async () => {
      expect(await readEntries(VALID_SID)).toHaveLength(0);
    });
  });

  test("rate-limit OK の時は通常通り claim → 処理続行", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated(
      { sessionId: VALID_SID, recipeName: "diary" },
      { setup: () => seedHealthyObservation() },
    );

    expect(result.kind).toBe("processed");
    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("done");
    });
  });

  test("--force 指定時は rate-limit 該当でもバイパスして処理続行", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated(
      { sessionId: VALID_SID, recipeName: "diary", force: true },
      { setup: () => seedOverPaceObservation() },
    );

    expect(result.kind).toBe("processed");
    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("done");
    });
  });

  test("観測なし (no-observation) の時は通常通り処理続行", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated({ sessionId: VALID_SID, recipeName: "diary" });

    expect(result.kind).toBe("processed");
    await inspect(async () => {
      const entries = await readEntries(VALID_SID);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.status).toBe("done");
    });
  });

  test("entry skipped 後の再 convert も claim 成功して再処理する", async () => {
    const projectsDir = join(claudeDir, "projects");
    await createSessionFile(projectsDir, VALID_SID);

    const result = await runConvertIsolated(
      { sessionId: VALID_SID, recipeName: "diary" },
      {
        setup: async () => {
          await preClaim(VALID_SID, "diary");
          const { markSkipped } = await import("../lib/queue/queue.ts");
          await markSkipped(VALID_SID, "diary", "empty_session", 0);
        },
      },
    );

    expect(result.kind).toBe("processed");
  });
});
