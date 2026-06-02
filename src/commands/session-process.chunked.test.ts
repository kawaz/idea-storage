import { describe, expect, test } from "bun:test";
import { processChunked } from "./session-process.ts";
import { ClaudeAbortError } from "../lib/claude-runner.ts";
import type { ProcessResult } from "./session-process.ts";

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
