import { define } from 'gunshi'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { generatePlist } from '../lib/plist.ts'
import { exitWithError, errorMessage } from '../lib/errors.ts'

const LABEL = 'com.idea-storage.session'

function getLaunchAgentsDir(): string {
  const home = process.env.HOME ?? '/'
  return join(home, 'Library', 'LaunchAgents')
}

async function getProgramPath(): Promise<string> {
  // Use the absolute path to the built binary
  const proc = Bun.spawn(['which', 'idea-storage'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited

  if (stdout.trim()) {
    return stdout.trim()
  }

  // Fallback: use the dist path relative to this project
  // Resolve from process.argv[0] which is the running binary
  return process.argv[1] ?? 'idea-storage'
}

const launchd = define({
  name: 'launchd',
  description: 'Install/update launchd plist for session processing',
  run: async () => {
    const program = await getProgramPath()

    const plist = generatePlist({
      label: LABEL,
      program,
      programArguments: [program, 'session', 'run'],
      startInterval: 3600,
    })

    const launchAgentsDir = getLaunchAgentsDir()
    await mkdir(launchAgentsDir, { recursive: true })
    const plistPath = join(launchAgentsDir, `${LABEL}.plist`)

    await Bun.write(plistPath, plist)
    console.log(`Written: ${plistPath}`)

    // Unload existing job (ignore errors if not loaded)
    const uid = process.getuid?.() ?? 0
    const domain = `gui/${uid}`

    try {
      const bootout = Bun.spawn(['launchctl', 'bootout', `${domain}/${LABEL}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      await bootout.exited
    } catch {
      // Ignore if not loaded
    }

    // Load the new job
    const bootstrap = Bun.spawn(['launchctl', 'bootstrap', domain, plistPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(bootstrap.stderr).text()
    const exitCode = await bootstrap.exited

    if (exitCode !== 0) {
      exitWithError(`launchctl bootstrap failed: ${stderr}`)
    }

    console.log(`Registered: ${LABEL} (interval: 3600s)`)
  },
})

export default launchd
