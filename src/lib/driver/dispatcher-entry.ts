import { getSessionMeta } from "../csa/csa.ts";
import { matchesRecipe } from "../recipe/recipe.ts";
import {
  DISPATCHER_RECIPE_NAME,
  enqueueBatch,
  markDone,
  markFailed,
  markSkipped,
  recordDispatchDecision,
} from "../queue/queue.ts";
import { decideDispatch } from "../recipe/dispatcher.ts";
import { log, logError } from "../logging.ts";
import type { Recipe } from "../../types/index.ts";
import type { ProcessResult, RunProcessOptions } from "./process-driver.ts";

/**
 * Phase 2 dispatcher worker: invoked when dequeue() returns a (session,
 * 'dispatcher') row. Decides which user recipes apply, fans them out via
 * enqueueBatch / markSkipped, records the decision in history, and marks
 * the dispatcher entry itself done.
 */
export async function processDispatcherEntry(args: {
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
    decision = await decideDispatch({
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
