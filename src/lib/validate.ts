/**
 * CLI argument validators.
 *
 * These check user-facing arguments (CLI flags) and throw CliError on invalid
 * input so the CLI exits cleanly with an error message that includes the
 * offending value.
 *
 * Design rationale:
 * - queue.ts has its own validateSessionId/validateRecipeName as last-line-of-defense
 *   internal invariant checks (throw plain Error). They use a deliberately loose
 *   recipe pattern (allowing '.' and '_') because they were originally designed to
 *   accept names already on disk.
 * - CLI input is the canonical entry point for new sessions/recipes, so we apply a
 *   tighter, user-friendly pattern here: lowercase + digits + hyphen, must start
 *   with a letter. This matches the documented recipe naming convention and gives
 *   users a clear, actionable error message early.
 */

import { CliError } from "./errors.ts";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECIPE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function validateSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new CliError(`Invalid session ID: ${value}. Expected UUID format.`);
  }
}

export function validateRecipeName(value: string): void {
  if (!RECIPE_NAME_PATTERN.test(value)) {
    throw new CliError(
      `Invalid recipe name: ${value}. Expected lowercase letters, digits, hyphens (must start with letter).`,
    );
  }
}
