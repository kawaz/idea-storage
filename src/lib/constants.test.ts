import { describe, expect, test } from "bun:test";
import {
  CSA_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TASK_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  OVERALL_TIMEOUT_MS,
  RATE_LIMIT_STALE_THRESHOLD_SEC,
} from "./constants.ts";

describe("constants", () => {
  test("CSA_TIMEOUT_MS は 10分", () => {
    expect(CSA_TIMEOUT_MS).toBe(10 * 60 * 1000);
  });

  test("DEFAULT_TASK_TIMEOUT_MS は 25分", () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(25 * 60 * 1000);
  });

  test("OVERALL_TIMEOUT_MS は 50分で StartInterval(60分) より短い", () => {
    expect(OVERALL_TIMEOUT_MS).toBe(50 * 60 * 1000);
    expect(OVERALL_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000);
  });

  test("OVERALL_TIMEOUT_MS は DEFAULT_TASK_TIMEOUT_MS より長い", () => {
    expect(OVERALL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TASK_TIMEOUT_MS);
  });

  test("RATE_LIMIT_STALE_THRESHOLD_SEC は 15分（秒単位）", () => {
    expect(RATE_LIMIT_STALE_THRESHOLD_SEC).toBe(15 * 60);
  });

  test("MAX_CONSECUTIVE_FAILURES は 5", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(5);
  });

  test("DEFAULT_MAX_RETRIES は 3", () => {
    expect(DEFAULT_MAX_RETRIES).toBe(3);
  });
});
