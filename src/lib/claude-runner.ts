export interface ClaudeRunOptions {
  prompt: string
  addDir?: string
  sessionPersistence?: boolean // default false
  dangerouslySkipPermissions?: boolean // default true
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
  const args = buildClaudeArgs(options)
  const env = buildClaudeEnv()

  const proc = Bun.spawn(args, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`claude exited with code ${exitCode}: ${stderr}`)
  }

  return stdout
}
