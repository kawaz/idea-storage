import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  formatSmartSize as formatSmartSizePlain,
  formatDuration as formatDurationPlain,
  formatTimestamp as formatTimestampPlain,
  shouldUseColor,
} from "../format.ts";

/**
 * Shared formatters for `article list` / `article view` output.
 *
 * Plain (color-less) implementations live in `./format.ts` and are reused
 * here. This module wraps them with ANSI color codes that respect
 * NO_COLOR / FORCE_COLOR / CI / TTY via `shouldUseColor()`.
 */

const ANSI = {
  red: "\x1b[0;31m",
  redDim: "\x1b[2;31m",
  green: "\x1b[0;32m",
  greenDim: "\x1b[2;32m",
  yellow: "\x1b[0;33m",
  yellowDim: "\x1b[2;33m",
  blue: "\x1b[0;34m",
  magenta: "\x1b[0;35m",
  blackBright: "\x1b[0;90m",
  reset: "\x1b[0m",
} as const;

/**
 * Color palette proxy. Each access returns the raw ANSI code when
 * `shouldUseColor()` is true, otherwise an empty string. This lets call
 * sites use `${C.red}foo${C.reset}` template literals unchanged while
 * honouring NO_COLOR / FORCE_COLOR / CI / TTY.
 */
export const C: Record<keyof typeof ANSI, string> = new Proxy(
  {} as Record<keyof typeof ANSI, string>,
  {
    get(_target, prop: string) {
      if (!(prop in ANSI)) return "";
      return shouldUseColor() ? ANSI[prop as keyof typeof ANSI] : "";
    },
  },
);

const HOME = process.env.HOME ?? "";

function tildefy(path: string): string {
  return HOME && path.startsWith(HOME) ? "~" + path.slice(HOME.length) : path;
}

/** Wrap text with an OSC 8 hyperlink, suppressed when colors are disabled. */
export function oscLink(url: string, text: string): string {
  // OSC 8 hyperlink is also a terminal escape sequence; suppress when colors
  // are disabled so plain output (pipes, CI logs) stays clean.
  if (!shouldUseColor()) return text;
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

/** Strip ANSI SGR escape sequences (e.g. for measuring visible length). */
export function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex -- intentional: strip ANSI escape sequences
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Smart byte formatter with size-band coloring (blue/yellow/red). */
export function formatSmartSize(bytes: number): string {
  const plain = formatSmartSizePlain(bytes);
  const num = plain.slice(0, -1);
  const unit = plain.slice(-1);
  let color: string;
  if (unit === "G") {
    color = C.red;
  } else if (unit === "M") {
    color = bytes > 2 * 1024 * 1024 ? C.red : C.blue;
  } else {
    color = bytes >= 500 * 1024 ? C.yellow : C.blue;
  }
  return `${color}${num}${C.reset}${unit}`;
}

/** Duration formatter with color: red(d) / yellow(h) / green(m) / dim(s-only). */
export function formatDuration(startMs: number, endMs: number): string {
  const plain = formatDurationPlain(startMs, endMs);
  if (plain === "-") return "-";
  if (plain.includes("d")) return `${C.red}${plain}${C.reset}`;
  if (plain.includes("h")) return `${C.yellow}${plain}${C.reset}`;
  if (plain.includes("m")) return `${C.green}${plain}${C.reset}`;
  // seconds-only (e.g. "5s", "0s"): dim, mirroring the old "0m" prefix dim.
  return `${C.blackBright}${plain}${C.reset}`;
}

/** Timestamp formatter (JST) with the `T` separator dimmed. */
export function formatTimestamp(date: Date): string {
  const plain = formatTimestampPlain(date);
  return plain.replace("T", `${C.blackBright}T${C.reset}`);
}

/**
 * Parse a project path into match (filter target) and display (colorized) forms.
 *
 * - `/repos/{host}/{owner}/{repo}[/rest...]` shaped paths are decomposed:
 *   - `host=github.com` is suppressed in both match and display
 *   - `owner` colored magenta, `repo` colored blue
 *   - first sub-component (`rest1`) colored green if it contains `.jj` or
 *     `.git` (i.e. is a worktree), otherwise dim
 * - Other paths are returned as-is (with `~` substitution for `$HOME`).
 */
export function parseProject(project: string): { matchPath: string; displayPath: string } {
  const reposIdx = project.indexOf("/repos/");
  if (reposIdx === -1) {
    // Non-matching pattern: return full path as-is.
    const clean = project.replace(/\/$/, "");
    return { matchPath: clean, displayPath: tildefy(clean) };
  }
  // /repos/{host}/{owner}/{repo}[/rest...]
  const after = project.slice(reposIdx + "/repos/".length).replace(/\/$/, "");
  const parts = after.split("/");
  const host = parts[0] ?? "";
  const owner = parts[1] ?? "";
  const repo = parts[2] ?? "";
  const rest = parts.slice(3).join("/");

  const isGithub = host === "github.com";
  const hostPart = isGithub ? "" : `${host}/`;
  const ownerColor = C.magenta;

  // rest1 is colored green if it is a worktree (.jj or .git present)
  const rest1 = parts[3] ?? "";
  const rest2 = parts.slice(4).join("/");
  let rest1Display = "";
  if (rest1) {
    const prefix = project.slice(0, reposIdx);
    const rest1Path = join(prefix, "repos", host, owner, repo, rest1);
    const isWs = existsSync(join(rest1Path, ".jj")) || existsSync(join(rest1Path, ".git"));
    rest1Display = isWs ? `/${C.green}${rest1}${C.reset}` : `${C.blackBright}/${rest1}${C.reset}`;
  }
  const rest2Display = rest2 ? `${C.blackBright}/${rest2}${C.reset}` : "";

  const matchPath = `${hostPart}${owner}/${repo}${rest ? `/${rest}` : ""}`;
  const displayPath = `${hostPart}${ownerColor}${owner}${C.reset}/${C.blue}${repo}${C.reset}${rest1Display}${rest2Display}`;

  return { matchPath, displayPath };
}
