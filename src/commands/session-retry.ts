import { define } from "gunshi";
import { retry, formatLogKey } from "../lib/queue.ts";
import { exitWithError } from "../lib/errors.ts";

const sessionRetry = define({
  name: "retry",
  description: "Move a failed or skipped entry back to the queue",
  args: {
    session: {
      type: "string",
      description: "Session ID (UUID)",
      required: true,
    },
    recipe: {
      type: "string",
      description: "Recipe name (without 'recipe-' prefix)",
      required: true,
    },
  },
  run: async (ctx) => {
    const sessionId = ctx.values.session as string;
    const recipeName = ctx.values.recipe as string;

    if (!sessionId || !recipeName) {
      exitWithError("Both --session and --recipe are required");
    }

    try {
      await retry(sessionId, recipeName);
      console.log(`Moved to queue: ${formatLogKey(sessionId, recipeName)}`);
    } catch (err) {
      exitWithError(err);
    }
  },
});

export default sessionRetry;
