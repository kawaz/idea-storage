import { describe, expect, test } from "bun:test";
import { CliError } from "../lib/errors.ts";
import { validateRecipeName, validateSessionId } from "../lib/validate.ts";

// session-retry.ts is a thin CLI wrapper that calls validateSessionId and
// validateRecipeName before delegating to queue.retry(). The retry() logic
// itself is covered by queue.test.ts. Here we only assert that the validation
// surface is wired up: invalid args must raise CliError so the CLI exits
// cleanly without ever reaching retry().
describe("session-retry CLI validation", () => {
  test("不正な session ID は CliError で弾かれる", () => {
    expect(() => validateSessionId("not-a-uuid")).toThrow(CliError);
    expect(() => validateSessionId("not-a-uuid")).toThrow(/Invalid session ID/);
  });

  test("不正な recipe 名は CliError で弾かれる", () => {
    expect(() => validateRecipeName("BAD-RECIPE")).toThrow(CliError);
    expect(() => validateRecipeName("BAD-RECIPE")).toThrow(/Invalid recipe name/);
  });

  test("空文字も CliError で弾かれる", () => {
    expect(() => validateSessionId("")).toThrow(CliError);
    expect(() => validateRecipeName("")).toThrow(CliError);
  });
});
