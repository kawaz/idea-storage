import { define } from 'gunshi'
import { join } from 'node:path'
import { runEnqueue } from './session-enqueue.ts'
import { runProcess } from './session-process.ts'
import { acquireLock } from '../lib/lockfile.ts'
import { getStateDir } from '../lib/paths.ts'
import { CliError } from '../lib/errors.ts'
import { log, logError } from '../lib/logging.ts'

/** Default per-task timeout: 25 minutes (generous margin; no need to rush) */
export const DEFAULT_TASK_TIMEOUT_MS = 25 * 60 * 1000

/** Default overall timeout: 45 minutes */
export const DEFAULT_OVERALL_TIMEOUT_MS = 45 * 60 * 1000

export class OverallTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`session run timed out after ${timeoutMs}ms`)
    this.name = 'OverallTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/**
 * Run an async function with an overall timeout.
 * The callback receives an AbortSignal that is aborted when the timeout fires.
 * Throws OverallTimeoutError if the timeout is reached.
 */
export async function runWithOverallTimeout(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let abortHandler: (() => void) | null = null
  try {
    const work = fn(controller.signal)
    const timeout = new Promise<never>((_, reject) => {
      abortHandler = () => reject(new OverallTimeoutError(timeoutMs))
      controller.signal.addEventListener('abort', abortHandler)
    })
    await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
    if (abortHandler) {
      controller.signal.removeEventListener('abort', abortHandler)
    }
  }
}

/** Required external commands and their install instructions. */
const REQUIRED_DEPS: ReadonlyArray<{ cmd: string; installHint: string }> = [
  { cmd: 'claude-session-analysis', installHint: 'npm i -g claude-session-analysis' },
  { cmd: 'claude', installHint: 'npm i -g @anthropic-ai/claude-code' },
]

/**
 * Check that required external commands are available in PATH.
 * Returns an array of error messages for missing commands (empty if all found).
 *
 * @param whichFn - lookup function (defaults to Bun.which). Accepts command name, returns path or null.
 */
export function checkDependencies(
  whichFn: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
): string[] {
  const errors: string[] = []
  for (const dep of REQUIRED_DEPS) {
    if (!whichFn(dep.cmd)) {
      errors.push(`${dep.cmd} is not installed. Install it with: ${dep.installHint}`)
    }
  }
  return errors
}

const sessionRun = define({
  name: 'run',
  description: 'Enqueue sessions then process until queue is empty',
  run: async () => {
    // Check required external commands before doing anything
    const depErrors = checkDependencies()
    if (depErrors.length > 0) {
      throw new CliError(depErrors.join('\n'))
    }

    const lockPath = join(getStateDir(), 'session-run.lock')
    const release = await acquireLock(lockPath)
    if (!release) {
      log({ msg: 'lock_held', lockPath })
      return
    }

    const overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS
    const taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS

    try {
      await runWithOverallTimeout(overallTimeoutMs, async (signal) => {
        await runEnqueue()

        while (!signal.aborted && await runProcess({ taskTimeoutMs, signal })) {
          // continue processing
        }
      })
    } catch (err) {
      if (err instanceof OverallTimeoutError) {
        logError({ msg: 'overall_timeout', timeoutMs: overallTimeoutMs })
        process.exitCode = 1
      } else if (err instanceof CliError) {
        console.error(`Error: ${err.message}`)
        process.exitCode = err.exitCode
      } else {
        throw err
      }
    } finally {
      await release()
    }
  },
})

export default sessionRun
