import { define } from "gunshi";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "../lib/config.ts";
import { loadRecipes } from "../lib/recipe.ts";
import { getRecipesDir, getDataDir, getRejectedDir } from "../lib/paths.ts";
import { getSessionMeta } from "../lib/conversation.ts";
import { generateFrontmatter } from "../lib/frontmatter.ts";
import { runClaude, ClaudeTimeoutError, ClaudeAbortError } from "../lib/claude-runner.ts";
import type { ClaudeRunOptions } from "../lib/claude-runner.ts";
import { recordObservation } from "../lib/rate-limit-store.ts";
import type { RateLimitObservation } from "../lib/rate-limit-parser.ts";
import {
  DISPATCHER_RECIPE_NAME,
  dequeue,
  enqueueBatch,
  markDone,
  markFailed,
  markSkipped,
  getDoneLineCount,
  recordDispatchDecision,
} from "../lib/queue.ts";
import { runDispatcher } from "../lib/dispatcher.ts";
import { runQualityGate } from "../lib/quality-gate.ts";
import { matchesRecipe } from "../lib/recipe-matcher.ts";
import { getClaudeMeta } from "../lib/claude-meta.ts";
import { listRecentOutputs, formatInjectedRecent } from "../lib/recent-outputs.ts";
import { CliError } from "../lib/errors.ts";
import {
  splitTimeline,
  extractChunkText,
  DEFAULT_MAX_CHUNK_BYTES,
  type TimelineChunk,
} from "../lib/chunker.ts";
import { spawnWithTimeout, SpawnTimeoutError } from "../lib/spawn-timeout.ts";
import { log, logError } from "../lib/logging.ts";
import { formatDatePath, formatFileTimestamp } from "../lib/format.ts";
import { redactSecrets } from "../lib/redact.ts";
import { findSessionFile } from "../lib/session-finder.ts";
import { CSA_TIMEOUT_MS } from "../lib/constants.ts";
import type { Recipe, SessionMeta } from "../types/index.ts";

const csaBin = "claude-session-analysis";

/**
 * Record a rate_limit observation from a worker claude call.
 * Best-effort: any DB error is swallowed so worker processing isn't disrupted.
 */
function recordWorkerObservation(obs: RateLimitObservation): void {
  try {
    recordObservation({
      ts: Math.floor(Date.now() / 1000),
      fiveHour: obs.fiveHour,
      sevenDay: obs.sevenDay,
      source: "worker",
    });
  } catch (err) {
    logError({ msg: "rate_limit_record_failed", error: String(err) });
  }
}

function findRecipeByName(recipes: Recipe[], name: string): Recipe | undefined {
  return recipes.find((r) => r.name === name);
}

// --- フォークセッション用のタイムライン切り詰め ---

/**
 * フォークセッションのタイムラインから、フォーク後の新規部分のみを抽出する。
 * firstNewUuid の先頭8文字を CSA ブロックID として検索し、
 * そのブロック以降（--- 区切り含む）を返す。
 */
export function trimTimelineForFork(timelineText: string, firstNewUuid: string): string {
  if (!firstNewUuid) return timelineText;

  const blockIdPrefix = firstNewUuid.slice(0, 8);
  const lines = timelineText.split("\n");

  // ヘッダー（最初の --- ... --- ペア）を特定
  let headerEnd = 0;
  if (lines[0]?.trim() === "---") {
    let i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") i++;
    headerEnd = i + 1; // 閉じの --- の次
  }

  // CSA ブロックID パターン: タイプ文字(U,T,B,F,G,R,W,S等) + 8文字hex
  // .includes() だとメッセージ本文中の偶然の一致で誤マッチするため、
  // CSA のブロックIDフォーマットに限定してマッチする
  const blockIdPattern = new RegExp(`[A-Z]${blockIdPrefix}\\b`);

  // ブロックIDを含む行を探す
  for (let i = headerEnd; i < lines.length; i++) {
    if (blockIdPattern.test(lines[i] ?? "")) {
      // この行を含むブロックの開始位置（直前の --- か headerEnd）を見つける
      let blockStart = i;
      for (let j = i - 1; j >= headerEnd; j--) {
        if (lines[j]?.trim() === "---") {
          blockStart = j;
          break;
        }
      }
      // ヘッダー + このブロック以降を返す
      const header = lines.slice(0, headerEnd).join("\n");
      const body = lines.slice(blockStart).join("\n");
      return header + "\n" + body;
    }
  }

  // 見つからない場合はそのまま返す
  return timelineText;
}

