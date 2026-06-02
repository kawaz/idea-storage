import { join } from "node:path";
import { getRejectedDir } from "../paths.ts";
import {
  CsaTimelineError,
  countTimelineSeparators,
  getSessionTimeline,
  isValidCsaTimeline,
} from "../csa.ts";
import { type ClaudeRunner, runClaude, ClaudeTimeoutError } from "../claude-runner.ts";
import { judgeQuality } from "../quality-gate.ts";
import { getClaudeMeta } from "../claude-meta.ts";
import { listRecentOutputs, formatInjectedRecent } from "../recent-outputs.ts";
import { splitTimeline } from "../chunker.ts";
import { SpawnTimeoutError } from "../spawn-timeout.ts";
import { log, logError } from "../logging.ts";
import { formatDatePath, formatFileTimestamp } from "../format.ts";
import { redactSecrets } from "../redact.ts";
import { redactForPrompt } from "../redact-pipeline.ts";
import { CSA_TIMEOUT_MS } from "../constants.ts";
import type { Recipe, SessionMeta } from "../../types/index.ts";
import { trimTimelineForFork } from "./fork-timeline.ts";
import { processChunked } from "./chunked-runner.ts";
import { buildFrontmatter } from "./frontmatter-builder.ts";
import { persistAccepted, persistRejected } from "./persistence.ts";
import { recordWorkerObservation } from "./worker-observation.ts";

// --- Pure session processing function ---

/**
 * 純粋なセッション処理関数。
 * queue 操作（dequeue/markDone/markFailed/getDoneLineCount）は呼ばない。
 *
 * 入力で受け取った meta/recipe/sessionStats を使って、CSA timeline 取得 →
 * Claude 呼び出し → 出力ファイル書き出しを行う。
 *
 * 戻り値:
 * - kind: "processed": 出力ファイルを書き出した
 * - kind: "skipped":   会話が空などで処理不要だった (lineCount は markDone 用)
 *
 * 例外:
 * - 処理失敗（CSA エラー、claude エラー、空セッションなど）は Error を throw する
 */
export interface ProcessSessionInput {
  sessionId: string;
  recipe: Recipe;
  meta: SessionMeta;
  sessionStats: { turns?: number; bytes?: number; duration_ms?: number };
  dataDir: string;
  taskTimeoutMs?: number;
  signal?: AbortSignal;
  /**
   * true の場合、recipe.onExisting と previousLineCount による
   * 「append note 追加」「skip 判定」を全てスキップして強制的に処理する。
   * Convert コマンドのように明示指示で実行する場合に使う。
   */
  forceProcess?: boolean;
  /**
   * append note を付けるかどうか (forceProcess=false かつ runProcess が
   * recipe.onExisting === "append" と判定した場合に true を渡す)。
   */
  appendPreviousRunNote?: boolean;
  /** ロギング用の key (デフォルト: `${sessionId}.${recipe.name}`) */
  logKey?: string;
  /**
   * Override runClaude for tests (DR-0009 Phase 3 step 3-e). When set, this
   * replaces runClaude across all three LLM sinks invoked by processSession:
   * the single-pass call, processChunked, and judgeQuality. Production code
   * leaves this undefined; tests use it instead of `mock.module()` to avoid
   * the dynamic-import mock leak documented in
   * `docs/journal/2026-05-31-mock-removal-real-cause.md`.
   */
  _runClaude?: ClaudeRunner;
}

export type ProcessSessionResult =
  | { kind: "processed"; outputFile: string; lineCount: number }
  | { kind: "skipped"; reason: string; lineCount: number };

