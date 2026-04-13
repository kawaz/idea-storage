import { parseRateLimitHeaders, type RateLimitObservation } from './rate-limit-parser.ts'

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
  /** Whitelist of tools to allow. When omitted, all tools are disabled via --tools "". */
  allowedTools?: string[]
  /** Per-task timeout in milliseconds. No timeout if omitted. */
  timeoutMs?: number
  /** AbortSignal to cancel the process externally. */
  signal?: AbortSignal
  /**
   * When true, enable ANTHROPIC_LOG=debug and --output-format json so that
   * rate_limits response headers and a structured result can be extracted.
   * The callback `onUsageObserved` will be invoked (if provided) with any
   * rate_limit observation found in the stdout. Returned value remains the
   * response text (from `.result` field of the JSON output).
   * Default: false (legacy behavior: no debug injection, raw text stdout).
   */
  captureUsage?: boolean
  /** Called when rate_limit headers are successfully parsed from stdout. */
  onUsageObserved?: (obs: RateLimitObservation) => void
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

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowedTools', options.allowedTools.join(','))
  } else {
    args.push('--tools', '')
  }

  if (options.captureUsage) {
    args.push('--output-format', 'json')
  }

  return args
}

export function buildClaudeEnv(options?: { captureUsage?: boolean }): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE') continue
    if (value !== undefined) {
      env[key] = value
    }
  }
  if (options?.captureUsage) {
    env.ANTHROPIC_LOG = 'debug'
  }
  return env
}

/**
 * Parse a multi-line stdout string (as produced by `claude -p --output-format json`
 * potentially mixed with ANTHROPIC_LOG=debug output) and return the `.result`
 * string from the last JSON result line, or null if not found.
 *
 * Design rationale: `--output-format json` always emits a single-line JSON at
 * the end, even when debug logs pollute stdout. We walk lines from bottom up to
 * find the last parseable JSON whose `type === "result"`.
 */
export function extractResultFromJsonOutput(stdout: string): string | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && obj.type === 'result' && typeof obj.result === 'string') {
        return obj.result as string
      }
    } catch {
      // not JSON; continue
    }
  }
  return null
}

export async function runClaude(options: ClaudeRunOptions): Promise<string> {
  // Check if already aborted before spawning
  if (options.signal?.aborted) {
    throw new ClaudeAbortError()
  }

  const proc = options._spawnOverride
    ? options._spawnOverride()
    : Bun.spawn(buildClaudeArgs(options), {
        env: buildClaudeEnv({ captureUsage: options.captureUsage }),
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

  // Build race competitors with cleanup support
  const racePromises: Promise<number | never>[] = [proc.exited]
  const cleanups: (() => void)[] = []

  if (options.timeoutMs != null) {
    const timeoutMs = options.timeoutMs
    let timerId: ReturnType<typeof setTimeout>
    racePromises.push(
      new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new ClaudeTimeoutError(timeoutMs)), timeoutMs)
      }),
    )
    cleanups.push(() => clearTimeout(timerId))
  }

  if (options.signal) {
    const signal = options.signal
    racePromises.push(
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new ClaudeAbortError())
          return
        }
        const handler = () => reject(new ClaudeAbortError())
        signal.addEventListener('abort', handler, { once: true })
        cleanups.push(() => signal.removeEventListener('abort', handler))
      }),
    )
  }

  /** Run all registered cleanups to prevent timer/listener leaks */
  function runCleanups(): void {
    for (const cleanup of cleanups) {
      cleanup()
    }
  }

  function finalizeOutput(stdout: string): string {
    if (!options.captureUsage) return stdout

    // Best-effort rate_limit extraction
    try {
      const obs = parseRateLimitHeaders(stdout)
      if (obs && options.onUsageObserved) {
        options.onUsageObserved(obs)
      }
    } catch {
      // Silent: observation is best-effort, must not break worker.
    }

    const result = extractResultFromJsonOutput(stdout)
    // Fallback: if JSON result not found (unexpected), return raw stdout so
    // caller at least sees *something* instead of empty string.
    return result ?? stdout
  }

  // If we have timeout or signal, race them
  if (racePromises.length > 1) {
    try {
      const exitCode = await Promise.race(racePromises)
      runCleanups()
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
      if (exitCode !== 0) {
        throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
      }
      return finalizeOutput(stdout)
    } catch (err) {
      runCleanups()
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

  return finalizeOutput(stdout)
}