// --- チャンク分割パス用のプロンプトビルダー ---

/**
 * セクションプロンプトを生成する。
 * 各チャンクを個別に処理するための指示をレシピの指示と組み合わせる。
 */
export function buildSectionPrompt(
  recipePrompt: string,
  chunk: TimelineChunk,
  chunkText: string,
  sessionInfo: string,
): string {
  return `あなたはこれからセッションの一部分（チャンク）を読みます。
以下のレシピの指示に従って、このチャンクについてのセクションを書いてください。

--- レシピの指示 ---
${recipePrompt}
---

重要:
- このチャンクの内容に集中して、深く具体的に書いてください
- 短くまとめすぎないでください。このセクションはそのまま最終出力の一部になります
- セクション見出し（## ）を1つ付けてください。内容に合った見出しにしてください
- 他のチャンクの内容は知らなくて構いません

---
## チャンク情報
- チャンク: ${chunk.index + 1}/${chunk.label}
- ターン数: ${chunk.turnCount}

## セッション情報
${sessionInfo}

## 会話タイムライン（このチャンクの部分）
${chunkText}`;
}

/**
 * 合成プロンプトを生成する。
 * 各セクションの結果を統合して最終出力を作るための指示。
 */
export function buildSynthesisPrompt(sections: string[], sessionInfo: string): string {
  return `出力はMarkdown形式で。

以下は、あるセッションの出力を分割して書いたセクションです。
あなたの仕事は：

1. 全セクションをそのまま並べる（各セクションの見出しと本文はそのまま維持）
2. 冒頭にタイトル（# ）を付ける
3. 末尾に「## まとめ」セクションを追加する
   - 全体を通して感じたことを自分の言葉で書く
   - 各セクションの繰り返しにならないように、俯瞰的な視点で
   - セッション全体の流れや変化について

各セクションは編集しないでください。追加するのはタイトルとまとめだけです。

---
## セッション情報
${sessionInfo}

## セクション一覧
${sections.map((s, i) => `### --- セクション ${i + 1} ---\n${s}`).join("\n\n")}`;
}

/**
 * チャンク分割パスで処理する。
 * 各チャンクを並列で処理し、結果を合成する。
 *
 * フォールバック戦略:
 * 1. 全チャンクを並列実行
 * 2. 失敗チャンクがあれば1回リトライ
 * 3. まだ失敗があり、全体サイズが maxChunkBytes 以内なら分割なしで1回再試行
 * 4. それでも失敗なら例外を投げる
 *
 * @param _runClaudeOverride - テスト用: runClaude の差し替え関数
 */
