import { define } from 'gunshi'
import {
  SERVICE_LABEL,
  getLaunchdDomain,
} from '../lib/service.ts'

const status = define({
  name: 'status',
  description: 'Show the launchd service status',
  run: async () => {
    const domain = getLaunchdDomain()
    const serviceTarget = `${domain}/${SERVICE_LABEL}`

    const proc = Bun.spawn(['launchctl', 'print', serviceTarget], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      console.error(`Service not registered: ${SERVICE_LABEL}`)
      if (stderr.trim()) {
        console.error(stderr.trim())
      }
      process.exit(1)
    }

    console.log(stdout)
  },
})

export default status
