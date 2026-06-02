import { describe, expect, test } from "bun:test";
import { assertCliRecipeName, assertCliSessionId } from "./validate.ts";
import { CliError } from "./errors.ts";

describe("assertCliSessionId", () => {
  test("accepts valid UUID v4-style", () => {
    expect(() => assertCliSessionId("550e8400-e29b-41d4-a716-446655440000")).not.toThrow();
  });

  test("accepts uppercase UUID", () => {
    expect(() => assertCliSessionId("550E8400-E29B-41D4-A716-446655440000")).not.toThrow();
  });

  test("rejects empty string with CliError", () => {
    expect(() => assertCliSessionId("")).toThrow(CliError);
    expect(() => assertCliSessionId("")).toThrow(/Invalid session ID/);
  });

  test("rejects non-UUID string with CliError", () => {
    expect(() => assertCliSessionId("not-a-uuid")).toThrow(CliError);
  });

  test("rejects path traversal", () => {
    expect(() => assertCliSessionId("../etc/passwd")).toThrow(CliError);
    expect(() => assertCliSessionId("../etc/passwd")).toThrow(/Invalid session ID/);
  });

  test("error message includes the offending value", () => {
    try {
      assertCliSessionId("bogus");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).toContain("bogus");
    }
  });
});

describe("assertCliRecipeName", () => {
  test("accepts simple lowercase recipe name", () => {
    expect(() => assertCliRecipeName("diary")).not.toThrow();
  });

  test("accepts hyphenated recipe name", () => {
    expect(() => assertCliRecipeName("my-recipe")).not.toThrow();
  });

  test("accepts recipe name with digits", () => {
    expect(() => assertCliRecipeName("recipe-v2")).not.toThrow();
  });

  test("rejects dotted recipe name (CLI uses tighter pattern than internal)", () => {
    expect(() => assertCliRecipeName("my.recipe")).toThrow(CliError);
  });

  test("rejects underscore (CLI uses tighter pattern than internal)", () => {
    expect(() => assertCliRecipeName("recipe_v2")).toThrow(CliError);
  });

  test("rejects uppercase recipe name", () => {
    expect(() => assertCliRecipeName("BAD-RECIPE")).toThrow(CliError);
    expect(() => assertCliRecipeName("BAD-RECIPE")).toThrow(/Invalid recipe name/);
  });

  test("rejects empty string with CliError", () => {
    expect(() => assertCliRecipeName("")).toThrow(CliError);
    expect(() => assertCliRecipeName("")).toThrow(/Invalid recipe name/);
  });

  test("rejects whitespace with CliError", () => {
    expect(() => assertCliRecipeName("bad name")).toThrow(CliError);
  });

  test("rejects path traversal", () => {
    expect(() => assertCliRecipeName("../etc/passwd")).toThrow(CliError);
  });

  test("rejects names starting with hyphen/dot", () => {
    expect(() => assertCliRecipeName("-bad")).toThrow(CliError);
    expect(() => assertCliRecipeName(".bad")).toThrow(CliError);
  });

  test("error message includes the offending value", () => {
    try {
      assertCliRecipeName("BAD RECIPE");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).toContain("BAD RECIPE");
    }
  });
});
