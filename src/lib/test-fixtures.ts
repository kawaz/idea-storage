/**
 * Test fixtures for tests that exercise the real CSA bin.
 *
 * Design rationale: idea-storage が CSA `sessions --format jsonl` を消費する側で、
 * テスト時に CSA spawn を mock すると CSA との契約を実機で確認できない。代わりに
 * 隔離した base dir (HOME + CLAUDE_CONFIG_DIR override) と Claude 互換 jsonl fixture
 * を用意して実 CSA を呼ぶ。これにより mock と現実の乖離リスクを排除する。
 */

import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { utimesSync } from "node:fs";
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
  /**
   * Number of trailing assistant turns to emit after the user turns. Each
   * assistant entry is one JSONL line, so CSA's lineCount becomes
   * `userTurns + assistantTurns`. Defaults to 0 (= legacy user-only shape used
   * by conversation.test.ts).
   */
  assistantTurns?: number;
  /** ISO8601 timestamp for the first entry. */
  startTime?: string;
  /** ISO8601 timestamp for the last entry. Defaults to startTime. */
  endTime?: string;
  /**
   * Backdate the file mtime so CSA reports `ageSec = ageMs / 1000`. If set and
   * `startTime` is omitted, `startTime` also defaults to `now - ageMs`.
   * Required by recipe match (`min_age`) tests that exercise the real
   * `loadConfig()`/CSA pipeline.
   */
  ageMs?: number;
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
  const assistantTurns = opts.assistantTurns ?? 0;
  // When ageMs is set but startTime isn't, anchor startTime at `now - ageMs`
  // so CSA's ageSec matches what the caller asked for.
  const start =
    opts.startTime ??
    (opts.ageMs !== undefined
      ? new Date(Date.now() - opts.ageMs).toISOString()
      : "2024-01-01T10:00:00.000Z");
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
  // Trailing assistant turns (per legacy session-process / session-convert /
  // session-enqueue createSessionFile shape). Each assistant entry is a single
  // JSONL line so CSA's lineCount becomes userTurns + assistantTurns.
  for (let j = 0; j < assistantTurns; j++) {
    const ts = new Date(startMs + (j + 1) * 1000).toISOString();
    const entry: Record<string, unknown> = {
      type: "assistant",
      timestamp: ts,
      uuid: `entry-${opts.sessionId}-asst-${j}`,
      sessionId: opts.sessionId,
      message: { role: "assistant", content: [{ type: "text", text: `Resp ${j + 1}` }] },
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
  if (opts.ageMs !== undefined) {
    const mtime = new Date(Date.now() - opts.ageMs);
    utimesSync(filePath, mtime, mtime);
  }
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

/**
 * Like {@link withIsolatedClaudeEnv} but also redirects all of idea-storage's
 * XDG paths under `base`, so tests can exercise the real config / recipe /
 * paths / queue / rate-limit-store modules against a temporary on-disk state
 * instead of mocking those internal layers.
 *
 * Layout under `base`:
 *   <base>/projects/...                 — CSA fixture JSONLs (HOME / CLAUDE_CONFIG_DIR)
 *   <base>/.config/idea-storage/        — config.ts, recipe-*.md (XDG_CONFIG_HOME)
 *   <base>/state/idea-storage/          — queue.db, rate_limit.db etc. (XDG_STATE_HOME)
 *   <base>/data/idea-storage/           — output files, _rejected/ (XDG_DATA_HOME)
 *
 * Within a single test file, save/restore is safe because tests run
 * sequentially. Between files, bun test isolates `process.env` mutations on
 * its own, so this helper is composable without leaking across files.
 */
export async function withIsolatedIdeaStorageEnv<T>(
  base: string,
  fn: () => Promise<T>,
): Promise<T> {
  const origHome = process.env.HOME;
  const origClaudeCfg = process.env.CLAUDE_CONFIG_DIR;
  const origXdgConfig = process.env.XDG_CONFIG_HOME;
  const origXdgState = process.env.XDG_STATE_HOME;
  const origXdgData = process.env.XDG_DATA_HOME;
  process.env.HOME = base;
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.XDG_CONFIG_HOME = join(base, ".config");
  process.env.XDG_STATE_HOME = join(base, "state");
  process.env.XDG_DATA_HOME = join(base, "data");
  try {
    return await fn();
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origClaudeCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = origClaudeCfg;
    if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdgConfig;
    if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = origXdgState;
    if (origXdgData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = origXdgData;
  }
}

export interface ConfigFixtureOpts {
  /** claudeDirs override. Defaults to [`<base>/.claude`]. */
  claudeDirs?: string[];
  /** minAgeMinutes override. Defaults to 120 (idea-storage's default). */
  minAgeMinutes?: number;
}

/**
 * Write `<base>/.config/idea-storage/config.ts` so the real `loadConfig()`
 * picks it up via XDG_CONFIG_HOME (paired with `withIsolatedIdeaStorageEnv`).
 */
export async function writeConfigFixture(base: string, opts: ConfigFixtureOpts): Promise<void> {
  const configDir = join(base, ".config", "idea-storage");
  await mkdir(configDir, { recursive: true });
  const claudeDirs = opts.claudeDirs ?? [join(base, ".claude")];
  const minAgeMinutes = opts.minAgeMinutes ?? 120;
  const content = `export default ${JSON.stringify({ claudeDirs, minAgeMinutes }, null, 2)};\n`;
  await writeFile(join(configDir, "config.ts"), content);
}

export interface RecipeFixtureSpec {
  /** recipe name (becomes recipe-<name>.md) */
  name: string;
  /** match block (project / minTurns / minAge) */
  match?: { project?: string; min_turns?: number; min_age?: number };
  /** default "append" */
  onExisting?: "append" | "separate" | "skip";
  /** optional Phase 2 hint for the dispatcher */
  hint?: string;
  /** optional Phase 3 inject_recent N */
  injectRecent?: number;
  /** prompt body (the `## Hint` etc. below frontmatter) */
  prompt?: string;
}

/**
 * Write each recipe spec as `<base>/.config/idea-storage/recipe-<name>.md` so
 * the real `loadRecipes()` discovers them via XDG_CONFIG_HOME.
 */
export async function writeRecipeFixtures(
  base: string,
  recipes: RecipeFixtureSpec[],
): Promise<void> {
  const configDir = join(base, ".config", "idea-storage");
  await mkdir(configDir, { recursive: true });
  for (const r of recipes) {
    const frontmatter: Record<string, unknown> = {};
    if (r.match && Object.keys(r.match).length > 0) frontmatter.match = r.match;
    if (r.onExisting) frontmatter.on_existing = r.onExisting;
    if (r.hint) frontmatter.hint = r.hint;
    if (r.injectRecent !== undefined) frontmatter.inject_recent = r.injectRecent;
    const fmYaml =
      Object.keys(frontmatter).length === 0
        ? "---\n---\n"
        : `---\n${stringifyFrontmatter(frontmatter)}---\n`;
    const body = r.prompt ?? `Write a ${r.name}`;
    await writeFile(join(configDir, `recipe-${r.name}.md`), `${fmYaml}${body}\n`);
  }
}

/** Minimal YAML serializer for the keys we use in recipe frontmatter. */
function stringifyFrontmatter(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${k}: ${formatYamlValue(v)}`);
      }
    } else {
      lines.push(`${key}: ${formatYamlValue(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatYamlValue(v: unknown): string {
  if (typeof v === "string") {
    // Quote strings that contain YAML-significant characters; otherwise leave bare.
    if (/[:#[\]{},&*!|>'"%@`]/.test(v) || /^\s|\s$/.test(v)) {
      return JSON.stringify(v);
    }
    return v;
  }
  return String(v);
}
