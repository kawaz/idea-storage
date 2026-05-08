import { redactSecrets } from "./redact.ts";

/**
 * Maximum length for the `error` field in log payloads. Anything longer is
 * truncated with a `...(truncated)` marker.
 *
 * Design rationale: error messages from spawned processes (claude CLI, csa,
 * etc.) can include large stderr or stack traces. Logs are intended for
 * structured operational signal, not full diagnostic capture, so we cap the
 * size aggressively.
 */
const MAX_ERROR_LEN = 500;

/**
 * Field names that may carry large user / session bodies. These are always
 * filtered out of log payloads to prevent prompts, conversation timelines,
 * and other content from leaking into operational logs.
 *
 * Design rationale: defense in depth. Even if a future caller passes such a
 * field by accident, the logger drops it silently rather than emitting it.
 */
const DANGEROUS_FIELDS: ReadonlySet<string> = new Set([
  "prompt",
  "timeline",
  "content",
  "text",
  "body",
]);

function sanitizeLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (DANGEROUS_FIELDS.has(key)) continue;
    if (key === "error" && typeof value === "string") {
      const redacted = redactSecrets(value).text;
      result[key] =
        redacted.length > MAX_ERROR_LEN
          ? redacted.slice(0, MAX_ERROR_LEN) + "...(truncated)"
          : redacted;
      continue;
    }
    result[key] = value;
  }
  return result;
}

export function log(data: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...sanitizeLogPayload(data) }));
}

export function logError(data: Record<string, unknown>) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      ...sanitizeLogPayload(data),
    }),
  );
}
