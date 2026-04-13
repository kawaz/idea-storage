import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Track markFailed / markDone calls
const markFailedCalls: Array<{ key: string; reason?: string }> = [];
const markDoneCalls: string[] = [];

let claudeDir: string;
let tempDir: string;

// Dynamic dequeue result (can be overridden per test)
let dequeueResult: { sessionId: string; recipeName: string; key: string } | null = {
  sessionId: "missing-session-id",
  recipeName: "diary",
  key: "missing-session-id.diary",
};

// Mock modules before importing runProcess
mock.module("../lib/queue.ts", () => ({
  dequeue: mock(async () => dequeueResult),
  markDone: mock(async (key: string) => {
    markDoneCalls.push(key);
  }),
  markFailed: mock(async (key: string, reason?: string) => {
    markFailedCalls.push({ key, reason });
  }),
}));

// loadConfig will be set up in beforeEach with real temp dir
let loadConfigResult: { claudeDirs: string[]; minAgeMinutes: number };

mock.module("../lib/config.ts", () => ({
  loadConfig: mock(async () => loadConfigResult),
}));

// Control recipe loading behavior
let mockRecipesThrow = false;
let mockRecipes: Array<{
  name: string;
  filePath: string;
  match: Record<string, unknown>;
  onExisting: string;
  prompt: string;
}> = [];

mock.module("../lib/recipe.ts", () => ({
  loadRecipes: mock(async () => {
    if (mockRecipesThrow) throw new Error("no recipes dir");
    return mockRecipes;
  }),
}));

