/**
 * claude-session-analysis (CSA) domain module.
 *
 * Aggregates everything related to invoking the `claude-session-analysis`
 * binary: bin name, env construction wiring (via spawn-env), spawn helpers,
 * and the domain-shaped converters (CSA record → SessionMeta).
 *
 * DR-0009 Phase 3: Callers should import CSA-related symbols from this one
 * module instead of reaching into commands/* or conversation.ts.
 *
 * Design rationale: CSA is a required external dependency (no JSONL-direct
 * fallback). All spawns go through buildCsaEnv() so that secrets in
 * process.env (ANTHROPIC_API_KEY / GH_TOKEN / SSH_AUTH_SOCK / 1Password
 * sockets / AWS creds, ...) never reach the child process.
 */

import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { buildCsaEnv } from "../spawn-env.ts";
import { spawnWithTimeout, SpawnTimeoutError } from "../spawn-timeout.ts";
import { CSA_TIMEOUT_MS } from "../constants.ts";
import { logError } from "../logging.ts";

export interface SessionMeta {
  /** UUID */
  id: string;
  filePath: string;
  /** cwd */
  project: string;
  lineCount: number;
  ageSec: number;
  startTime: Date;
  endTime?: Date;
  userTurns: number;
  /** ツール結果などを除いた実質的なユーザー発話ターン数（CSA 由来） */
  effectiveUserTurns: number;
  /** フォークセッションの場合に設定される */
  forkInfo?: {
    parentSessionId: string;
    /** フォーク後の最初の行の UUID（CSA timeline との突合用） */
    firstNewUuid: string;
  };
}

/** CSA binary name (resolved via PATH). */
export const csaBin = "claude-session-analysis";

/**
 * Session record as emitted by `claude-session-analysis sessions --format jsonl`.
 * Timestamps are ISO8601 strings; `endTime` / `forkedFrom` / `forkFirstNewUuid`
 * may be null. Only the fields consumed by SessionMeta are typed here.
 */
export interface CsaSessionRecord {
  sessionId: string;
  cwd: string;
  startTime: string;
  endTime: string | null;
  lines: number;
  turns: number;
  effectiveUserTurns: number;
  forkedFrom: string | null;
  forkFirstNewUuid: string | null;
}

/**
 * Run `claude-session-analysis sessions --format jsonl <ids...>` and return the
 * parsed JSONL records. Batches ids to stay within argv length limits.
 *
 * Design rationale: CSA は必須依存。spawn 失敗時はフォールバックせず例外を投げる
 * （旧 JSONL 直読は廃止）。バッチ呼び出しで N spawn を回避する。
 *
 * テスト時は mock せず、HOME / CLAUDE_CONFIG_DIR を tempDir に向けて fixture jsonl
 * を実 CSA に読ませる方式（src/lib/test-fixtures.ts 参照）。
 */
export async function runCsaSessions(sessionIds: string[]): Promise<unknown[]> {
  if (sessionIds.length === 0) return [];
  const BATCH = 200;
  const records: unknown[] = [];
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH);
    const proc = Bun.spawn(
      [csaBin, "sessions", "--format", "jsonl", ...batch],
      // CSA は session JSONL の読み取りしかしないため、API クレデンシャル類は
      // 必要ない。allowlist で env を絞り込む (= 子プロセスから ANTHROPIC_API_KEY /
      // GH_TOKEN / SSH_AUTH_SOCK 等にアクセスさせない、DR-0009 Phase 1 補強)。
      { stdout: "pipe", stderr: "pipe", env: buildCsaEnv() },
    );
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `claude-session-analysis failed (exit ${exitCode}): ${err.trim() || "no stderr"}`,
      );
    }
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      records.push(JSON.parse(line) as unknown);
    }
  }
  return records;
}

/** Extract a session UUID from a JSONL file path, falling back to the basename. */
function sessionIdFromPath(filePath: string): string {
  const filename = basename(filePath, ".jsonl");
  const uuidMatch = filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch ? uuidMatch[0] : filename;
}

/** Build a SessionMeta from a CSA record + per-file age. */
function toSessionMeta(filePath: string, rec: CsaSessionRecord, ageSec: number): SessionMeta {
  const start = new Date(rec.startTime);
  const meta: SessionMeta = {
    id: rec.sessionId,
    filePath,
    project: rec.cwd,
    lineCount: rec.lines,
    ageSec,
    startTime: Number.isNaN(start.getTime()) ? new Date(0) : start,
    userTurns: rec.turns,
    effectiveUserTurns: rec.effectiveUserTurns,
  };
  if (rec.endTime) {
    const end = new Date(rec.endTime);
    if (!Number.isNaN(end.getTime())) meta.endTime = end;
  }
  if (rec.forkedFrom) {
    meta.forkInfo = {
      parentSessionId: rec.forkedFrom,
      firstNewUuid: rec.forkFirstNewUuid ?? "",
    };
  }
  return meta;
}

/**
 * Extract session metadata for multiple JSONL files via CSA in a single batch
 * (avoids N spawns). Returns a Map keyed by sessionId.
 *
 * `ageSec` is computed per file from `stat().mtimeMs` (CSA doesn't provide it).
 * Throws if CSA fails or if any requested session is missing from CSA output.
 */
