import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  withIsolatedIdeaStorageEnv,
  writeConfigFixture,
  writeRecipeFixtures,
} from "../lib/test-fixtures.ts";

// Policy: no internal mock.module() at file scope. config / recipe / paths /
// queue / rate-limit / spawn-timeout (= CSA spawn) are all real modules
// exercised against a temp on-disk state. Only claude-runner is mocked, and
// we mock it inline per-test (NOT at file scope) so that the file-level
// static import of ClaudeAbortError used by processChunked tests below
// keeps pointing at the real class (instanceof checks would break otherwise).

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

  /** Create a minimal JSONL session file with the given UUID. */
  async function createSessionFile(
    sessionId: string,
    opts: {
      project?: string;
      lines?: number;
      ageMs?: number;
      subDir?: string;
    } = {},
  ): Promise<string> {
    const projectsDir = join(claudeDir, "projects");
    const {
      project = "/tmp/test-project",
      lines = 3,
      ageMs = 3 * 60 * 60 * 1000,
      subDir = "test-project",
    } = opts;
    const dir = join(projectsDir, subDir);
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${sessionId}.jsonl`);
    const now = Date.now();
    const sessionStart = new Date(now - ageMs).toISOString();
    const jsonlLines: string[] = [];
    jsonlLines.push(
      JSON.stringify({
        type: "user",
        timestamp: sessionStart,
        uuid: `${sessionId.slice(0, 8)}-line-0001`,
        sessionId,
        cwd: project,
        message: { role: "user", content: "ユーザの実質的な発言 hello world" },
      }),
    );
    for (let i = 1; i < lines; i++) {
      jsonlLines.push(
        JSON.stringify({
          type: "assistant",
          timestamp: new Date(now - ageMs + i * 1000).toISOString(),
          uuid: `${sessionId.slice(0, 8)}-line-${String(i + 1).padStart(4, "0")}`,
          sessionId,
          message: { role: "assistant", content: [{ type: "text", text: `Resp ${i}` }] },
        }),
      );
    }
    await Bun.write(filePath, jsonlLines.join("\n") + "\n");
    const mtime = new Date(now - ageMs);
    utimesSync(filePath, mtime, mtime);
    return filePath;
  }

  /** Read queue_entries for a given session. */
  async function readEntries(sessionId: string): Promise<ReadEntry[]> {
    const { getDb } = await import("../lib/queue.ts");
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
    const { enqueue } = await import("../lib/queue.ts");
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
    await createSessionFile(NORECIPE_SID);

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

    // Inline claude-runner mock to avoid hitting the real claude CLI in the
    // (unlikely) event the code path reached it. Empty session should short-
    // circuit before runClaude though.
    mock.module("../lib/claude-runner.ts", () => ({
      runClaude: mock(async () => "should-not-be-called"),
      ClaudeTimeoutError: class extends Error {
        readonly timeoutMs: number;
        constructor(timeoutMs = 0) {
          super(`timeout ${timeoutMs}`);
          this.timeoutMs = timeoutMs;
        }
      },
      ClaudeAbortError: class extends Error {},
    }));

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
    // No enqueue: queue is empty.
    const result = await runProcessIsolated();
    expect(result).toBe("empty");
  });
});

// --- チャンク分割パスのユニットテスト ---
// These are pure tests that exercise the chunking pipeline via
// _runClaudeOverride. They do NOT touch the real claude-runner or CSA, so
// they don't need any module mocks.
import { buildSectionPrompt, buildSynthesisPrompt } from "./session-process.ts";
import type { TimelineChunk } from "../lib/chunker.ts";

describe("buildSectionPrompt", () => {
  const recipePrompt = "日記を書いてください";
  const sessionInfo =
    "- Session ID: abc123\n- Project: my-project\n- Created: 2025-01-01T00:00:00Z";

  function makeChunk(overrides: Partial<TimelineChunk> = {}): TimelineChunk {
    return {
      index: 0,
      turns: [],
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T01:00:00Z"),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: "1/1 00:00-01:00",
      ...overrides,
    };
  }

  test("レシピの指示がプロンプトに含まれる", () => {
    const chunk = makeChunk();
    const result = buildSectionPrompt(recipePrompt, chunk, "チャンクのテキスト", sessionInfo);
    expect(result).toContain(recipePrompt);
  });

  test("チャンク情報（index, label, turnCount）がプロンプトに含まれる", () => {
    const chunk = makeChunk({ index: 2, label: "1/1-1/2", turnCount: 10 });
    const result = buildSectionPrompt(recipePrompt, chunk, "テキスト", sessionInfo);
    expect(result).toContain("3");
    expect(result).toContain("1/1-1/2");
    expect(result).toContain("10");
  });

  test("セッション情報がプロンプトに含まれる", () => {
    const chunk = makeChunk();
    const result = buildSectionPrompt(recipePrompt, chunk, "テキスト", sessionInfo);
    expect(result).toContain("abc123");
    expect(result).toContain("my-project");
  });

  test("chunkText がプロンプト末尾に含まれる", () => {
    const chunk = makeChunk();
    const chunkText = "ユーザーがコードをレビューしました";
    const result = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo);
    expect(result).toContain(chunkText);
  });

  test("セクション見出しの指示が含まれる", () => {
    const chunk = makeChunk();
    const result = buildSectionPrompt(recipePrompt, chunk, "テキスト", sessionInfo);
    expect(result).toContain("セクション見出し");
  });
});

describe("buildSynthesisPrompt", () => {
  const sessionInfo =
    "- Session ID: abc123\n- Project: my-project\n- Created: 2025-01-01T00:00:00Z";

  test("全セクションがプロンプトに含まれる", () => {
    const sections = ["## セクション1\n内容A", "## セクション2\n内容B"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("内容A");
    expect(result).toContain("内容B");
  });

  test("セクション番号が付与される", () => {
    const sections = ["セクションA", "セクションB", "セクションC"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("セクション 1");
    expect(result).toContain("セクション 2");
    expect(result).toContain("セクション 3");
  });

  test("セッション情報がプロンプトに含まれる", () => {
    const sections = ["内容"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("abc123");
    expect(result).toContain("my-project");
  });

  test("タイトルとまとめの指示が含まれる", () => {
    const sections = ["内容"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("タイトル");
    expect(result).toContain("まとめ");
  });

  test("Markdown出力指示が含まれる", () => {
    const sections = ["内容"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("Markdown");
  });
});

// --- processChunked のユニットテスト ---
import { processChunked } from "./session-process.ts";
import { ClaudeAbortError } from "../lib/claude-runner.ts";

describe("processChunked", () => {
  const dummyMeta: import("../types/index.ts").SessionMeta = {
    id: "test-session-id",
    filePath: "/tmp/test-session.jsonl",
    ageSec: 3600,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "test-project",
    lineCount: 100,
    userTurns: 5,
    effectiveUserTurns: 3,
  };

  function makeChunks(
    count: number,
    bytesEach = 1000,
  ): import("../lib/chunker.ts").TimelineChunk[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      turns: [],
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T01:00:00Z"),
      bytes: bytesEach,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: `chunk-${i}`,
    }));
  }

  test("全チャンク成功時は正常に合成結果を返す", async () => {
    const chunks = makeChunks(2);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    let callCount = 0;
    const result = await processChunked(
      convText,
      chunks,
      recipePrompt,
      "test-session-id",
      dummyMeta,
      undefined,
      async (_options) => {
        callCount++;
        if (callCount <= 2) {
          return `## Section ${callCount}\nContent ${callCount}`;
        }
        return "# Title\n## Section 1\nContent 1\n## Section 2\nContent 2\n## まとめ\nOverall summary";
      },
    );

    expect(callCount).toBe(3);
    expect(result).toContain("Title");
    expect(result).toContain("まとめ");
  });

  test("1チャンク失敗 → リトライ成功で合成まで完了する", async () => {
    const chunks = makeChunks(3);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    const callLog: string[] = [];
    let chunk1FailCount = 0;

    const result = await processChunked(
      convText,
      chunks,
      recipePrompt,
      "test-session-id",
      dummyMeta,
      undefined,
      async (options) => {
        const prompt = options.prompt;
        if (prompt.includes("セクション一覧")) {
          callLog.push("synthesis");
          return "# Title\n## まとめ\nSummary";
        }
        if (prompt.includes("チャンク: 2/")) {
          chunk1FailCount++;
          if (chunk1FailCount === 1) {
            callLog.push("chunk1-fail");
            throw new Error("API error");
          }
          callLog.push("chunk1-retry-success");
          return "## Section 2\nRetried content";
        }
        callLog.push("chunk-success");
        return "## Section\nContent";
      },
    );

    expect(callLog).toContain("chunk1-fail");
    expect(callLog).toContain("chunk1-retry-success");
    expect(callLog).toContain("synthesis");
    expect(result).toContain("Title");
  });

  test("1チャンク失敗 → リトライも失敗 → 分割なしフォールバック成功", async () => {
    const convText = "short timeline text";
    const chunks = makeChunks(2, 500);
    const recipePrompt = "test prompt";

    let chunk0FailCount = 0;
    const callLog: string[] = [];

    const result = await processChunked(
      convText,
      chunks,
      recipePrompt,
      "test-session-id",
      dummyMeta,
      undefined,
      async (options) => {
        const prompt = options.prompt;
        if (prompt.includes("セクション一覧")) {
          callLog.push("synthesis");
          return "# Synthesis result";
        }
        if (prompt.includes("チャンク: 1/")) {
          chunk0FailCount++;
          callLog.push(`chunk0-fail-${chunk0FailCount}`);
          throw new Error("persistent API error");
        }
        if (!prompt.includes("チャンク:")) {
          callLog.push("fallback-unsplit");
          return "# Fallback result\nFull content";
        }
        callLog.push("chunk-success");
        return "## Section\nContent";
      },
    );

    expect(chunk0FailCount).toBe(2);
    expect(callLog).toContain("fallback-unsplit");
    expect(callLog).not.toContain("synthesis");
    expect(result).toContain("Fallback result");
  });

  test("全チャンク失敗 → リトライ失敗 → 分割なしフォールバック失敗 → 例外", async () => {
    const convText = "short timeline text";
    const chunks = makeChunks(2, 500);
    const recipePrompt = "test prompt";

    const callLog: string[] = [];

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        "test-session-id",
        dummyMeta,
        undefined,
        async (options) => {
          const prompt = options.prompt;
          if (!prompt.includes("チャンク:")) {
            callLog.push("fallback-unsplit-fail");
            throw new Error("fallback also failed");
          }
          callLog.push("chunk-fail");
          throw new Error("API error");
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("fallback also failed");
    }

    const chunkFails = callLog.filter((l) => l === "chunk-fail").length;
    expect(chunkFails).toBe(4);
    expect(callLog).toContain("fallback-unsplit-fail");
  });

  test("全チャンク失敗 → テキストが大きい場合はフォールバックをスキップして例外", async () => {
    const convText = "x".repeat(40000);
    const chunks = makeChunks(2, 20000);
    const recipePrompt = "test prompt";

    const callLog: string[] = [];

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        "test-session-id",
        dummyMeta,
        undefined,
        async (_options) => {
          callLog.push("chunk-fail");
          throw new Error("API error");
        },
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("API error");
    }

    expect(callLog.length).toBe(4);
    expect(callLog.every((l) => l === "chunk-fail")).toBe(true);
  });

  test("一部チャンク成功 + 失敗チャンクのリトライ成功 → 成功結果が保持される", async () => {
    const chunks = makeChunks(3);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    let chunk2CallCount = 0;

    const result = await processChunked(
      convText,
      chunks,
      recipePrompt,
      "test-session-id",
      dummyMeta,
      undefined,
      async (options) => {
        const prompt = options.prompt;
        if (prompt.includes("セクション一覧")) {
          return "# Synthesized\n## まとめ\nAll good";
        }
        if (prompt.includes("チャンク: 3/")) {
          chunk2CallCount++;
          if (chunk2CallCount === 1) {
            throw new Error("transient error");
          }
          return "## Section 3\nRetried chunk 3";
        }
        const match = prompt.match(/チャンク: (\d+)\//);
        const idx = match ? match[1] : "?";
        return `## Section ${idx}\nOriginal content ${idx}`;
      },
    );

    expect(chunk2CallCount).toBe(2);
    expect(result).toContain("Synthesized");
  });

  test("DR-0009 Phase 1 補強 (codex review #2): chunked synthesis prompt は section LLM 出力を redact する", async () => {
    const ghToken = "ghp_" + "d".repeat(36);
    const chunks = makeChunks(2);

    let callCount = 0;
    let synthesisPrompt = "";
    await processChunked(
      "dummy timeline text",
      chunks,
      "test prompt",
      "test-session-id",
      dummyMeta,
      undefined,
      async (options) => {
        callCount++;
        if (callCount <= 2) {
          // section LLM が transcribe / hallucinate した secret を含む出力
          return `## Section\nLeaked content with token=${ghToken}`;
        }
        // synthesis LLM 呼び出し: prompt を capture
        synthesisPrompt = options.prompt;
        return "## Synthesized\nResult";
      },
    );

    expect(synthesisPrompt).not.toContain(ghToken);
    expect(synthesisPrompt).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  test("DR-0009 Phase 1 補強 (codex review #3): meta.project に secret を含むと section / synthesis prompt 両方で redact される", async () => {
    const akia = "AKIAIOSFODNN7EXAMPLE";
    const metaWithSecret: import("../types/index.ts").SessionMeta = {
      ...dummyMeta,
      project: `/tmp/repo-${akia}`,
    };
    const chunks = makeChunks(2);

    let firstSectionPrompt = "";
    let synthesisPrompt = "";
    let callCount = 0;
    await processChunked(
      "dummy timeline text",
      chunks,
      "test prompt",
      "test-session-id",
      metaWithSecret,
      undefined,
      async (options) => {
        callCount++;
        if (callCount === 1) firstSectionPrompt = options.prompt;
        if (callCount <= 2) return "section result";
        synthesisPrompt = options.prompt;
        return "synth";
      },
    );

    expect(firstSectionPrompt).not.toContain(akia);
    expect(firstSectionPrompt).toContain("[REDACTED:AWS_ACCESS_KEY]");
    expect(synthesisPrompt).not.toContain(akia);
    expect(synthesisPrompt).toContain("[REDACTED:AWS_ACCESS_KEY]");
  });
});

// --- processChunked の外部 signal 連携テスト ---

describe("processChunked external signal propagation", () => {
  const dummyMeta: import("../types/index.ts").SessionMeta = {
    id: "test-session-id",
    filePath: "/tmp/test-session.jsonl",
    ageSec: 3600,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "test-project",
    lineCount: 100,
    userTurns: 5,
    effectiveUserTurns: 3,
  };

  function makeChunks(count: number): import("../lib/chunker.ts").TimelineChunk[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      turns: [],
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T01:00:00Z"),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: `chunk-${i}`,
    }));
  }

  test("外部signalがabortされるとprocessChunked内のrunClaude呼び出しもabortされる", async () => {
    const chunks = makeChunks(2);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    const externalController = new AbortController();
    const receivedSignals: AbortSignal[] = [];

    setTimeout(() => externalController.abort(), 50);

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        "test-session-id",
        dummyMeta,
        undefined,
        async (options) => {
          if (options.signal) {
            receivedSignals.push(options.signal);
          }
          return new Promise<string>((resolve, reject) => {
            if (options.signal?.aborted) {
              reject(new ClaudeAbortError());
              return;
            }
            options.signal?.addEventListener("abort", () => {
              reject(new ClaudeAbortError());
            });
          });
        },
        externalController.signal,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAbortError);
    }

    expect(receivedSignals.length).toBe(2);
    for (const sig of receivedSignals) {
      expect(sig.aborted).toBe(true);
    }
  });

  test("外部signalがabortされると合成フェーズもキャンセルされる", async () => {
    const chunks = makeChunks(2);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    const externalController = new AbortController();
    let sectionCount = 0;

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        "test-session-id",
        dummyMeta,
        undefined,
        async (options) => {
          if (!options.prompt.includes("セクション一覧")) {
            sectionCount++;
            return `## Section ${sectionCount}\nContent`;
          }
          externalController.abort();
          if (options.signal?.aborted) {
            throw new ClaudeAbortError();
          }
          return "should not reach here";
        },
        externalController.signal,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAbortError);
    }

    expect(sectionCount).toBe(2);
  });

  test("外部signalがabort済みの場合、リトライやフォールバックをスキップして即座にClaudeAbortError", async () => {
    const chunks = makeChunks(2);
    const convText = "short text";
    const recipePrompt = "test prompt";

    const externalController = new AbortController();
    externalController.abort();

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        "test-session-id",
        dummyMeta,
        undefined,
        async (options) => {
          if (options.signal?.aborted) {
            throw new ClaudeAbortError();
          }
          return "## Section\nContent";
        },
        externalController.signal,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAbortError);
    }
  });
});

