import { define } from "gunshi";
import { join, basename } from "node:path";
import { stat } from "node:fs/promises";
import { loadConfig } from "../lib/config.ts";
import { getSessionMetaBatch } from "../lib/csa/csa.ts";
import { formatDuration, formatSmartSize } from "../lib/format.ts";
import { UUID_JSONL_PATTERN } from "../lib/csa/session-finder.ts";

function projectName(project: string): string {
  if (!project) return "-";
  return basename(project);
}

function formatShortTimestamp(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime()) || d.getTime() === 0) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const VALID_OUTPUT_FORMATS = ["text", "json", "jsonl"] as const;
export type OutputFormat = (typeof VALID_OUTPUT_FORMATS)[number];

export function isOutputFormat(s: string): s is OutputFormat {
  return (VALID_OUTPUT_FORMATS as readonly string[]).includes(s);
}

export function validateOutputFormat(value: string | undefined): OutputFormat {
  if (value === undefined || value === "") return "text";
  if (!isOutputFormat(value)) {
    throw new Error(`Invalid format: ${value}. Valid values: ${VALID_OUTPUT_FORMATS.join(", ")}`);
  }
  return value;
}

interface SessionListEntry {
  id: string;
  filePath: string;
  project: string;
  projectShort: string;
  lineCount: number;
  ageSec: number;
  userTurns: number;
  sessionBytes: number;
  /** First non-fork timestamp in JSONL, or null if none. */
  startTime: Date | null;
  /** Last non-fork timestamp in JSONL, or null if none. */
  endTime: Date | null;
}

/**
 * JSON-safe shape for a session entry. snake_case keys for consistency with
 * `claude-session-analysis` JSON output.
 */
export interface SessionJsonEntry {
  id: string;
  path: string;
  project: string;
  user_turns: number;
  session_bytes: number;
  age_sec: number;
  line_count: number;
  /** Whether the session has an end timestamp (derived from endTime presence). */
  has_end: boolean;
  status: "ended" | "active";
  /** ISO8601 of first non-fork timestamp; null when unknown. */
  started_at: string | null;
  /** ISO8601 of last non-fork timestamp; null when unknown. */
  ended_at: string | null;
  /** ended_at - started_at in seconds; null when either timestamp is missing. */
  duration_sec: number | null;
}

export function toSessionJsonEntry(entry: SessionListEntry): SessionJsonEntry {
  const started_at = entry.startTime ? entry.startTime.toISOString() : null;
  const ended_at = entry.endTime ? entry.endTime.toISOString() : null;
  const duration_sec =
    entry.startTime && entry.endTime
      ? Math.max(0, Math.floor((entry.endTime.getTime() - entry.startTime.getTime()) / 1000))
      : null;
  // Design rationale: hasEnd フィールド廃止に伴い、終了判定は endTime の有無に統一。
  const hasEnd = entry.endTime != null;
  return {
    id: entry.id,
    path: entry.filePath,
    project: entry.project,
    user_turns: entry.userTurns,
    session_bytes: entry.sessionBytes,
    age_sec: entry.ageSec,
    line_count: entry.lineCount,
    has_end: hasEnd,
    status: hasEnd ? "ended" : "active",
    started_at,
    ended_at,
    duration_sec,
  };
}

