import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findRecipeByName, loadRecipesOrFail, matchesRecipe, parseRecipe } from "./recipe.ts";
import { CliError } from "./errors.ts";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Recipe, SessionMeta } from "../types/index.ts";

describe("parseRecipe", () => {
  test("parses match conditions and prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipe-test-"));
    const filePath = join(dir, "recipe-diary.md");
    await writeFile(
      filePath,
      `---
match:
  project: "*/myapp/*"
  min_turns: 3
  min_age: 7200
---
Write a diary entry.
`,
    );
    const recipe = await parseRecipe(filePath);
    expect(recipe.name).toBe("diary");
    expect(recipe.match.project).toBe("*/myapp/*");
    expect(recipe.match.minTurns).toBe(3);
    expect(recipe.match.minAge).toBe(7200);
    expect(recipe.onExisting).toBe("append"); // default
    expect(recipe.prompt).toContain("Write a diary entry.");
  });

  test("parses on_existing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipe-test-"));
    const filePath = join(dir, "recipe-review.md");
    await writeFile(
      filePath,
      `---
on_existing: skip
---
Review prompt.
`,
    );
    const recipe = await parseRecipe(filePath);
    expect(recipe.onExisting).toBe("skip");
  });

  test("applies default values for missing fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipe-test-"));
    const filePath = join(dir, "recipe-minimal.md");
    await writeFile(
      filePath,
      `---
---
Minimal prompt.
`,
    );
    const recipe = await parseRecipe(filePath);
    expect(recipe.name).toBe("minimal");
    expect(recipe.match).toEqual({});
    expect(recipe.onExisting).toBe("append");
  });

  test("extracts name from filename by removing recipe- prefix and .md suffix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "recipe-test-"));
    const filePath = join(dir, "recipe-diary-work.md");
    await writeFile(
      filePath,
      `---
---
Work prompt.
`,
    );
    const recipe = await parseRecipe(filePath);
    expect(recipe.name).toBe("diary-work");
  });
});

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "test-recipe",
    filePath: "/tmp/recipe-test.md",
    match: {},
    onExisting: "append",
    prompt: "Test prompt",
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "test-session-id",
    filePath: "/tmp/session.jsonl",
    project: "/Users/kawaz/projects/myapp",
    lineCount: 200,
    ageSec: 3600,
    startTime: new Date("2025-01-01T00:00:00"),
    userTurns: 5,
    effectiveUserTurns: 3,
    ...overrides,
  };
}