// --- ProcessResult 型のテスト ---
import type { ProcessResult } from "./session-process.ts";

describe("ProcessResult", () => {
  test("ProcessResult type includes expected values", () => {
    const values: ProcessResult[] = ["processed", "failed", "empty"];
    expect(values).toHaveLength(3);
  });
});

// --- processChunked: チャンク1つの場合 synthesis スキップ ---

describe("processChunked single chunk", () => {
  const dummyMeta: import("../types/index.ts").SessionMeta = {
    id: "test-session-id",
    filePath: "/tmp/test-session.jsonl",
    ageSec: 3600,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "test-project",
    lineCount: 100,
    userTurns: 5,
    effectiveUserTurns: 3,
  };

  function makeChunks(count: number): import("../lib/chunker.ts").TimelineChunk[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      turns: [],
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T01:00:00Z"),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: `chunk-${i}`,
    }));
  }

  test("チャンク1つの場合はsynthesisフェーズをスキップし、セクション結果をそのまま返す", async () => {
    const chunks = makeChunks(1);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    const callLog: string[] = [];

    const result = await processChunked(
      convText,
      chunks,
      recipePrompt,
      "test-session-id",
      dummyMeta,
      undefined,
      async (options) => {
        const prompt = options.prompt;
        if (prompt.includes("セクション一覧")) {
          callLog.push("synthesis");
          return "# Synthesized\n## まとめ\nSummary";
        }
        callLog.push("section");
        return "## Section 1\nDirect content";
      },
    );

    expect(callLog).toEqual(["section"]);
    expect(result).toBe("## Section 1\nDirect content");
  });

  test("チャンク2つ以上の場合はsynthesisフェーズが実行される", async () => {
    const chunks = makeChunks(2);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    const callLog: string[] = [];

    await processChunked(
      convText,
      chunks,
      recipePrompt,
      "test-session-id",
      dummyMeta,
      undefined,
      async (options) => {
        const prompt = options.prompt;
        if (prompt.includes("セクション一覧")) {
          callLog.push("synthesis");
          return "# Title\n## まとめ\nSummary";
        }
        callLog.push("section");
        return "## Section\nContent";
      },
    );

    expect(callLog).toEqual(["section", "section", "synthesis"]);
  });
});

