import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { getDataDir } from "../paths.ts";
import { getSessionMeta, getSessionStats } from "../csa.ts";
import { findSessionFile } from "../session-finder.ts";
import { claim, markDone, markFailed, markSkipped, waitForCompletion } from "../queue.ts";
import { CliError } from "../errors.ts";
import { log, logError } from "../logging.ts";
import { formatDatePath, formatFileTimestamp } from "../format.ts";
import { getLatestObservations } from "../rate-limit-store.ts";
import { shouldSkip } from "../rate-limit-judge.ts";
import { RATE_LIMIT_STALE_THRESHOLD_SEC } from "../constants.ts";
import { findRecipeByName, loadRecipesOrFail } from "../recipe.ts";
import { processSession } from "../session-worker/index.ts";

export interface RunConvertInput {
  sessionId: string;
  recipeName: string;
  taskTimeoutMs?: number;
  signal?: AbortSignal;
  /** Override for waitForCompletion timeout (ms). */
  waitTimeoutMs?: number;
  /**
   * Bypass the rate-limit check. Defaults to false.
   * Should be set only when an explicit user intent overrides the shared quota
   * concern (Claude API 5h/7d limits) — convert is a manual command but it
   * still consumes the same quota that the worker tries to pace.
   */
  force?: boolean;
}

export type RunConvertResult =
  | { kind: "processed"; outputFile: string; lineCount: number }
  /** Skipped at the processSession level (e.g. no conversation). */
  | { kind: "skipped"; reason: string; lineCount: number }
  /** Another process was already processing; we waited and it completed. */
  | { kind: "waited"; outputFile: string; lineCount: number };

/**
 * Compute the deterministic output file path for a (sessionId, recipeName) pair.
 *
 * Design rationale: processSession derives the output path from meta.startTime,
 * so we can compute it independently here and report the path even when we did
 * not actually run the processing ourselves (waitForCompletion path).
 */
function computeOutputFile(
  dataDir: string,
  recipeName: string,
  sessionStart: Date,
  sessionId: string,
): string {
  const datePath = formatDatePath(sessionStart);
  const fileTs = formatFileTimestamp(sessionStart);
  return join(dataDir, recipeName, datePath, `${fileTs}.${sessionId}.md`);
}

/**
 * Convert: explicitly process a (session, recipe) pair, regardless of queue order
 * and recipe.onExisting setting.
 *
 * Behavior:
 * 1. Find session file & recipe (errors thrown to caller).
 * 2. Atomically claim the (session, recipe) key as processing.
 * 3. If we own the claim, run processSession with forceProcess=true and finalize
 *    via markDone / markFailed.
 * 4. If another process owns it, wait for completion via waitForCompletion and
 *    return the deterministic output file path on success.
 */
export async function runConvert(input: RunConvertInput): Promise<RunConvertResult> {
  const { sessionId, recipeName, taskTimeoutMs, signal, waitTimeoutMs } = input;
  const force = input.force ?? false;
  const key = `${sessionId}.${recipeName}`;

  // Rate-limit check (shared quota with worker). Bypass only when --force.
  // Same logic as session-run.ts so manual convert and worker apply identical
  // pacing rules to the Claude API 5h/7d budget.
  if (!force) {
    const latestObs = getLatestObservations(1);
    const decision = shouldSkip(latestObs, Math.floor(Date.now() / 1000), {
      staleThresholdSec: RATE_LIMIT_STALE_THRESHOLD_SEC,
    });
    if (decision.skip) {
      log({ key, msg: "convert_rate_limit_skip", reason: decision.reason });
      throw new CliError(
        `Rate limits over pace: ${decision.reason}\n` +
          `Use --force to bypass this check (this consumes shared quota; mainly for explicit user request).`,
      );
    }
  }

  const config = await loadConfig();
  const dataDir = getDataDir();

  // Find session file
  const sessionFile = await findSessionFile(config.claudeDirs, sessionId);
  if (!sessionFile) {
    log({ key, msg: "session_file_not_found" });
    throw new CliError(`session file not found for sessionId ${sessionId}`);
  }

  // Find recipe (CliError if recipes dir missing)
  const recipes = await loadRecipesOrFail();
  const recipe = findRecipeByName(recipes, recipeName);
  if (!recipe) {
    log({ key, msg: "recipe_not_found", recipe: recipeName });
    throw new CliError(`recipe not found: ${recipeName}`);
  }

  // Get session metadata (needed up-front for output path computation)
  const meta = await getSessionMeta(sessionFile);

  // Atomically claim ownership
  const claimResult = await claim(sessionId, recipeName);

  if (!claimResult.claimed) {
    // Another process is already processing this (session, recipe) pair.
    log({ key, msg: "convert_wait_for_other", prevStatus: claimResult.prevStatus });

    const waitResult = await waitForCompletion(
      sessionId,
      recipeName,
      waitTimeoutMs !== undefined ? { timeoutMs: waitTimeoutMs } : {},
    );

    if (waitResult.status === "done") {
      const outputFile = computeOutputFile(dataDir, recipeName, meta.startTime, sessionId);
      log({ key, msg: "convert_wait_done", lineCount: waitResult.lineCount });
      return { kind: "waited", outputFile, lineCount: waitResult.lineCount };
    }

    if (waitResult.status === "failed") {
      logError({ key, msg: "convert_wait_failed", reason: waitResult.reason });
      throw new CliError(
        `Other process failed while convert was waiting: ${waitResult.reason ?? "unknown"}`,
      );
    }

    if (waitResult.status === "skipped") {
      log({ key, msg: "convert_wait_skipped", reason: waitResult.reason });
      return {
        kind: "skipped",
        reason: waitResult.reason ?? "skipped_by_other_process",
        lineCount: meta.lineCount,
      };
    }

    // timeout
    logError({ key, msg: "convert_wait_timeout" });
    throw new CliError(`Timeout while waiting for other process to finish: ${key}`);
  }

  // We own processing.
  log({
    key,
    msg: "convert_start",
    prevStatus: claimResult.prevStatus,
    forceProcess: true,
    forcedRateLimit: force,
  });

  // Best-effort session stats fetch
  const sessionStats = await getSessionStats(sessionId, key);

  try {
    const result = await processSession({
      sessionId,
      recipe,
      meta,
      sessionStats,
      dataDir,
      taskTimeoutMs,
      signal,
      forceProcess: true,
      logKey: key,
    });

    if (result.kind === "skipped") {
      await markSkipped(sessionId, recipeName, result.reason, result.lineCount);
      return { kind: "skipped", reason: result.reason, lineCount: result.lineCount };
    }
    await markDone(sessionId, recipeName, result.lineCount, result.outputFile);
    return { kind: "processed", outputFile: result.outputFile, lineCount: result.lineCount };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markFailed(sessionId, recipeName, reason);
    throw err;
  }
}
