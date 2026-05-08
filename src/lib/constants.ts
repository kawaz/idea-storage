/**
 * Centralized timeout / threshold / retry constants.
 *
 * Design rationale: Constants used across multiple modules are gathered here
 * so that values, units, and rationales live in one place. Module-local values
 * that are not shared and have no inter-module relationships intentionally
 * remain in their own modules (e.g. queue.ts wait/poll defaults).
 */

/** CSA subprocess timeout: 10 minutes (実測では1.7MBセッションでも50ms以内だが余裕を持たせる) */
export const CSA_TIMEOUT_MS = 10 * 60 * 1000;

/** Per-task timeout for a single claude invocation: 25 minutes */
export const DEFAULT_TASK_TIMEOUT_MS = 25 * 60 * 1000;

/** Worker-loop overall timeout: 50 minutes (must be shorter than launchd StartInterval=3600s=60min) */
export const OVERALL_TIMEOUT_MS = 50 * 60 * 1000;

/**
 * Rate limit observations older than this are considered stale and the judge
 * ignores them (treated as no-data → proceed). 15 minutes (in seconds).
 */
export const RATE_LIMIT_STALE_THRESHOLD_SEC = 15 * 60;

/** Bail out of the worker loop after this many consecutive task failures */
export const MAX_CONSECUTIVE_FAILURES = 5;

/** Default retry budget for a failed (session, recipe) pair before treating as permanently failed */
export const DEFAULT_MAX_RETRIES = 3;