export async function processChunked(
  convText: string,
  chunks: TimelineChunk[],
  recipePrompt: string,
  sessionId: string,
  meta: SessionMeta,
  timeoutMs?: number,
  _runClaudeOverride?: (options: ClaudeRunOptions) => Promise<string>,
  externalSignal?: AbortSignal,
): Promise<string> {
  const run = _runClaudeOverride ?? runClaude;
  const sessionInfo = `- Session ID: ${sessionId}\n- Project: ${meta.project || "unknown"}\n- Created: ${meta.startTime.toISOString()}`;
  const lines = convText.split("\n");

  const controller = new AbortController();

  // 外部 signal が abort されたら内部の controller も abort する
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  // --- Step 1: 全チャンクを並列実行 ---
  const sectionSettled = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const chunkText = extractChunkText(lines, chunk);
      const sectionPrompt = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo);
      return await run({
        prompt: sectionPrompt,
        timeoutMs,
        signal: controller.signal,
        captureUsage: true,
        onUsageObserved: recordWorkerObservation,
      });
    }),
  );

  // 結果を集約: index をキーにした Map で管理
  const sectionResults = new Map<number, string>();
  const failedIndices: number[] = [];
  let hasAbortError = false;

  for (let i = 0; i < sectionSettled.length; i++) {
    const result = sectionSettled[i]!;
    if (result.status === "fulfilled") {
      sectionResults.set(i, result.value);
    } else if (result.reason instanceof ClaudeAbortError) {
      hasAbortError = true;
    } else {
      failedIndices.push(i);
    }
  }

  // 外部 signal による中断: リトライやフォールバックをスキップ
  if (hasAbortError && sectionResults.size === 0) {
    throw new ClaudeAbortError();
  }

  // --- Step 2: 失敗チャンクを1回リトライ ---
  let lastError: unknown = null;

  if (failedIndices.length > 0) {
    // Bail out early if the external signal was already aborted. Step 1 may
    // have succeeded on some chunks before the abort fired, which would leave
    // failedIndices populated by genuine errors; without this guard we would
    // pointlessly enter the retry loop with an aborted signal.
    if (externalSignal?.aborted) {
      throw new ClaudeAbortError();
    }

    log({ msg: "chunk_retry", failedChunks: failedIndices.length, totalChunks: chunks.length });

    const retrySettled = await Promise.allSettled(
      failedIndices.map(async (idx) => {
        // Re-check inside each task so that an abort racing with retry start
        // does not get masked behind a cascade of follow-up errors.
        if (externalSignal?.aborted) {
          throw new ClaudeAbortError();
        }
        const chunk = chunks[idx]!;
        const chunkText = extractChunkText(lines, chunk);
        const sectionPrompt = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo);
        return {
          idx,
          result: await run({
            prompt: sectionPrompt,
            timeoutMs,
            signal: controller.signal,
            captureUsage: true,
            onUsageObserved: recordWorkerObservation,
          }),
        };
      }),
    );

    const stillFailedIndices: number[] = [];
    for (const settled of retrySettled) {
      if (settled.status === "fulfilled") {
        sectionResults.set(settled.value.idx, settled.value.result);
      } else {
        lastError = settled.reason;
        // リトライ結果から失敗したindexを特定
        // Promise.allSettled は入力と同じ順序なので、failedIndices[i] で追跡
        stillFailedIndices.push(failedIndices[retrySettled.indexOf(settled)]!);
      }
    }

    // --- Step 3: まだ失敗があり、全体サイズが許容内なら分割なしフォールバック ---
    if (stillFailedIndices.length > 0) {
      // External abort raced with the retry phase: don't attempt the
      // unsplit fallback either, just surface the abort.
      if (externalSignal?.aborted || lastError instanceof ClaudeAbortError) {
        throw new ClaudeAbortError();
      }
      const totalBytes = new TextEncoder().encode(convText).length;
      if (totalBytes <= DEFAULT_MAX_CHUNK_BYTES) {
        log({ msg: "fallback_unsplit", totalBytes, maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES });
        const fullPrompt = `${recipePrompt}

---
## セッション情報
${sessionInfo}

## 会話タイムライン
${convText}`;
        const result = await run({
          prompt: fullPrompt,
          timeoutMs,
          signal: controller.signal,
          captureUsage: true,
          onUsageObserved: recordWorkerObservation,
        });
        // 分割なしフォールバック成功: synthesis 不要（1チャンク相当）
        return result;
      } else {
        log({
          msg: "fallback_unsplit_skipped",
          reason: "text_too_large",
          totalBytes,
          maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES,
        });
        throw lastError;
      }
    }
  }

  // 全チャンク成功
  const orderedResults = chunks.map((_, i) => sectionResults.get(i)!);

  // チャンク1つの場合は synthesis 不要: セクション結果をそのまま返す
  if (orderedResults.length === 1) {
    return orderedResults[0]!;
  }

  // 複数チャンク: 合成 (外部signalも渡す)
  const synthesisPrompt = buildSynthesisPrompt(orderedResults, sessionInfo);
  return run({
    prompt: synthesisPrompt,
    timeoutMs,
    signal: externalSignal,
    captureUsage: true,
    onUsageObserved: recordWorkerObservation,
  });
}

