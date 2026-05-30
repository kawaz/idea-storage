import { describe, expect, test } from "bun:test";
import { runQualityGate } from "./quality-gate.ts";

describe("runQualityGate", () => {
  const baseInput = {
    output: "出力本文 (テスト)\n\nこれは中身のある記事です。",
    recipeName: "diary",
    guidelines: "GUIDELINES",
  };

  test("LLM が rejected を返したら kind='rejected' + reason", async () => {
    const verdict = await runQualityGate({
      ...baseInput,
      _runClaude: async () => JSON.stringify({ kind: "rejected", reason: "テンプレ表現連発" }),
    });
    expect(verdict.kind).toBe("rejected");
    expect(verdict.reason).toBe("テンプレ表現連発");
    expect(verdict.fallback).toBeNull();
  });

  test("LLM が accepted を返したら kind='accepted'", async () => {
    const verdict = await runQualityGate({
      ...baseInput,
      _runClaude: async () => JSON.stringify({ kind: "accepted", reason: "新しい気づきあり" }),
    });
    expect(verdict.kind).toBe("accepted");
    expect(verdict.reason).toBe("新しい気づきあり");
    expect(verdict.fallback).toBeNull();
  });

  test("LLM throw 時は fallback=accepted (= 退避しない、保守的)", async () => {
    const verdict = await runQualityGate({
      ...baseInput,
      _runClaude: async () => {
        throw new Error("api timeout");
      },
    });
    expect(verdict.kind).toBe("accepted");
    expect(verdict.fallback?.reason).toMatch(/claude_error/);
  });

  test("JSON parse 失敗時は fallback=accepted", async () => {
    const verdict = await runQualityGate({
      ...baseInput,
      _runClaude: async () => "ごめん JSON 出せませんでした",
    });
    expect(verdict.kind).toBe("accepted");
    expect(verdict.fallback?.reason).toBe("json_parse_error");
  });

  test("kind が不明値なら accepted にフォールバック (defensive)", async () => {
    const verdict = await runQualityGate({
      ...baseInput,
      _runClaude: async () => JSON.stringify({ kind: "maybe", reason: "曖昧" }),
    });
    expect(verdict.kind).toBe("accepted");
    expect(verdict.reason).toBe("曖昧");
  });

  test("出力本文が prompt に含まれる + recipe 名も伝わる", async () => {
    let captured = "";
    await runQualityGate({
      ...baseInput,
      _runClaude: async (p) => {
        captured = p;
        return JSON.stringify({ kind: "accepted", reason: "ok" });
      },
    });
    expect(captured).toContain("GUIDELINES");
    expect(captured).toContain("recipe=diary");
    expect(captured).toContain("出力本文 (テスト)");
  });

  test("LLM が周囲に説明文を付けてきた場合は {...} を抽出する", async () => {
    const verdict = await runQualityGate({
      ...baseInput,
      _runClaude: async () => '判定結果: {"kind":"rejected","reason":"過剰総括"}',
    });
    expect(verdict.kind).toBe("rejected");
    expect(verdict.reason).toBe("過剰総括");
  });
});
