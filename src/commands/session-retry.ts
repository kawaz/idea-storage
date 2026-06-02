import { define } from "gunshi";
import { retry, formatLogKey } from "../lib/queue/queue.ts";
import { CliError, errorMessage } from "../lib/errors.ts";
import { assertCliRecipeName, assertCliSessionId } from "../lib/validate.ts";

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
      throw new CliError("Both --session and --recipe are required");
    }

    try {
      assertCliSessionId(sessionId);
      assertCliRecipeName(recipeName);
      await retry(sessionId, recipeName);
      console.log(`Moved to queue: ${formatLogKey(sessionId, recipeName)}`);
    } catch (err) {
      throw err instanceof CliError ? err : new CliError(errorMessage(err));
    }
  },
});

export default sessionRetry;
