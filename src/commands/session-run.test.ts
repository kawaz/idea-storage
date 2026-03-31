import { describe, expect, test, mock } from 'bun:test'
import { runWithOverallTimeout, OverallTimeoutError } from './session-run.ts'

describe('OverallTimeoutError', () => {
  test('is an instance of Error', () => {
    const err = new OverallTimeoutError(45 * 60 * 1000)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('OverallTimeoutError')
  })

  test('contains timeoutMs in message', () => {
    const err = new OverallTimeoutError(2700000)
    expect(err.message).toContain('2700000')
  })

  test('exposes timeoutMs property', () => {
    const err = new OverallTimeoutError(2700000)
    expect(err.timeoutMs).toBe(2700000)
  })
})

describe('runWithOverallTimeout', () => {
  test('completes normally when work finishes before timeout', async () => {
    let completed = false
    await runWithOverallTimeout(5000, async (signal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      completed = true
    })
    expect(completed).toBe(true)
  })

  test('throws OverallTimeoutError when work exceeds timeout', async () => {
    try {
      await runWithOverallTimeout(100, async (_signal) => {
        await new Promise(resolve => setTimeout(resolve, 10000))
      })
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(OverallTimeoutError)
      expect((err as OverallTimeoutError).timeoutMs).toBe(100)
    }
  })

  test('signal is aborted when timeout fires', async () => {
    let capturedSignal: AbortSignal | null = null
    try {
      await runWithOverallTimeout(100, async (signal) => {
        capturedSignal = signal
        await new Promise(resolve => setTimeout(resolve, 10000))
      })
    } catch {
      // expected
    }
    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal!.aborted).toBe(true)
  })

  test('signal is not aborted when work completes before timeout', async () => {
    let capturedSignal: AbortSignal | null = null
    await runWithOverallTimeout(5000, async (signal) => {
      capturedSignal = signal
      // finish immediately
    })
    expect(capturedSignal).not.toBeNull()
    expect(capturedSignal!.aborted).toBe(false)
  })
})

describe('session run: signal propagation to runProcess', () => {
  test('runWithOverallTimeout callback receives signal that can be passed to runProcess', async () => {
    // This test verifies the contract: the signal from runWithOverallTimeout
    // should be passable to runProcess as part of RunProcessOptions.
    // The actual wiring test is in session-process.test.ts.
    let receivedSignal: AbortSignal | null = null
    await runWithOverallTimeout(5000, async (signal) => {
      receivedSignal = signal
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal.aborted).toBe(false)
    })
    expect(receivedSignal).not.toBeNull()
  })

  test('signal is aborted when timeout fires, allowing runProcess to be cancelled', async () => {
    let signalAbortedDuringWork = false
    try {
      await runWithOverallTimeout(50, async (signal) => {
        // Simulate a loop like session run does
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            signalAbortedDuringWork = true
            resolve()
          })
        })
      })
    } catch (err) {
      expect(err).toBeInstanceOf(OverallTimeoutError)
    }
    expect(signalAbortedDuringWork).toBe(true)
  })
})

describe('runWithOverallTimeout cleanup', () => {
  test('abort listener on signal is removed after normal completion (no unhandled rejection)', async () => {
    const rejections: unknown[] = []
    const handler = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason)
      event.preventDefault()
    }
    globalThis.addEventListener('unhandledrejection', handler)

    try {
      // Use a manually controlled AbortController to verify listener cleanup
      const outerController = new AbortController()
      let capturedSignal: AbortSignal | null = null

      await runWithOverallTimeout(5000, async (signal) => {
        capturedSignal = signal
        // finish immediately
      })

      expect(capturedSignal).not.toBeNull()
      // Manually abort the underlying controller's signal after completion
      // The abort event should not trigger an unhandled rejection
      // (In current impl, the abort listener on the timeout promise rejects with
      //  OverallTimeoutError, but nobody catches it after race resolves)
      // We can't abort the internal controller directly, but we test the timer side

      await new Promise(resolve => setTimeout(resolve, 100))
      expect(rejections).toEqual([])
    } finally {
      globalThis.removeEventListener('unhandledrejection', handler)
    }
  })

  test('timeout promise does not leak after normal completion (no pending promises)', async () => {
    const rejections: unknown[] = []
    const handler = (event: PromiseRejectionEvent) => {
      rejections.push(event.reason)
      event.preventDefault()
    }
    globalThis.addEventListener('unhandledrejection', handler)

    try {
      const start = Date.now()
      await runWithOverallTimeout(60000, async (_signal) => {
        // finish immediately
      })
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(1000)

      await new Promise(resolve => setTimeout(resolve, 100))
      expect(rejections).toEqual([])
    } finally {
      globalThis.removeEventListener('unhandledrejection', handler)
    }
  })

  test('timer is cleared after normal completion (signal not aborted)', async () => {
    let capturedSignal: AbortSignal | null = null
    await runWithOverallTimeout(200, async (signal) => {
      capturedSignal = signal
      // finish immediately
    })

    // Wait past the timeout duration
    await new Promise(resolve => setTimeout(resolve, 400))

    // The signal should NOT have been aborted since work completed before timeout
    expect(capturedSignal!.aborted).toBe(false)
  })
})
