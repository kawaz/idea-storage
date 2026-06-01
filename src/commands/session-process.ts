import { define } from "gunshi";
import { loadConfig } from "../lib/config.ts";
import { findRecipeByName, loadRecipesOrFail, matchesRecipe } from "../lib/recipe.ts";
import { getDataDir } from "../lib/paths.ts";
import { getSessionMeta, getSessionStats } from "../lib/csa.ts";
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
import { log, logError } from "../lib/logging.ts";
import { findSessionFile } from "../lib/session-finder.ts";
import { processSession } from "../lib/session-worker/index.ts";
import type { Recipe } from "../types/index.ts";

// --- Re-exports for backwards compatibility ---
//
// The library responsibilities (prompt building, fork trimming, chunked
// runner, frontmatter assembly, persistence, processSession orchestrator)
// moved to src/lib/session-worker/ in DR-0009 Phase 3 step 3-c. We keep
// re-exports here so existing imports (tests + session-convert) don't break.
// step 3-d will further extract the driver functions (runProcess /
// runDispatcherEntry) out of this file.
export { processSession } from "../lib/session-worker/index.ts";
export type { ProcessSessionInput, ProcessSessionResult } from "../lib/session-worker/index.ts";
export { buildSectionPrompt, buildSynthesisPrompt } from "../lib/session-worker/prompt-builder.ts";
export { trimTimelineForFork } from "../lib/session-worker/fork-timeline.ts";
export { processChunked } from "../lib/session-worker/chunked-runner.ts";

export type ProcessResult = "processed" | "failed" | "empty";

export interface RunProcessOptions {
  taskTimeoutMs?: number;
  /** AbortSignal from the overall timeout. Propagated to runClaude calls. */
  signal?: AbortSignal;
}

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
  const sessionStats = await getSessionStats(sessionId, key);

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