describe("matchesRecipe", () => {
  test("returns true when all conditions match", () => {
    const recipe = makeRecipe({
      match: {
        project: "*/myapp",
        minTurns: 3,
        minAge: 1800,
      },
    });
    const session = makeSession({
      project: "/Users/kawaz/projects/myapp",
      userTurns: 5,
      ageSec: 3600,
    });
    expect(matchesRecipe(recipe, session)).toBe(true);
  });

  test("returns false when project does not match", () => {
    const recipe = makeRecipe({
      match: { project: "*/emeradaco/*" },
    });
    const session = makeSession({
      project: "/Users/kawaz/projects/myapp",
    });
    expect(matchesRecipe(recipe, session)).toBe(false);
  });

  test("matches project with glob pattern", () => {
    const recipe = makeRecipe({
      match: { project: "*/emeradaco/*" },
    });
    const session = makeSession({
      project: "/Users/kawaz/repos/emeradaco/antenna",
    });
    expect(matchesRecipe(recipe, session)).toBe(true);
  });

  test("returns false when userTurns is below minTurns", () => {
    const recipe = makeRecipe({
      match: { minTurns: 3 },
    });
    const session = makeSession({ userTurns: 2 });
    expect(matchesRecipe(recipe, session)).toBe(false);
  });

  test("default minTurns=1 filters out sessions with 0 user turns", () => {
    const recipe = makeRecipe({ match: {} });
    const session = makeSession({ userTurns: 0 });
    expect(matchesRecipe(recipe, session)).toBe(false);
  });

  test("default minTurns=1 allows sessions with 1+ user turns", () => {
    const recipe = makeRecipe({ match: {} });
    const session = makeSession({ userTurns: 1 });
    expect(matchesRecipe(recipe, session)).toBe(true);
  });

  test("returns false when ageSec is below minAge", () => {
    const recipe = makeRecipe({
      match: { minAge: 7200 },
    });
    const session = makeSession({ ageSec: 3600 });
    expect(matchesRecipe(recipe, session)).toBe(false);
  });

  test("recipe with no conditions matches sessions with user turns", () => {
    const recipe = makeRecipe({ match: {} });
    const session = makeSession();
    expect(matchesRecipe(recipe, session)).toBe(true);
  });

  test("boundary: userTurns exactly equals minTurns matches", () => {
    const recipe = makeRecipe({ match: { minTurns: 5 } });
    const session = makeSession({ userTurns: 5 });
    expect(matchesRecipe(recipe, session)).toBe(true);
  });

  test("boundary: ageSec exactly equals minAge matches", () => {
    const recipe = makeRecipe({ match: { minAge: 3600 } });
    const session = makeSession({ ageSec: 3600 });
    expect(matchesRecipe(recipe, session)).toBe(true);
  });

  test("古いセッションも maxAge 制限なくマッチする", () => {
    const recipe = makeRecipe({ match: { minAge: 60 } });
    const session = makeSession({ ageSec: 999999 });
    expect(matchesRecipe(recipe, session)).toBe(true);
  });
});

describe("findRecipeByName", () => {
  const recipes: Recipe[] = [
    makeRecipe({ name: "diary" }),
    makeRecipe({ name: "review" }),
    makeRecipe({ name: "summary" }),
  ];

  test("returns the recipe when name matches", () => {
    const found = findRecipeByName(recipes, "review");
    expect(found?.name).toBe("review");
  });

  test("returns undefined when no recipe matches the name", () => {
    expect(findRecipeByName(recipes, "no-such-recipe")).toBeUndefined();
  });

  test("returns undefined for an empty recipes array", () => {
    expect(findRecipeByName([], "diary")).toBeUndefined();
  });
});

describe("loadRecipesOrFail", () => {
  let prevXdgConfig: string | undefined;
  let tmpBase: string;
  let recipesDir: string;

  beforeEach(async () => {
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    tmpBase = await mkdtemp(join(tmpdir(), "idea-storage-loadrecipes-"));
    process.env.XDG_CONFIG_HOME = tmpBase;
    // getRecipesDir() = getConfigDir() = `${XDG_CONFIG_HOME}/idea-storage/`
    recipesDir = join(tmpBase, "idea-storage");
  });

  afterEach(async () => {
    if (prevXdgConfig === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = prevXdgConfig;
    }
    await rm(tmpBase, { recursive: true, force: true });
  });

  test("returns recipes when configDir has 1+ recipe", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(join(recipesDir, "recipe-foo.md"), `---\n---\nFoo prompt.\n`);
    const recipes = await loadRecipesOrFail();
    expect(recipes).toHaveLength(1);
    expect(recipes[0]?.name).toBe("foo");
  });

  test("returns empty array when recipes dir exists but contains no recipes", async () => {
    // Design rationale: loadRecipesOrFail throws only when the recipes dir is
    // missing; an empty dir returns []. Caller (e.g. runProcess) decides what
    // to do with an empty list.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(recipesDir, { recursive: true });
    const recipes = await loadRecipesOrFail();
    expect(recipes).toEqual([]);
  });

  test("throws CliError when recipes dir does not exist", async () => {
    // recipesDir under tmpBase is intentionally not created
    await expect(loadRecipesOrFail()).rejects.toBeInstanceOf(CliError);
    await expect(loadRecipesOrFail()).rejects.toThrow(/No recipes found in/);
  });
});
