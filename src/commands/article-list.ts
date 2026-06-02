import { define } from "gunshi";
import { dirname } from "node:path";
import { getDataDir } from "../lib/paths.ts";
import { parseFrontmatter } from "../lib/frontmatter.ts";
import { runCsaSessions } from "../lib/csa/csa.ts";
import { listViewEntries } from "./article-view.ts";
import {
  C,
  formatDuration,
  formatSmartSize,
  formatTimestamp,
  oscLink,
  parseProject,
  stripAnsi,
} from "../lib/article/article-format.ts";

interface ListEntry {
  fullPath: string;
  sizeBytes: number;
  recipe: string;
  sessionId: string;
  sessionStart: Date | null;
  sessionEnd: Date | null;
  durationMs: number | null;
  userTurns: number | null;
  sessionBytes: number | null;
  project: string;
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

/**
 * JSON-safe shape for an article entry. All fields are plain JS values with
 * snake_case keys (matching `claude-session-analysis` conventions).
 *
 * - Dates → ISO 8601 strings (or null)
 * - File path is the absolute path to the article .md
 * - `size_bytes` is the article file size; `session_bytes` is the source
 *   session JSONL size as reported by CSA / frontmatter
 */
export interface ArticleJsonEntry {
  path: string;
  size_bytes: number;
  recipe: string;
  session_id: string;
  project: string;
  session_start: string | null;
  session_end: string | null;
  duration_ms: number | null;
  user_turns: number | null;
  session_bytes: number | null;
}

export function toArticleJsonEntry(entry: ListEntry): ArticleJsonEntry {
  return {
    path: entry.fullPath,
    size_bytes: entry.sizeBytes,
    recipe: entry.recipe,
    session_id: entry.sessionId,
    project: entry.project,
    session_start: entry.sessionStart ? entry.sessionStart.toISOString() : null,
    session_end: entry.sessionEnd ? entry.sessionEnd.toISOString() : null,
    duration_ms: entry.durationMs,
    user_turns: entry.userTurns,
    session_bytes: entry.sessionBytes,
  };
}

const VALID_SORT_KEYS = ["start", "end", "duration", "turn", "rule"] as const;
type SortKey = (typeof VALID_SORT_KEYS)[number];

function isSortKey(s: string): s is SortKey {
  return (VALID_SORT_KEYS as readonly string[]).includes(s);
}

export function parseSortKeys(value: string | undefined): SortKey[] {
  if (!value) return ["start"];
  const keys = value
    .split(",")
    .map((s) => s.trim())
    .filter(isSortKey);
  return keys.length > 0 ? keys : ["start"];
}

export function validateSortKeys(value: string | undefined): void {
  if (!value) return;
  const keys = value.split(",").map((s) => s.trim());
  const invalid = keys.filter((k) => k && !isSortKey(k));
  if (invalid.length > 0) {
    throw new Error(
      `Invalid sort key: ${invalid.join(", ")}. Valid keys: ${VALID_SORT_KEYS.join(", ")}`,
    );
  }
}

export function validateRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid regular expression for ${label}: "${pattern}" - ${msg}`);
  }
}

export function sortEntries(entries: ListEntry[], sortKeys: SortKey[]): void {
  entries.sort((a, b) => {
    for (const key of sortKeys) {
      let cmp = 0;
      switch (key) {
        case "start":
          // 降順（最新が上）
          cmp = (b.sessionStart?.getTime() ?? 0) - (a.sessionStart?.getTime() ?? 0);
          break;
        case "end":
          cmp = (b.sessionEnd?.getTime() ?? 0) - (a.sessionEnd?.getTime() ?? 0);
          break;
        case "duration": {
          const aDur =
            a.durationMs ??
            (a.sessionStart && a.sessionEnd
              ? a.sessionEnd.getTime() - a.sessionStart.getTime()
              : 0);
          const bDur =
            b.durationMs ??
            (b.sessionStart && b.sessionEnd
              ? b.sessionEnd.getTime() - b.sessionStart.getTime()
              : 0);
          cmp = bDur - aDur; // 降順
          break;
        }
        case "turn":
          cmp = (b.userTurns ?? 0) - (a.userTurns ?? 0); // 降順
          break;
        case "rule":
          cmp = a.recipe.localeCompare(b.recipe); // 昇順
          break;
      }
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

interface CsaSession {
  sessionId: string;
  cwd: string;
  startTime: string;
  endTime: string;
  duration_ms: number;
  bytes: number;
  turns: number;
}

/**
 * Best-effort fetch of session stats from claude-session-analysis.
 * Swallows CSA spawn failures and returns whatever was collected so that
 * article listing degrades gracefully (frontmatter fallback covers the rest).
 *
 * Wraps {@link runCsaSessions} (which throws on non-zero exit) to preserve the
 * original silent-failure behavior. DR-0009 Phase 3 集約。
 */
async function fetchSessionStats(sessionIds: string[]): Promise<Map<string, CsaSession>> {
  const map = new Map<string, CsaSession>();
  if (sessionIds.length === 0) return map;
  try {
    const records = await runCsaSessions(sessionIds);
    for (const r of records) {
      const s = r as CsaSession;
      if (s && typeof s.sessionId === "string") {
        map.set(s.sessionId, s);
      }
    }
  } catch {
    // Best-effort: degrade to frontmatter fallback if CSA fails.
  }
  return map;
}

const UUID_RE = /\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;

interface ArticleInfo {
  fullPath: string;
  sizeBytes: number;
  mtime: Date;
  sessionId: string;
  recipe: string;
}

/** ファイルスキャンのみ（glob + stat） */
async function scanArticles(dataDir: string): Promise<ArticleInfo[]> {
  const viewEntries = await listViewEntries(dataDir);
  return viewEntries.map((ve) => ({
    fullPath: ve.fullPath,
    sizeBytes: ve.sizeBytes,
    mtime: ve.mtime,
    sessionId: ve.relativePath.match(UUID_RE)?.[1] ?? "",
    recipe: ve.relativePath.split("/")[0] ?? "",
  }));
}

const parseDateValue = (v: unknown) => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** CSA + frontmatter fallback で ListEntry を構築 */
async function enrichArticles(articles: ArticleInfo[]): Promise<ListEntry[]> {
  const uniqueIds = [...new Set(articles.map((a) => a.sessionId).filter(Boolean))];
  const csaMap = await fetchSessionStats(uniqueIds);

  const fmCache = new Map<string, Record<string, unknown>>();
  const fmTargets = articles.filter((a) => a.sessionId && !csaMap.has(a.sessionId));
  const fmResults = await Promise.all(
    fmTargets.map(async (a) => {
      const content = await Bun.file(a.fullPath).text();
      const { frontmatter } = parseFrontmatter(content);
      return { path: a.fullPath, frontmatter };
    }),
  );
  for (const { path, frontmatter } of fmResults) {
    fmCache.set(path, frontmatter);
  }

  return articles.map((a) => {
    const csa = csaMap.get(a.sessionId);
    if (csa) {
      return {
        fullPath: a.fullPath,
        sizeBytes: a.sizeBytes,
        recipe: a.recipe,
        sessionId: a.sessionId,
        sessionStart: new Date(csa.startTime),
        sessionEnd: new Date(csa.endTime),
        durationMs: csa.duration_ms,
        userTurns: csa.turns,
        sessionBytes: csa.bytes,
        project: csa.cwd,
      };
    }
    const fm = fmCache.get(a.fullPath);
    const fmProject = typeof fm?.project === "string" ? fm.project : "";
    return {
      fullPath: a.fullPath,
      sizeBytes: a.sizeBytes,
      recipe: a.recipe,
      sessionId: a.sessionId,
      sessionStart: parseDateValue(fm?.session_start) ?? a.mtime,
      sessionEnd: parseDateValue(fm?.session_end),
      durationMs: typeof fm?.duration_ms === "number" ? fm.duration_ms : null,
      userTurns: typeof fm?.user_turns === "number" ? fm.user_turns : null,
      sessionBytes: typeof fm?.session_bytes === "number" ? fm.session_bytes : null,
      project: fmProject.includes("/") ? fmProject : "",
    };
  });
}

function formatLine(
  entry: ListEntry,
  maxRuleLen: number,
  maxSizeLen: number,
  maxTurnLen: number,
  maxDurLen: number,
): string {
  // 1. Rule
  const rule = `${C.magenta}${entry.recipe.padEnd(maxRuleLen)}${C.reset}`;

  // 2. Size
  const size = formatSmartSize(entry.sizeBytes).padStart(maxSizeLen);

  // 3. Turn
  const turn =
    entry.userTurns !== null
      ? String(entry.userTurns).padStart(maxTurnLen)
      : "-".padStart(maxTurnLen);

  // 4. Duration (durationMs 優先、なければ start/end から計算)
  let dur: string;
  if (entry.durationMs !== null) {
    dur = formatDuration(0, entry.durationMs);
  } else if (entry.sessionStart && entry.sessionEnd) {
    dur = formatDuration(entry.sessionStart.getTime(), entry.sessionEnd.getTime());
  } else {
    dur = "-";
  }
  const durPlain = stripAnsi(dur);
  const durPadded = " ".repeat(Math.max(0, maxDurLen - durPlain.length)) + dur;

  // 5. Timestamp（/ 区切り）
  const ts = entry.sessionStart ? formatTimestamp(entry.sessionStart) : "                "; // 16 spaces

  // 6-7. UUID + path（パディングなし）
  const uuid = entry.sessionId ? `${C.blackBright}${entry.sessionId}${C.reset}` : "";

  // 7. [F][V] clickable links + path
  const finderLink = oscLink(`file://${dirname(entry.fullPath)}`, `${C.blackBright}[F]${C.reset}`);
  const vscodeLink = oscLink(`vscode://file${entry.fullPath}`, `${C.blackBright}[V]${C.reset}`);
  const { displayPath } = parseProject(entry.project);
  const pathStr = entry.project ? displayPath : "";

