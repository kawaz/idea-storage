import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withIsolatedIdeaStorageEnv } from "../lib/test-fixtures.ts";

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

    // Capture prompts via _runClaude DI (DR-0009 Phase 3 step 3-e).
    const runClaudeCalls: Array<{ prompt: string }> = [];
    const fakeRunClaude = async (
      options: import("../lib/claude/claude-runner.ts").ClaudeRunOptions,
    ) => {
      runClaudeCalls.push({ prompt: options.prompt });
      return "# Title\n\nFake article output";
    };

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
        const { getSessionMeta } = await import("../lib/csa/csa.ts");
        const meta = await getSessionMeta(filePath);
        const result = await processSession({
          sessionId: REDACT_SID,
          recipe: {
            name: "diary",
            filePath: "/tmp/recipe-diary.md",
            match: {},
            onExisting: "append",
            prompt: "Write a diary",
          } as import("../lib/recipe/recipe.ts").Recipe,
          meta,
          sessionStats: { turns: 1, bytes: 100 },
          dataDir: join(workDir, "data"),
          _runClaude: fakeRunClaude,
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

    // LLM injection: 出力に secret を含めて返す (= LLM がうっかり transcribe / hallucinate
    // した想定)。output 防御層がここで止めるべき。
    // Both single-pass + quality_gate go through the same _runClaude shim;
    // quality_gate's response (non-JSON or accepted) doesn't matter — its
    // parse-fallback is `accepted`, which is what this test needs.
    const fakeRunClaude = async () => `# Article\n\n本文内に token=${ghToken} を含む\n`;

    let outputFile = "";
    await withIsolatedIdeaStorageEnv(workDir, async () => {
      const { processSession } = await import("./session-process.ts");
      const { getSessionMeta } = await import("../lib/csa/csa.ts");
      const meta = await getSessionMeta(filePath);
      const result = await processSession({
        sessionId: SID,
        recipe: {
          name: "diary",
          filePath: "/tmp/recipe-diary.md",
          match: {},
          onExisting: "append",
          prompt: "Write a diary",
        } as import("../lib/recipe/recipe.ts").Recipe,
        meta,
        sessionStats: { turns: 1, bytes: 100 },
        dataDir: join(workDir, "data"),
        _runClaude: fakeRunClaude,
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

    // DI: 1 回目 (content 生成) は secret 含む output、2 回目 (quality_gate) は rejected
    let callCount = 0;
    const fakeRunClaude = async () => {
      callCount++;
      if (callCount === 1) {
        return `# Article\n\n本文 token=${ghToken}\n`;
      }
      // quality_gate を rejected に倒す
      return JSON.stringify({ kind: "rejected", reason: "too thin" });
    };

    await withIsolatedIdeaStorageEnv(workDir, async () => {
      const { processSession } = await import("./session-process.ts");
      const { getSessionMeta } = await import("../lib/csa/csa.ts");
      const meta = await getSessionMeta(filePath);
      const result = await processSession({
        sessionId: SID,
        recipe: {
          name: "diary",
          filePath: "/tmp/recipe-diary.md",
          match: {},
          onExisting: "append",
          prompt: "Write a diary",
        } as import("../lib/recipe/recipe.ts").Recipe,
        meta,
        sessionStats: { turns: 1, bytes: 100 },
        dataDir: join(workDir, "data"),
        _runClaude: fakeRunClaude,
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
    const fakeRunClaude = async (
      options: import("../lib/claude/claude-runner.ts").ClaudeRunOptions,
    ) => {
      runClaudeCalls.push({ prompt: options.prompt });
      return "should-not-be-called";
    };

    const baseMeta: import("../lib/csa/csa.ts").SessionMeta = {
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
        } as import("../lib/recipe/recipe.ts").Recipe,
        meta: baseMeta,
        sessionStats: { turns: 1, bytes: 100 },
        dataDir: join(workDir, "data"),
        _runClaude: fakeRunClaude,
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
