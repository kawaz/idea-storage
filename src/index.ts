import { cli, define } from 'gunshi'
import { showHelp } from './lib/help.ts'
import session from './commands/session.ts'
import extract from './commands/extract.ts'
import service from './commands/service.ts'
import article from './commands/article.ts'

const subCommands = {
  session,
  extract,
  service,
  article,
}

const main = define({
  name: 'idea-storage',
  description: 'idea-storage CLI',
  subCommands,
  run: async (ctx) => {
    await showHelp(ctx as Parameters<typeof showHelp>[0])
  },
})

await cli(process.argv.slice(2), main, {
  name: 'idea-storage',
  version: '0.1.0',
  subCommands,
  renderHeader: async () => '',
})
