import { define } from "gunshi";
import { join } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { getDataDir } from "../lib/paths.ts";
import { getSessionMeta } from "../lib/conversation.ts";
import { findSessionFile } from "../lib/session-finder.ts";
import { claim, markDone, markFailed, markSkipped, waitForCompletion } from "../lib/queue.ts";
import { CliError, exitWithError } from "../lib/errors.ts";
import { validateRecipeName, validateSessionId } from "../lib/validate.ts";
import { log, logError } from "../lib/logging.ts";
import { formatDatePath, formatFileTimestamp } from "../lib/format.ts";
import { getLatestObservations } from "../lib/rate-limit-store.ts";
import { shouldSkip } from "../lib/rate-limit-judge.ts";
import { RATE_LIMIT_STALE_THRESHOLD_SEC } from "../lib/constants.ts";
import {
  fetchSessionStats,
  findRecipeByName,
  loadRecipesOrFail,
  processSession,
} from "./session-process.ts";

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
  const sessionStats = await fetchSessionStats(sessionId, key);

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

const sessionConvert = define({
  name: "convert",
  description: "Convert a specific (session, recipe) pair directly, bypassing queue order",
  args: {
    session: {
      type: "string",
      description: "Session ID (UUID)",
      required: true,
    },
    recipe: {
      type: "string",
      description: "Recipe name (without 'recipe-' prefix)",
      required: true,
    },
    force: {
      type: "boolean",
      description:
        "Bypass rate-limit check (consumes shared quota; use only when explicit user intent overrides shared-quota concerns)",
    },
  },
  run: async (ctx) => {
    const sessionId = ctx.values.session as string;
    const recipeName = ctx.values.recipe as string;
    const force = (ctx.values.force as boolean | undefined) ?? false;

    if (!sessionId || !recipeName) {
      exitWithError("Both --session and --recipe are required");
    }

    try {
      validateSessionId(sessionId);
      validateRecipeName(recipeName);
      const result = await runConvert({ sessionId, recipeName, force });
      switch (result.kind) {
        case "processed":
          console.log(result.outputFile);
          break;
        case "waited":
          console.log(result.outputFile);
          break;
        case "skipped":
          console.error(`Skipped: ${result.reason} (lineCount=${result.lineCount})`);
          break;
      }
    } catch (err) {
      exitWithError(err);
    }
  },
});

export default sessionConvert;
