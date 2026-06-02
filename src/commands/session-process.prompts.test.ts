import { describe, expect, test } from "bun:test";
import { buildSectionPrompt, buildSynthesisPrompt } from "./session-process.ts";
import type { TimelineChunk } from "../lib/chunker.ts";

// --- buildSectionPrompt / buildSynthesisPrompt のユニットテスト ---
// Pure pure prompt construction. No I/O, no LLM, no CSA spawn.

describe("buildSectionPrompt", () => {
  const recipePrompt = "日記を書いてください";
  const sessionInfo =
    "- Session ID: abc123\n- Project: my-project\n- Created: 2025-01-01T00:00:00Z";

  function makeChunk(overrides: Partial<TimelineChunk> = {}): TimelineChunk {
    return {
      index: 0,
      turns: [],
      startTime: new Date("2025-01-01T00:00:00Z"),
      endTime: new Date("2025-01-01T01:00:00Z"),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: "1/1 00:00-01:00",
      ...overrides,
    };
  }

  test("レシピの指示がプロンプトに含まれる", () => {
    const chunk = makeChunk();
    const result = buildSectionPrompt(recipePrompt, chunk, "チャンクのテキスト", sessionInfo);
    expect(result).toContain(recipePrompt);
  });

  test("チャンク情報（index, label, turnCount）がプロンプトに含まれる", () => {
    const chunk = makeChunk({ index: 2, label: "1/1-1/2", turnCount: 10 });
    const result = buildSectionPrompt(recipePrompt, chunk, "テキスト", sessionInfo);
    expect(result).toContain("3");
    expect(result).toContain("1/1-1/2");
    expect(result).toContain("10");
  });

  test("セッション情報がプロンプトに含まれる", () => {
    const chunk = makeChunk();
    const result = buildSectionPrompt(recipePrompt, chunk, "テキスト", sessionInfo);
    expect(result).toContain("abc123");
    expect(result).toContain("my-project");
  });

  test("chunkText がプロンプト末尾に含まれる", () => {
    const chunk = makeChunk();
    const chunkText = "ユーザーがコードをレビューしました";
    const result = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo);
    expect(result).toContain(chunkText);
  });

  test("セクション見出しの指示が含まれる", () => {
    const chunk = makeChunk();
    const result = buildSectionPrompt(recipePrompt, chunk, "テキスト", sessionInfo);
    expect(result).toContain("セクション見出し");
  });
});

describe("buildSynthesisPrompt", () => {
  const sessionInfo =
    "- Session ID: abc123\n- Project: my-project\n- Created: 2025-01-01T00:00:00Z";

  test("全セクションがプロンプトに含まれる", () => {
    const sections = ["## セクション1\n内容A", "## セクション2\n内容B"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("内容A");
    expect(result).toContain("内容B");
  });

  test("セクション番号が付与される", () => {
    const sections = ["セクションA", "セクションB", "セクションC"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("セクション 1");
    expect(result).toContain("セクション 2");
    expect(result).toContain("セクション 3");
  });

  test("セッション情報がプロンプトに含まれる", () => {
    const sections = ["内容"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("abc123");
    expect(result).toContain("my-project");
  });

  test("タイトルとまとめの指示が含まれる", () => {
    const sections = ["内容"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("タイトル");
    expect(result).toContain("まとめ");
  });

  test("Markdown出力指示が含まれる", () => {
    const sections = ["内容"];
    const result = buildSynthesisPrompt(sections, sessionInfo);
    expect(result).toContain("Markdown");
  });
});
