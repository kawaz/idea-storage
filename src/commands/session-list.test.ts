import { describe, test, expect } from "bun:test";
import { toSessionJsonEntry, validateOutputFormat } from "./session-list.ts";

describe("session-list", () => {
  describe("validateOutputFormat", () => {
    test("returns 'text' when value is undefined", () => {
      expect(validateOutputFormat(undefined)).toBe("text");
    });

    test("returns 'text' when value is empty string", () => {
      expect(validateOutputFormat("")).toBe("text");
    });

    test("accepts canonical formats", () => {
      expect(validateOutputFormat("text")).toBe("text");
      expect(validateOutputFormat("json")).toBe("json");
      expect(validateOutputFormat("jsonl")).toBe("jsonl");
    });

    test("throws for invalid format with available values in message", () => {
      expect(() => validateOutputFormat("yaml")).toThrow(/invalid format.*yaml/i);
      expect(() => validateOutputFormat("yaml")).toThrow(/text.*json.*jsonl/);
    });
  });

  describe("toSessionJsonEntry", () => {
    // oxlint-disable-next-line no-control-regex -- intentional: detect any ANSI escape
    const ANY_ANSI = /\x1b\[/;

    function makeEntry(
      overrides: Partial<{
        id: string;
        filePath: string;
        project: string;
        projectShort: string;
        lineCount: number;
        ageSec: number;
        hasEnd: boolean;
        userTurns: number;
        sessionBytes: number;
      }> = {},
    ) {
      return {
        id: overrides.id ?? "abcdef01-2345-6789-abcd-ef0123456789",
        filePath:
          overrides.filePath ??
          "/Users/kawaz/.claude/projects/-Users-kawaz-foo/abcdef01-2345-6789-abcd-ef0123456789.jsonl",
        project: overrides.project ?? "/Users/kawaz/foo",
        projectShort: overrides.projectShort ?? "foo",
        lineCount: overrides.lineCount ?? 234,
        ageSec: overrides.ageSec ?? 12345,
        hasEnd: overrides.hasEnd ?? true,
        userTurns: overrides.userTurns ?? 21,
        sessionBytes: overrides.sessionBytes ?? 1234567,
      };
    }

    test("returns snake_case fields", () => {
      const j = toSessionJsonEntry(makeEntry());
      expect(j.id).toBe("abcdef01-2345-6789-abcd-ef0123456789");
      expect(j.path).toMatch(/\.jsonl$/);
      expect(j.project).toBe("/Users/kawaz/foo");
      expect(j.user_turns).toBe(21);
      expect(j.session_bytes).toBe(1234567);
      expect(j.age_sec).toBe(12345);
      expect(j.line_count).toBe(234);
      expect(j.has_end).toBe(true);
      expect(j.status).toBe("ended");
    });

    test("status reflects hasEnd=false as 'active'", () => {
      const j = toSessionJsonEntry(makeEntry({ hasEnd: false }));
      expect(j.status).toBe("active");
      expect(j.has_end).toBe(false);
    });

    test("JSON output contains no ANSI escape sequences", () => {
      const arr = [makeEntry(), makeEntry({ id: "11111111-2222-3333-4444-555555555555" })].map(
        toSessionJsonEntry,
      );
      const text = JSON.stringify(arr);
      expect(ANY_ANSI.test(text)).toBe(false);
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    });

    test("JSONL line is valid JSON per row and single-line", () => {
      const entries = [makeEntry(), makeEntry({ hasEnd: false })].map(toSessionJsonEntry);
      const lines = entries.map((e) => JSON.stringify(e));
      for (const line of lines) {
        expect(line).not.toContain("\n");
        const parsed = JSON.parse(line);
        expect(typeof parsed.id).toBe("string");
        expect(typeof parsed.path).toBe("string");
      }
    });
  });
});
