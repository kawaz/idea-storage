import { BaseTimeoutError } from "./timeout-error.ts";

export class SpawnTimeoutError extends BaseTimeoutError {
  constructor(timeoutMs: number) {
    super(`subprocess timed out after ${timeoutMs}ms`, timeoutMs);
    this.name = "SpawnTimeoutError";
  }
}

export interface SpawnWithTimeoutOptions {
  cmd: string[];
  timeoutMs: number;
  /**
   * Override the subprocess env. Default is `{ ...process.env }`. Pass
   * `buildCsaEnv()` for CSA spawns to drop API credentials and agent sockets
   * (see DR-0009 Phase 1 codex review: env全送 was a defense-in-depth gap).
   */
  env?: Record<string, string>;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn a subprocess with a timeout.
 * If the process does not exit within timeoutMs, it is killed and SpawnTimeoutError is thrown.
 */
export async function spawnWithTimeout(options: SpawnWithTimeoutOptions): Promise<SpawnResult> {
  const { cmd, timeoutMs, env } = options;

  // Pass env explicitly so tests can override HOME / CLAUDE_CONFIG_DIR (used by
  // CSA for session discovery) via process.env. Bun.spawn does not inherit
  // process.env by default.
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: env ?? { ...process.env },
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new SpawnTimeoutError(timeoutMs)), timeoutMs);
  });

  try {
    const exitCode = await Promise.race([proc.exited, timeoutPromise]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { stdout, stderr, exitCode };
  } catch (err) {
    if (err instanceof SpawnTimeoutError) {
      proc.kill();
      // Drain streams to avoid resource leaks
      await Promise.allSettled([stdoutPromise, stderrPromise, proc.exited]);
      throw err;
    }
    throw err;
  } finally {
    clearTimeout(timerId!);
  }
}
