import { type ClaudeRunner, ClaudeAbortError, runClaude } from "../claude-runner.ts";
import { DEFAULT_MAX_CHUNK_BYTES, extractChunkText, type TimelineChunk } from "../chunker.ts";
import { log } from "../logging.ts";
import { redactForPrompt } from "../redact-pipeline.ts";
import type { SessionMeta } from "../../types/index.ts";
import { buildSectionPrompt, buildSynthesisPrompt } from "./prompt-builder.ts";
import { recordWorkerObservation } from "./worker-observation.ts";

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
 * @param _runClaude - テスト用: runClaude の差し替え (DR-0009 Phase 3 step 3-e で
 *   `ClaudeRunner` 型に統一)
 */
export async function processChunked(
  convText: string,
  chunks: TimelineChunk[],
  recipePrompt: string,
  sessionId: string,
  meta: SessionMeta,
  timeoutMs?: number,
  _runClaude?: ClaudeRunner,
  externalSignal?: AbortSignal,
): Promise<string> {
  const run = _runClaude ?? runClaude;
  // meta.project (= session cwd) は session 由来の文字列で、env や path に
  // secret が含まれうる。dispatcher prompt は Phase 1 で redact 済だが、
  // article generation 系の prompt は補強コミットで対応 (codex review #3)。
  const projectSafe = redactForPrompt(meta.project || "unknown");
  const sessionInfo = `- Session ID: ${sessionId}\n- Project: ${projectSafe}\n- Created: ${meta.startTime.toISOString()}`;
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
  // 各 section は section LLM の生出力。LLM が transcribe / hallucinate
  // した secret を synthesis LLM に再送信しないよう redact pipeline を通す
  // (codex review CRITICAL #2)。
  const redactedSections = orderedResults.map(redactForPrompt);
  const synthesisPrompt = buildSynthesisPrompt(redactedSections, sessionInfo);
  return run({
    prompt: synthesisPrompt,
    timeoutMs,
    signal: externalSignal,
    captureUsage: true,
    onUsageObserved: recordWorkerObservation,
  });
}
