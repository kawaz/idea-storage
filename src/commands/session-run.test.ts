import { describe, expect, test } from 'bun:test'
import { checkDependencies, DEFAULT_TASK_TIMEOUT_MS, MAX_CONSECUTIVE_FAILURES, OVERALL_TIMEOUT_MS } from './session-run.ts'
import { CliError } from '../lib/errors.ts'

describe('session-run constants', () => {
  test('MAX_CONSECUTIVE_FAILURES は 5', () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(5)
  })

  test('OVERALL_TIMEOUT_MS は 50分で StartInterval(60分) より短い', () => {
    expect(OVERALL_TIMEOUT_MS).toBe(50 * 60 * 1000)
    expect(OVERALL_TIMEOUT_MS).toBeLessThan(60 * 60 * 1000) // StartInterval
  })

  test('DEFAULT_TASK_TIMEOUT_MS は 25分', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(25 * 60 * 1000)
  })
})

describe('checkDependencies', () => {
  test('claude-session-analysis が見つからない場合にインストール案内付きエラーを返す', () => {
    const errors = checkDependencies((cmd) => {
      if (cmd === 'claude-session-analysis') return null
      return `/usr/local/bin/${cmd}`
    })

    expect(errors.length).toBeGreaterThanOrEqual(1)
    const csaError = errors.find(e => e.includes('claude-session-analysis'))
    expect(csaError).toBeDefined()
    expect(csaError).toContain('npm i -g claude-session-analysis')
  })

  test('claude が見つからない場合にインストール案内付きエラーを返す', () => {
    const errors = checkDependencies((cmd) => {
      if (cmd === 'claude') return null
      return `/usr/local/bin/${cmd}`
    })

    expect(errors.length).toBeGreaterThanOrEqual(1)
    const claudeError = errors.find(e => e.includes('claude'))
    expect(claudeError).toBeDefined()
    expect(claudeError).toContain('@anthropic-ai/claude-code')
  })

  test('両方見つからない場合に2つのエラーを返す', () => {
    const errors = checkDependencies(() => null)
    expect(errors).toHaveLength(2)
  })

  test('両方見つかる場合は空配列を返す', () => {
    const errors = checkDependencies((cmd) => `/usr/local/bin/${cmd}`)
    expect(errors).toHaveLength(0)
  })
})

describe('session run: lock release on errors', () => {
  test('CliError: finally executes (simulating lock release)', async () => {
    const releaseLog: string[] = []
    const mockRelease = async () => { releaseLog.push('released') }

    const savedExitCode = process.exitCode
    try {
      throw new CliError('no recipes found')
    } catch (err) {
      if (err instanceof CliError) {
        process.exitCode = err.exitCode
      } else {
        throw err
      }
    } finally {
      await mockRelease()
    }

    expect(releaseLog).toEqual(['released'])
    expect(process.exitCode).toBe(1)
    process.exitCode = savedExitCode
  })

  test('unknown error: re-thrown but finally still executes', async () => {
    const releaseLog: string[] = []
    const mockRelease = async () => { releaseLog.push('released') }

    try {
      try {
        throw new Error('unexpected')
      } catch (err) {
        if (err instanceof CliError) {
          process.exitCode = err.exitCode
        } else {
          throw err
        }
      } finally {
        await mockRelease()
      }
    } catch (err) {
      expect((err as Error).message).toBe('unexpected')
    }

    expect(releaseLog).toEqual(['released'])
  })

  test('checkDependencies returns error strings that CliError can wrap', () => {
    const depErrors = checkDependencies(() => null)
    expect(depErrors.length).toBeGreaterThan(0)

    let finallyCalled = false
    try {
      throw new CliError(depErrors.join('\n'))
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
    } finally {
      finallyCalled = true
    }
    expect(finallyCalled).toBe(true)
  })
})
