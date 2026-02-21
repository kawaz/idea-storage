import { define } from 'gunshi'
import { existsSync } from 'node:fs'
import { getStateDir } from '../lib/paths.ts'
import { SERVICE_LABEL } from '../lib/service.ts'

const log = define({
  name: 'log',
  description: 'Show service log output',
  args: {
    follow: {
      type: 'boolean' as const,
      description: 'Follow log output (like tail -f)',
      default: false,
    },
    lines: {
      type: 'number' as const,
      description: 'Number of lines to show',
      default: 50,
    },
    stderr: {
      type: 'boolean' as const,
      description: 'Show stderr log instead of stdout',
      default: false,
    },
  },
  run: async (ctx) => {
    const follow = ctx.values.follow as boolean
    const lines = (ctx.values.lines as number | undefined) ?? 50
    const showStderr = ctx.values.stderr as boolean
    const stateDir = getStateDir().replace(/\/$/, '')
    const suffix = showStderr ? 'stderr' : 'stdout'
    const logPath = `${stateDir}/${SERVICE_LABEL}-${suffix}.log`

    if (!existsSync(logPath)) {
      console.error(`Log file not found: ${logPath}`)
      console.error('The service may not have run yet.')
      process.exit(1)
    }

    if (follow) {
      const proc = Bun.spawn(['tail', '-f', logPath], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await proc.exited
    } else {
      const proc = Bun.spawn(['tail', '-n', String(lines), logPath], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      await proc.exited
    }
  },
})

export default log
