import { cli, define } from "gunshi";
import { showHelp } from "./lib/help.ts";
import { CliError } from "./lib/errors.ts";
import session from "./commands/session.ts";
import extract from "./commands/extract.ts";
import service from "./commands/service.ts";
import article from "./commands/article.ts";

const subCommands = {
  session,
  extract,
  service,
  article,
};

const main = define({
  name: "idea-storage",
  description: "Transform Claude Code session histories into articles via AI recipes",
  subCommands,
  run: async (ctx) => {
    await showHelp(ctx as Parameters<typeof showHelp>[0]);
  },
});

try {
  await cli(process.argv.slice(2), main, {
    name: "idea-storage",
    version: "0.1.0",
    subCommands,
    renderHeader: async () => "",
    // gunshi's default validation rendering prints to stdout and exits with code 0.
    // For required-positional violations etc., emit to stderr and exit non-zero so
    // callers (CI, shell scripts) can detect failures.
    renderValidationErrors: async (_ctx, error) => {
      const messages = error.errors.map((e) => e.message);
      for (const msg of messages) {
        console.error(`Error: ${msg}`);
      }
      process.exit(1);
    },
  });
} catch (err) {
  // DR-0009 Phase 7: top-level CliError handler. Commands throw CliError
  // instead of calling process.exit() so caller `finally` blocks (lock
  // release, db.close, etc.) run before exit. Other errors re-throw for
  // bun's default crash handling (= visible stack trace).
  if (err instanceof CliError) {
    console.error(`Error: ${err.message}`);
    process.exit(err.exitCode);
  }
  throw err;
}