describe("session-process", () => {
  beforeEach(async () => {
    markFailedCalls.length = 0;
    markDoneCalls.length = 0;
    mockRecipesThrow = false;
    mockRecipes = [
      {
        name: "diary",
        filePath: "/tmp/recipe-diary.md",
        match: {},
        onExisting: "append",
        prompt: "Write a diary",
      },
    ];
    dequeueResult = {
      sessionId: "missing-session-id",
      recipeName: "diary",
      key: "missing-session-id.diary",
    };
    tempDir = await mkdtemp(join(tmpdir(), "session-process-test-"));
    claudeDir = join(tempDir, "claude");
    // Create projects dir so Bun.Glob.scan doesn't throw
    await mkdir(join(claudeDir, "projects"), { recursive: true });
    loadConfigResult = {
      claudeDirs: [claudeDir],
      minAgeMinutes: 120,
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("calls markFailed when session file is not found", async () => {
    const { runProcess } = await import("./session-process.ts");
    const result = await runProcess();

    expect(result).toBe("failed");
    expect(markFailedCalls.map((c) => c.key)).toContain("missing-session-id.diary");
  });

  test("レシピが見つからない場合のエラーメッセージに次のアクション案内が含まれる", async () => {
    mockRecipesThrow = true;

    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    dequeueResult = {
      sessionId,
      recipeName: "diary",
      key: `${sessionId}.diary`,
    };

    // Create a session file so it gets past the session-not-found check
    const projectDir = join(claudeDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    const now = Date.now();
    const ageMs = 3 * 60 * 60 * 1000;
    const sessionStart = new Date(now - ageMs).toISOString();
    const jsonlLine = JSON.stringify({
      type: "user",
      timestamp: sessionStart,
      uuid: `${sessionId.slice(0, 8)}-line-0001`,
      cwd: "/tmp/test-project",
      message: { role: "user", content: "Hello" },
    });
    await Bun.write(join(projectDir, `${sessionId}.jsonl`), jsonlLine + "\n");

    const { runProcess } = await import("./session-process.ts");
    try {
      await runProcess();
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("recipe-*.md");
      expect((err as Error).message).toContain("config-examples/");
    }
  });

  test("calls markFailed with empty_session when session file is empty (0 lines)", async () => {
    const sessionId = "00000000-0000-0000-0000-000000000000";
    const key = `${sessionId}.diary`;
    dequeueResult = { sessionId, recipeName: "diary", key };

    // Create an empty session JSONL file (0 bytes)
    const projectDir = join(claudeDir, "projects", "test-project");
    await mkdir(projectDir, { recursive: true });
    await Bun.write(join(projectDir, `${sessionId}.jsonl`), "");

    const { runProcess } = await import("./session-process.ts");
    const result = await runProcess();

    expect(result).toBe("failed");
    // Should markFailed with reason containing "empty"
    const failedEntry = markFailedCalls.find((c) => c.key === key);
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.reason).toContain("empty");
    // Should NOT have called markDone
    expect(markDoneCalls).not.toContain(key);
  });

  test("returns empty when queue is empty", async () => {
    dequeueResult = null;

    const { runProcess } = await import("./session-process.ts");
    const result = await runProcess();

    expect(result).toBe("empty");
  });
});

// --- チャンク分割パスのユニットテスト ---
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
    // index は 0-based なので表示は +1
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

// テスト用ヘルパー: processChunked をモックされた runClaude で検証する
// processChunked は内部で runClaude を呼ぶため、_runClaudeOverride 経由でテストする

describe("processChunked", () => {
  const dummyMeta: import("../types/index.ts").SessionMeta = {
    id: "test-session-id",
    filePath: "/tmp/test-session.jsonl",
    ageSec: 3600,
    hasEnd: true,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "test-project",
    lineCount: 100,
    userTurns: 5,
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
        // synthesis call
        return "# Title\n## Section 1\nContent 1\n## Section 2\nContent 2\n## まとめ\nOverall summary";
      },
    );

    expect(callCount).toBe(3); // 2 chunks + 1 synthesis
    expect(result).toContain("Title");
    expect(result).toContain("まとめ");
  });

  test("1チャンク失敗 → リトライ成功で合成まで完了する", async () => {
    const chunks = makeChunks(3);
    const convText = "dummy timeline text";
    const recipePrompt = "test prompt";

    // 各チャンクの呼び出し回数を追跡（promptの内容でチャンクを特定）
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
        // チャンク処理かsynthesisかを判定
        if (prompt.includes("セクション一覧")) {
          callLog.push("synthesis");
          return "# Title\n## まとめ\nSummary";
        }
        // chunk-1 の処理を特定（チャンク情報にindex+1が含まれる）
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

    // chunk0成功, chunk1失敗→リトライ成功, chunk2成功, synthesis
    expect(callLog).toContain("chunk1-fail");
    expect(callLog).toContain("chunk1-retry-success");
    expect(callLog).toContain("synthesis");
    expect(result).toContain("Title");
  });

  test("1チャンク失敗 → リトライも失敗 → 分割なしフォールバック成功", async () => {
    // convText が maxChunkBytes(35000) 以内なので分割なしフォールバックが可能
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
        // chunk-0（チャンク: 1/）を常に失敗させる
        if (prompt.includes("チャンク: 1/")) {
          chunk0FailCount++;
          callLog.push(`chunk0-fail-${chunk0FailCount}`);
          throw new Error("persistent API error");
        }
        // 分割なしフォールバック（チャンク情報を含まない）
        if (!prompt.includes("チャンク:")) {
          callLog.push("fallback-unsplit");
          return "# Fallback result\nFull content";
        }
        callLog.push("chunk-success");
        return "## Section\nContent";
      },
    );

    // chunk0: 初回失敗 + リトライ失敗 = 2回、その後 fallback-unsplit
    expect(chunk0FailCount).toBe(2);
    expect(callLog).toContain("fallback-unsplit");
    // synthesis はスキップされる（1チャンクなので不要）
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
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("fallback also failed");
    }

    // 初回2チャンク + リトライ2チャンク + フォールバック1回
    const chunkFails = callLog.filter((l) => l === "chunk-fail").length;
    expect(chunkFails).toBe(4); // 2 initial + 2 retries
    expect(callLog).toContain("fallback-unsplit-fail");
  });

  test("全チャンク失敗 → テキストが大きい場合はフォールバックをスキップして例外", async () => {
    const convText = "x".repeat(40000); // maxChunkBytes(35000)を超える
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
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("API error");
    }

    // 初回2チャンク + リトライ2チャンク = 4回、フォールバックなし
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
        // chunk 0, 1 は常に成功
        const match = prompt.match(/チャンク: (\d+)\//);
        const idx = match ? match[1] : "?";
        return `## Section ${idx}\nOriginal content ${idx}`;
      },
    );

    // chunk2 はリトライで成功、他は初回成功
    expect(chunk2CallCount).toBe(2);
    expect(result).toContain("Synthesized");
  });
});