// --- redact integration test ---
// Exercises processSession via real CSA (timeline). Only claude-runner is
// mocked, inline, to capture the prompt passed in. We assert redact ran by
// inspecting that captured prompt.

describe("processSession redact integration", () => {
  let workDir: string;
  let redactClaudeDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "redact-integration-"));
    redactClaudeDir = join(workDir, ".claude");
    await mkdir(join(redactClaudeDir, "projects"), { recursive: true });
    await Bun.write(join(redactClaudeDir, "settings.json"), "{}");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("タイムラインに含まれる secret は Claude に渡される前に redact される", async () => {
    const akia = "AKIAIOSFODNN7EXAMPLE";
    const REDACT_SID = "44444444-4444-4444-4444-444444444444";
    // Build a real session file containing the AWS key in a user turn.
    const projectDir = join(redactClaudeDir, "projects", "redact-test-project");
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${REDACT_SID}.jsonl`);
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const line = JSON.stringify({
      type: "user",
      timestamp: startTime,
      uuid: "44444444-line-0001",
      sessionId: REDACT_SID,
      cwd: "/tmp/redact-test-project",
      message: { role: "user", content: `my aws key is ${akia} please be careful` },
    });
    await Bun.write(filePath, line + "\n");

    // Capture prompts via inline claude-runner mock.
    const runClaudeCalls: Array<{ prompt: string }> = [];
    mock.module("../lib/claude-runner.ts", () => ({
      runClaude: mock(async (options: { prompt: string }) => {
        runClaudeCalls.push({ prompt: options.prompt });
        return "# Title\n\nFake article output";
      }),
      ClaudeTimeoutError: class extends Error {
        readonly timeoutMs: number;
        constructor(timeoutMs: number) {
          super(`claude process timed out after ${timeoutMs}ms`);
          this.name = "ClaudeTimeoutError";
          this.timeoutMs = timeoutMs;
        }
      },
      ClaudeAbortError: class extends Error {
        constructor() {
          super("claude process was aborted");
          this.name = "ClaudeAbortError";
        }
      },
    }));

    // Capture log output for the redacted counter assertion.
    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (line2: string) => {
      logLines.push(line2);
    };

    try {
      await withIsolatedIdeaStorageEnv(workDir, async () => {
        // Override HOME / CLAUDE_CONFIG_DIR are already set by helper. But
        // since redact's claudeDir lives under workDir, the helper already
        // points HOME at workDir, so CSA discovers redactClaudeDir.
        const { processSession } = await import("./session-process.ts");
        const { getSessionMeta } = await import("../lib/csa.ts");
        const meta = await getSessionMeta(filePath);
        const result = await processSession({
          sessionId: REDACT_SID,
          recipe: {
            name: "diary",
            filePath: "/tmp/recipe-diary.md",
            match: {},
            onExisting: "append",
            prompt: "Write a diary",
          } as import("../types/index.ts").Recipe,
          meta,
          sessionStats: { turns: 1, bytes: 100 },
          dataDir: join(workDir, "data"),
        });
        expect(result.kind).toBe("processed");
      });
    } finally {
      console.log = origLog;
    }

    expect(runClaudeCalls.length).toBeGreaterThanOrEqual(1);
    const passedPrompt = runClaudeCalls[0]!.prompt;

    expect(passedPrompt).toContain("[REDACTED:AWS_ACCESS_KEY]");
    expect(passedPrompt).not.toContain(akia);

    const redactLog = logLines
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((entry) => entry && entry.msg === "redacted");
    expect(redactLog).toBeDefined();
    expect(redactLog!.count).toBeGreaterThanOrEqual(1);
  });

  test("DR-0009 Phase 1 S2: LLM 出力に含まれる secret も Bun.write 直前で redact される (output 防御層)", async () => {
    const ghToken = "ghp_" + "b".repeat(36);
    const SID = "55555555-5555-4555-9555-555555555555";
    const projectDir = join(redactClaudeDir, "projects", "output-redact-test");
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${SID}.jsonl`);
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const line = JSON.stringify({
      type: "user",
      timestamp: startTime,
      uuid: "55555555-line-0001",
      sessionId: SID,
      cwd: "/tmp/output-redact-test",
      message: { role: "user", content: "普通のセッション本文" },
    });
    await Bun.write(filePath, line + "\n");

    // LLM mock: 出力に secret を含めて返す (= LLM がうっかり transcribe / hallucinate
    // した想定)。output 防御層がここで止めるべき。
    mock.module("../lib/claude-runner.ts", () => ({
      runClaude: mock(async () => `# Article\n\n本文内に token=${ghToken} を含む\n`),
      ClaudeTimeoutError: class extends Error {
        readonly timeoutMs: number;
        constructor(timeoutMs: number) {
          super(`claude process timed out after ${timeoutMs}ms`);
          this.name = "ClaudeTimeoutError";
          this.timeoutMs = timeoutMs;
        }
      },
      ClaudeAbortError: class extends Error {
        constructor() {
          super("claude process was aborted");
          this.name = "ClaudeAbortError";
        }
      },
    }));

    let outputFile = "";
    await withIsolatedIdeaStorageEnv(workDir, async () => {
      const { processSession } = await import("./session-process.ts");
      const { getSessionMeta } = await import("../lib/csa.ts");
      const meta = await getSessionMeta(filePath);
      const result = await processSession({
        sessionId: SID,
        recipe: {
          name: "diary",
          filePath: "/tmp/recipe-diary.md",
          match: {},
          onExisting: "append",
          prompt: "Write a diary",
        } as import("../types/index.ts").Recipe,
        meta,
        sessionStats: { turns: 1, bytes: 100 },
        dataDir: join(workDir, "data"),
      });
      expect(result.kind).toBe("processed");
      if (result.kind === "processed") {
        outputFile = result.outputFile;
      }
    });

    const written = await Bun.file(outputFile).text();
    expect(written).not.toContain(ghToken);
    expect(written).toContain("[REDACTED:GITHUB_TOKEN]");

    // DR-0009 Phase 1 S3: file mode 0600 + parent dir mode 0700 (新規分のみ)
    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(outputFile);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const dirStat = await stat(join(outputFile, ".."));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  test("DR-0009 Phase 1 補強 (codex review #6): _rejected/ 経路でも output redact + mode 0600 + dir mode 0700", async () => {
    const ghToken = "ghp_" + "e".repeat(36);
    const SID = "66666666-6666-4666-9666-666666666666";
    const projectDir = join(redactClaudeDir, "projects", "rejected-redact-test");
    await mkdir(projectDir, { recursive: true });
    const filePath = join(projectDir, `${SID}.jsonl`);
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const line = JSON.stringify({
      type: "user",
      timestamp: startTime,
      uuid: "66666666-line-0001",
      sessionId: SID,
      cwd: "/tmp/rejected-redact-test",
      message: { role: "user", content: "普通のセッション本文" },
    });
    await Bun.write(filePath, line + "\n");

    // mock: 1 回目 (content 生成) は secret 含む output、2 回目 (quality_gate) は rejected
    let callCount = 0;
    mock.module("../lib/claude-runner.ts", () => ({
      runClaude: mock(async () => {
        callCount++;
        if (callCount === 1) {
          return `# Article\n\n本文 token=${ghToken}\n`;
        }
        // quality_gate を rejected に倒す
        return JSON.stringify({ kind: "rejected", reason: "too thin" });
      }),
      ClaudeTimeoutError: class extends Error {
        readonly timeoutMs: number;
        constructor(timeoutMs: number) {
          super(`claude process timed out after ${timeoutMs}ms`);
          this.name = "ClaudeTimeoutError";
          this.timeoutMs = timeoutMs;
        }
      },
      ClaudeAbortError: class extends Error {
        constructor() {
          super("claude process was aborted");
          this.name = "ClaudeAbortError";
        }
      },
    }));

    await withIsolatedIdeaStorageEnv(workDir, async () => {
      const { processSession } = await import("./session-process.ts");
      const { getSessionMeta } = await import("../lib/csa.ts");
      const meta = await getSessionMeta(filePath);
      const result = await processSession({
        sessionId: SID,
        recipe: {
          name: "diary",
          filePath: "/tmp/recipe-diary.md",
          match: {},
          onExisting: "append",
          prompt: "Write a diary",
        } as import("../types/index.ts").Recipe,
        meta,
        sessionStats: { turns: 1, bytes: 100 },
        dataDir: join(workDir, "data"),
      });
      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") {
        expect(result.reason).toBe("quality_rejected");
      }
    });

    // _rejected/ 配下に書かれた md ファイルを探す
    const glob = new Bun.Glob("**/_rejected/**/*.md");
    const rejectedFiles: string[] = [];
    for await (const rel of glob.scan(workDir)) {
      rejectedFiles.push(join(workDir, rel));
    }
    expect(rejectedFiles.length).toBe(1);
    const rejectedFile = rejectedFiles[0]!;

    const written = await Bun.file(rejectedFile).text();
    expect(written).not.toContain(ghToken);
    expect(written).toContain("[REDACTED:GITHUB_TOKEN]");

    const { stat } = await import("node:fs/promises");
    const fileStat = await stat(rejectedFile);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const dirStat = await stat(join(rejectedFile, ".."));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

// --- フォークセッションのタイムライン切り詰めテスト ---
import { trimTimelineForFork } from "./session-process.ts";

describe("trimTimelineForFork", () => {
  const sampleTimeline = `---
session: test-session
---
2024-01-01T10:00:00+09:00 Uaaa11111 User message 1
Some user content

---
2024-01-01T10:00:05+09:00 Tbbb22222 Assistant reply 1
Some assistant content

---
2024-01-01T10:01:00+09:00 Uccc33333 User message 2
More user content

---
2024-01-01T10:01:10+09:00 Tddd44444 Assistant reply 2
More assistant content

---
2024-01-01T11:00:00+09:00 Ueee55555 Fork user message
Fork content here

---
2024-01-01T11:00:10+09:00 Tfff66666 Fork assistant reply
Fork reply content`;

  test("firstNewUuid の先頭8文字でブロックを特定し、そのブロック以降を返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "eee55555-0000-0000-0000-000000000000");
    expect(result).toContain("Ueee55555");
    expect(result).toContain("Fork user message");
    expect(result).toContain("Tfff66666");
    expect(result).toContain("Fork reply content");
    expect(result).not.toContain("Uaaa11111");
    expect(result).not.toContain("Uccc33333");
    expect(result).not.toContain("Tddd44444");
  });

  test("firstNewUuid が空の場合、元のタイムラインをそのまま返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "");
    expect(result).toBe(sampleTimeline);
  });

  test("firstNewUuid がタイムラインに見つからない場合、元のタイムラインをそのまま返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "zzzzzzzz-0000-0000-0000-000000000000");
    expect(result).toBe(sampleTimeline);
  });

  test("firstNewUuid が最初のブロックの場合、ヘッダー以降全て返す", () => {
    const result = trimTimelineForFork(sampleTimeline, "aaa11111-0000-0000-0000-000000000000");
    expect(result).toContain("Uaaa11111");
    expect(result).toContain("Tfff66666");
  });

  test("メッセージ本文中に同じ8文字hexが含まれても誤マッチしない", () => {
    const timelineWithContent = `---
session: test
---
2024-01-01T10:00:00+09:00 Uaaa11111 User message
The commit hash is eee55555abc and some content

---
2024-01-01T11:00:00+09:00 Ueee55555 Real fork point
Fork content here`;

    const result = trimTimelineForFork(timelineWithContent, "eee55555-0000-0000-0000-000000000000");
    expect(result).toContain("Ueee55555");
    expect(result).not.toContain("Uaaa11111");
  });
});

