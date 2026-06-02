import type { RateLimitObservation } from "../rate-limit/rate-limit-parser.ts";
import { recordObservation } from "../rate-limit/rate-limit-store.ts";
import { logError } from "../logging.ts";

/**
 * Record a rate_limit observation from a worker claude call.
 * Best-effort: any DB error is swallowed so worker processing isn't disrupted.
 *
 * Shared leaf helper used by both single-pass processSession (index.ts) and
 * chunked-runner. Lives at this depth to avoid cycles (would-be cycle:
 * session-process.ts ↔ session-worker/index.ts ↔ chunked-runner if helper
 * stayed in session-process.ts).
 */
export function recordWorkerObservation(obs: RateLimitObservation): void {
  try {
    recordObservation({
      ts: Math.floor(Date.now() / 1000),
      fiveHour: obs.fiveHour,
      sevenDay: obs.sevenDay,
      source: "worker",
    });
  } catch (err) {
    logError({ msg: "rate_limit_record_failed", error: String(err) });
  }
}
