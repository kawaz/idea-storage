import { define } from "gunshi";
import { join, basename } from "node:path";
import { stat } from "node:fs/promises";
import { loadConfig } from "../lib/config.ts";
import { getSessionMeta } from "../lib/conversation.ts";
import { formatAge } from "../lib/format.ts";
import { UUID_JSONL_PATTERN } from "../lib/session-finder.ts";

function projectName(project: string): string {
  if (!project) return "-";
  return basename(project);
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
  hasEnd: boolean;
  userTurns: number;
  sessionBytes: number;
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
  has_end: boolean;
  status: "ended" | "active";
}

export function toSessionJsonEntry(entry: SessionListEntry): SessionJsonEntry {
  return {
    id: entry.id,
    path: entry.filePath,
    project: entry.project,
    user_turns: entry.userTurns,
    session_bytes: entry.sessionBytes,
    age_sec: entry.ageSec,
    line_count: entry.lineCount,
    has_end: entry.hasEnd,
    status: entry.hasEnd ? "ended" : "active",
  };
}

async function collectSessions(): Promise<SessionListEntry[]> {
  const config = await loadConfig();
  const sessions: SessionListEntry[] = [];

  for (const claudeDir of config.claudeDirs) {
    const projectsDir = join(claudeDir, "projects");
    const glob = new Bun.Glob("**/*.jsonl");

    try {
      for await (const relativePath of glob.scan(projectsDir)) {
        const filename = relativePath.split("/").pop() ?? "";
        if (!UUID_JSONL_PATTERN.test(filename)) continue;

        const filePath = join(projectsDir, relativePath);
        const meta = await getSessionMeta(filePath);
        let sessionBytes = 0;
        try {
          const st = await stat(filePath);
          sessionBytes = st.size;
        } catch {
          // best-effort: 0 if stat fails
        }

        sessions.push({
          id: meta.id,
          filePath,
          project: meta.project,
          projectShort: projectName(meta.project),
          lineCount: meta.lineCount,
          ageSec: meta.ageSec,
          hasEnd: meta.hasEnd,
          userTurns: meta.userTurns,
          sessionBytes,
        });
      }
    } catch (e: unknown) {
      // ディレクトリが存在しない場合はスキップ（他のclaudeDirを継続処理）
      if (e instanceof Error && "code" in e && e.code === "ENOENT") continue;
      throw e;
    }
  }

  // Sort by age descending (oldest first)
  sessions.sort((a, b) => b.ageSec - a.ageSec);

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

  // Text output (existing behavior)
  const header = {
    id: "SESSION_ID",
    project: "PROJECT",
    lines: "LINES",
    age: "AGE",
    status: "STATUS",
  };
  const rows = sessions.map((s) => ({
    id: s.id.slice(0, 8) + "..",
    project: s.projectShort,
    lines: String(s.lineCount),
    age: formatAge(s.ageSec),
    status: s.hasEnd ? "ended" : "active",
  }));

  const colWidths = {
    id: Math.max(header.id.length, ...rows.map((r) => r.id.length)),
    project: Math.max(header.project.length, ...rows.map((r) => r.project.length)),
    lines: Math.max(header.lines.length, ...rows.map((r) => r.lines.length)),
    age: Math.max(header.age.length, ...rows.map((r) => r.age.length)),
    status: Math.max(header.status.length, ...rows.map((r) => r.status.length)),
  };

  const formatRow = (r: typeof header) =>
    `${r.id.padEnd(colWidths.id)}  ${r.project.padEnd(colWidths.project)}  ${r.lines.padStart(colWidths.lines)}  ${r.age.padStart(colWidths.age)}  ${r.status.padEnd(colWidths.status)}`;

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
