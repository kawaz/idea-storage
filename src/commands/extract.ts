import { define } from 'gunshi'
import { join } from 'node:path'
import { loadConfig } from '../lib/config.ts'
import { formatConversationToText } from '../lib/conversation.ts'
import { exitWithError } from '../lib/errors.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function findSessionByUUID(claudeDirs: string[], uuid: string): Promise<string | null> {
  for (const claudeDir of claudeDirs) {
    const projectsDir = join(claudeDir, 'projects')
    const glob = new Bun.Glob(`**/${uuid}.jsonl`)
    for await (const relativePath of glob.scan(projectsDir)) {
      return join(projectsDir, relativePath)
    }
  }
  return null
}

const extract = define({
  name: 'extract',
  description: 'Extract conversation text from a session file',
  args: {
    'max-chars': {
      type: 'number',
      description: 'Maximum characters (truncates from the beginning, keeping recent)',
    },
  },
  run: async (ctx) => {
    const target = ctx.positionals[ctx.commandPath.length]
    if (!target) {
      exitWithError('Usage: idea-storage extract [--max-chars N] <session-file-or-uuid>')
    }

    let filePath: string

    if (UUID_PATTERN.test(target)) {
      // UUID: search in claudeDirs
      const config = await loadConfig()
      const found = await findSessionByUUID(config.claudeDirs, target)
      if (!found) {
        exitWithError(`Session not found: ${target}`)
      }
      filePath = found
    } else {
      // File path
      filePath = target
    }

    let text = await formatConversationToText(filePath)

    // Truncate from the beginning if max-chars specified (keep recent)
    const maxChars = ctx.values['max-chars'] as number | undefined
    if (maxChars !== undefined && text.length > maxChars) {
      text = text.slice(-maxChars)
    }

    process.stdout.write(text)
  },
})

export default extract
