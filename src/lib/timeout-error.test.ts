import { describe, expect, test } from "bun:test";
import { BaseTimeoutError } from "./timeout-error.ts";
import { ClaudeTimeoutError } from "./claude-runner.ts";
import { SpawnTimeoutError } from "./spawn-timeout.ts";

describe("BaseTimeoutError", () => {
  test("is an instance of Error", () => {
    const err = new BaseTimeoutError("timed out", 1000);
    expect(err).toBeInstanceOf(Error);
  });

  test("exposes timeoutMs and message", () => {
    const err = new BaseTimeoutError("timed out at X", 12345);
    expect(err.timeoutMs).toBe(12345);
    expect(err.message).toBe("timed out at X");
  });

  test("default name is BaseTimeoutError", () => {
    const err = new BaseTimeoutError("x", 1);
    expect(err.name).toBe("BaseTimeoutError");
  });
});

describe("ClaudeTimeoutError extends BaseTimeoutError", () => {
  test("is an instance of both BaseTimeoutError and Error", () => {
    const err = new ClaudeTimeoutError(60000);
    expect(err).toBeInstanceOf(BaseTimeoutError);
    expect(err).toBeInstanceOf(Error);
  });

  test("retains its own name", () => {
    const err = new ClaudeTimeoutError(60000);
    expect(err.name).toBe("ClaudeTimeoutError");
  });

  test("exposes timeoutMs", () => {
    const err = new ClaudeTimeoutError(60000);
    expect(err.timeoutMs).toBe(60000);
  });

  test("instanceof BaseTimeoutError checks work for unified handling", () => {
    const err: unknown = new ClaudeTimeoutError(30000);
    if (err instanceof BaseTimeoutError) {
      expect(err.timeoutMs).toBe(30000);
    } else {
      expect.unreachable("ClaudeTimeoutError should match BaseTimeoutError");
    }
  });
});

describe("SpawnTimeoutError extends BaseTimeoutError", () => {
  test("is an instance of both BaseTimeoutError and Error", () => {
    const err = new SpawnTimeoutError(5000);
    expect(err).toBeInstanceOf(BaseTimeoutError);
    expect(err).toBeInstanceOf(Error);
  });

  test("retains its own name", () => {
    const err = new SpawnTimeoutError(5000);
    expect(err.name).toBe("SpawnTimeoutError");
  });

  test("exposes timeoutMs", () => {
    const err = new SpawnTimeoutError(5000);
    expect(err.timeoutMs).toBe(5000);
  });

  test("instanceof BaseTimeoutError checks work for unified handling", () => {
    const err: unknown = new SpawnTimeoutError(7777);
    if (err instanceof BaseTimeoutError) {
      expect(err.timeoutMs).toBe(7777);
    } else {
      expect.unreachable("SpawnTimeoutError should match BaseTimeoutError");
    }
  });
});

describe("BaseTimeoutError discrimination between subclasses", () => {
  test("ClaudeTimeoutError is not SpawnTimeoutError", () => {
    const err = new ClaudeTimeoutError(100);
    expect(err).not.toBeInstanceOf(SpawnTimeoutError);
  });

  test("SpawnTimeoutError is not ClaudeTimeoutError", () => {
    const err = new SpawnTimeoutError(100);
    expect(err).not.toBeInstanceOf(ClaudeTimeoutError);
  });
});
