import { define } from 'gunshi'
import { join } from 'node:path'
import { runEnqueue } from './session-enqueue.ts'
import { runProcess } from './session-process.ts'
import { acquireLock } from '../lib/lockfile.ts'
import { getStateDir } from '../lib/paths.ts'
import { CliError } from '../lib/errors.ts'
import { log } from '../lib/logging.ts'

/** Default per-task timeout: 25 minutes */
export const DEFAULT_TASK_TIMEOUT_MS = 25 * 60 * 1000

/** Bail out after this many consecutive failures */
export const MAX_CONSECUTIVE_FAILURES = 5

/** Overall timeout: 50 minutes (must be shorter than launchd StartInterval=3600s=60min) */
export const OVERALL_TIMEOUT_MS = 50 * 60 * 1000

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

    const taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS

    try {
      await runEnqueue()

      let consecutiveFailures = 0
      const deadline = Date.now() + OVERALL_TIMEOUT_MS

      while (true) {
        if (Date.now() > deadline) {
          log({ msg: 'overall_timeout', timeoutMs: OVERALL_TIMEOUT_MS })
          break
        }

        const result = await runProcess({ taskTimeoutMs })

        if (result === 'empty') break

        if (result === 'failed') {
          consecutiveFailures++
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            log({ msg: 'bail_out', consecutiveFailures })
            break
          }
        } else {
          consecutiveFailures = 0
        }
      }
    } catch (err) {
      if (err instanceof CliError) {
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
