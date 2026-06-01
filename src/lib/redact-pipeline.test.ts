import { describe, expect, test } from "bun:test";
import {
  REDACT_LOG_DEFAULT_MAX_LEN,
  redactForLog,
  redactForOutput,
  redactForPrompt,
} from "./redact-pipeline.ts";

describe("redactForLog", () => {
  test("secret を redact する", () => {
    const ghToken = "ghp_" + "a".repeat(36);
    const result = redactForLog(`token=${ghToken}`);
    expect(result).not.toContain(ghToken);
    expect(result).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  test("デフォルトで 500 文字 + ...(truncated) で切り詰める", () => {
    const long = "x".repeat(1000);
    const result = redactForLog(long);
    expect(result.length).toBe(500 + "...(truncated)".length);
    expect(result.endsWith("...(truncated)")).toBe(true);
    expect(result.startsWith("x".repeat(500))).toBe(true);
  });

  test("ちょうど 500 文字なら切り詰めない", () => {
    const exact = "y".repeat(500);
    expect(redactForLog(exact)).toBe(exact);
  });

  test("500 未満なら redact のみで返る", () => {
    expect(redactForLog("hi")).toBe("hi");
  });

  test("maxLength オプションで上限を変更できる", () => {
    const long = "z".repeat(200);
    const result = redactForLog(long, { maxLength: 100 });
    expect(result.length).toBe(100 + "...(truncated)".length);
    expect(result.endsWith("...(truncated)")).toBe(true);
  });

  test("redact + truncate を両方適用 (redact 後に長さ判定)", () => {
    const ghToken = "ghp_" + "a".repeat(36);
    const longPrefix = "padding ".repeat(70);
    const result = redactForLog(longPrefix + ghToken);
    expect(result).not.toContain(ghToken);
    expect(result.endsWith("...(truncated)")).toBe(true);
  });

  test("空文字列を受けても安全に動く", () => {
    expect(redactForLog("")).toBe("");
  });

  test("REDACT_LOG_DEFAULT_MAX_LEN は 500", () => {
    expect(REDACT_LOG_DEFAULT_MAX_LEN).toBe(500);
  });
});

describe("redactForOutput", () => {
  test("secret を redact する", () => {
    const akia = "AKIAIOSFODNN7EXAMPLE";
    const result = redactForOutput(`secret=${akia}`);
    expect(result).not.toContain(akia);
    expect(result).toContain("[REDACTED:AWS_ACCESS_KEY]");
  });

  test("長さ制限なし (本文を保持)", () => {
    const long = "x".repeat(5000);
    expect(redactForOutput(long)).toBe(long);
    expect(redactForOutput(long).length).toBe(5000);
  });

  test("空文字列もそのまま", () => {
    expect(redactForOutput("")).toBe("");
  });
});

describe("redactForPrompt", () => {
  test("secret を redact する", () => {
    const ghToken = "ghp_" + "a".repeat(36);
    const result = redactForPrompt(`token=${ghToken}`);
    expect(result).not.toContain(ghToken);
    expect(result).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  test("LLM 入力なので長さ制限なし (情報量を保持)", () => {
    const long = "context ".repeat(1000);
    const result = redactForPrompt(long);
    expect(result.length).toBeGreaterThan(7000);
  });

  test("空文字列もそのまま", () => {
    expect(redactForPrompt("")).toBe("");
  });
});

describe("idempotency", () => {
  test("redact 結果に再度 pipeline を適用しても変化しない", () => {
    const ghToken = "ghp_" + "a".repeat(36);
    const first = redactForOutput(`token=${ghToken}`);
    expect(redactForOutput(first)).toBe(first);
  });

  test("log の cap 結果に再度 redactForLog を適用しても増えない", () => {
    const long = "x".repeat(1000);
    const first = redactForLog(long);
    const second = redactForLog(first);
    expect(second).toBe(first);
  });
});