// --- #16 processSession fork guard test ---
// Pure functional test: pass `meta.forkInfo.firstNewUuid=""` and verify the
// early-skip path. Uses a real session JSONL + real CSA for timeline. Inline
// claude-runner mock guards against accidentally hitting the real CLI.

describe("processSession fork guard (#16)", () => {
  let workDir: string;
  let forkClaudeDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "fork-guard-"));
    forkClaudeDir = join(workDir, ".claude");
    await mkdir(join(forkClaudeDir, "projects"), { recursive: true });
    await Bun.write(join(forkClaudeDir, "settings.json"), "{}");
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  test("forkInfo.firstNewUuid が空文字列なら markSkipped 相当の result を返し runClaude は呼ばれない", async () => {
    const FORK_SID = "55555555-5555-4555-a555-555555555555";
    // Write a minimal valid session JSONL so CSA's timeline succeeds.
    const projectDir = join(forkClaudeDir, "projects", "fork-test-project");
    await mkdir(projectDir, { recursive: true });
    const startTime = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const line = JSON.stringify({
      type: "user",
      timestamp: startTime,
      uuid: "55555555-line-0001",
      sessionId: FORK_SID,
      cwd: "/tmp/fork-test-project",
      message: { role: "user", content: "ユーザの実質的な発言 something" },
    });
    await Bun.write(join(projectDir, `${FORK_SID}.jsonl`), line + "\n");

    const runClaudeCalls: Array<{ prompt: string }> = [];
    mock.module("../lib/claude-runner.ts", () => ({
      runClaude: mock(async (options: { prompt: string }) => {
        runClaudeCalls.push({ prompt: options.prompt });
        return "should-not-be-called";
      }),
      ClaudeTimeoutError: class extends Error {
        readonly timeoutMs: number;
        constructor(timeoutMs: number) {
          super(`claude process timed out after ${timeoutMs}ms`);
          this.name = "ClaudeTimeoutError";
          this.timeoutMs = timeoutMs;
        }
      },
      ClaudeAbortError: class extends Error {
        constructor() {
          super("claude process was aborted");
          this.name = "ClaudeAbortError";
        }
      },
    }));

    const baseMeta: import("../types/index.ts").SessionMeta = {
      id: FORK_SID,
      filePath: join(projectDir, `${FORK_SID}.jsonl`),
      ageSec: 3600,
      startTime: new Date(startTime),
      endTime: new Date(startTime),
      project: "fork-test-project",
      lineCount: 10,
      userTurns: 1,
      effectiveUserTurns: 1,
      forkInfo: {
        parentSessionId: "parent-session-id",
        firstNewUuid: "", // empty: fork-no-new-conversation
      },
    };

    await withIsolatedIdeaStorageEnv(workDir, async () => {
      const { processSession } = await import("./session-process.ts");
      const result = await processSession({
        sessionId: FORK_SID,
        recipe: {
          name: "diary",
          filePath: "/tmp/recipe-diary.md",
          match: {},
          onExisting: "append",
          prompt: "Write a diary",
        } as import("../types/index.ts").Recipe,
        meta: baseMeta,
        sessionStats: { turns: 1, bytes: 100 },
        dataDir: join(workDir, "data"),
      });

      expect(result.kind).toBe("skipped");
      if (result.kind === "skipped") {
        expect(result.reason).toBe("fork_no_new_conversation");
        expect(result.lineCount).toBe(baseMeta.lineCount);
      }
    });
    expect(runClaudeCalls.length).toBe(0);
  });
});