export type ProcessResult = "processed" | "failed" | "empty";

export interface RunProcessOptions {
  taskTimeoutMs?: number;
  /** AbortSignal from the overall timeout. Propagated to runClaude calls. */
  signal?: AbortSignal;
}

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
  } = input;
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
    const csaResult = await spawnWithTimeout({
      cmd: [csaBin, "timeline", sessionId, "--md", "--no-emoji"],
      timeoutMs: CSA_TIMEOUT_MS,
    });

    if (csaResult.exitCode !== 0) {
      logError({ key, msg: "csa_failed", exitCode: csaResult.exitCode, stderr: csaResult.stderr });
      throw new Error(`csa failed with exit code ${csaResult.exitCode}`);
    }
    convText = csaResult.stdout;
  } catch (err) {
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
  const separatorCount = convText.split("\n").filter((l) => l.trim() === "---").length;
  if (separatorCount < 2) {
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

  // Redact secrets from the timeline before sending to Claude.
  // Best-effort filter: applies to both the prompt sent to the API and (by
  // extension) anything the model may transcribe into the output article.
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
        undefined,
        signal,
      );
    } else {
      // 既存の単一パス（変更なし）
      const fullPrompt = `${prompt}

---
## セッション情報
- Session ID: ${sessionId}
- Project: ${meta.project || "unknown"}
- Created: ${sessionStart}

## 会話タイムライン
${timelineText}`;
      output = await runClaude({
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
  const fmData: Record<string, unknown> = {
    session_id: sessionId,
    project: meta.project || "unknown",
    session_start: sessionStart,
    session_end: sessionEnd,
    generated_at: generatedAt,
    recipe: recipeName,
    user_turns: sessionStats.turns ?? meta.userTurns,
    session_bytes: sessionStats.bytes,
    duration_ms: sessionStats.duration_ms,
    // DR-0008 §10: track which model/version produced this output so future
    // analyses (Phase 4 quality_guidelines auto-update) can segment by model.
    claude_model: claudeMeta.model,
    claude_version: claudeMeta.version,
  };
  if (meta.forkInfo) {
    fmData.forked_from = meta.forkInfo.parentSessionId;
  }
  const fm = generateFrontmatter(fmData);

  // Output file path: {dataDir}/{recipeName}/YYYY/MM/DD/{yyyymmddTHHMMSSZ}.{sessionId}.md
  const datePath = formatDatePath(meta.startTime);
  const outputDir = join(dataDir, recipeName, datePath);
  await mkdir(outputDir, { recursive: true });

  const fileTs = formatFileTimestamp(meta.startTime);
  const outputFile = join(outputDir, `${fileTs}.${sessionId}.md`);
  const fullOutput = fm + output;

  // DR-0008 §8: quality gate before persisting. Gate is conservative — any
  // LLM unreachability or parse failure falls back to accepted (don't block
  // the main path on the gate's own reliability).
  const verdict = await runQualityGate({
    output,
    recipeName,
    timeoutMs: taskTimeoutMs,
    signal,
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
    await mkdir(rejectedDir, { recursive: true });
    const rejectedFile = join(rejectedDir, `${fileTs}.${sessionId}.md`);
    await Bun.write(rejectedFile, fullOutput);
    log({ key, msg: "quality_rejected", output: rejectedFile, reason: verdict.reason });
    return { kind: "skipped", reason: "quality_rejected", lineCount: meta.lineCount };
  }

  await Bun.write(outputFile, fullOutput);
  log({ key, msg: "success", output: outputFile });

  return { kind: "processed", outputFile, lineCount: meta.lineCount };
}

/**
 * Fetch session stats from claude-session-analysis.
 * Best-effort: returns empty object if CSA fails or times out.
 */
export async function fetchSessionStats(
  sessionId: string,
  logKey: string,
): Promise<{ turns?: number; bytes?: number; duration_ms?: number }> {
  try {
    const statsResult = await spawnWithTimeout({
      cmd: [csaBin, "sessions", "--format", "jsonl", sessionId],
      timeoutMs: CSA_TIMEOUT_MS,
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
 * Load recipes, throwing a CliError with a helpful message if the recipes dir
 * doesn't exist. Shared by runProcess and runConvert.
 */
export async function loadRecipesOrFail(): Promise<Recipe[]> {
  try {
    return await loadRecipes(getRecipesDir());
  } catch {
    throw new CliError(
      `No recipes found in ${getRecipesDir()}\nCreate recipe-*.md files in that directory. See config-examples/ for examples.`,
    );
  }
}

export { findRecipeByName };

export async function runProcess(options: RunProcessOptions = {}): Promise<ProcessResult> {
  const entry = await dequeue();
  if (!entry) {
    log({ msg: "no_items_in_queue" });
    return "empty";
  }

  const { sessionId, recipeName, key } = entry;
  const config = await loadConfig();
  const dataDir = getDataDir();

  // Find session file
  const sessionFile = await findSessionFile(config.claudeDirs, sessionId);
  if (!sessionFile) {
    log({ key, msg: "session_file_not_found" });
    await markFailed(sessionId, recipeName, "session file not found");
    return "failed";
  }

  // Find recipe (user recipes only; dispatcher is a sentinel handled separately).
  const recipes = await loadRecipesOrFail();

  // Phase 2: dispatcher entry is a recipe-less control row. Handle it before
  // any per-recipe lookup or processSession call.
  if (recipeName === DISPATCHER_RECIPE_NAME) {
    return await runDispatcherEntry({ sessionId, key, sessionFile, recipes, options });
  }

  const recipe = findRecipeByName(recipes, recipeName);
  if (!recipe) {
    log({ key, msg: "recipe_not_found", recipe: recipeName });
    await markFailed(sessionId, recipeName, `recipe not found: ${recipeName}`);
    return "failed";
  }

  // Get session metadata
  const meta = await getSessionMeta(sessionFile);

  // Get session stats from claude-session-analysis (early fetch for log + frontmatter)
  const sessionStats = await fetchSessionStats(sessionId, key);

  // Determine mode based on on_existing and done state
  let hasPreviousRun = false;
  const prevLineCount = await getDoneLineCount(sessionId, recipeName);
  if (prevLineCount !== null && meta.lineCount > prevLineCount) {
    hasPreviousRun = true;
  }

  let appendPreviousRunNote = false;
  if (hasPreviousRun) {
    switch (recipe.onExisting) {
      case "skip":
        log({ key, msg: "skip", reason: "already_processed" });
        await markSkipped(sessionId, recipeName, "already_processed", meta.lineCount);
        return "processed";
      case "append":
        appendPreviousRunNote = true;
        break;
      case "separate":
        // New file, no modification needed
        break;
    }
  }

  try {
    const result = await processSession({
      sessionId,
      recipe,
      meta,
      sessionStats,
      dataDir,
      taskTimeoutMs: options.taskTimeoutMs,
      signal: options.signal,
      forceProcess: false,
      appendPreviousRunNote,
      logKey: key,
    });
    if (result.kind === "skipped") {
      await markSkipped(sessionId, recipeName, result.reason, result.lineCount);
      return "processed";
    }
    await markDone(sessionId, recipeName, result.lineCount, result.outputFile);
    return "processed";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markFailed(sessionId, recipeName, reason);
    return "failed";
  }
}

/**
 * Phase 2 dispatcher worker: invoked when dequeue() returns a (session,
 * 'dispatcher') row. Decides which user recipes apply, fans them out via
 * enqueueBatch / markSkipped, records the decision in history, and marks
 * the dispatcher entry itself done.
 */
async function runDispatcherEntry(args: {
  sessionId: string;
  key: string;
  sessionFile: string;
  recipes: Recipe[];
  options: RunProcessOptions;
}): Promise<ProcessResult> {
  const { sessionId, key, sessionFile, recipes, options } = args;
  const meta = await getSessionMeta(sessionFile);

  // Empty / zero-line sessions cannot meaningfully be dispatched. Reuse the
  // markDone path (lineCount=0) so a subsequent append re-evaluates per
  // §5.1 (done, new > old → queued).
  if (meta.lineCount === 0) {
    log({ key, msg: "dispatcher_empty_session" });
    await markDone(sessionId, DISPATCHER_RECIPE_NAME, meta.lineCount, null);
    return "processed";
  }

  // Static match filter — recipes whose project/minTurns/minAge don't fit
  // this session are never candidates, so we don't even surface them to the
  // LLM (saves prompt tokens, narrows the decision space).
  const matched = recipes.filter((r) => matchesRecipe(r, meta));
  if (matched.length === 0) {
    log({ key, msg: "dispatcher_no_matching_recipes" });
    await markDone(sessionId, DISPATCHER_RECIPE_NAME, meta.lineCount, null);
    return "processed";
  }

  let decision;
  try {
    decision = await runDispatcher({
      sessionId,
      meta,
      recipes: matched,
      timeoutMs: options.taskTimeoutMs,
      signal: options.signal,
    });
  } catch (err) {
    // Transient (spawn/API/timeout): markFailed so the retry mechanism kicks in.
    const reason = err instanceof Error ? err.message : String(err);
    logError({ key, msg: "dispatcher_failed", error: reason });
    await markFailed(sessionId, DISPATCHER_RECIPE_NAME, reason);
    return "failed";
  }

  log({
    key,
    msg: "dispatcher_decided",
    accepted: decision.acceptedRecipes,
    rejected: decision.rejectedRecipes,
    fallback: decision.fallback?.reason ?? null,
  });

  // Enqueue accepted recipes (queue.ts §5.1 rules apply per entry: existing
  // done/skipped(no_effective_turn) with stale lineCount auto-recover; same-
  // lineCount no-op; quality_rejected stays skipped).
  if (decision.acceptedRecipes.length > 0) {
    enqueueBatch(
      decision.acceptedRecipes.map((name) => ({
        sessionId,
        recipeName: name,
        lineCount: meta.lineCount,
      })),
    );
  }

  // Mark rejected recipes as skipped(dispatcher_rejected, lineCount=N) so a
  // later append (lineCount > N) triggers a fresh dispatch decision via
  // queue.ts §5.1.
  for (const name of decision.rejectedRecipes) {
    await markSkipped(sessionId, name, "dispatcher_rejected", meta.lineCount);
  }

  // Audit log: append the full decision JSON to history.
  await recordDispatchDecision(sessionId, decision.decisionMessage);

  // Dispatcher row itself is done. line_count=meta.lineCount so §5.1
  // (done, new > old → queued) re-fires the dispatcher when the session grows.
  await markDone(sessionId, DISPATCHER_RECIPE_NAME, meta.lineCount, null);
  return "processed";
}

const sessionProcess = define({
  name: "process",
  description: "Process one item from the queue",
  run: async () => {
    await runProcess();
  },
});

export default sessionProcess;
