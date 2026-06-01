import { redactForLog } from "./redact-pipeline.ts";

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

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactForLog(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  return sanitizeLogPayload(value as Record<string, unknown>);
}

function sanitizeLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    // DANGEROUS_FIELDS は階層問わず drop (e.g. log({ meta: { prompt: "..." } })
    // のような future caller を保護)。
    if (DANGEROUS_FIELDS.has(key)) continue;
    result[key] = sanitizeValue(value);
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
