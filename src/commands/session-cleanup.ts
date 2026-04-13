import { define } from "gunshi";
import { cleanup } from "../lib/queue.ts";
import { loadConfig } from "../lib/config.ts";

const sessionCleanup = define({
  name: "cleanup",
  description: "Remove orphaned failed entries",
  run: async () => {
    const config = await loadConfig();

    const isSessionExists = async (sessionId: string): Promise<boolean> => {
      for (const claudeDir of config.claudeDirs) {
        const glob = new Bun.Glob("**/projects/**/*.jsonl");
        for await (const path of glob.scan(claudeDir)) {
          if (path.includes(sessionId)) {
            return true;
          }
        }
      }
      return false;
    };

    const removed = await cleanup(isSessionExists);
    console.log(`Cleaned up ${removed} entries`);
  },
});

export default sessionCleanup;
