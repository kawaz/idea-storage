import { define } from "gunshi";
import { runEnqueue } from "../lib/driver/enqueue-driver.ts";

// --- Re-exports for backwards compatibility ---
// The driver body moved to src/lib/driver/enqueue-driver.ts in DR-0009
// Phase 3 step 3-d. Tests / session-run import runEnqueue from here, so
// we re-export until step 3-g retires this command file.
export { runEnqueue } from "../lib/driver/enqueue-driver.ts";

const sessionEnqueue = define({
  name: "enqueue",
  description: "Find sessions and add to queue",
  run: async () => {
    await runEnqueue();
  },
});

export default sessionEnqueue;