  const tail = [uuid, `${finderLink}${vscodeLink}`, pathStr].filter(Boolean).join(" ");
  return `${rule}  ${size}  ${turn}  ${durPadded}  ${ts}${tail ? `  ${tail}` : ""}`;
}

const articleList = define({
  name: "list",
  description: "List all articles with rich formatting (see also: `article ls` for plain output)",
  args: {
    pattern: {
      type: "positional",
      multiple: true,
      description:
        "Filter regex(s): each pattern matches against recipe name first, falls back to project path",
    },
    sort: {
      type: "string",
      description: "Sort keys (comma-separated): start, end, duration, turn, rule",
    },
    rule: {
      type: "string",
      description: "Filter by rule (recipe) name (regex)",
    },
    path: {
      type: "string",
      description: "Filter by project path (regex)",
    },
    format: {
      type: "string",
      description: `Output format: ${VALID_OUTPUT_FORMATS.join(", ")} (default: text)`,
    },
  },
  run: async (ctx) => {
    validateSortKeys(ctx.values.sort as string | undefined);
    const format = validateOutputFormat(ctx.values.format as string | undefined);
    const sortKeys = parseSortKeys(ctx.values.sort as string | undefined);
    const rulePattern = ctx.values.rule as string | undefined;
    const pathPattern = ctx.values.path as string | undefined;
    const positional = (ctx.values.pattern as string[] | undefined) ?? [];

    const dataDir = getDataDir();

    // Phase 1: ファイルスキャン（I/O: glob + stat のみ）
    let articles = await scanArticles(dataDir);

    // Phase 2: recipe だけで判定できるフィルタを先に適用（CSA 不要）
    if (rulePattern) {
      const re = validateRegex(rulePattern, "rule");
      articles = articles.filter((a) => re.test(a.recipe));
    }
    // positional のうち recipe だけで全マッチするものを先に適用
    let pathRegexes: RegExp[] = [];
    if (positional.length > 0) {
      const regexes = positional.map((p) => validateRegex(p, "positional"));
      const recipeValues = new Set(articles.map((a) => a.recipe));
      const recipeOnly: RegExp[] = [];
      for (const re of regexes) {
        if ([...recipeValues].some((r) => re.test(r))) {
          recipeOnly.push(re);
        } else {
          pathRegexes.push(re);
        }
      }
      // recipe でマッチする regex はここで適用
      if (recipeOnly.length > 0) {
        articles = articles.filter((a) => recipeOnly.every((re) => re.test(a.recipe)));
      }
    }

    if (articles.length === 0) {
      if (format === "json") console.log("[]");
      else if (format === "jsonl") {
        // empty: print nothing (each line is one entry)
      } else {
        console.log("No articles found.");
      }
      return;
    }

    // Phase 3: path フィルタが必要な場合のみ CSA を呼ぶ
    const needsCsa = pathPattern || pathRegexes.length > 0;
    let entries: ListEntry[];
    if (needsCsa || articles.length <= 500) {
      // CSA で enrich
      entries = await enrichArticles(articles);
      // path フィルタ適用
      if (pathPattern) {
        const re = validateRegex(pathPattern, "path");
        entries = entries.filter((e) => {
          const { matchPath } = parseProject(e.project);
          return re.test(matchPath);
        });
      }
      if (pathRegexes.length > 0) {
        entries = entries.filter((e) => {
          const { matchPath } = parseProject(e.project);
          return pathRegexes.every((re) => re.test(e.recipe) || re.test(matchPath));
        });
      }
    } else {
      // フィルタ不要で件数が多い場合もCSAで enrich（表示に必要）
      entries = await enrichArticles(articles);
    }

    if (entries.length === 0) {
      if (format === "json") console.log("[]");
      else if (format === "jsonl") {
        // empty: print nothing
      } else {
        console.log("No articles found.");
      }
      return;
    }

    // Sort
    sortEntries(entries, sortKeys);

    // JSON / JSONL output: serialize and skip text formatting entirely.
    // Strings here come from data fields (path, recipe, project, ISO date),
    // none of which carry ANSI escapes — so JSON output is plain by construction.
    if (format === "json") {
      const arr = entries.map(toArticleJsonEntry);
      console.log(JSON.stringify(arr));
      return;
    }
    if (format === "jsonl") {
      for (const e of entries) {
        console.log(JSON.stringify(toArticleJsonEntry(e)));
      }
      return;
    }

    // Calculate column widths
    const maxRuleLen = Math.max(...entries.map((e) => e.recipe.length));

    const sizes = entries.map((e) => formatSmartSize(e.sizeBytes));
    const maxSizeLen = Math.max(...sizes.map((s) => s.length));

    const turns = entries.map((e) => (e.userTurns !== null ? String(e.userTurns) : "-"));
    const maxTurnLen = Math.max(...turns.map((t) => t.length));

    const durations = entries.map((e) => {
      if (e.durationMs !== null) return stripAnsi(formatDuration(0, e.durationMs));
      if (e.sessionStart && e.sessionEnd)
        return stripAnsi(formatDuration(e.sessionStart.getTime(), e.sessionEnd.getTime()));
      return "-";
    });
    const maxDurLen = Math.max(...durations.map((d) => d.length));

    for (const entry of entries) {
      console.log(formatLine(entry, maxRuleLen, maxSizeLen, maxTurnLen, maxDurLen));
    }
  },
});

export default articleList;
