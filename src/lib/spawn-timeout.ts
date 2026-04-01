export class SpawnTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`subprocess timed out after ${timeoutMs}ms`)
    this.name = 'SpawnTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export interface SpawnWithTimeoutOptions {
  cmd: string[]
  timeoutMs: number
}

export interface SpawnResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Spawn a subprocess with a timeout.
 * If the process does not exit within timeoutMs, it is killed and SpawnTimeoutError is thrown.
 */
export async function spawnWithTimeout(options: SpawnWithTimeoutOptions): Promise<SpawnResult> {
  const { cmd, timeoutMs } = options

  const proc = Bun.spawn(cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()

  let timerId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new SpawnTimeoutError(timeoutMs)), timeoutMs)
  })

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise])
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    return { stdout, stderr, exitCode }
  } catch (err) {
    if (err instanceof SpawnTimeoutError) {
      proc.kill()
      // Drain streams to avoid resource leaks
      await Promise.allSettled([stdoutPromise, stderrPromise, proc.exited])
      throw err
    }
    throw err
  } finally {
    clearTimeout(timerId!)
  }
}
