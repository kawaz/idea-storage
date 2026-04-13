import { define } from "gunshi";
import { retry } from "../lib/queue.ts";
import { exitWithError } from "../lib/errors.ts";

const sessionRetry = define({
  name: "retry",
  description: "Retry a failed session",
  run: async (ctx) => {
    const key = ctx.positionals[ctx.commandPath.length];
    if (!key) {
      exitWithError("Usage: idea-storage session retry <session-id.recipe-name>");
    }
    try {
      await retry(key);
      console.log(`Moved to queue: ${key}`);
    } catch (err) {
      exitWithError(err);
    }
  },
});

export default sessionRetry;
