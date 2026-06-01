import { loadConfig } from "../config.ts";
import { findRecipeByName, loadRecipesOrFail } from "../recipe.ts";
import { getDataDir } from "../paths.ts";
import { getSessionMeta, getSessionStats } from "../csa.ts";
import {
  DISPATCHER_RECIPE_NAME,
  dequeue,
  markDone,
  markFailed,
  markSkipped,
  getDoneLineCount,
} from "../queue.ts";
import { log } from "../logging.ts";
import { findSessionFile } from "../session-finder.ts";
import { processSession } from "../session-worker/index.ts";
import { runDispatcherEntry } from "./dispatcher-entry.ts";

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
