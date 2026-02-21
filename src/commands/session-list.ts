import { define } from 'gunshi'
import { join, basename } from 'node:path'
import { loadConfig } from '../lib/config.ts'
import { getSessionMeta } from '../lib/conversation.ts'
import { formatAge } from '../lib/format.ts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

function projectName(project: string): string {
  if (!project) return '-'
  return basename(project)
}

export async function runList(): Promise<void> {
  const config = await loadConfig()

  const sessions: {
    id: string
    project: string
    lineCount: number
    ageSec: number
    status: string
  }[] = []

  for (const claudeDir of config.claudeDirs) {
    const projectsDir = join(claudeDir, 'projects')
    const glob = new Bun.Glob('**/*.jsonl')

    try {
      for await (const relativePath of glob.scan(projectsDir)) {
        const filename = relativePath.split('/').pop() ?? ''
        if (!UUID_PATTERN.test(filename)) continue

        const filePath = join(projectsDir, relativePath)
        const meta = await getSessionMeta(filePath)

        sessions.push({
          id: meta.id,
          project: projectName(meta.project),
          lineCount: meta.lineCount,
          ageSec: meta.ageSec,
          status: meta.hasEnd ? 'ended' : 'active',
        })
      }
    } catch (e: unknown) {
      // ディレクトリが存在しない場合はスキップ（他のclaudeDirを継続処理）
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') continue
      throw e
    }
  }

  // Sort by age descending (oldest first)
  sessions.sort((a, b) => b.ageSec - a.ageSec)

  if (sessions.length === 0) {
    console.log('No sessions found.')
    return
  }

  // Calculate column widths
  const header = { id: 'SESSION_ID', project: 'PROJECT', lines: 'LINES', age: 'AGE', status: 'STATUS' }
  const rows = sessions.map((s) => ({
    id: s.id.slice(0, 8) + '..',
    project: s.project,
    lines: String(s.lineCount),
    age: formatAge(s.ageSec),
    status: s.status,
  }))

  const colWidths = {
    id: Math.max(header.id.length, ...rows.map((r) => r.id.length)),
    project: Math.max(header.project.length, ...rows.map((r) => r.project.length)),
    lines: Math.max(header.lines.length, ...rows.map((r) => r.lines.length)),
    age: Math.max(header.age.length, ...rows.map((r) => r.age.length)),
    status: Math.max(header.status.length, ...rows.map((r) => r.status.length)),
  }

  const formatRow = (r: typeof header) =>
    `${r.id.padEnd(colWidths.id)}  ${r.project.padEnd(colWidths.project)}  ${r.lines.padStart(colWidths.lines)}  ${r.age.padStart(colWidths.age)}  ${r.status.padEnd(colWidths.status)}`

  console.log(formatRow(header))
  for (const row of rows) {
    console.log(formatRow(row))
  }
}

const sessionList = define({
  name: 'list',
  description: 'List all sessions',
  run: async () => {
    await runList()
  },
})

export default sessionList