async function collectSessions(): Promise<SessionListEntry[]> {
  const config = await loadConfig();

  // Phase 1: glob all session files across claudeDirs.
  const filePaths: string[] = [];
  for (const claudeDir of config.claudeDirs) {
    const projectsDir = join(claudeDir, "projects");
    const glob = new Bun.Glob("**/*.jsonl");

    try {
      for await (const relativePath of glob.scan(projectsDir)) {
        const filename = relativePath.split("/").pop() ?? "";
        if (!UUID_JSONL_PATTERN.test(filename)) continue;
        filePaths.push(join(projectsDir, relativePath));
      }
    } catch (e: unknown) {
      // ディレクトリが存在しない場合はスキップ（他のclaudeDirを継続処理）
      if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
      throw e;
    }
  }

  // Phase 2: fetch metadata for all sessions in a single CSA batch (no N spawn).
  const metaMap = await getSessionMetaBatch(filePaths);

  // Phase 3: build entries (per-file stat for byte size).
  const sessions: SessionListEntry[] = [];
  for (const meta of metaMap.values()) {
    let sessionBytes = 0;
    try {
      const st = await stat(meta.filePath);
      sessionBytes = st.size;
    } catch {
      // best-effort: 0 if stat fails
    }

    const startTime = meta.startTime && meta.startTime.getTime() !== 0 ? meta.startTime : null;
    const endTime = meta.endTime ?? null;
    sessions.push({
      id: meta.id,
      filePath: meta.filePath,
      project: meta.project,
      projectShort: projectName(meta.project),
      lineCount: meta.lineCount,
      ageSec: meta.ageSec,
      userTurns: meta.userTurns,
      sessionBytes,
      startTime,
      endTime,
    });
  }

  // Sort by start time ascending (oldest first); fall back to ageSec when
  // startTime is unknown so legacy entries still get a stable position.
  sessions.sort((a, b) => {
    const ax = a.startTime?.getTime() ?? -1;
    const bx = b.startTime?.getTime() ?? -1;
    if (ax !== bx) return ax - bx;
    return b.ageSec - a.ageSec;
  });

  return sessions;
}

export async function runList(format: OutputFormat = "text"): Promise<void> {
  const sessions = await collectSessions();

  if (sessions.length === 0) {
    if (format === "json") console.log("[]");
    else if (format === "jsonl") {
      // empty: print nothing
    } else {
      console.log("No sessions found.");
    }
    return;
  }

  if (format === "json") {
    console.log(JSON.stringify(sessions.map(toSessionJsonEntry)));
    return;
  }
  if (format === "jsonl") {
    for (const s of sessions) {
      console.log(JSON.stringify(toSessionJsonEntry(s)));
    }
    return;
  }

  // Text output: START / END / DUR / SIZE / TURNS / PROJECT / ID
  const header = {
    start: "START",
    end: "END",
    dur: "DUR",
    size: "SIZE",
    turns: "TURNS",
    project: "PROJECT",
    id: "ID",
  };
  const rows = sessions.map((s) => {
    const start = formatShortTimestamp(s.startTime);
    const end = formatShortTimestamp(s.endTime);
    const dur =
      s.startTime && s.endTime ? formatDuration(s.startTime.getTime(), s.endTime.getTime()) : "-";
    return {
      start,
      end,
      dur,
      size: formatSmartSize(s.sessionBytes),
      turns: String(s.userTurns),
      project: s.projectShort,
      id: s.id.slice(0, 8),
    };
  });

  const colWidths = {
    start: Math.max(header.start.length, ...rows.map((r) => r.start.length)),
    end: Math.max(header.end.length, ...rows.map((r) => r.end.length)),
    dur: Math.max(header.dur.length, ...rows.map((r) => r.dur.length)),
    size: Math.max(header.size.length, ...rows.map((r) => r.size.length)),
    turns: Math.max(header.turns.length, ...rows.map((r) => r.turns.length)),
    project: Math.max(header.project.length, ...rows.map((r) => r.project.length)),
    id: Math.max(header.id.length, ...rows.map((r) => r.id.length)),
  };

  const formatRow = (r: typeof header) =>
    `${r.start.padEnd(colWidths.start)}  ${r.end.padEnd(colWidths.end)}  ${r.dur.padEnd(colWidths.dur)}  ${r.size.padStart(colWidths.size)}  ${r.turns.padStart(colWidths.turns)}  ${r.project.padEnd(colWidths.project)}  ${r.id.padEnd(colWidths.id)}`;

  console.log(formatRow(header));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

const sessionList = define({
  name: "list",
  description: "List all sessions",
  args: {
    format: {
      type: "string",
      description: `Output format: ${VALID_OUTPUT_FORMATS.join(", ")} (default: text)`,
    },
  },
  run: async (ctx) => {
    const format = validateOutputFormat(ctx.values.format as string | undefined);
    await runList(format);
  },
});

export default sessionList;
