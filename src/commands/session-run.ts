import { define } from 'gunshi'
import { runEnqueue } from './session-enqueue.ts'
import { runProcess } from './session-process.ts'
import { log, logError } from '../lib/logging.ts'

/** Default per-task timeout: 12 minutes (p99=7.2min, max observed=11.5min) */
export const DEFAULT_TASK_TIMEOUT_MS = 12 * 60 * 1000

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

  try {
    const work = fn(controller.signal)
    const timeout = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new OverallTimeoutError(timeoutMs))
      })
    })
    await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const sessionRun = define({
  name: 'run',
  description: 'Enqueue sessions then process until queue is empty',
  run: async () => {
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
    }
  },
})

export default sessionRun
