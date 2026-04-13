import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
import { parseFrontmatter } from "./frontmatter.ts";
import type { Recipe } from "../types/index.ts";

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

  return {
    name,
    filePath,
    match,
    onExisting,
    prompt: body,
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
