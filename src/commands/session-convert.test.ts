import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Mock setup ---

let claudeDir: string;
let tempDir: string;
let dataDir: string;

let loadConfigResult: { claudeDirs: string[]; minAgeMinutes: number };

mock.module("../lib/config.ts", () => ({
  loadConfig: mock(async () => loadConfigResult),
}));

mock.module("../lib/paths.ts", () => ({
  getDataDir: mock(() => dataDir),
  getRecipesDir: mock(() => "/tmp/fake-recipes"),
  getStateDir: mock(() => "/tmp/fake-state"),
  getConfigDir: mock(() => "/tmp/fake-config"),
}));

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

// Track queue interactions
const claimCalls: Array<{ sessionId: string; recipeName: string }> = [];
const markDoneCalls: Array<{ key: string; lineCount: number }> = [];
const markFailedCalls: Array<{ key: string; reason?: string }> = [];
const waitForCompletionCalls: string[] = [];

let claimResult: { claimed: boolean; prevStatus: string | null } = {
  claimed: true,
  prevStatus: null,
};
let waitForCompletionResult:
  | { status: "done"; lineCount: number }
  | { status: "failed"; failReason: string | null }
  | { status: "timeout" } = { status: "done", lineCount: 0 };

mock.module("../lib/queue.ts", () => ({
  claim: mock(async (sessionId: string, recipeName: string) => {
    claimCalls.push({ sessionId, recipeName });
    return claimResult;
  }),
  markDone: mock(async (key: string, lineCount: number) => {
    markDoneCalls.push({ key, lineCount });
  }),
  markFailed: mock(async (key: string, reason?: string) => {
    markFailedCalls.push({ key, reason });
  }),
  waitForCompletion: mock(async (key: string) => {
    waitForCompletionCalls.push(key);
    return waitForCompletionResult;
  }),
  // Other queue functions kept as default no-ops if anything imports them
  dequeue: mock(async () => null),
  getDoneLineCount: mock(async () => null),
}));

// Mock claude-runner so processSession's runClaude returns a fixed string without
// actually invoking claude (also avoids writing rate_limit data)
mock.module("../lib/claude-runner.ts", () => ({
  runClaude: mock(async () => "# Generated content\n## まとめ\nMocked\n"),
  ClaudeTimeoutError: class ClaudeTimeoutError extends Error {
    timeoutMs: number;
    constructor(timeoutMs = 0) {
      super(`timeout ${timeoutMs}`);
      this.timeoutMs = timeoutMs;
    }
  },
  ClaudeAbortError: class ClaudeAbortError extends Error {},
}));

// Mock CSA spawn (used inside processSession)
mock.module("../lib/spawn-timeout.ts", () => ({
  spawnWithTimeout: mock(async (opts: { cmd: string[] }) => {
    // sessions JSONL stats: empty string (we'll use meta values)
    // timeline --md: return some fake timeline content
    if (opts.cmd[1] === "sessions") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (opts.cmd[1] === "timeline") {
      return {
        exitCode: 0,
        stdout: `---\nsession: test\n---\n2024-01-01T00:00:00+00:00 Uaaa11111 user line\nhello\n`,
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }),
  SpawnTimeoutError: class SpawnTimeoutError extends Error {},
}));

// Mock rate-limit-store (best-effort recordObservation, no-op for tests)
mock.module("../lib/rate-limit-store.ts", () => ({
  recordObservation: mock(() => {}),
}));

const VALID_SID = "aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee";

function makeRecipe(overrides: Partial<(typeof mockRecipes)[0]> = {}) {
  return {
    name: "diary",
    filePath: "/tmp/recipe-diary.md",
    match: {},
    onExisting: "skip", // default to skip to verify forceProcess overrides it
    prompt: "Write a diary",
    ...overrides,
  };
}

async function writeSessionFile(
  projectsDir: string,
  sessionId: string,
  opts: { lines?: number; ageMs?: number; subDir?: string } = {},
): Promise<string> {
  const { lines = 5, ageMs = 3 * 60 * 60 * 1000, subDir = "test-project" } = opts;
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
      cwd: "/tmp/test-project",
      message: { role: "user", content: "Hello" },
    }),
  );

  for (let i = 1; i < lines; i++) {
    jsonlLines.push(
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(now - ageMs + i * 1000).toISOString(),
        uuid: `${sessionId.slice(0, 8)}-line-${String(i + 1).padStart(4, "0")}`,
        message: { role: "assistant", content: [{ type: "text", text: `Resp ${i}` }] },
      }),
    );
  }

  await Bun.write(filePath, jsonlLines.join("\n") + "\n");
  return filePath;
}

