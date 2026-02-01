/**
 * Shared error handling utilities for CLI commands.
 */

/** Extract a human-readable message from an unknown error value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Print an error message to stderr and exit with code 1.
 * Accepts either an Error/unknown (formatted via errorMessage) or a plain string.
 */
export function exitWithError(err: unknown): never {
  const msg = typeof err === 'string' ? err : errorMessage(err)
  console.error(`Error: ${msg}`)
  process.exit(1)
}
