/**
 * Conversation extraction from Claude session JSONL files.
 * TypeScript port of the jq-based extract_conversation logic
 * from idea-storage-session-processor.sh / extract-conversation.sh.
 *
 * NOTE: CSA (claude-session-analysis) wiring lives in lib/csa.ts. This module
 * is for direct JSONL parsing only.
 */

import { streamSessionLines } from "./session-jsonl.ts";
import type { ConversationMessage } from "../../types/index.ts";

/**
 * Convert an ISO8601 timestamp to local time string (YYYY-MM-DDTHH:MM:SS).
 * Mirrors jq's `strflocaltime("%Y-%m-%dT%H:%M:%S")` behavior.
 */
function toLocalTimestamp(isoStr: string | undefined): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Type definitions for JSONL line structure
interface ContentText {
  type: "text";
  text: string;
}

interface ContentThinking {
  type: "thinking";
  thinking: string;
}

interface ContentToolUse {
  type: "tool_use";
  name: string;
  input?: Record<string, unknown>;
}

interface ContentToolResult {
  type: "tool_result";
  tool_use_id?: string;
  content?: string | ContentText[];
}

type AssistantContentItem = ContentText | ContentThinking | ContentToolUse | ContentToolResult;
type UserContentItem = ContentText | ContentToolResult;

interface SessionLine {
  type?: string;
  timestamp?: string;
  uuid?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: string | UserContentItem[] | AssistantContentItem[];
  };
  summary?: string;
  operation?: string;
  content?: string;
  forkedFrom?: {
    sessionId: string;
    messageUuid: string;
  };
}

/**
 * Extract conversation messages from a session JSONL file.
 * Faithfully mirrors the jq logic from extract-conversation.sh.
 */
export async function* extractConversation(filePath: string): AsyncGenerator<ConversationMessage> {
  for await (const raw of streamSessionLines(filePath)) {
    const line = raw as SessionLine;
    const ts = toLocalTimestamp(line.timestamp);

    if (line.type === "user") {
      const content = line.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === "text") {
            yield { type: "USER", timestamp: ts, content: (item as ContentText).text };
          } else if (item.type === "tool_result") {
            const tr = item as ContentToolResult;
            let text: string;
            if (Array.isArray(tr.content)) {
              text = tr.content
                .filter((c): c is ContentText => c.type === "text")
                .map((c) => c.text)
                .join("");
            } else {
              text = tr.content ?? "";
            }
            yield { type: "TOOL_RESULT", timestamp: ts, content: text };
          }
          // Other types in user content array are skipped (matching jq `empty`)
        }
      } else if (typeof content === "string") {
        yield { type: "USER", timestamp: ts, content };
      }
    } else if (line.type === "assistant") {
      const content = line.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === "thinking") {
            yield { type: "THINKING", timestamp: ts, content: (item as ContentThinking).thinking };
          } else if (item.type === "text") {
            yield { type: "ASSISTANT", timestamp: ts, content: (item as ContentText).text };
          } else if (item.type === "tool_use") {
            const tu = item as ContentToolUse;
            const inputStr = tu.input ? ` ${JSON.stringify(tu.input).slice(0, 100)}` : "";
            yield { type: "TOOL_USE", timestamp: ts, content: `${tu.name}${inputStr}` };
          }
          // Other types (including tool_result in assistant) are skipped
        }
      }
      // String content for assistant is skipped (matching jq `empty`)
    } else if (line.type === "summary") {
      yield { type: "SUMMARY", timestamp: ts, content: line.summary ?? "" };
    } else if (line.type === "queue-operation") {
      if (line.operation === "enqueue" && line.content) {
        yield { type: "QUEUED", timestamp: ts, content: line.content };
      }
      // dequeue and other operations are skipped
    }
    // All other types (progress, result, etc.) are skipped
  }
}

/**
 * Format conversation as text with "[timestamp] TYPE: content" lines.
 * Equivalent to piping extract_conversation output.
 */
export async function formatConversationToText(filePath: string): Promise<string> {
  const lines: string[] = [];
  for await (const msg of extractConversation(filePath)) {
    const prefix = msg.timestamp ? `[${msg.timestamp}] ` : "";
    lines.push(`${prefix}${msg.type}: ${msg.content}`);
  }
  return lines.join("\n");
}
