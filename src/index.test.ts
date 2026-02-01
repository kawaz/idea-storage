import { describe, test, expect } from 'bun:test'

const CLI = new URL('./index.ts', import.meta.url).pathname

async function run(...args: string[]) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

describe('CLI E2E', () => {
  test('引数なしでヘルプを表示', async () => {
    const result = await run()
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('COMMANDS')
  })

  test('--help でヘルプを表示', async () => {
    const result = await run('--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('COMMANDS')
  })

  test('session 引数なしでサブコマンド一覧を表示', async () => {
    const result = await run('session')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('COMMANDS')
  })

  test('session status でステータスを表示', async () => {
    const result = await run('session', 'status')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Queued:.*Done:.*Failed:/)
  })

  test('session --help でヘルプを表示', async () => {
    const result = await run('session', '--help')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('COMMANDS')
  })

  test('不明なコマンドでエラー', async () => {
    const result = await run('nonexistent-command')
    expect(result.exitCode).not.toBe(0)
  })

  test('extract 引数なしでエラー', async () => {
    const result = await run('extract')
    expect(result.exitCode).not.toBe(0)
  })
})
