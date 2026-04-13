import { describe, expect, test } from 'bun:test'
import { buildClaudeArgs, buildClaudeEnv, runClaude, ClaudeTimeoutError, ClaudeAbortError, extractResultFromJsonOutput } from './claude-runner.ts'
import type { ClaudeRunOptions } from './claude-runner.ts'

describe('claude-runner', () => {
  describe('buildClaudeArgs', () => {
    test('builds basic args with prompt and default flags', () => {
      const options: ClaudeRunOptions = { prompt: 'Hello world' }
      const args = buildClaudeArgs(options)
      expect(args).toEqual([
        'claude',
        '-p',
        'Hello world',
        '--no-session-persistence',
        '--tools',
        '',
      ])
    })

    test('never includes --dangerously-skip-permissions', () => {
      const options: ClaudeRunOptions = { prompt: 'test' }
      const args = buildClaudeArgs(options)
      expect(args).not.toContain('--dangerously-skip-permissions')
    })

    test('uses --tools "" by default to disable all tools', () => {
      const options: ClaudeRunOptions = { prompt: 'test' }
      const args = buildClaudeArgs(options)
      const toolsIdx = args.indexOf('--tools')
      expect(toolsIdx).toBeGreaterThan(-1)
      expect(args[toolsIdx + 1]).toBe('')
    })

    test('uses custom allowedTools when specified', () => {
      const options: ClaudeRunOptions = {
        prompt: 'test',
        allowedTools: ['Read', 'Bash(git:*)'],
      }
      const args = buildClaudeArgs(options)
      expect(args).not.toContain('--tools')
      const allowedIdx = args.indexOf('--allowedTools')
      expect(allowedIdx).toBeGreaterThan(-1)
      expect(args[allowedIdx + 1]).toBe('Read,Bash(git:*)')
    })

    test('includes --add-dir when addDir is specified', () => {
      const options: ClaudeRunOptions = {
        prompt: 'Generate diary',
        addDir: '/tmp/data',
      }
      const args = buildClaudeArgs(options)
      expect(args).toContain('--add-dir')
      expect(args).toContain('/tmp/data')
      // --add-dir should come before --no-session-persistence
      const addDirIdx = args.indexOf('--add-dir')
      const noSessionIdx = args.indexOf('--no-session-persistence')
      expect(addDirIdx).toBeLessThan(noSessionIdx)
    })

    test('omits --no-session-persistence when sessionPersistence is true', () => {
      const options: ClaudeRunOptions = {
        prompt: 'test',
        sessionPersistence: true,
      }
      const args = buildClaudeArgs(options)
      expect(args).not.toContain('--no-session-persistence')
    })

    test('includes --no-session-persistence by default (sessionPersistence false)', () => {
      const options: ClaudeRunOptions = { prompt: 'test' }
      const args = buildClaudeArgs(options)
      expect(args).toContain('--no-session-persistence')
    })

    test('allowedTools overrides default --tools ""', () => {
      const withAllowed = buildClaudeArgs({
        prompt: 'test',
        allowedTools: ['Edit'],
      })
      expect(withAllowed).not.toContain('--tools')
      expect(withAllowed).toContain('--allowedTools')

      const withoutAllowed = buildClaudeArgs({ prompt: 'test' })
      expect(withoutAllowed).toContain('--tools')
      expect(withoutAllowed).not.toContain('--allowedTools')
    })

    test('handles all options combined', () => {
      const options: ClaudeRunOptions = {
        prompt: 'full test',
        addDir: '/my/dir',
        sessionPersistence: false,
        allowedTools: ['Read', 'Bash(git:*)'],
      }
      const args = buildClaudeArgs(options)
      expect(args).toEqual([
        'claude',
        '-p',
        'full test',
        '--add-dir',
        '/my/dir',
        '--no-session-persistence',
        '--allowedTools',
        'Read,Bash(git:*)',
      ])
    })

    test('handles all options combined with default tools (no allowedTools)', () => {
      const options: ClaudeRunOptions = {
        prompt: 'full test',
        addDir: '/my/dir',
        sessionPersistence: false,
      }
      const args = buildClaudeArgs(options)
      expect(args).toEqual([
        'claude',
        '-p',
        'full test',
        '--add-dir',
        '/my/dir',
        '--no-session-persistence',
        '--tools',
        '',
      ])
    })

    test('captureUsage: true adds --output-format json', () => {
      const args = buildClaudeArgs({ prompt: 'test', captureUsage: true })
      const idx = args.indexOf('--output-format')
      expect(idx).toBeGreaterThan(-1)
      expect(args[idx + 1]).toBe('json')
    })

    test('captureUsage: false (default) omits --output-format', () => {
      const args = buildClaudeArgs({ prompt: 'test' })
      expect(args).not.toContain('--output-format')
    })
  })

  describe('buildClaudeEnv', () => {
    test('excludes CLAUDECODE from environment', () => {
      const originalEnv = process.env.CLAUDECODE
      process.env.CLAUDECODE = 'some-value'
      try {
        const env = buildClaudeEnv()
        expect(env.CLAUDECODE).toBeUndefined()
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDECODE = originalEnv
        } else {
          delete process.env.CLAUDECODE
        }
      }
    })

    test('preserves other environment variables', () => {
      const env = buildClaudeEnv()
      expect(env.HOME).toBe(process.env.HOME)
      expect(env.PATH).toBe(process.env.PATH)
    })

    test('works when CLAUDECODE is not set', () => {
      const originalEnv = process.env.CLAUDECODE
      delete process.env.CLAUDECODE
      try {
        const env = buildClaudeEnv()
        expect(env.CLAUDECODE).toBeUndefined()
        expect(env.HOME).toBe(process.env.HOME)
      } finally {
        if (originalEnv !== undefined) {
          process.env.CLAUDECODE = originalEnv
        }
      }
    })

    test('captureUsage: true sets ANTHROPIC_LOG=debug', () => {
      const env = buildClaudeEnv({ captureUsage: true })
      expect(env.ANTHROPIC_LOG).toBe('debug')
    })

    test('captureUsage: false (default) does not set ANTHROPIC_LOG', () => {
      const originalLog = process.env.ANTHROPIC_LOG
      delete process.env.ANTHROPIC_LOG
      try {
        const env = buildClaudeEnv()
        expect(env.ANTHROPIC_LOG).toBeUndefined()
      } finally {
        if (originalLog !== undefined) process.env.ANTHROPIC_LOG = originalLog
      }
    })
  })

  describe('extractResultFromJsonOutput', () => {
    test('extracts .result from a JSON object line', () => {
      const input = `some debug log
more debug
{"type":"result","subtype":"success","is_error":false,"result":"hello world","usage":{}}`
      expect(extractResultFromJsonOutput(input)).toBe('hello world')
    })

    test('picks the LAST JSON result line even if there is earlier JSON-looking content', () => {
      const input = `[log_abc] response parsed { url: "..." }
{"type":"result","result":"final answer"}`
      expect(extractResultFromJsonOutput(input)).toBe('final answer')
    })

    test('returns null when no valid result JSON found', () => {
      expect(extractResultFromJsonOutput('no json here')).toBeNull()
      expect(extractResultFromJsonOutput('')).toBeNull()
    })

    test('handles multi-line debug then trailing JSON', () => {
      const input = `[log_1] sending request {
  method: "post",
  url: "..."
}
[log_1] response parsed { status: 200 }
{"type":"result","subtype":"success","result":"ok"}
`
      expect(extractResultFromJsonOutput(input)).toBe('ok')
    })
  })

  describe('ClaudeTimeoutError', () => {
    test('is an instance of Error', () => {
      const err = new ClaudeTimeoutError(10000)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('ClaudeTimeoutError')
    })

    test('contains timeoutMs in message', () => {
      const err = new ClaudeTimeoutError(60000)
      expect(err.message).toContain('60000')
    })

    test('exposes timeoutMs property', () => {
      const err = new ClaudeTimeoutError(30000)
      expect(err.timeoutMs).toBe(30000)
    })
  })

  describe('runClaude with timeoutMs', () => {
    test('completes normally when process finishes before timeout', async () => {
      const result = await runClaude({
        prompt: 'unused',
        timeoutMs: 5000,
        _spawnOverride: () => {
          const proc = Bun.spawn(['echo', 'hello'], { stdout: 'pipe', stderr: 'pipe' })
          return proc
        },
      })
      expect(result.trim()).toBe('hello')
    })

    test('throws ClaudeTimeoutError when process exceeds timeout', async () => {
      try {
        await runClaude({
          prompt: 'unused',
          timeoutMs: 100,
          _spawnOverride: () => {
            // sleep for 10 seconds -- will be killed by timeout
            const proc = Bun.spawn(['sleep', '10'], { stdout: 'pipe', stderr: 'pipe' })
            return proc
          },
        })
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ClaudeTimeoutError)
        expect((err as ClaudeTimeoutError).timeoutMs).toBe(100)
      }
    })

    test('kills the child process on timeout', async () => {
      let spawnedProc: ReturnType<typeof Bun.spawn> | null = null
      try {
        await runClaude({
          prompt: 'unused',
          timeoutMs: 100,
          _spawnOverride: () => {
            spawnedProc = Bun.spawn(['sleep', '10'], { stdout: 'pipe', stderr: 'pipe' })
            return spawnedProc
          },
        })
      } catch {
        // expected
      }
      // Process should have been killed -- exitCode should be non-null after kill
      expect(spawnedProc).not.toBeNull()
      // Give a moment for the process to be cleaned up
      const exitCode = await spawnedProc!.exited
      // Killed process should have a non-zero exit code (signal)
      expect(exitCode).not.toBe(0)
    })

    test('works without timeoutMs (no timeout)', async () => {
      const result = await runClaude({
        prompt: 'unused',
        _spawnOverride: () => {
          const proc = Bun.spawn(['echo', 'no-timeout'], { stdout: 'pipe', stderr: 'pipe' })
          return proc
        },
      })
      expect(result.trim()).toBe('no-timeout')
    })
  })

  describe('runClaude with signal (AbortSignal)', () => {
    test('completes normally when signal is not aborted', async () => {
      const controller = new AbortController()
      const result = await runClaude({
        prompt: 'unused',
        signal: controller.signal,
        _spawnOverride: () => {
          return Bun.spawn(['echo', 'ok'], { stdout: 'pipe', stderr: 'pipe' })
        },
      })
      expect(result.trim()).toBe('ok')
    })

    test('throws ClaudeAbortError when signal is aborted during execution', async () => {
      const controller = new AbortController()
      // Abort after 50ms
      setTimeout(() => controller.abort(), 50)

      try {
        await runClaude({
          prompt: 'unused',
          signal: controller.signal,
          _spawnOverride: () => {
            return Bun.spawn(['sleep', '10'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ClaudeAbortError)
      }
    })

    test('kills the child process when signal is aborted', async () => {
      const controller = new AbortController()
      let spawnedProc: ReturnType<typeof Bun.spawn> | null = null

      setTimeout(() => controller.abort(), 50)

      try {
        await runClaude({
          prompt: 'unused',
          signal: controller.signal,
          _spawnOverride: () => {
            spawnedProc = Bun.spawn(['sleep', '10'], { stdout: 'pipe', stderr: 'pipe' })
            return spawnedProc
          },
        })
      } catch {
        // expected
      }

      expect(spawnedProc).not.toBeNull()
      const exitCode = await spawnedProc!.exited
      expect(exitCode).not.toBe(0)
    })

    test('throws ClaudeAbortError immediately when signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      try {
        await runClaude({
          prompt: 'unused',
          signal: controller.signal,
          _spawnOverride: () => {
            return Bun.spawn(['echo', 'should-not-run'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(true).toBe(false) // should not reach here
      } catch (err) {
        expect(err).toBeInstanceOf(ClaudeAbortError)
      }
    })

    test('timeout takes priority over signal when timeout fires first', async () => {
      const controller = new AbortController()
      // Signal aborts after 500ms, timeout is 100ms -- timeout fires first
      setTimeout(() => controller.abort(), 500)

      try {
        await runClaude({
          prompt: 'unused',
          timeoutMs: 100,
          signal: controller.signal,
          _spawnOverride: () => {
            return Bun.spawn(['sleep', '10'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(ClaudeTimeoutError)
      }
    })

    test('signal takes priority over timeout when signal fires first', async () => {
      const controller = new AbortController()
      // Signal aborts after 50ms, timeout is 5000ms -- signal fires first
      setTimeout(() => controller.abort(), 50)

      try {
        await runClaude({
          prompt: 'unused',
          timeoutMs: 5000,
          signal: controller.signal,
          _spawnOverride: () => {
            return Bun.spawn(['sleep', '10'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(true).toBe(false)
      } catch (err) {
        expect(err).toBeInstanceOf(ClaudeAbortError)
      }
    })
  })

  describe('runClaude timer/promise cleanup', () => {
    test('timeout timer is cleared after normal completion (no unhandled rejection)', async () => {
      // Track unhandled rejections during this test
      const rejections: unknown[] = []
      const handler = (event: PromiseRejectionEvent) => {
        rejections.push(event.reason)
        event.preventDefault()
      }
      globalThis.addEventListener('unhandledrejection', handler)

      try {
        // Use a short timeout so the timer would fire quickly if not cleared
        const result = await runClaude({
          prompt: 'unused',
          timeoutMs: 200,
          _spawnOverride: () => {
            return Bun.spawn(['echo', 'fast'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(result.trim()).toBe('fast')

        // Wait longer than the timeout to ensure no unhandled rejection fires
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(rejections).toEqual([])
      } finally {
        globalThis.removeEventListener('unhandledrejection', handler)
      }
    })

    test('abort listener is cleaned up after normal completion (no unhandled rejection)', async () => {
      const rejections: unknown[] = []
      const handler = (event: PromiseRejectionEvent) => {
        rejections.push(event.reason)
        event.preventDefault()
      }
      globalThis.addEventListener('unhandledrejection', handler)

      try {
        const controller = new AbortController()
        const result = await runClaude({
          prompt: 'unused',
          signal: controller.signal,
          _spawnOverride: () => {
            return Bun.spawn(['echo', 'done'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(result.trim()).toBe('done')

        // Aborting after completion should not cause unhandled rejection
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(rejections).toEqual([])
      } finally {
        globalThis.removeEventListener('unhandledrejection', handler)
      }
    })

    test('both timeout timer and abort listener are cleaned up after normal completion', async () => {
      const rejections: unknown[] = []
      const handler = (event: PromiseRejectionEvent) => {
        rejections.push(event.reason)
        event.preventDefault()
      }
      globalThis.addEventListener('unhandledrejection', handler)

      try {
        const controller = new AbortController()
        const result = await runClaude({
          prompt: 'unused',
          timeoutMs: 200,
          signal: controller.signal,
          _spawnOverride: () => {
            return Bun.spawn(['echo', 'both'], { stdout: 'pipe', stderr: 'pipe' })
          },
        })
        expect(result.trim()).toBe('both')

        // Trigger both: abort the signal and wait past the timeout
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(rejections).toEqual([])
      } finally {
        globalThis.removeEventListener('unhandledrejection', handler)
      }
    })
  })

  describe('runClaude with captureUsage: end-to-end', () => {
    // Simulated stdout: mixed ANTHROPIC_LOG=debug output + final result JSON
    const fakeStdout = `[log_abc] sending request {
  method: "post",
  url: "https://api.anthropic.com/v1/messages",
}
[log_abc] response headers {
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-5h-reset": "1776056400",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.08",
  "anthropic-ratelimit-unified-7d-reset": "1776646800",
  "anthropic-ratelimit-unified-7d-status": "allowed",
}
{"type":"result","subtype":"success","is_error":false,"result":"ok","usage":{}}
`

    test('extracts headers via onUsageObserved callback and returns .result', async () => {
      const observations: unknown[] = []

      const result = await runClaude({
        prompt: 'test',
        captureUsage: true,
        onUsageObserved: (obs) => observations.push(obs),
        _spawnOverride: () => {
          // Use printf to emit the fake stdout verbatim
          return Bun.spawn(['printf', '%s', fakeStdout], { stdout: 'pipe', stderr: 'pipe' })
        },
      })

      // Return value is .result from the trailing JSON line
      expect(result).toBe('ok')

      // onUsageObserved was called exactly once with parsed headers
      expect(observations).toHaveLength(1)
      expect(observations[0]).toEqual({
        fiveHour: { util: 0.42, reset: 1776056400, status: 'allowed' },
        sevenDay: { util: 0.08, reset: 1776646800, status: 'allowed' },
      })
    })

    test('does not invoke onUsageObserved when no rate_limit headers present', async () => {
      const observations: unknown[] = []
      const justResult = `{"type":"result","subtype":"success","is_error":false,"result":"bare","usage":{}}\n`

      const result = await runClaude({
        prompt: 'test',
        captureUsage: true,
        onUsageObserved: (obs) => observations.push(obs),
        _spawnOverride: () => {
          return Bun.spawn(['printf', '%s', justResult], { stdout: 'pipe', stderr: 'pipe' })
        },
      })

      expect(result).toBe('bare')
      expect(observations).toEqual([])
    })

    test('onUsageObserved errors do not break the pipeline (best-effort)', async () => {
      const result = await runClaude({
        prompt: 'test',
        captureUsage: true,
        onUsageObserved: () => {
          throw new Error('simulated callback failure')
        },
        _spawnOverride: () => {
          return Bun.spawn(['printf', '%s', fakeStdout], { stdout: 'pipe', stderr: 'pipe' })
        },
      })
      // Still returns .result even though callback threw
      expect(result).toBe('ok')
    })

    test('falls back to raw stdout when JSON result line cannot be found', async () => {
      const brokenOutput = `some garbage\nno JSON here at all\n`
      const result = await runClaude({
        prompt: 'test',
        captureUsage: true,
        _spawnOverride: () => {
          return Bun.spawn(['printf', '%s', brokenOutput], { stdout: 'pipe', stderr: 'pipe' })
        },
      })
      // Fallback: return raw stdout instead of throwing/returning empty
      expect(result).toBe(brokenOutput)
    })
  })
})
