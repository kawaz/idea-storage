import { describe, expect, test } from "bun:test";
import { parseRecipe } from "./recipe.ts";
import { join } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

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
