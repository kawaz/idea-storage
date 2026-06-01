/**
 * Conversation extraction from Claude session JSONL files.
 * TypeScript port of the jq-based extract_conversation logic
 * from idea-storage-session-processor.sh / extract-conversation.sh.
 */

import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { streamSessionLines } from "./session-jsonl.ts";
import { buildCsaEnv } from "./spawn-env.ts";
import type { ConversationMessage, SessionMeta } from "../types/index.ts";

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

/**
 * Session record as emitted by `claude-session-analysis sessions --format jsonl`.
 * Timestamps are ISO8601 strings; `endTime` / `forkedFrom` / `forkFirstNewUuid`
 * may be null. Only the fields consumed by SessionMeta are typed here.
 */
interface CsaSessionRecord {
  sessionId: string;
  cwd: string;
  startTime: string;
  endTime: string | null;
  lines: number;
  turns: number;
  effectiveUserTurns: number;
  forkedFrom: string | null;
  forkFirstNewUuid: string | null;
}

/**
 * Run `claude-session-analysis sessions --format jsonl <ids...>` and return the
 * parsed JSONL records. Batches ids to stay within argv length limits.
 *
 * Design rationale: CSA は必須依存。spawn 失敗時はフォールバックせず例外を投げる
 * （旧 JSONL 直読は廃止）。バッチ呼び出しで N spawn を回避する。
 *
 * テスト時は mock せず、HOME / CLAUDE_CONFIG_DIR を tempDir に向けて fixture jsonl
 * を実 CSA に読ませる方式（src/lib/test-fixtures.ts 参照）。
 */
async function runCsaSessions(sessionIds: string[]): Promise<unknown[]> {
  if (sessionIds.length === 0) return [];
  const BATCH = 200;
  const records: unknown[] = [];
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH);
    const proc = Bun.spawn(
      ["claude-session-analysis", "sessions", "--format", "jsonl", ...batch],
      // CSA は session JSONL の読み取りしかしないため、API クレデンシャル類は
      // 必要ない。allowlist で env を絞り込む (= 子プロセスから ANTHROPIC_API_KEY /
      // GH_TOKEN / SSH_AUTH_SOCK 等にアクセスさせない、DR-0009 Phase 1 補強)。
      { stdout: "pipe", stderr: "pipe", env: buildCsaEnv() },
    );
    const [out, err, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `claude-session-analysis failed (exit ${exitCode}): ${err.trim() || "no stderr"}`,
      );
    }
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      records.push(JSON.parse(line) as unknown);
    }
  }
  return records;
}

/** Extract a session UUID from a JSONL file path, falling back to the basename. */
function sessionIdFromPath(filePath: string): string {
  const filename = basename(filePath, ".jsonl");
  const uuidMatch = filename.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch ? uuidMatch[0] : filename;
}

/** Build a SessionMeta from a CSA record + per-file age. */
function toSessionMeta(filePath: string, rec: CsaSessionRecord, ageSec: number): SessionMeta {
  const start = new Date(rec.startTime);
  const meta: SessionMeta = {
    id: rec.sessionId,
    filePath,
    project: rec.cwd,
    lineCount: rec.lines,
    ageSec,
    startTime: Number.isNaN(start.getTime()) ? new Date(0) : start,
    userTurns: rec.turns,
    effectiveUserTurns: rec.effectiveUserTurns,
  };
  if (rec.endTime) {
    const end = new Date(rec.endTime);
    if (!Number.isNaN(end.getTime())) meta.endTime = end;
  }
  if (rec.forkedFrom) {
    meta.forkInfo = {
      parentSessionId: rec.forkedFrom,
      firstNewUuid: rec.forkFirstNewUuid ?? "",
    };
  }
  return meta;
}

/**
 * Extract session metadata for multiple JSONL files via CSA in a single batch
 * (avoids N spawns). Returns a Map keyed by sessionId.
 *
 * `ageSec` is computed per file from `stat().mtimeMs` (CSA doesn't provide it).
 * Throws if CSA fails or if any requested session is missing from CSA output.
 */
export async function getSessionMetaBatch(filePaths: string[]): Promise<Map<string, SessionMeta>> {
  const result = new Map<string, SessionMeta>();
  if (filePaths.length === 0) return result;

  // Map sessionId -> filePath (and dedupe ids for the CSA call).
  const idToPath = new Map<string, string>();
  for (const filePath of filePaths) {
    idToPath.set(sessionIdFromPath(filePath), filePath);
  }
  const ids = [...idToPath.keys()];

  const rawRecords = await runCsaSessions(ids);
  const byId = new Map<string, CsaSessionRecord>();
  for (const raw of rawRecords) {
    const rec = raw as CsaSessionRecord;
    byId.set(rec.sessionId, rec);
  }

  // File age. Clamp to 0: in tests (or on NFS with clock drift) the file mtime
  // can be microseconds in the "future" from Date.now()'s perspective,
  // yielding a negative age. Age < 0 makes no sense to callers.
  for (const [id, filePath] of idToPath) {
    const rec = byId.get(id);
    const fileStat = await stat(filePath);
    const ageSec = Math.max(0, Math.floor((Date.now() - fileStat.mtimeMs) / 1000));
    if (!rec) {
      // Design rationale: CSA は空 file (0 byte) に対して何も emit しない (header もない
      // ため "session" として認識されない)。一方 idea-storage の pipeline は
      // 「empty session = lineCount 0 として markSkipped」と扱う前提で processSession の
      // 早期 return を組んでいる (session-process.ts の `meta.lineCount === 0` 分岐参照)。
      // CSA 移行前は jsonl 直読で lineCount=0 を返していたが、CSA 委譲後はその経路が
      // 失われた。空 file は throw せず合成 meta を返すことで旧挙動を保つ。
      // 非空なのに CSA が record を返さないケースは真の不整合なので従来通り throw する。
      if (fileStat.size === 0) {
        result.set(id, {
          id,
          filePath,
          project: "",
          lineCount: 0,
          ageSec,
          startTime: new Date(0),
          userTurns: 0,
          effectiveUserTurns: 0,
        });
        continue;
      }
      throw new Error(`claude-session-analysis returned no record for session ${id}`);
    }
    result.set(id, toSessionMeta(filePath, rec, ageSec));
  }
  return result;
}

/**
 * Extract session metadata for a single JSONL file. Thin wrapper over
 * {@link getSessionMetaBatch}.
 */
export async function getSessionMeta(filePath: string): Promise<SessionMeta> {
  const map = await getSessionMetaBatch([filePath]);
  const id = sessionIdFromPath(filePath);
  const meta = map.get(id);
  if (!meta) {
    throw new Error(`claude-session-analysis returned no record for session ${id}`);
  }
  return meta;
}
