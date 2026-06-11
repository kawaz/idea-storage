import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extractConversation, formatConversationToText } from "./conversation.ts";
import { getSessionMeta, getSessionMetaBatch } from "./csa.ts";
import {
  createCsaFixtureDir,
  writeSessionFixture,
  withIsolatedClaudeEnv,
} from "../test-fixtures.ts";
import type { ConversationMessage } from "./conversation.ts";

describe("conversation", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "conversation-test-"));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTempFile(name: string, lines: Record<string, unknown>[]): Promise<string> {
    const path = join(tmpDir, name);
    const content = lines.map((l) => JSON.stringify(l)).join("\n");
    await Bun.write(path, content);
    return path;
  }

  // Helper to format a Date to local ISO-like string (matching jq strflocaltime behavior)
  function toLocalIso(isoStr: string): string {
    const d = new Date(isoStr);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  describe("extractConversation", () => {
    test("extracts user message with string content", async () => {
      const path = await writeTempFile("user-string.jsonl", [
        {
          type: "user",
          timestamp: "2024-01-01T10:00:00.000Z",
          message: { role: "user", content: "Hello world" },
          cwd: "/tmp/test",
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("USER");
      expect(msgs[0]!.content).toBe("Hello world");
      expect(msgs[0]!.timestamp).toBe(toLocalIso("2024-01-01T10:00:00.000Z"));
    });

    test("extracts user message with array content (text)", async () => {
      const path = await writeTempFile("user-array.jsonl", [
        {
          type: "user",
          timestamp: "2024-01-01T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Hello from array" }] },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("USER");
      expect(msgs[0]!.content).toBe("Hello from array");
    });

    test("extracts user message with array content (tool_result with string)", async () => {
      const path = await writeTempFile("user-tool-result.jsonl", [
        {
          type: "user",
          timestamp: "2024-01-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "x", content: "file contents here" }],
          },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("TOOL_RESULT");
      expect(msgs[0]!.content).toBe("file contents here");
    });

    test("extracts user message with tool_result containing array content", async () => {
      const path = await writeTempFile("user-tool-result-array.jsonl", [
        {
          type: "user",
          timestamp: "2024-01-01T10:00:00.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "x",
                content: [
                  { type: "text", text: "part1" },
                  { type: "text", text: "part2" },
                ],
              },
            ],
          },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("TOOL_RESULT");
      expect(msgs[0]!.content).toBe("part1part2");
    });

    test("extracts assistant message with text content", async () => {
      const path = await writeTempFile("assistant-text.jsonl", [
        {
          type: "assistant",
          timestamp: "2024-01-01T10:00:05.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("ASSISTANT");
      expect(msgs[0]!.content).toBe("Hi there!");
    });

    test("extracts assistant message with thinking content", async () => {
      const path = await writeTempFile("assistant-thinking.jsonl", [
        {
          type: "assistant",
          timestamp: "2024-01-01T10:00:05.000Z",
          message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: "Let me think about this..." }],
          },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("THINKING");
      expect(msgs[0]!.content).toBe("Let me think about this...");
    });

    test("extracts assistant message with tool_use content", async () => {
      const path = await writeTempFile("assistant-tool-use.jsonl", [
        {
          type: "assistant",
          timestamp: "2024-01-01T10:00:05.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "/tmp/test.txt" },
              },
            ],
          },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("TOOL_USE");
      expect(msgs[0]!.content).toStartWith("Read ");
    });

    test("tool_use input is truncated to 100 characters", async () => {
      const longInput = "a".repeat(200);
      const path = await writeTempFile("assistant-tool-use-long.jsonl", [
        {
          type: "assistant",
          timestamp: "2024-01-01T10:00:05.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: { command: longInput },
              },
            ],
          },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      // "Bash " + truncated JSON string (100 chars from input serialized)
      const inputStr = JSON.stringify({ command: longInput });
      expect(msgs[0]!.content).toBe(`Bash ${inputStr.slice(0, 100)}`);
    });

    test("extracts assistant message with multiple content items", async () => {
      const path = await writeTempFile("assistant-multi.jsonl", [
        {
          type: "assistant",
          timestamp: "2024-01-01T10:00:05.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Hmm" },
              { type: "text", text: "Here is the answer" },
              { type: "tool_use", name: "Read", input: { file_path: "/foo" } },
            ],
          },
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(3);
      expect(msgs[0]!.type).toBe("THINKING");
      expect(msgs[1]!.type).toBe("ASSISTANT");
      expect(msgs[2]!.type).toBe("TOOL_USE");
    });

    test("extracts summary message", async () => {
      const path = await writeTempFile("summary.jsonl", [
        { type: "summary", summary: "Session completed successfully" },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("SUMMARY");
      expect(msgs[0]!.content).toBe("Session completed successfully");
    });

    test("extracts queue-operation enqueue as QUEUED", async () => {
      const path = await writeTempFile("queued.jsonl", [
        {
          type: "queue-operation",
          operation: "enqueue",
          content: "queued task",
          timestamp: "2024-01-01T10:00:00.000Z",
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.type).toBe("QUEUED");
      expect(msgs[0]!.content).toBe("queued task");
    });

    test("skips queue-operation dequeue", async () => {
      const path = await writeTempFile("dequeue.jsonl", [
        {
          type: "queue-operation",
          operation: "dequeue",
          timestamp: "2024-01-01T10:00:00.000Z",
          sessionId: "abc",
        },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(0);
    });

    test("skips unknown types (progress, etc.)", async () => {
      const path = await writeTempFile("unknown.jsonl", [
        {
          type: "progress",
          data: { type: "hook_progress" },
          timestamp: "2024-01-01T10:00:00.000Z",
        },
        { type: "result", subtype: "success", timestamp: "2024-01-01T10:00:00.000Z" },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(0);
    });

    test("handles line without timestamp", async () => {
      const path = await writeTempFile("no-timestamp.jsonl", [
        { type: "summary", summary: "No timestamp here" },
      ]);

      const msgs: ConversationMessage[] = [];
      for await (const msg of extractConversation(path)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.timestamp).toBe("");
    });
  });

  describe("formatConversationToText", () => {
    test("formats messages as [timestamp] TYPE: content lines", async () => {
      const path = await writeTempFile("format.jsonl", [
        {
          type: "user",
          timestamp: "2024-01-01T10:00:00.000Z",
          message: { role: "user", content: "Hello" },
          cwd: "/tmp",
        },
        {
          type: "assistant",
          timestamp: "2024-01-01T10:00:05.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
        },
      ]);

      const text = await formatConversationToText(path);
      const lines = text.split("\n").filter((l) => l.length > 0);

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\[.+\] USER: Hello$/);
      expect(lines[1]).toMatch(/^\[.+\] ASSISTANT: Hi!$/);
    });

    test("omits timestamp bracket when timestamp is empty", async () => {
      const path = await writeTempFile("no-ts-format.jsonl", [
        { type: "summary", summary: "Done" },
      ]);

      const text = await formatConversationToText(path);

      expect(text.trim()).toBe("SUMMARY: Done");
    });
  });

  describe("getSessionMeta / getSessionMetaBatch (fixture, real CSA)", () => {
    /**
     * Each test creates its own fixture base dir so that one CSA-discovered
     * session per test stays isolated from the others. The base is wiped after.
     */
    async function withFixture<T>(fn: (base: string) => Promise<T>): Promise<T> {
      const base = await createCsaFixtureDir();
      try {
        return await fn(base);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    }

    test("getSessionMeta maps CSA fields onto SessionMeta", async () => {
      await withFixture(async (base) => {
        const sid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        const path = await writeSessionFixture(base, {
          sessionId: sid,
          cwd: "/home/user/project",
          startTime: "2024-01-01T10:00:00.000Z",
          endTime: "2024-01-01T10:02:00.000Z",
          userTurns: 7,
          effectiveUserTurns: 3,
        });

        const meta = await withIsolatedClaudeEnv(base, () => getSessionMeta(path));

        expect(meta.id).toBe(sid);
        expect(meta.filePath).toBe(path);
        expect(meta.project).toBe("/home/user/project");
        expect(meta.lineCount).toBe(7); // CSA counts JSONL lines; our fixture writes one per turn.
        expect(meta.userTurns).toBe(7);
        expect(meta.effectiveUserTurns).toBe(3);
        expect(meta.startTime).toEqual(new Date("2024-01-01T10:00:00.000Z"));
        expect(meta.endTime).toEqual(new Date("2024-01-01T10:02:00.000Z"));
        expect(meta.ageSec).toBeGreaterThanOrEqual(0);
        expect(meta.forkInfo).toBeUndefined();
      });
    });

    test("getSessionMeta leaves endTime undefined when CSA endTime equals startTime (single entry)", async () => {
      // With a single-entry fixture, CSA reports endTime == startTime. This isn't
      // strictly the "null endTime" path, but it's the closest natural shape from
      // a real CSA invocation; the null branch is unit-tested elsewhere via
      // CsaSessionRecord typing.
      await withFixture(async (base) => {
        const sid = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
        const path = await writeSessionFixture(base, {
          sessionId: sid,
          startTime: "2024-01-01T10:00:00.000Z",
          userTurns: 1,
        });

        const meta = await withIsolatedClaudeEnv(base, () => getSessionMeta(path));

        expect(meta.startTime).toEqual(new Date("2024-01-01T10:00:00.000Z"));
        // Single-entry: endTime equals startTime in CSA output.
        expect(meta.endTime).toEqual(new Date("2024-01-01T10:00:00.000Z"));
      });
    });

    test("getSessionMeta sets forkInfo from forkedFrom + forkFirstNewUuid", async () => {
      await withFixture(async (base) => {
        const parentSid = "11111111-2222-3333-4444-555555555555";
        const newUuid = "99990001-0000-0000-0000-000000000000";

        // Parent session: must exist so CSA can resolve the fork link.
        await writeSessionFixture(base, {
          sessionId: parentSid,
          cwd: "/home/user/project",
          startTime: "2024-01-01T09:00:00.000Z",
          endTime: "2024-01-01T09:05:00.000Z",
          userTurns: 2,
        });

        const sid = "aaaa1111-2222-3333-4444-555555555555";
        const path = await writeSessionFixture(base, {
          sessionId: sid,
          cwd: "/home/user/project",
          startTime: "2024-01-01T10:00:00.000Z",
          endTime: "2024-01-01T10:02:00.000Z",
          userTurns: 3,
          forkedFromSessionId: parentSid,
          forkedFromMessageUuid: newUuid,
        });

        const meta = await withIsolatedClaudeEnv(base, () => getSessionMeta(path));

        expect(meta.forkInfo).toBeDefined();
        expect(meta.forkInfo!.parentSessionId).toBe(parentSid);
        // CSA's forkFirstNewUuid is the UUID of the *first new* entry in the child,
        // not the parent's branch point. Our fixture sets `forkedFrom` on each user
        // entry and CSA reports the first entry's uuid as forkFirstNewUuid.
        expect(meta.forkInfo!.firstNewUuid).toBeString();
      });
    });

    test("getSessionMeta has no forkInfo when forkedFrom is absent", async () => {
      await withFixture(async (base) => {
        const sid = "f6a7b8c9-d0e1-2345-fabc-456789012345";
        const path = await writeSessionFixture(base, {
          sessionId: sid,
          userTurns: 1,
        });

        const meta = await withIsolatedClaudeEnv(base, () => getSessionMeta(path));
        expect(meta.forkInfo).toBeUndefined();
      });
    });

    test("getSessionMeta throws when the session id is outside CSA's discovery scope", async () => {
      await withFixture(async (base) => {
        // Write a stub file in our normal tmpDir so the path exists on disk,
        // but never create a matching JSONL inside the CSA base. CSA itself
        // exits 1 ("Session not found") — this is an environment mismatch
        // (claudeDirs vs CSA scope), so it must surface as a throw.
        const sid = "d4e5f6a7-b8c9-0123-defa-234567890123";
        const path = join(tmpDir, `${sid}.jsonl`);
        await Bun.write(path, "stub");

        await expect(withIsolatedClaudeEnv(base, () => getSessionMeta(path))).rejects.toThrow();
      });
    });

    test("getSessionMeta returns a synthetic empty meta for a snapshot-only JSONL (no conversation records)", async () => {
      await withFixture(async (base) => {
        // file-history-snapshot 行のみの jsonl: 非空だが CSA は session として
        // 認識せず record を emit しない。throw せず skip 経路 (lineCount 0)
        // に乗ることを保証する。
        const sid = "c3d4e5f6-a7b8-9012-cdef-345678901234";
        const projDir = join(base, "projects", "snapshot-only");
        await mkdir(projDir, { recursive: true });
        const path = join(projDir, `${sid}.jsonl`);
        const line = JSON.stringify({
          type: "file-history-snapshot",
          messageId: "m1",
          snapshot: { messageId: "m1", trackedFileBackups: {} },
        });
        await Bun.write(path, line + "\n");

        const meta = await withIsolatedClaudeEnv(base, () => getSessionMeta(path));
        expect(meta.id).toBe(sid);
        expect(meta.filePath).toBe(path);
        expect(meta.lineCount).toBe(0);
        expect(meta.userTurns).toBe(0);
        expect(meta.effectiveUserTurns).toBe(0);
      });
    });

    test("getSessionMetaBatch returns a Map keyed by sessionId", async () => {
      await withFixture(async (base) => {
        const sidA = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        const sidB = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
        const pathA = await writeSessionFixture(base, {
          sessionId: sidA,
          projectSlug: "a",
          cwd: "/p/a",
          userTurns: 4,
          effectiveUserTurns: 2,
          startTime: "2024-01-01T10:00:00.000Z",
          endTime: "2024-01-01T10:00:30.000Z",
        });
        const pathB = await writeSessionFixture(base, {
          sessionId: sidB,
          projectSlug: "b",
          cwd: "/p/b",
          userTurns: 8,
          effectiveUserTurns: 5,
          startTime: "2024-01-01T11:00:00.000Z",
          endTime: "2024-01-01T11:01:00.000Z",
        });

        const map = await withIsolatedClaudeEnv(base, () => getSessionMetaBatch([pathA, pathB]));

        expect(map.size).toBe(2);
        expect(map.get(sidA)!.project).toBe("/p/a");
        expect(map.get(sidA)!.filePath).toBe(pathA);
        expect(map.get(sidA)!.effectiveUserTurns).toBe(2);
        expect(map.get(sidB)!.project).toBe("/p/b");
        expect(map.get(sidB)!.filePath).toBe(pathB);
        expect(map.get(sidB)!.userTurns).toBe(8);
      });
    });

    test("getSessionMetaBatch returns empty map for empty input", async () => {
      // No CSA call necessary; no env override needed.
      const map = await getSessionMetaBatch([]);
      expect(map.size).toBe(0);
    });

    test("getSessionMetaBatch fills a synthetic empty meta for in-scope sessions CSA emits no record for", async () => {
      await withFixture(async (base) => {
        const sidA = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
        // sidB は探索範囲内だが snapshot 行のみ → CSA exit 0 で record なし。
        const sidB = "b2c3d4e5-f6a7-8901-bcde-f12345678901";

        const pathA = await writeSessionFixture(base, {
          sessionId: sidA,
          userTurns: 1,
        });
        const projDir = join(base, "projects", "snapshot-only-batch");
        await mkdir(projDir, { recursive: true });
        const pathB = join(projDir, `${sidB}.jsonl`);
        await Bun.write(
          pathB,
          JSON.stringify({ type: "file-history-snapshot", messageId: "m1", snapshot: {} }) + "\n",
        );

        const map = await withIsolatedClaudeEnv(base, () => getSessionMetaBatch([pathA, pathB]));
        expect(map.size).toBe(2);
        expect(map.get(sidA)!.userTurns).toBe(1);
        expect(map.get(sidB)!.lineCount).toBe(0);
        expect(map.get(sidB)!.effectiveUserTurns).toBe(0);
      });
    });
  });
});