// --- processChunked の外部 signal 連携テスト ---

describe("processChunked external signal propagation", () => {
  const dummyMeta: import("../types/index.ts").SessionMeta = {
    id: "test-session-id",
    filePath: "/tmp/test-session.jsonl",
    ageSec: 3600,
    hasEnd: true,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "test-project",
    lineCount: 100,
    userTurns: 5,
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

    // 50ms後に外部signalをabort
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
          // signalがabortされるまで待つ
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
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAbortError);
    }

    // 2つのチャンクの runClaude 呼び出しに signal が渡されていること
    expect(receivedSignals.length).toBe(2);
    // 全ての signal が abort 済みであること
    for (const sig of receivedSignals) {
      expect(sig.aborted).toBe(true);
    }
  });

  test("外部signalがabortされると合成フェーズもキャンセルされる", async () => {
    // チャンク1つでは synthesis がスキップされるため、2チャンクでテスト
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
            // チャンク処理は成功
            return `## Section ${sectionCount}\nContent`;
          }
          // 合成フェーズ前に外部signalをabort
          externalController.abort();
          // signal が abort されていれば ClaudeAbortError が期待される
          if (options.signal?.aborted) {
            throw new ClaudeAbortError();
          }
          return "should not reach here";
        },
        externalController.signal,
      );
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeAbortError);
    }

    expect(sectionCount).toBe(2); // 2チャンク処理 + 合成1回(abort)
  });

  test("外部signalがabort済みの場合、リトライやフォールバックをスキップして即座にClaudeAbortError", async () => {
    const chunks = makeChunks(2);
    const convText = "short text";
    const recipePrompt = "test prompt";

    const externalController = new AbortController();
    externalController.abort(); // 事前にabort

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

// --- CSA_TIMEOUT_MS のテスト ---
import { CSA_TIMEOUT_MS } from "./session-process.ts";

describe("CSA_TIMEOUT_MS", () => {
  test("10分（600000ms）に設定されている", () => {
    expect(CSA_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });
});

// --- ProcessResult 型のテスト ---
import type { ProcessResult } from "./session-process.ts";

describe("ProcessResult", () => {
  test("ProcessResult type includes expected values", () => {
    // 型レベルの確認（コンパイルが通ればOK）
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
    hasEnd: true,
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    project: "test-project",
    lineCount: 100,
    userTurns: 5,
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

    // synthesis は呼ばれない（section のみ1回）
    expect(callLog).toEqual(["section"]);
    // セクション結果がそのまま返される
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

    // 2つのセクション + 1つの synthesis = 3回
    expect(callLog).toEqual(["section", "section", "synthesis"]);
  });
});

// --- フォークセッションのタイムライン切り詰めテスト ---
import { trimTimelineForFork } from "./session-process.ts";

describe("trimTimelineForFork", () => {
  // CSA timeline --md 形式のサンプル
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
    // eee55555 = uuid "eee55555-..." の先頭8文字
    const result = trimTimelineForFork(sampleTimeline, "eee55555-0000-0000-0000-000000000000");
    expect(result).toContain("Ueee55555");
    expect(result).toContain("Fork user message");
    expect(result).toContain("Tfff66666");
    expect(result).toContain("Fork reply content");
    // 親の行は含まれない
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
    // ブロックIDの Ueee55555 にマッチし、本文中の eee55555 には誤マッチしない
    expect(result).toContain("Ueee55555");
    expect(result).not.toContain("Uaaa11111");
  });
});
