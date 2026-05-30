import { describe, expect, test } from "bun:test";
import { runDispatcher } from "./dispatcher.ts";
import type { Recipe, SessionMeta } from "../types/index.ts";

function makeRecipe(name: string, hint?: string): Recipe {
  return {
    name,
    filePath: `/tmp/recipe-${name}.md`,
    match: {},
    onExisting: "append",
    prompt: `body for ${name}`,
    ...(hint !== undefined ? { hint } : {}),
  };
}

function makeMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "00000000-0000-4000-a000-000000000001",
    filePath: "/tmp/x.jsonl",
    project: "/home/user/proj",
    lineCount: 42,
    ageSec: 3600,
    startTime: new Date("2026-05-30T10:00:00Z"),
    userTurns: 7,
    effectiveUserTurns: 3,
    ...overrides,
  };
}

describe("runDispatcher", () => {
  const sessionId = "00000000-0000-4000-a000-000000000001";
  const baseRecipes = [
    makeRecipe("diary", "対話メイン、葛藤や葛藤の解消が含まれるセッション向け"),
    makeRecipe("knowledge", "新規 API・ライブラリの調査記録"),
    makeRecipe("ops"),
  ];

  test("LLM が JSON 採用リストを返したら accepted/rejected を partition する", async () => {
    const decision = await runDispatcher({
      sessionId,
      meta: makeMeta(),
      recipes: baseRecipes,
      promptTemplate: "PROMPT",
      _runClaude: async () =>
        JSON.stringify({
          recipes: [
            { name: "diary", reason: "葛藤あり" },
            { name: "knowledge", reason: "API 調査あり" },
          ],
        }),
    });

    expect(decision.acceptedRecipes).toEqual(["diary", "knowledge"]);
    expect(decision.rejectedRecipes).toEqual(["ops"]);
    expect(decision.fallback).toBeNull();
    const parsed = JSON.parse(decision.decisionMessage);
    expect(parsed.accepted).toEqual(["diary", "knowledge"]);
    expect(parsed.rejected).toEqual(["ops"]);
  });

  test('空配列 {"recipes":[]} は "書かない判断" として全 recipe を rejected に', async () => {
    const decision = await runDispatcher({
      sessionId,
      meta: makeMeta(),
      recipes: baseRecipes,
      promptTemplate: "PROMPT",
      _runClaude: async () => JSON.stringify({ recipes: [] }),
    });

    expect(decision.acceptedRecipes).toEqual([]);
    expect(decision.rejectedRecipes).toEqual(["diary", "knowledge", "ops"]);
    expect(decision.fallback).toBeNull();
  });

  test("存在しない recipe 名は無視され、知ってる名前だけ accepted に", async () => {
    const decision = await runDispatcher({
      sessionId,
      meta: makeMeta(),
      recipes: baseRecipes,
      promptTemplate: "PROMPT",
      _runClaude: async () =>
        JSON.stringify({
          recipes: [
            { name: "diary", reason: "ok" },
            { name: "nonexistent", reason: "huh" },
          ],
        }),
    });

    expect(decision.acceptedRecipes).toEqual(["diary"]);
    expect(decision.rejectedRecipes.sort()).toEqual(["knowledge", "ops"]);
    expect(decision.fallback).toBeNull();
    const parsed = JSON.parse(decision.decisionMessage);
    expect(parsed.unknown).toEqual(["nonexistent"]);
  });

  test("JSON parse 失敗時は全 recipe accepted の fallback を返す", async () => {
    const decision = await runDispatcher({
      sessionId,
      meta: makeMeta(),
      recipes: baseRecipes,
      promptTemplate: "PROMPT",
      _runClaude: async () => "ごめん JSON 出せなかった",
    });

    expect(decision.acceptedRecipes).toEqual(["diary", "knowledge", "ops"]);
    expect(decision.rejectedRecipes).toEqual([]);
    expect(decision.fallback?.reason).toBe("json_parse_error");
  });

  test("空文字列出力でも fallback が走る", async () => {
    const decision = await runDispatcher({
      sessionId,
      meta: makeMeta(),
      recipes: baseRecipes,
      promptTemplate: "PROMPT",
      _runClaude: async () => "",
    });

    expect(decision.fallback?.reason).toBe("json_parse_error");
    expect(decision.acceptedRecipes).toEqual(["diary", "knowledge", "ops"]);
  });

  test("LLM が周囲に説明文を付けてきた場合は {...} を抽出して parse する", async () => {
    const decision = await runDispatcher({
      sessionId,
      meta: makeMeta(),
      recipes: baseRecipes,
      promptTemplate: "PROMPT",
      _runClaude: async () =>
        '判断結果は以下です:\n{"recipes":[{"name":"diary","reason":"ok"}]}\n以上',
    });

    expect(decision.acceptedRecipes).toEqual(["diary"]);
    expect(decision.fallback).toBeNull();
  });

  test("LLM が throw したら caller (markFailed → retry) に伝播", async () => {
    await expect(
      runDispatcher({
        sessionId,
        meta: makeMeta(),
        recipes: baseRecipes,
        promptTemplate: "PROMPT",
        _runClaude: async () => {
          throw new Error("api timeout");
        },
      }),
    ).rejects.toThrow(/api timeout/);
  });

  test("recipe.hint がない場合は (no hint) としてプロンプトに含む", async () => {
    let capturedPrompt = "";
    await runDispatcher({
      sessionId,
      meta: makeMeta({ effectiveUserTurns: 5 }),
      recipes: [makeRecipe("hinted", "ある hint"), makeRecipe("no_hint")],
      promptTemplate: "TEMPLATE",
      _runClaude: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({ recipes: [] });
      },
    });

    expect(capturedPrompt).toContain("TEMPLATE");
    expect(capturedPrompt).toContain("- hinted: ある hint");
    expect(capturedPrompt).toContain("- no_hint: (no hint)");
    expect(capturedPrompt).toContain("effective_user_turns: 5");
  });
});
