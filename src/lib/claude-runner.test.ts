import { describe, expect, test } from 'bun:test'
import { buildClaudeArgs, buildClaudeEnv } from './claude-runner.ts'
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
})
