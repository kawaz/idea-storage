import { define } from "gunshi";
import { exitWithError } from "../lib/errors.ts";
import { validateRecipeName, validateSessionId } from "../lib/validate.ts";
import { runConvert } from "../lib/driver/convert-driver.ts";

// --- Re-exports for backwards compatibility ---
// The driver body moved to src/lib/driver/convert-driver.ts in DR-0009
// Phase 3 step 3-d. Tests import { runConvert } from "./session-convert.ts",
// so we re-export here until step 3-g retires this command file.
export { runConvert } from "../lib/driver/convert-driver.ts";
export type { RunConvertInput, RunConvertResult } from "../lib/driver/convert-driver.ts";

const sessionConvert = define({
  name: "convert",
  description: "Convert a specific (session, recipe) pair directly, bypassing queue order",
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
    force: {
      type: "boolean",
      description:
        "Bypass rate-limit check (consumes shared quota; use only when explicit user intent overrides shared-quota concerns)",
    },
  },
  run: async (ctx) => {
    const sessionId = ctx.values.session as string;
    const recipeName = ctx.values.recipe as string;
    const force = (ctx.values.force as boolean | undefined) ?? false;

    if (!sessionId || !recipeName) {
      exitWithError("Both --session and --recipe are required");
    }

    try {
      validateSessionId(sessionId);
      validateRecipeName(recipeName);
      const result = await runConvert({ sessionId, recipeName, force });
      switch (result.kind) {
        case "processed":
          console.log(result.outputFile);
          break;
        case "waited":
          console.log(result.outputFile);
          break;
        case "skipped":
          console.error(`Skipped: ${result.reason} (lineCount=${result.lineCount})`);
          break;
      }
    } catch (err) {
      exitWithError(err);
    }
  },
});

export default sessionConvert;
