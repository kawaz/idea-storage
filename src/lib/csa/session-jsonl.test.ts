import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { streamSessionLines, countLines } from "./session-jsonl.ts";

describe("session-jsonl", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "session-jsonl-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTempFile(name: string, content: string): Promise<string> {
    const path = join(tmpDir, name);
    await Bun.write(path, content);
    return path;
  }

  describe("streamSessionLines", () => {
    test("parses each JSONL line as JSON object", async () => {
      const path = await writeTempFile(
        "basic.jsonl",
        [
          '{"type":"user","message":{"content":"hello"}}',
          '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
        ].join("\n"),
      );

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({ type: "user", message: { content: "hello" } });
      expect(lines[1]).toEqual({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      });
    });

    test("skips empty lines", async () => {
      const path = await writeTempFile(
        "empty-lines.jsonl",
        [
          '{"type":"user","message":{"content":"a"}}',
          "",
          '{"type":"user","message":{"content":"b"}}',
          "",
          "",
        ].join("\n"),
      );

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(2);
    });

    test("handles file with trailing newline", async () => {
      const path = await writeTempFile(
        "trailing.jsonl",
        '{"type":"user","message":{"content":"only"}}\n',
      );

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(1);
    });

    test("handles empty file", async () => {
      const path = await writeTempFile("empty.jsonl", "");

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(0);
    });

    test("yields lines in order", async () => {
      const path = await writeTempFile("order.jsonl", ['{"n":1}', '{"n":2}', '{"n":3}'].join("\n"));

      const nums: number[] = [];
      for await (const line of streamSessionLines(path)) {
        nums.push((line as { n: number }).n);
      }

      expect(nums).toEqual([1, 2, 3]);
    });

    test("skips broken JSON lines and continues processing", async () => {
      const path = await writeTempFile(
        "broken-middle.jsonl",
        ['{"n":1}', '{"n":2, broken', '{"n":3}'].join("\n"),
      );

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({ n: 1 });
      expect(lines[1]).toEqual({ n: 3 });
    });

    test("skips truncated last line (incomplete write)", async () => {
      const path = await writeTempFile(
        "truncated-last.jsonl",
        ['{"n":1}', '{"n":2}', '{"n":3, "data": "incom'].join("\n"),
      );

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({ n: 1 });
      expect(lines[1]).toEqual({ n: 2 });
    });

    test("handles file where all lines are broken JSON", async () => {
      const path = await writeTempFile(
        "all-broken.jsonl",
        ["{broken1", "not json at all", '{"unclosed": true'].join("\n"),
      );

      const lines: unknown[] = [];
      for await (const line of streamSessionLines(path)) {
        lines.push(line);
      }

      expect(lines).toHaveLength(0);
    });
  });

  describe("countLines", () => {
    test("counts lines in a JSONL file", async () => {
      const path = await writeTempFile(
        "count.jsonl",
        ['{"type":"user"}', '{"type":"assistant"}', '{"type":"summary"}'].join("\n"),
      );

      expect(await countLines(path)).toBe(3);
    });

    test("skips empty lines in count", async () => {
      const path = await writeTempFile(
        "count-empty.jsonl",
        ['{"type":"user"}', "", '{"type":"assistant"}', ""].join("\n"),
      );

      expect(await countLines(path)).toBe(2);
    });

    test("returns 0 for empty file", async () => {
      const path = await writeTempFile("count-zero.jsonl", "");

      expect(await countLines(path)).toBe(0);
    });
  });
});
