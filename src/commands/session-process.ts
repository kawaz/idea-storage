import { define } from "gunshi";
import { runProcess } from "../lib/driver/process-driver.ts";

// --- Re-exports for backwards compatibility ---
//
// The library responsibilities (prompt building, fork trimming, chunked
// runner, frontmatter assembly, persistence, processSession orchestrator)
// moved to src/lib/session-worker/ in DR-0009 Phase 3 step 3-c, and the
// driver entry points (runProcess / processDispatcherEntry) moved to
// src/lib/driver/ in step 3-d. We keep re-exports here so existing
// imports (tests + session-run) don't break until step 3-g fully retires
// this command file.
export { processSession } from "../lib/session-worker/index.ts";
export type { ProcessSessionInput, ProcessSessionResult } from "../lib/session-worker/index.ts";
export { buildSectionPrompt, buildSynthesisPrompt } from "../lib/session-worker/prompt-builder.ts";
export { trimTimelineForFork } from "../lib/session-worker/fork-timeline.ts";
export { processChunked } from "../lib/session-worker/chunked-runner.ts";

export { runProcess } from "../lib/driver/process-driver.ts";
export type { ProcessResult, RunProcessOptions } from "../lib/driver/process-driver.ts";
export { processDispatcherEntry } from "../lib/driver/dispatcher-entry.ts";

const sessionProcess = define({
  name: "process",
  description: "Process one item from the queue",
  run: async () => {
    await runProcess();
  },
});

export default sessionProcess;
