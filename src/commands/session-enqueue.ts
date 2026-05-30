import { define } from "gunshi";
import { join } from "node:path";
import { loadConfig } from "../lib/config.ts";
import { loadRecipes } from "../lib/recipe.ts";
import { getRecipesDir } from "../lib/paths.ts";
import { getSessionMeta } from "../lib/conversation.ts";
import { matchesRecipe } from "../lib/recipe-matcher.ts";
import { enqueueBatch, loadQueueState, isFailedByState, markSkipped } from "../lib/queue.ts";
import { CliError } from "../lib/errors.ts";
import { dirExists } from "../lib/dir-exists.ts";
import { log } from "../lib/logging.ts";
import { UUID_JSONL_PATTERN } from "../lib/session-finder.ts";

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

      // Check each recipe (matchesRecipe filter applies in both branches).
      for (const recipe of recipes) {
        if (!matchesRecipe(recipe, meta)) continue;

        const key = `${meta.id}.${recipe.name}`;

        // Pre-filter using queue state to avoid pointless DB round-trips.
        // queue.ts §5.1 also defends these invariants at write time.
        if (state.queued.has(key)) continue;
        if (isFailedByState(state, key)) continue;
        const doneEntry = state.done.get(key);
        if (doneEntry && doneEntry.lineCount >= meta.lineCount) continue;

        if (noEffective) {
          noEffectiveSkips.push({
            sessionId: meta.id,
            recipeName: recipe.name,
            lineCount: meta.lineCount,
          });
          log({ msg: "no_effective_turn_skipped", key });
          continue;
        }

        pending.push({ sessionId: meta.id, recipeName: recipe.name, lineCount: meta.lineCount });
        log({ msg: "queued", key });
      }
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

const sessionEnqueue = define({
  name: "enqueue",
  description: "Find sessions and add to queue",
  run: async () => {
    await runEnqueue();
  },
});

export default sessionEnqueue;
