import { define } from 'gunshi'
import { join } from 'node:path'
import { runEnqueue } from './session-enqueue.ts'
import { runProcess } from './session-process.ts'
import { acquireLock } from '../lib/lockfile.ts'
import { getStateDir } from '../lib/paths.ts'
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

const sessionRun = define({
  name: 'run',
  description: 'Enqueue sessions then process until queue is empty',
  run: async () => {
    const lockPath = join(getStateDir(), 'session-run.lock')
    const release = await acquireLock(lockPath)
    if (!release) {
      log({ msg: 'lock_held', lockPath })
      process.exit(0)
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
        process.exit(1)
      }
      throw err
    } finally {
      await release()
    }
  },
})

export default sessionRun
