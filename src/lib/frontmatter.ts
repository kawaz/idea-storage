/**
 * Simple YAML frontmatter parser (no external YAML dependency).
 * Supports up to 2 levels of nesting.
 */

import { redactForOutput } from "./redact-pipeline.ts";

/**
 * Encode a value as a single-line YAML scalar that survives parseFrontmatter
 * round-trip without breaking the surrounding `---` delimiters.
 *
 * Design rationale: generateFrontmatter is fed user / session-derived data
 * (cwd, project, session_id, ...). `String(value)` directly would let a value
 * like `x\n---\nbody\n---\n` re-open the frontmatter block. We:
 *
 * 1. Redact secrets first (defense in depth — frontmatter is part of output).
 * 2. Plain-emit when the scalar is "obviously safe" (matches the unquoted
 *    string shape that parseValue() treats as a plain string).
 * 3. Otherwise double-quote and escape backslash / quote / control chars.
 *
 * parseFrontmatter does *not* decode `\n` inside double-quoted strings (it
 * just strips the surrounding quotes), so multi-line values round-trip as
 * the literal 2-char sequence `\n`. That is acceptable: frontmatter is for
 * single-line metadata; long-form text belongs in the body.
 */
function encodeYamlScalar(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const raw = redactForOutput(String(value));
  if (isSafePlainScalar(raw)) return raw;
  const escaped = raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function isSafePlainScalar(s: string): boolean {
  if (s === "") return false;
  if (s !== s.trim()) return false;
  if (s === "---") return false;
  for (const ch of s) {
    if (ch === "\n" || ch === "\r" || ch === "\t") return false;
    if (ch === ":" || ch === '"' || ch === "'" || ch === "\\" || ch === "#") {
      return false;
    }
  }
  return true;
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  // Quoted string (single or double quotes)
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  // Number
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  // Plain string
  return trimmed;
}

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = content.split("\n");

  // Must start with ---
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  // Find closing ---
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmLines = lines.slice(1, closingIndex);
  const body = lines.slice(closingIndex + 1).join("\n");

  const frontmatter: Record<string, unknown> = {};
  let currentParent: string | null = null;

  for (const line of fmLines) {
    // Skip blank lines and comment lines
    const stripped = line.trimStart();
    if (stripped === "" || stripped.startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;
    const colonIndex = stripped.indexOf(":");
    if (colonIndex === -1) continue;

    const key = stripped.slice(0, colonIndex).trim();
    const valueRaw = stripped.slice(colonIndex + 1);
    // Strip inline comments: find # preceded by whitespace, not inside quotes
    const valueNoComment = stripInlineComment(valueRaw);
    const valueTrimmed = valueNoComment.trim();

    if (indent >= 2 && currentParent !== null) {
      // Nested key under currentParent
      const parentObj = frontmatter[currentParent];
      if (typeof parentObj === "object" && parentObj !== null) {
        (parentObj as Record<string, unknown>)[key] = parseValue(valueTrimmed);
      }
    } else if (valueTrimmed === "") {
      // Parent key with no value — next indented lines are children
      currentParent = key;
      frontmatter[key] = {};
    } else {
      // Top-level key with value
      currentParent = null;
      frontmatter[key] = parseValue(valueTrimmed);
    }
  }

  return { frontmatter, body: body.replace(/^\n/, "") };
}

function stripInlineComment(value: string): string {
  // Strip inline comments: # preceded by at least one space,
  // but not inside single or double quotes
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "#" && !inSingle && !inDouble && i > 0 && value[i - 1] === " ") {
      return value.slice(0, i - 1);
    }
  }
  return value;
}

export function generateFrontmatter(data: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value == null) continue;
    lines.push(`${key}: ${encodeYamlScalar(value)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}
