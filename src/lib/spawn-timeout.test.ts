import { describe, expect, test } from 'bun:test'
import { spawnWithTimeout, SpawnTimeoutError } from './spawn-timeout.ts'

describe('spawnWithTimeout', () => {
  test('returns stdout and stderr on success', async () => {
    const result = await spawnWithTimeout({
      cmd: ['echo', 'hello'],
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
  })

  test('captures stderr', async () => {
    const result = await spawnWithTimeout({
      cmd: ['bash', '-c', 'echo err >&2; exit 0'],
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.trim()).toBe('err')
  })

  test('returns non-zero exit code without throwing', async () => {
    const result = await spawnWithTimeout({
      cmd: ['bash', '-c', 'exit 42'],
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(42)
  })

  test('throws SpawnTimeoutError when process exceeds timeout', async () => {
    try {
      await spawnWithTimeout({
        cmd: ['sleep', '60'],
        timeoutMs: 100,
      })
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnTimeoutError)
      expect((err as SpawnTimeoutError).timeoutMs).toBe(100)
    }
  })

  test('kills the process on timeout', async () => {
    const start = Date.now()
    try {
      await spawnWithTimeout({
        cmd: ['sleep', '60'],
        timeoutMs: 200,
      })
    } catch {
      // expected
    }
    const elapsed = Date.now() - start
    // Should complete quickly after timeout, not wait for sleep to finish
    expect(elapsed).toBeLessThan(2000)
  })

  test('SpawnTimeoutError is an instance of Error', () => {
    const err = new SpawnTimeoutError(5000)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('SpawnTimeoutError')
    expect(err.timeoutMs).toBe(5000)
  })

  test('SpawnTimeoutError message contains timeoutMs', () => {
    const err = new SpawnTimeoutError(3000)
    expect(err.message).toContain('3000')
  })
})
