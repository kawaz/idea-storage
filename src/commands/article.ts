import { define } from 'gunshi'
import { showHelp } from '../lib/help.ts'
import ls from './article-ls.ts'
import view from './article-view.ts'
import list from './article-list.ts'

const article = define({
  name: 'article',
  description: 'Browse and manage generated articles',
  subCommands: { ls, list, view },
  run: async (ctx) => {
    await showHelp(ctx as Parameters<typeof showHelp>[0])
  },
})

export default article
