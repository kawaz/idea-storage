import { describe, expect, test } from 'bun:test'
import { buildClaudeArgs, buildClaudeEnv, runClaude, ClaudeTimeoutError } from './claude-runner.ts'
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
        '--dangerously-skip-permissions',
      ])
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

    test('omits --dangerously-skip-permissions when dangerouslySkipPermissions is false', () => {
      const options: ClaudeRunOptions = {
        prompt: 'test',
        dangerouslySkipPermissions: false,
      }
      const args = buildClaudeArgs(options)
      expect(args).not.toContain('--dangerously-skip-permissions')
    })

    test('includes --dangerously-skip-permissions by default', () => {
      const options: ClaudeRunOptions = { prompt: 'test' }
      const args = buildClaudeArgs(options)
      expect(args).toContain('--dangerously-skip-permissions')
    })

    test('handles all options combined', () => {
      const options: ClaudeRunOptions = {
        prompt: 'full test',
        addDir: '/my/dir',
        sessionPersistence: false,
        dangerouslySkipPermissions: true,
      }
      const args = buildClaudeArgs(options)
      expect(args).toEqual([
        'claude',
        '-p',
        'full test',
        '--add-dir',
        '/my/dir',
        '--no-session-persistence',
        '--dangerously-skip-permissions',
      ])
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
})
