import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { log, logError } from "./logging.ts";

interface CapturedLog {
  stdout: string[];
  stderr: string[];
}

let captured: CapturedLog;
let originalLog: typeof console.log;
let originalError: typeof console.error;

beforeEach(() => {
  captured = { stdout: [], stderr: [] };
  originalLog = console.log;
  originalError = console.error;
  console.log = (msg: string) => captured.stdout.push(msg);
  console.error = (msg: string) => captured.stderr.push(msg);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
});

function parseLast(channel: "stdout" | "stderr"): Record<string, unknown> {
  const lines = captured[channel];
  expect(lines.length).toBeGreaterThan(0);
  return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
}

describe("log", () => {
  test("emits ts + payload to stdout", () => {
    log({ msg: "hello", n: 1 });
    const obj = parseLast("stdout");
    expect(obj.msg).toBe("hello");
    expect(obj.n).toBe(1);
    expect(typeof obj.ts).toBe("string");
  });

  test("error 文字列が MAX_ERROR_LEN (500) を超えると ...(truncated) で切り詰められる", () => {
    const big = "x".repeat(1000);
    log({ msg: "boom", error: big });
    const obj = parseLast("stdout");
    const error = obj.error as string;
    expect(error.length).toBe(500 + "...(truncated)".length);
    expect(error.endsWith("...(truncated)")).toBe(true);
    expect(error.startsWith("x".repeat(500))).toBe(true);
  });

  test("error 文字列がちょうど MAX_ERROR_LEN なら切り詰められない", () => {
    const exact = "y".repeat(500);
    log({ msg: "edge", error: exact });
    const obj = parseLast("stdout");
    expect(obj.error).toBe(exact);
  });

  test("error 文字列内の Anthropic API キーが redact される", () => {
    const fakeKey = "sk-ant-" + "a".repeat(80);
    log({ msg: "fail", error: `request failed with key ${fakeKey}` });
    const obj = parseLast("stdout");
    const error = obj.error as string;
    expect(error).not.toContain(fakeKey);
    expect(error).toContain("[REDACTED:ANTHROPIC_API_KEY]");
  });

  test("error 文字列内の GitHub トークンが redact される", () => {
    const ghToken = "ghp_" + "A".repeat(36);
    log({ msg: "fail", error: `gh push failed: ${ghToken}` });
    const obj = parseLast("stdout");
    const error = obj.error as string;
    expect(error).not.toContain(ghToken);
    expect(error).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  test("error が string でなければ redact / truncation 対象外", () => {
    log({ msg: "obj-error", error: { code: 42 } });
    const obj = parseLast("stdout");
    expect(obj.error).toEqual({ code: 42 });
  });

  test("prompt フィールドは出力に含まれない", () => {
    log({ msg: "leak", prompt: "secret prompt body", other: "kept" });
    const obj = parseLast("stdout");
    expect(obj).not.toHaveProperty("prompt");
    expect(obj.other).toBe("kept");
  });

  test("timeline フィールドは出力に含まれない", () => {
    log({ msg: "leak", timeline: "##user\nhi" });
    const obj = parseLast("stdout");
    expect(obj).not.toHaveProperty("timeline");
  });

  test("content フィールドは出力に含まれない", () => {
    log({ msg: "leak", content: "blah" });
    const obj = parseLast("stdout");
    expect(obj).not.toHaveProperty("content");
  });

  test("text フィールドは出力に含まれない", () => {
    log({ msg: "leak", text: "blah" });
    const obj = parseLast("stdout");
    expect(obj).not.toHaveProperty("text");
  });

  test("body フィールドは出力に含まれない", () => {
    log({ msg: "leak", body: "blah" });
    const obj = parseLast("stdout");
    expect(obj).not.toHaveProperty("body");
  });
});

describe("logError", () => {
  test("level: 'error' を付けて stderr に出す", () => {
    logError({ msg: "bad" });
    const obj = parseLast("stderr");
    expect(obj.level).toBe("error");
    expect(obj.msg).toBe("bad");
  });

  test("error 文字列に redact + truncation の両方を適用", () => {
    const ghToken = "ghp_" + "A".repeat(36);
    const big = `prefix ${ghToken} ` + "z".repeat(1000);
    logError({ msg: "boom", error: big });
    const obj = parseLast("stderr");
    const error = obj.error as string;
    expect(error).not.toContain(ghToken);
    expect(error).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(error.endsWith("...(truncated)")).toBe(true);
  });

  test("dangerous フィールドは出力に含まれない", () => {
    logError({ msg: "boom", prompt: "secret", timeline: "tl", body: "b" });
    const obj = parseLast("stderr");
    expect(obj).not.toHaveProperty("prompt");
    expect(obj).not.toHaveProperty("timeline");
    expect(obj).not.toHaveProperty("body");
  });
});
