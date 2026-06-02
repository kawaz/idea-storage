/**
 * CLI argument validators.
 *
 * These check user-facing arguments (CLI flags) and throw CliError on invalid
 * input so the CLI exits cleanly with an error message that includes the
 * offending value.
 *
 * Design rationale (DR-0009 Phase 7 naming distinction):
 * - This module's `assertCli*` checks are the **strict** front-line gate applied
 *   to CLI inputs (lowercase + digits + hyphen, must start with a letter).
 * - `queue-internal.ts` exposes `validateStored*` as last-line-of-defense
 *   invariant checks for names already on disk (loose pattern allowing '.' and
 *   '_', throws plain Error). The two namespaces don't collide.
 */

import { CliError } from "./errors.ts";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECIPE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function assertCliSessionId(value: string): void {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new CliError(`Invalid session ID: ${value}. Expected UUID format.`);
  }
}

export function assertCliRecipeName(value: string): void {
  if (!RECIPE_NAME_PATTERN.test(value)) {
    throw new CliError(
      `Invalid recipe name: ${value}. Expected lowercase letters, digits, hyphens (must start with letter).`,
    );
  }
}