export async function getSessionMetaBatch(filePaths: string[]): Promise<Map<string, SessionMeta>> {
  const result = new Map<string, SessionMeta>();
  if (filePaths.length === 0) return result;

  // Map sessionId -> filePath (and dedupe ids for the CSA call).
  const idToPath = new Map<string, string>();
  for (const filePath of filePaths) {
    idToPath.set(sessionIdFromPath(filePath), filePath);
  }
  const ids = [...idToPath.keys()];

  const rawRecords = await runCsaSessions(ids);
  const byId = new Map<string, CsaSessionRecord>();
  for (const raw of rawRecords) {
    const rec = raw as CsaSessionRecord;
    byId.set(rec.sessionId, rec);
  }

  // File age. Clamp to 0: in tests (or on NFS with clock drift) the file mtime
  // can be microseconds in the "future" from Date.now()'s perspective,
  // yielding a negative age. Age < 0 makes no sense to callers.
  for (const [id, filePath] of idToPath) {
    const rec = byId.get(id);
    const fileStat = await stat(filePath);
    const ageSec = Math.max(0, Math.floor((Date.now() - fileStat.mtimeMs) / 1000));
    if (!rec) {
      // Design rationale: CSA は空 file (0 byte) に対して何も emit しない (header もない
      // ため "session" として認識されない)。一方 idea-storage の pipeline は
      // 「empty session = lineCount 0 として markSkipped」と扱う前提で processSession の
      // 早期 return を組んでいる (session-process.ts の `meta.lineCount === 0` 分岐参照)。
      // CSA 移行前は jsonl 直読で lineCount=0 を返していたが、CSA 委譲後はその経路が
      // 失われた。空 file は throw せず合成 meta を返すことで旧挙動を保つ。
      // 非空なのに CSA が record を返さないケースは真の不整合なので従来通り throw する。
      if (fileStat.size === 0) {
        result.set(id, {
          id,
          filePath,
          project: "",
          lineCount: 0,
          ageSec,
          startTime: new Date(0),
          userTurns: 0,
          effectiveUserTurns: 0,
        });
        continue;
      }
      throw new Error(`claude-session-analysis returned no record for session ${id}`);
    }
    result.set(id, toSessionMeta(filePath, rec, ageSec));
  }
  return result;
}

/**
 * Extract session metadata for a single JSONL file. Thin wrapper over
 * {@link getSessionMetaBatch}.
 */
export async function getSessionMeta(filePath: string): Promise<SessionMeta> {
  const map = await getSessionMetaBatch([filePath]);
  const id = sessionIdFromPath(filePath);
  const meta = map.get(id);
  if (!meta) {
    throw new Error(`claude-session-analysis returned no record for session ${id}`);
  }
  return meta;
}

/**
 * Fetch session stats from claude-session-analysis.
 * Best-effort: returns empty object if CSA fails or times out.
 */
export async function getSessionStats(
  sessionId: string,
  logKey: string,
): Promise<{ turns?: number; bytes?: number; duration_ms?: number }> {
  try {
    const statsResult = await spawnWithTimeout({
      cmd: [csaBin, "sessions", "--format", "jsonl", sessionId],
      timeoutMs: CSA_TIMEOUT_MS,
      env: buildCsaEnv(),
    });
    const line = statsResult.stdout.trim().split("\n")[0];
    if (line) return JSON.parse(line);
    return {};
  } catch (err) {
    if (err instanceof SpawnTimeoutError) {
      logError({ key: logKey, msg: "csa_stats_timeout", timeoutMs: CSA_TIMEOUT_MS });
    }
    return {};
  }
}

/**
 * Count the number of standalone `---` lines in a CSA timeline output.
 * Used by {@link isValidCsaTimeline} to detect malformed CSA output.
 * Exported so tests can verify the contract directly without mocking spawn.
 */
export function countTimelineSeparators(convText: string): number {
  return convText.split("\n").filter((l) => l.trim() === "---").length;
}

/**
 * Returns true if `convText` looks like a valid CSA `timeline --md` output.
 * A valid output always has at least two `---` separators (the open and close
 * lines of the YAML-style frontmatter). Anything less is malformed (e.g. CSA
 * wrote `error: ...` to stdout while still exiting 0).
 */
export function isValidCsaTimeline(convText: string): boolean {
  return countTimelineSeparators(convText) >= 2;
}

/**
 * Error thrown by {@link getSessionTimeline} when CSA exits non-zero.
 */
export class CsaTimelineError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  constructor(exitCode: number, stderr: string) {
    super(`csa failed with exit code ${exitCode}`);
    this.name = "CsaTimelineError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface GetSessionTimelineOptions {
  /** Override timeout (defaults to CSA_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Run `claude-session-analysis timeline <sessionId> --md --no-emoji` and
 * return the stdout text.
 *
 * Throws:
 * - {@link CsaTimelineError} when CSA exits non-zero
 * - {@link SpawnTimeoutError} when the spawn exceeds `timeoutMs`
 */
export async function getSessionTimeline(
  sessionId: string,
  opts: GetSessionTimelineOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? CSA_TIMEOUT_MS;
  const result = await spawnWithTimeout({
    cmd: [csaBin, "timeline", sessionId, "--md", "--no-emoji"],
    timeoutMs,
    env: buildCsaEnv(),
  });
  if (result.exitCode !== 0) {
    throw new CsaTimelineError(result.exitCode, result.stderr);
  }
  return result.stdout;
}