// --- #17 CSA timeline validation: unit-test the extracted helpers ---
// CSA `timeline --md` is documented to always emit at least two `---` lines
// (open + close of the YAML frontmatter). Producing exitCode=0 + malformed
// output from real CSA is not achievable, so the malformed-output skip path
// in processSession is asserted at the pure-function level instead.
import { isValidCsaTimeline, countTimelineSeparators } from "../lib/csa.ts";

describe("processSession CSA timeline validation (#17)", () => {
  test("`---` セパレータを 1 つも含まない出力は invalid と判定される", () => {
    const malformed = "error: something went wrong while building timeline\n";
    expect(countTimelineSeparators(malformed)).toBe(0);
    expect(isValidCsaTimeline(malformed)).toBe(false);
  });

  test("`---` が1個しかない（閉じ --- 欠落）出力も invalid と判定される", () => {
    const malformed = `---
command: claude-session-analysis timeline foo
2025-01-01T00:00:00+00:00 Uaaa11111 truncated output`;
    expect(countTimelineSeparators(malformed)).toBe(1);
    expect(isValidCsaTimeline(malformed)).toBe(false);
  });

  test("`---` が2個（frontmatter open + close）以上あれば valid", () => {
    const valid = `---
session: real
---
2025-01-01T00:00:00+00:00 Uaaa11111 hello`;
    expect(countTimelineSeparators(valid)).toBe(2);
    expect(isValidCsaTimeline(valid)).toBe(true);
  });

  test("空文字列は invalid (セパレータ 0 個)", () => {
    expect(countTimelineSeparators("")).toBe(0);
    expect(isValidCsaTimeline("")).toBe(false);
  });
});

