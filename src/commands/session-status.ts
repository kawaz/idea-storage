import { define } from "gunshi";
import { getStatus } from "../lib/queue.ts";
import { getLatestObservations } from "../lib/rate-limit-store.ts";
import { shouldSkip } from "../lib/rate-limit-judge.ts";
import { RATE_LIMIT_STALE_THRESHOLD_SEC } from "./session-run.ts";

function formatBucket(
  util: number | null,
  reset: number | null,
  windowSec: number,
  nowSec: number,
): string {
  if (util === null || reset === null) return "n/a";
  const pct = (util * 100).toFixed(1);
  const windowStart = reset - windowSec;
  const elapsed = Math.max(0, Math.min(1, (nowSec - windowStart) / windowSec));
  const elapsedPct = (elapsed * 100).toFixed(1);
  const remaining = Math.max(0, reset - nowSec);
  const mins = Math.floor(remaining / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const remStr = h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m`;
  return `util=${pct}% elapsed=${elapsedPct}% reset=${remStr}`;
}

const sessionStatus = define({
  name: "status",
  description: "Show queue status and rate_limits observation",
  run: async () => {
    const status = await getStatus();
    console.log(`Queued: ${status.queued} / Done: ${status.done} / Failed: ${status.failed}`);

    const nowSec = Math.floor(Date.now() / 1000);
    const rows = getLatestObservations(1);
    if (rows.length === 0) {
      console.log("Rate limits: no observation yet");
      return;
    }
    const row = rows[0]!;
    const ageSec = nowSec - row.ts;
    console.log(`Rate limits (${ageSec}s ago, source=${row.source}):`);
    console.log(`  5h : ${formatBucket(row.fiveHourUtil, row.fiveHourReset, 5 * 3600, nowSec)}`);
    console.log(`  7d : ${formatBucket(row.sevenDayUtil, row.sevenDayReset, 7 * 86400, nowSec)}`);

    const decision = shouldSkip(rows, nowSec, {
      staleThresholdSec: RATE_LIMIT_STALE_THRESHOLD_SEC,
    });
    console.log(`Worker decision: ${decision.skip ? "SKIP" : "PROCEED"} (${decision.reason})`);
  },
});

export default sessionStatus;
