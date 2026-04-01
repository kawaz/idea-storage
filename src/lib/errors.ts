/**
 * Shared error handling utilities for CLI commands.
 */

/** Extract a human-readable message from an unknown error value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * An error that represents a CLI-level failure with an exit code.
 * Throw this instead of calling process.exit() so that callers' finally blocks
 * (e.g. lock release) execute properly. Top-level CLI entry points catch this
 * and call process.exit(exitCode).
 */
export class CliError extends Error {
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
  }
}

/**
 * Print an error message to stderr and exit with code 1.
 * Accepts either an Error/unknown (formatted via errorMessage) or a plain string.
 *
 * WARNING: This calls process.exit(1) which skips finally blocks.
 * In library functions called from session-run (or any context with cleanup),
 * throw CliError instead.
 */
export function exitWithError(err: unknown): never {
  const msg = typeof err === 'string' ? err : errorMessage(err)
  console.error(`Error: ${msg}`)
  process.exit(1)
}