// --- #18 processChunked: 外部signal abort と Step 2 リトライの連携 ---

describe("processChunked external abort during retry (#18)", () => {
  const dummyMeta: import("../types/index.ts").SessionMeta = {
    id: "abort-during-retry-session",
    filePath: "/tmp/abort-during-retry.jsonl",
    ageSec: 3600,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "abort-test-project",
    lineCount: 100,
    userTurns: 5,
    effectiveUserTurns: 3,
  };

  function makeChunks(count: number): import("../lib/chunker.ts").TimelineChunk[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      turns: [],
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T01:00:00Z"),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: `chunk-${i}`,
    }));
  }

  test("Step 1 中に externalSignal が abort されても、Step 2 リトライには入らず ClaudeAbortError を throw する", async () => {
    const chunks = makeChunks(2);
    const convText = "short timeline text";
    const recipePrompt = "test prompt";

    const externalController = new AbortController();
    const callLog: string[] = [];
    let chunk0Calls = 0;
    let chunk1Calls = 0;

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        "abort-during-retry-session",
        dummyMeta,
        undefined,
        async (options) => {
          if (options.prompt.includes("チャンク: 1/")) {
            chunk0Calls++;
            callLog.push(`chunk0-call-${chunk0Calls}`);
            externalController.abort();
            return "## Section 1\nContent A";
          }
          if (options.prompt.includes("チャンク: 2/")) {
            chunk1Calls++;
            callLog.push(`chunk1-call-${chunk1Calls}`);
            throw new Error("transient API error");
          }
          callLog.push("non-chunk-call");
          return "## Section X\nUnexpected content";
        },
        externalController.signal,
      );
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAbortError);
    }

    expect(chunk0Calls).toBe(1);
    expect(chunk1Calls).toBe(1);
    expect(callLog).not.toContain("non-chunk-call");
  });
});