export async function processSession(input: ProcessSessionInput): Promise<ProcessSessionResult> {
  const {
    sessionId,
    recipe,
    meta,
    sessionStats,
    dataDir,
    taskTimeoutMs,
    signal,
    forceProcess = false,
    appendPreviousRunNote = false,
    _runClaude,
  } = input;
  const run = _runClaude ?? runClaude;
  const recipeName = recipe.name;
  const key = input.logKey ?? `${sessionId}.${recipeName}`;

  // Empty session checks (apply even with forceProcess=true: nothing to process).
  // Design rationale: Empty/no-user-turn sessions are not failures; they are
  // intentionally skipped. The caller maps this to markSkipped().
  if (meta.lineCount === 0) {
    log({ key, msg: "empty_session" });
    return { kind: "skipped", reason: "empty_session", lineCount: meta.lineCount };
  }
  if ((meta.userTurns ?? 0) === 0) {
    log({ key, msg: "empty_session", reason: "no_user_turns" });
    return { kind: "skipped", reason: "no_user_turns", lineCount: meta.lineCount };
  }

  // Build prompt (apply append note only when not forced)
  let prompt = recipe.prompt;
  if (!forceProcess && appendPreviousRunNote) {
    prompt += "\n\n---\nNote: Session continued. Please append to existing entry.";
  }

  // DR-0008 §9: prepend N most-recent past outputs for this recipe so the LLM
  // can deliberately avoid repeating phrasings / observations. Best-effort:
  // missing dataDir or zero outputs is a no-op.
  if (recipe.injectRecent && recipe.injectRecent > 0) {
    const recent = await listRecentOutputs(dataDir, recipeName, recipe.injectRecent);
    if (recent.length > 0) {
      const injected = formatInjectedRecent(recent);
      prompt = injected + prompt;
      log({ key, msg: "inject_recent", count: recent.length });
    }
  }

  const sizeBytes = sessionStats.bytes ?? null;
  const turns = sessionStats.turns ?? meta.userTurns;
  const project = meta.project || "unknown";
  log({ key, msg: "start", recipe: recipeName, sizeBytes, turns, project });

  // Extract conversation timeline via claude-session-analysis
  let convText: string;
  try {
    convText = await getSessionTimeline(sessionId);
  } catch (err) {
    if (err instanceof CsaTimelineError) {
      logError({ key, msg: "csa_failed", exitCode: err.exitCode, stderr: err.stderr });
      throw new Error(err.message);
    }
    if (err instanceof SpawnTimeoutError) {
      logError({ key, msg: "csa_timeline_timeout", timeoutMs: CSA_TIMEOUT_MS });
      throw new Error(`csa timeline timed out after ${CSA_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!convText.trim()) {
    log({ key, msg: "skip", reason: "no_conversation" });
    return { kind: "skipped", reason: "no_conversation", lineCount: meta.lineCount };
  }

  // Validate CSA timeline output structure. CSA timeline --md always emits a
  // YAML-style frontmatter delimited by two `---` lines (open + close), then
  // the actual blocks separated by additional `---` lines. If we see fewer
  // than two `---` separators, exitCode==0 notwithstanding, the output is not
  // a valid timeline (e.g. CSA wrote "error: ..." to stdout). Skip such
  // sessions instead of feeding malformed text into the recipe prompt.
  if (!isValidCsaTimeline(convText)) {
    const separatorCount = countTimelineSeparators(convText);
    log({ key, msg: "skip", reason: "empty_or_invalid_timeline", separatorCount });
    return {
      kind: "skipped",
      reason: "empty_or_invalid_timeline",
      lineCount: meta.lineCount,
    };
  }

  // フォークセッションの場合、タイムラインを切り詰め＋プロンプト調整
  let timelineText = convText;
  if (meta.forkInfo) {
    log({ key, msg: "fork", parent: meta.forkInfo.parentSessionId });

    if (!meta.forkInfo.firstNewUuid) {
      log({ key, msg: "skip", reason: "fork_no_new_conversation" });
      return { kind: "skipped", reason: "fork_no_new_conversation", lineCount: meta.lineCount };
    }

    const originalLen = convText.length;
    timelineText = trimTimelineForFork(convText, meta.forkInfo.firstNewUuid);
    log({ key, msg: "trimmed", from: originalLen, to: timelineText.length });
    prompt += `\n\n---\nNote: このセッションは元セッション ${meta.forkInfo.parentSessionId} からフォークされたものです。以下のタイムラインはフォーク後の新規会話のみです。`;
  }

  // Redact secrets from the timeline before sending to Claude. We use the
  // primitive (not redactForPrompt) here because we want the hit count for
  // observability — pipeline wrappers discard the count.
  // Defense in depth at persistence time (persistAccepted/Rejected re-applies
  // redactForOutput) covers LLM transcription leaks.
  const redacted = redactSecrets(timelineText);
  timelineText = redacted.text;
  if (redacted.count > 0) {
    log({ key, msg: "redacted", count: redacted.count });
  }

  // チャンク分割の判定
  const chunks = splitTimeline(timelineText);

  let output: string;
  const sessionStart = meta.startTime.toISOString();

  try {
    if (chunks.length > 1) {
      log({ key, msg: "chunked", chunks: chunks.length });
      output = await processChunked(
        timelineText,
        chunks,
        prompt,
        sessionId,
        meta,
        taskTimeoutMs,
        _runClaude,
        signal,
      );
    } else {
      // single-pass: meta.project を redact 経由 (codex review #3、
      // chunked path と挙動を揃える)
      const projectSafe = redactForPrompt(meta.project || "unknown");
      const fullPrompt = `${prompt}

---
## セッション情報
- Session ID: ${sessionId}
- Project: ${projectSafe}
- Created: ${sessionStart}

## 会話タイムライン
${timelineText}`;
      output = await run({
        prompt: fullPrompt,
        addDir: dataDir,
        timeoutMs: taskTimeoutMs,
        signal,
        captureUsage: true,
        onUsageObserved: recordWorkerObservation,
      });
    }
  } catch (err) {
    if (err instanceof ClaudeTimeoutError) {
      logError({ key, msg: "task_timeout", timeoutMs: err.timeoutMs });
      throw new Error(`task timeout after ${err.timeoutMs}ms`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    logError({ key, msg: "failed", error: reason });
    throw err instanceof Error ? err : new Error(reason);
  }

  // Generate frontmatter
  const sessionEnd = meta.endTime ? meta.endTime.toISOString() : "unknown";
  const generatedAt = new Date().toISOString();
  const claudeMeta = await getClaudeMeta();
  const fm = buildFrontmatter({
    sessionId,
    meta,
    sessionStats,
    recipeName,
    claudeMeta,
    sessionStart,
    sessionEnd,
    generatedAt,
  });

  // Output file path: {dataDir}/{recipeName}/YYYY/MM/DD/{yyyymmddTHHMMSSZ}.{sessionId}.md
  const datePath = formatDatePath(meta.startTime);
  const fileTs = formatFileTimestamp(meta.startTime);
  const outputDir = join(dataDir, recipeName, datePath);
  const outputFile = join(outputDir, `${fileTs}.${sessionId}.md`);
  const fullOutput = fm + output;

  // DR-0008 §8: quality gate before persisting. Gate is conservative — any
  // LLM unreachability or parse failure falls back to accepted (don't block
  // the main path on the gate's own reliability).
  const verdict = await judgeQuality({
    output,
    recipeName,
    timeoutMs: taskTimeoutMs,
    signal,
    _runClaude,
  });
  log({
    key,
    msg: "quality_gate",
    kind: verdict.kind,
    reason: verdict.reason,
    fallback: verdict.fallback?.reason ?? null,
  });

  if (verdict.kind === "rejected") {
    // Divert to _rejected/<recipe>/YYYY/MM/DD/ for later inspection (manual
    // re-evaluation when quality_guidelines.md is improved).
    const rejectedDir = join(getRejectedDir(), recipeName, datePath);
    const rejectedFile = join(rejectedDir, `${fileTs}.${sessionId}.md`);
    await persistRejected(rejectedFile, fullOutput);
    log({ key, msg: "quality_rejected", output: rejectedFile, reason: verdict.reason });
    return { kind: "skipped", reason: "quality_rejected", lineCount: meta.lineCount };
  }

  await persistAccepted(outputFile, fullOutput);
  log({ key, msg: "success", output: outputFile });

  return { kind: "processed", outputFile, lineCount: meta.lineCount };
}
