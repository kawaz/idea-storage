import { describe, expect, test } from "bun:test";
import { validateRecipeName, validateSessionId } from "./validate.ts";
import { CliError } from "./errors.ts";

describe("validateSessionId", () => {
  test("accepts valid UUID v4-style", () => {
    expect(() => validateSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  test("accepts uppercase UUID", () => {
    expect(() => validateSessionId("550E8400-E29B-41D4-A716-446655440000")).not.toThrow();
  });

  test("rejects empty string with CliError", () => {
    expect(() => validateSessionId("")).toThrow(CliError);
    expect(() => validateSessionId("")).toThrow(/Invalid session ID/);
  });

  test("rejects non-UUID string with CliError", () => {
    expect(() => validateSessionId("not-a-uuid")).toThrow(CliError);
  });

  test("rejects path traversal", () => {
    expect(() => validateSessionId("../etc/passwd")).toThrow(CliError);
    expect(() => validateSessionId("../etc/passwd")).toThrow(/Invalid session ID/);
  });

  test("error message includes the offending value", () => {
    try {
      validateSessionId("bogus");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).toContain("bogus");
    }
  });
});

describe("validateRecipeName", () => {
  test("accepts simple lowercase recipe name", () => {
    expect(() => validateRecipeName("diary")).not.toThrow();
  });

  test("accepts hyphenated recipe name", () => {
    expect(() => validateRecipeName("my-recipe")).not.toThrow();
  });

  test("accepts recipe name with digits", () => {
    expect(() => validateRecipeName("recipe-v2")).not.toThrow();
  });

  test("rejects dotted recipe name (CLI uses tighter pattern than internal)", () => {
    expect(() => validateRecipeName("my.recipe")).toThrow(CliError);
  });

  test("rejects underscore (CLI uses tighter pattern than internal)", () => {
    expect(() => validateRecipeName("recipe_v2")).toThrow(CliError);
  });

  test("rejects uppercase recipe name", () => {
    expect(() => validateRecipeName("BAD-RECIPE")).toThrow(CliError);
    expect(() => validateRecipeName("BAD-RECIPE")).toThrow(/Invalid recipe name/);
  });

  test("rejects empty string with CliError", () => {
    expect(() => validateRecipeName("")).toThrow(CliError);
    expect(() => validateRecipeName("")).toThrow(/Invalid recipe name/);
  });

  test("rejects whitespace with CliError", () => {
    expect(() => validateRecipeName("bad name")).toThrow(CliError);
  });

  test("rejects path traversal", () => {
    expect(() => validateRecipeName("../etc/passwd")).toThrow(CliError);
  });

  test("rejects names starting with hyphen/dot", () => {
    expect(() => validateRecipeName("-bad")).toThrow(CliError);
    expect(() => validateRecipeName(".bad")).toThrow(CliError);
  });

  test("error message includes the offending value", () => {
    try {
      validateRecipeName("BAD RECIPE");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).toContain("BAD RECIPE");
    }
  });
});
