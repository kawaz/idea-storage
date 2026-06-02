import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
import { parseFrontmatter } from "../frontmatter.ts";
import { getRecipesDir } from "../paths.ts";
import { CliError } from "../errors.ts";
import type { SessionMeta } from "../csa/csa.ts";

export interface Recipe {
  /** recipe-*.md のファイル名から recipe- を除いた部分 */
  name: string;
  filePath: string;
  match: {
    /** glob パターン */
    project?: string;
    minTurns?: number;
    /** seconds */
    minAge?: number;
  };
  /** default 'append' */
  onExisting: "append" | "separate" | "skip";
  /** frontmatter 以外の本文 */
  prompt: string;
  /**
   * DR-0008 §7: dispatcher が「向き・不向き」を判断する手がかりに使う
   * 自由テキスト 1 行ヒント。任意。
   */
  hint?: string;
  /**
   * DR-0008 §9: recipe 実行時、directly preceding N 本の過去出力 (同一 recipe)
   * を prompt 先頭に自動付加する。任意。未指定 / 0 で注入なし。
   */
  injectRecent?: number;
}

/**
 * Parse a recipe-*.md file into a Recipe object.
 */
export async function parseRecipe(filePath: string): Promise<Recipe> {
  const content = await Bun.file(filePath).text();
  const { frontmatter, body } = parseFrontmatter(content);

  const fileName = basename(filePath, ".md");
  const name = fileName.replace(/^recipe-/, "");

  const rawMatch = (frontmatter.match ?? {}) as Record<string, unknown>;
  const match: Recipe["match"] = {};

  if (rawMatch.project != null) match.project = String(rawMatch.project);
  if (rawMatch.min_turns != null) match.minTurns = Number(rawMatch.min_turns);
  if (rawMatch.min_age != null) match.minAge = Number(rawMatch.min_age);
  const onExistingRaw = frontmatter.on_existing;
  let onExisting: Recipe["onExisting"] = "append";
  if (onExistingRaw === "separate" || onExistingRaw === "skip") {
    onExisting = onExistingRaw;
  }

  // DR-0008 §7: 自由テキスト 1 行ヒント。dispatcher が「向き・不向き」判断に使う。
  // 任意。未指定の recipe は dispatcher にとって判断不能 → recall 重視で候補に含める。
  const hintRaw = frontmatter.hint;
  const hint = typeof hintRaw === "string" && hintRaw.trim() ? hintRaw.trim() : undefined;

  // DR-0008 §9: inject_recent: N → recipe prompt 先頭に直近 N 本の過去出力を付加。
  // 任意、0 / 未指定 / 負数で注入なし。
  const injectRaw = frontmatter.inject_recent;
  let injectRecent: number | undefined;
  if (typeof injectRaw === "number" && Number.isFinite(injectRaw) && injectRaw > 0) {
    injectRecent = Math.floor(injectRaw);
  }

  return {
    name,
    filePath,
    match,
    onExisting,
    prompt: body,
    ...(hint !== undefined ? { hint } : {}),
    ...(injectRecent !== undefined ? { injectRecent } : {}),
  };
}

/**
 * Load all recipe-*.md files from a directory.
 */
export async function loadRecipes(recipesDir: string): Promise<Recipe[]> {
  const entries = await readdir(recipesDir);
  const recipeFiles = entries.filter((f) => f.startsWith("recipe-") && f.endsWith(".md")).sort();

  const recipes = await Promise.all(recipeFiles.map((f) => parseRecipe(join(recipesDir, f))));
  return recipes;
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

/**
 * Find a recipe by name from a list of recipes.
 */
export function findRecipeByName(recipes: Recipe[], name: string): Recipe | undefined {
  return recipes.find((r) => r.name === name);
}

/**
 * Test if a session matches a recipe's conditions.
 * All specified conditions must be satisfied (AND logic).
 * Unspecified conditions are skipped (always match).
 */
export function matchesRecipe(recipe: Recipe, session: SessionMeta): boolean {
  const { match } = recipe;

  // project: glob match
  // Design rationale: Recipe patterns use single `*` intending to match across
  // path separators (e.g. `*/emeradaco/*`), but Bun.Glob treats `*` as not
  // matching `/`. We normalize lone `*` to `**` for path-level globbing.
  if (match.project != null) {
    const pattern = match.project.replace(/(?<!\*)\*(?!\*)/g, "**");
    const glob = new Bun.Glob(pattern);
    if (!glob.match(session.project)) return false;
  }

  // minTurns (default 1: filter out sessions with no user interaction)
  const minTurns = match.minTurns ?? 1;
  if (session.userTurns < minTurns) return false;

  // minAge
  if (match.minAge != null && session.ageSec < match.minAge) return false;

  return true;
}
