import { define } from "gunshi";
import { CliError, errorMessage } from "../lib/errors.ts";
import { assertCliRecipeName, assertCliSessionId } from "../lib/validate.ts";
import { runConvert } from "../lib/driver/convert-driver.ts";

// --- Re-exports for backwards compatibility ---
// The driver body lives in src/lib/driver/convert-driver.ts (DR-0009 Phase 3
// step 3-d). Tests import runConvert from "./session-convert.ts", so we keep
// the re-export here. step 3-g (this commit) reduces this file to a thin
// define() wrapper; DI for the claude-runner now flows through RunConvertInput
// rather than mock.module() in the test file.
export { runConvert } from "../lib/driver/convert-driver.ts";
export type { RunConvertInput, RunConvertResult } from "../lib/driver/convert-driver.ts";

const sessionConvert = define({
  name: "convert",
  description: "Convert a specific (session, recipe) pair directly, bypassing queue order",
  args: {
    session: { type: "string", description: "Session ID (UUID)", required: true },
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
    try {
      assertCliSessionId(sessionId);
      assertCliRecipeName(recipeName);
      const result = await runConvert({ sessionId, recipeName, force });
      if (result.kind === "skipped") {
        console.error(`Skipped: ${result.reason} (lineCount=${result.lineCount})`);
      } else {
        console.log(result.outputFile);
      }
    } catch (err) {
      throw err instanceof CliError ? err : new CliError(errorMessage(err));
    }
  },
});

export default sessionConvert;
