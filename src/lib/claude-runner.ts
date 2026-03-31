export class ClaudeTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`claude process timed out after ${timeoutMs}ms`)
    this.name = 'ClaudeTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class ClaudeAbortError extends Error {
  constructor() {
    super('claude process was aborted')
    this.name = 'ClaudeAbortError'
  }
}

export interface ClaudeRunOptions {
  prompt: string
  addDir?: string
  sessionPersistence?: boolean // default false
  dangerouslySkipPermissions?: boolean // default true
  /** Per-task timeout in milliseconds. No timeout if omitted. */
  timeoutMs?: number
  /** AbortSignal to cancel the process externally. */
  signal?: AbortSignal
  /** @internal Override spawn for testing */
  _spawnOverride?: () => ReturnType<typeof Bun.spawn>
}

export function buildClaudeArgs(options: ClaudeRunOptions): string[] {
  const args: string[] = ['claude', '-p', options.prompt]

  if (options.addDir) {
    args.push('--add-dir', options.addDir)
  }

  if (options.sessionPersistence !== true) {
    args.push('--no-session-persistence')
  }

  if (options.dangerouslySkipPermissions !== false) {
    args.push('--dangerously-skip-permissions')
  }

  return args
}

export function buildClaudeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE') continue
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

export async function runClaude(options: ClaudeRunOptions): Promise<string> {
  // Check if already aborted before spawning
  if (options.signal?.aborted) {
    throw new ClaudeAbortError()
  }

  const proc = options._spawnOverride
    ? options._spawnOverride()
    : Bun.spawn(buildClaudeArgs(options), {
        env: buildClaudeEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      })

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()

  /** Kill proc and drain streams to avoid resource leaks */
  async function killAndDrain(): Promise<void> {
    proc.kill()
    await Promise.allSettled([stdoutPromise, stderrPromise, proc.exited])
  }

  // Build race competitors
  const racePromises: Promise<number | never>[] = [proc.exited]

  if (options.timeoutMs != null) {
    const timeoutMs = options.timeoutMs
    racePromises.push(
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new ClaudeTimeoutError(timeoutMs)), timeoutMs)
      }),
    )
  }

  if (options.signal) {
    const signal = options.signal
    racePromises.push(
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new ClaudeAbortError())
          return
        }
        signal.addEventListener('abort', () => reject(new ClaudeAbortError()), { once: true })
      }),
    )
  }

  // If we have timeout or signal, race them
  if (racePromises.length > 1) {
    try {
      const exitCode = await Promise.race(racePromises)
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
      if (exitCode !== 0) {
        throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
      }
      return stdout
    } catch (err) {
      if (err instanceof ClaudeTimeoutError || err instanceof ClaudeAbortError) {
        await killAndDrain()
        throw err
      }
      throw err
    }
  }

  // No timeout, no signal -- simple path
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
  }

  return stdout
}
