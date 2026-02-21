import { define } from 'gunshi'
import { showHelp } from '../lib/help.ts'
import register from './service-register.ts'
import unregister from './service-unregister.ts'
import status from './service-status.ts'
import log from './service-log.ts'

const service = define({
  name: 'service',
  description: 'Manage launchd service',
  subCommands: { register, unregister, status, log },
  run: async (ctx) => {
    await showHelp(ctx as Parameters<typeof showHelp>[0])
  },
})

export default service
