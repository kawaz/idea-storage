/**
 * Redact pipeline: thin wrappers around redactSecrets that encode the INTENT
 * (where the redacted text is going) at the call site, not just the act of
 * redaction.
 *
 * Design rationale: a call to `redactForOutput(body)` reads as "this body is
 * about to hit a file on disk, strip secrets first." Scattered raw
 * `redactSecrets()` calls hide that intent. Splitting by destination also
 * lets us tune length policy per destination:
 *
 * - log fields: capped at 500 chars (logs are operational signal, not
 *   diagnostic capture; long values bloat structured logs).
 * - output: no cap (article content destined for the user — full body matters).
 * - prompt: no cap (LLM input where information density matters).
 *
 * Caller contract: all three functions take `string` and return `string`.
 * Non-string filtering is the caller's responsibility (e.g. logging.ts only
 * calls redactForLog on values where `typeof value === "string"`).
 *
 * Phase 3 will route the persistence module's output and rejected paths
 * through `redactForOutput`. This file is intentionally light on dependencies
 * so it can be imported from any layer without cycles.
 */

import { redactSecrets } from "./redact.ts";

export const REDACT_LOG_DEFAULT_MAX_LEN = 500;

export interface RedactForLogOptions {
  /** Maximum length after redaction. Default REDACT_LOG_DEFAULT_MAX_LEN. */
  maxLength?: number;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...(truncated)";
}

/**
 * Redact for a structured log field. Applies length cap (default 500).
 */
export function redactForLog(text: string, opts?: RedactForLogOptions): string {
  const max = opts?.maxLength ?? REDACT_LOG_DEFAULT_MAX_LEN;
  return truncate(redactSecrets(text).text, max);
}

/**
 * Redact for content destined for disk (article body, _rejected/ raw,
 * frontmatter value). No length cap.
 */
export function redactForOutput(text: string): string {
  return redactSecrets(text).text;
}

/**
 * Redact for LLM input (recent-outputs body inject, dispatcher raw_excerpt,
 * runQualityGate input). No length cap.
 *
 * Today this is identical to redactForOutput. Kept as a separate function so
 * Phase 7 prompt-only filters (e.g. drop literal API key var names that
 * shouldn't influence LLM judgment) can be added without affecting output.
 */
export function redactForPrompt(text: string): string {
  return redactSecrets(text).text;
}
