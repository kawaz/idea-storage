import { define } from "gunshi";
import { formatBailedDirsError, runEnqueue } from "../lib/driver/enqueue-driver.ts";
import { CliError } from "../lib/errors.ts";

// --- Re-exports for backwards compatibility ---
// The driver body moved to src/lib/driver/enqueue-driver.ts in DR-0009
// Phase 3 step 3-d. Tests / session-run import runEnqueue from here, so
// we re-export until step 3-g retires this command file.
export { runEnqueue } from "../lib/driver/enqueue-driver.ts";

const sessionEnqueue = define({
  name: "enqueue",
  description: "Find sessions and add to queue",
  run: async () => {
    const { bailedDirs } = await runEnqueue();
    // 単発コマンドは enqueue の部分失敗をその場で fail として報告する。
    if (bailedDirs.length > 0) {
      throw new CliError(formatBailedDirsError(bailedDirs));
    }
  },
});

export default sessionEnqueue;
