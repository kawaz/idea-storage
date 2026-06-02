import { join } from "node:path";
import { loadConfig } from "../config.ts";
import { loadRecipes, matchesRecipe } from "../recipe/recipe.ts";
import { getRecipesDir } from "../paths.ts";
import { getSessionMeta } from "../csa/csa.ts";
import {
  DISPATCHER_RECIPE_NAME,
  enqueueBatch,
  loadQueueState,
  isFailedByState,
  markSkipped,
} from "../queue/queue.ts";
import { CliError } from "../errors.ts";
import { dirExists } from "../dir-exists.ts";
import { log } from "../logging.ts";
import { UUID_JSONL_PATTERN } from "../csa/session-finder.ts";

export async function runEnqueue(): Promise<void> {
  const config = await loadConfig();
  let recipes;
  try {
    recipes = await loadRecipes(getRecipesDir());
  } catch {
    throw new CliError(
      `No recipes found in ${getRecipesDir()}\nCreate recipe-*.md files in that directory. See config-examples/ for examples.`,
    );
  }

  if (recipes.length === 0) {
    throw new CliError(
      `No recipes found in ${getRecipesDir()}\nCreate recipe-*.md files in that directory. See config-examples/ for examples.`,
    );
  }

  const minAgeSec = config.minAgeMinutes * 60;

  // Load queue state once upfront (readdir x3 instead of per-entry file checks)
  const state = await loadQueueState();

  const pending: Array<{ sessionId: string; recipeName: string; lineCount: number }> = [];
  // DR-0008 §5: effectiveUserTurns=0 のセッションは全 recipe を skipped(no_effective_turn) で
  // 記録する。後で session に追記されて effectiveUserTurns >= 1 になったら、queue.ts の
  // §5.1 ルールが自動で queued に復帰させる (no_effective_turn は REENQUEUABLE_SKIPPED_REASONS)。
  const noEffectiveSkips: Array<{ sessionId: string; recipeName: string; lineCount: number }> = [];

  for (const claudeDir of config.claudeDirs) {
    const projectsDir = join(claudeDir, "projects");
    const glob = new Bun.Glob("**/*.jsonl");

    if (!(await dirExists(projectsDir))) continue;

    for await (const relativePath of glob.scan(projectsDir)) {
      const filename = relativePath.split("/").pop() ?? "";
      if (!UUID_JSONL_PATTERN.test(filename)) continue;

      const filePath = join(projectsDir, relativePath);
      const meta = await getSessionMeta(filePath);

      // Age check (skip only too-young sessions; no upper limit)
      if (meta.ageSec < minAgeSec) continue;

      const noEffective = meta.effectiveUserTurns < 1;

      // matchesRecipe で静的に通過する user recipes を絞り込む。
      // - noEffective: それらすべてを no_effective_turn skip 対象に
      // - effective:  少なくとも 1 件通過すれば (session, 'dispatcher') を 1 件 enqueue
      //   (Phase 2 二段化: dispatcher が LLM ベースで最終判断)
      const matchedRecipes = recipes.filter((r) => matchesRecipe(r, meta));
      if (matchedRecipes.length === 0) continue;

      if (noEffective) {
        for (const recipe of matchedRecipes) {
          const key = `${meta.id}.${recipe.name}`;
          if (state.queued.has(key)) continue;
          if (isFailedByState(state, key)) continue;
          const doneEntry = state.done.get(key);
          if (doneEntry && doneEntry.lineCount >= meta.lineCount) continue;

          noEffectiveSkips.push({
            sessionId: meta.id,
            recipeName: recipe.name,
            lineCount: meta.lineCount,
          });
          log({ msg: "no_effective_turn_skipped", key });
        }
        continue;
      }

      // Phase 2: (session, 'dispatcher') を 1 件 queued する。
      // dispatcher 自身に対する state チェックは queue.ts §5.1 ルールが defense in depth で
      // 担うが、無駄な DB round-trip を避けるためここでも事前確認する。
      const dispatcherKey = `${meta.id}.${DISPATCHER_RECIPE_NAME}`;
      if (state.queued.has(dispatcherKey)) continue;
      if (isFailedByState(state, dispatcherKey)) continue;
      const dispatcherDone = state.done.get(dispatcherKey);
      if (dispatcherDone && dispatcherDone.lineCount >= meta.lineCount) continue;

      pending.push({
        sessionId: meta.id,
        recipeName: DISPATCHER_RECIPE_NAME,
        lineCount: meta.lineCount,
      });
      log({ msg: "queued", key: dispatcherKey, candidates: matchedRecipes.length });
    }
  }

  // Batch INSERT in a single transaction (§5.1 transition rules applied per entry).
  if (pending.length > 0) {
    enqueueBatch(pending);
  }

  // markSkipped is per-entry but cheap (single UPSERT each). Batching is a YAGNI
  // optimisation for now — most enqueue runs see at most a handful of no-effective
  // sessions, and the same §5.1 rules apply at recovery time so order doesn't matter.
  for (const { sessionId, recipeName, lineCount } of noEffectiveSkips) {
    await markSkipped(sessionId, recipeName, "no_effective_turn", lineCount);
  }

  log({
    msg: "enqueue_done",
    count: pending.length,
    skipped_no_effective: noEffectiveSkips.length,
  });
}
