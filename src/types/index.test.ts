import { describe, expect, test } from "bun:test";
import type { Recipe, SessionMeta, QueueEntry, Config, ConversationMessage } from "./index.ts";

describe("types", () => {
  test("Recipe satisfies the interface", () => {
    const recipe: Recipe = {
      name: "diary",
      filePath: "/config/recipes/recipe-diary.md",
      match: {
        project: "*/my-project",
        minTurns: 3,
        minAge: 60,
      },
      onExisting: "append",
      prompt: "Write a diary entry.",
    };
    expect(recipe.name).toBe("diary");
    expect(recipe.match.project).toBe("*/my-project");
    expect(recipe.onExisting).toBe("append");
  });

  test("Recipe with minimal match", () => {
    const recipe: Recipe = {
      name: "minimal",
      filePath: "/path/to/recipe.md",
      match: {},
      onExisting: "skip",
      prompt: "Minimal prompt.",
    };
    expect(recipe.match).toEqual({});
  });

  test("SessionMeta satisfies the interface", () => {
    const now = new Date();
    const session: SessionMeta = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      filePath: "/data/sessions/abc.jsonl",
      project: "/Users/kawaz/project",
      lineCount: 42,
      ageSec: 7200,
      hasEnd: true,
      startTime: now,
      endTime: new Date(now.getTime() + 7200000),
      userTurns: 5,
    };
    expect(session.id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(session.hasEnd).toBe(true);
    expect(session.endTime).toBeDefined();
  });

  test("SessionMeta without endTime", () => {
    const session: SessionMeta = {
      id: "abc-123",
      filePath: "/data/sessions/abc.jsonl",
      project: "/Users/kawaz/project",
      lineCount: 10,
      ageSec: 300,
      hasEnd: false,
      startTime: new Date(),
      userTurns: 2,
    };
    expect(session.endTime).toBeUndefined();
  });

  test("QueueEntry satisfies the interface", () => {
    const entry: QueueEntry = {
      sessionId: "session-123",
      recipeName: "diary",
      key: "session-123.diary",
    };
    expect(entry.key).toBe("session-123.diary");
  });

  test("Config satisfies the interface", () => {
    const config: Config = {
      claudeDirs: ["/home/user/.claude/projects"],
      minAgeMinutes: 120,
    };
    expect(config.claudeDirs).toHaveLength(1);
    expect(config.minAgeMinutes).toBe(120);
  });

  test("ConversationMessage satisfies the interface", () => {
    const msg: ConversationMessage = {
      type: "USER",
      timestamp: "2025-01-01T00:00:00",
      content: "Hello world",
    };
    expect(msg.type).toBe("USER");
  });

  test("ConversationMessage type is union of expected values", () => {
    const types: ConversationMessage["type"][] = [
      "USER",
      "ASSISTANT",
      "TOOL_USE",
      "TOOL_RESULT",
      "THINKING",
      "SUMMARY",
      "QUEUED",
    ];
    expect(types).toHaveLength(7);
  });
});
