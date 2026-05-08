/**
 * Test fixtures for tests that exercise the real CSA bin.
 *
 * Design rationale: idea-storage が CSA `sessions --format jsonl` を消費する側で、
 * テスト時に CSA spawn を mock すると CSA との契約を実機で確認できない。代わりに
 * 隔離した base dir (HOME + CLAUDE_CONFIG_DIR override) と Claude 互換 jsonl fixture
 * を用意して実 CSA を呼ぶ。これにより mock と現実の乖離リスクを排除する。
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SessionFixtureOpts {
  sessionId: string;
  /** Project slug used as the directory name under <base>/projects/. */
  projectSlug?: string;
  /** cwd recorded on each entry. */
  cwd?: string;
  /** Number of user turns to emit. */
  userTurns?: number;
  /**
   * Number of leading user turns that should be classified as EFFECTIVE by CSA.
   * The rest are emitted as `"ok"` (SHORT_ASCII) to keep them non-effective.
   * Defaults to userTurns (all effective).
   */
  effectiveUserTurns?: number;
  /** ISO8601 timestamp for the first entry. */
  startTime?: string;
  /** ISO8601 timestamp for the last entry. Defaults to startTime. */
  endTime?: string;
  /**
   * If set, each entry will carry a `forkedFrom: { sessionId, messageUuid }`
   * field so CSA can detect this session as forked from another. Both
   * `forkedFromSessionId` and `forkedFromMessageUuid` must be supplied
   * together; the parent session JSONL must also exist in the same base.
   */
  forkedFromSessionId?: string;
  forkedFromMessageUuid?: string;
}

/** Create an isolated base dir containing an empty `projects/`. */
export async function createCsaFixtureDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "csa-fixture-"));
  await mkdir(join(base, "projects"), { recursive: true });
  return base;
}

/**
 * Write a Claude-compatible session JSONL into `<base>/projects/<slug>/<sid>.jsonl`.
 * Returns the absolute path.
 */
export async function writeSessionFixture(base: string, opts: SessionFixtureOpts): Promise<string> {
  const slug = opts.projectSlug ?? "test-project";
  const cwd = opts.cwd ?? `/tmp/${slug}`;
  const userTurns = opts.userTurns ?? 1;
  const effective = opts.effectiveUserTurns ?? userTurns;
  const start = opts.startTime ?? "2024-01-01T10:00:00.000Z";
  const end = opts.endTime ?? start;

  const projDir = join(base, "projects", slug);
  await mkdir(projDir, { recursive: true });
  const filePath = join(projDir, `${opts.sessionId}.jsonl`);

  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const lines: string[] = [];
  for (let i = 0; i < userTurns; i++) {
    // Linear interpolation between start and end so first/last timestamps match.
    const ts =
      userTurns === 1
        ? start
        : new Date(startMs + ((endMs - startMs) * i) / (userTurns - 1)).toISOString();
    const isEffective = i < effective;
    const content = isEffective ? `meaningful content ${i} あいうえお` : "ok";
    const entry: Record<string, unknown> = {
      type: "user",
      timestamp: ts,
      uuid: `entry-${opts.sessionId}-${i}`,
      sessionId: opts.sessionId,
      cwd,
      message: { role: "user", content },
    };
    if (opts.forkedFromSessionId && opts.forkedFromMessageUuid) {
      entry.forkedFrom = {
        sessionId: opts.forkedFromSessionId,
        messageUuid: opts.forkedFromMessageUuid,
      };
    }
    lines.push(JSON.stringify(entry));
  }
  await writeFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

/**
 * Run `fn` with `HOME` and `CLAUDE_CONFIG_DIR` pointed at `base`, then restore.
 *
 * Why: CSA discovers session JSONL files via (1) CLAUDE_CONFIG_DIR (env or arg)
 * and (2) $HOME/.claude*\/settings.json glob. Overriding HOME prevents the real
 * dev/CI environment from leaking into test results.
 *
 * Note on concurrency: bun test executes each test file in its own worker
 * process, so `process.env` mutations don't race across files. Within a file,
 * tests run sequentially, so save/restore around each test is safe.
 */
export async function withIsolatedClaudeEnv<T>(base: string, fn: () => Promise<T>): Promise<T> {
  const origHome = process.env.HOME;
  const origCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = base;
  process.env.CLAUDE_CONFIG_DIR = base;
  try {
    return await fn();
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origCfg;
  }
}