describe("session-convert", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "session-convert-test-"));
    claudeDir = join(tempDir, "claude");
    dataDir = join(tempDir, "data");
    await mkdir(join(claudeDir, "projects"), { recursive: true });
    await mkdir(dataDir, { recursive: true });

    loadConfigResult = {
      claudeDirs: [claudeDir],
      minAgeMinutes: 0,
    };

    mockRecipesThrow = false;
    mockRecipes = [makeRecipe()];

    claimCalls.length = 0;
    markDoneCalls.length = 0;
    markFailedCalls.length = 0;
    waitForCompletionCalls.length = 0;

    claimResult = { claimed: true, prevStatus: null };
    waitForCompletionResult = { status: "done", lineCount: 5 };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("正常系: 引数で指定した session_id と recipe で処理が走り、出力ファイルが生成される", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);

    const { runConvert } = await import("./session-convert.ts");
    const result = await runConvert({ sessionId: VALID_SID, recipeName: "diary" });

    expect(result.kind).toBe("processed");
    if (result.kind === "processed") {
      // Output file path follows {dataDir}/{recipe}/YYYY/MM/DD/{ts}.{sid}.md
      expect(result.outputFile).toContain(`${dataDir}/diary/`);
      expect(result.outputFile).toContain(`.${VALID_SID}.md`);
      // File should actually exist
      expect(await Bun.file(result.outputFile).exists()).toBe(true);
    }

    // claim was called
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0]).toEqual({ sessionId: VALID_SID, recipeName: "diary" });

    // markDone was called (claimed=true → owner)
    expect(markDoneCalls).toHaveLength(1);
    expect(markDoneCalls[0]!.key).toBe(`${VALID_SID}.diary`);
    expect(markFailedCalls).toHaveLength(0);
  });

  test("session_file が見つからない場合のエラー", async () => {
    // No session file created

    const { runConvert } = await import("./session-convert.ts");
    await expect(runConvert({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(
      /session file not found/,
    );

    // Should not have claimed (early failure)
    expect(claimCalls).toHaveLength(0);
  });

  test("recipe が見つからない場合のエラー", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);
    mockRecipes = [makeRecipe({ name: "other" })];

    const { runConvert } = await import("./session-convert.ts");
    await expect(runConvert({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(
      /recipe not found/,
    );

    // Should not have claimed
    expect(claimCalls).toHaveLength(0);
  });

  test("recipe ディレクトリが存在しない場合は CliError", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);
    mockRecipesThrow = true;

    const { runConvert } = await import("./session-convert.ts");
    const { CliError } = await import("../lib/errors.ts");
    await expect(runConvert({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(
      CliError,
    );
  });

  test("onExisting=skip でも強制実行される (forceProcess=true)", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);
    // recipe.onExisting is 'skip' by default in makeRecipe; convert should still run.

    const { runConvert } = await import("./session-convert.ts");
    const result = await runConvert({ sessionId: VALID_SID, recipeName: "diary" });

    expect(result.kind).toBe("processed");
    expect(markDoneCalls).toHaveLength(1);
  });

  test("claim 失敗（既に processing）→ waitForCompletion で done を待つ", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);

    claimResult = { claimed: false, prevStatus: "processing" };
    waitForCompletionResult = { status: "done", lineCount: 42 };

    const { runConvert } = await import("./session-convert.ts");
    const result = await runConvert({ sessionId: VALID_SID, recipeName: "diary" });

    expect(result.kind).toBe("waited");
    if (result.kind === "waited") {
      // outputFile path is computed deterministically from meta.startTime
      expect(result.outputFile).toContain(`${dataDir}/diary/`);
      expect(result.outputFile).toContain(`.${VALID_SID}.md`);
    }

    // We claimed (and it failed), then waited
    expect(claimCalls).toHaveLength(1);
    expect(waitForCompletionCalls).toHaveLength(1);
    expect(waitForCompletionCalls[0]).toBe(`${VALID_SID}.diary`);

    // No markDone / markFailed (we didn't own the processing)
    expect(markDoneCalls).toHaveLength(0);
    expect(markFailedCalls).toHaveLength(0);
  });

  test("claim 失敗（既に processing）→ waitForCompletion で failed → 例外", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);

    claimResult = { claimed: false, prevStatus: "processing" };
    waitForCompletionResult = { status: "failed", failReason: "boom" };

    const { runConvert } = await import("./session-convert.ts");
    await expect(runConvert({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(/boom/);

    expect(claimCalls).toHaveLength(1);
    expect(waitForCompletionCalls).toHaveLength(1);
    expect(markFailedCalls).toHaveLength(0); // we don't own
  });

  test("claim 失敗（既に processing）→ waitForCompletion で timeout → 例外", async () => {
    const projectsDir = join(claudeDir, "projects");
    await writeSessionFile(projectsDir, VALID_SID);

    claimResult = { claimed: false, prevStatus: "processing" };
    waitForCompletionResult = { status: "timeout" };

    const { runConvert } = await import("./session-convert.ts");
    await expect(runConvert({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(
      /timeout/i,
    );

    expect(claimCalls).toHaveLength(1);
    expect(waitForCompletionCalls).toHaveLength(1);
  });

  test("processSession が例外を投げた場合、markFailed が呼ばれる", async () => {
    const projectsDir = join(claudeDir, "projects");
    // Empty session (lineCount=0) → processSession throws
    const dir = join(projectsDir, "test-project");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, `${VALID_SID}.jsonl`), "");

    const { runConvert } = await import("./session-convert.ts");
    await expect(runConvert({ sessionId: VALID_SID, recipeName: "diary" })).rejects.toThrow(
      /empty session/,
    );

    // claim succeeded, then processSession threw, so markFailed was called
    expect(claimCalls).toHaveLength(1);
    expect(markFailedCalls).toHaveLength(1);
    expect(markFailedCalls[0]!.key).toBe(`${VALID_SID}.diary`);
    expect(markDoneCalls).toHaveLength(0);
  });
});
