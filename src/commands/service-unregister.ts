import { define } from 'gunshi'
import { unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { exitWithError, errorMessage } from '../lib/errors.ts'
import {
  SERVICE_LABEL,
  getLaunchdDomain,
  getPlistPath,
} from '../lib/service.ts'

const unregister = define({
  name: 'unregister',
  description: 'Unregister the launchd service and remove the plist file',
  run: async () => {
    const domain = getLaunchdDomain()
    const serviceTarget = `${domain}/${SERVICE_LABEL}`

    // Bootout the service
    try {
      const bootout = Bun.spawn(['launchctl', 'bootout', serviceTarget], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stderr = await new Response(bootout.stderr).text()
      const exitCode = await bootout.exited

      if (exitCode !== 0) {
        // Exit code 3 means "no such process" — service was not loaded
        if (!stderr.includes('No such process') && !stderr.includes('Could not find service')) {
          exitWithError(`launchctl bootout failed: ${stderr}`)
        }
        console.log(`Service was not loaded (already unregistered)`)
      } else {
        console.log(`Unloaded: ${SERVICE_LABEL}`)
      }
    } catch (err) {
      exitWithError(`Failed to bootout service: ${errorMessage(err)}`)
    }

    // Remove plist file
    const plistPath = getPlistPath()
    if (existsSync(plistPath)) {
      await unlink(plistPath)
      console.log(`Removed: ${plistPath}`)
    } else {
      console.log(`Plist not found: ${plistPath} (already removed)`)
    }
  },
})

export default unregister
