import { define } from 'gunshi'
import { showHelp } from '../lib/help.ts'
import run from './session-run.ts'
import enqueue from './session-enqueue.ts'
import process from './session-process.ts'
import status from './session-status.ts'
import retry from './session-retry.ts'
import cleanup from './session-cleanup.ts'

const session = define({
  name: 'session',
  description: 'Session processing commands',
  subCommands: { run, enqueue, process, status, retry, cleanup },
  run: async (ctx) => {
    await showHelp(ctx as Parameters<typeof showHelp>[0])
  },
})

export default session
