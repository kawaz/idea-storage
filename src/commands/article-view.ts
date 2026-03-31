import { define } from 'gunshi'
import { join } from 'node:path'
import { getDataDir } from '../lib/paths.ts'
import { formatAge, parseSortOrder, type SortOrder, SORT_ORDERS } from '../lib/format.ts'
export { type SortOrder, SORT_ORDERS } from '../lib/format.ts'

export interface ViewEntry {
  fullPath: string
  relativePath: string
  mtime: Date
  sizeBytes: number
}

export function nextSortOrder(current: SortOrder): SortOrder {
  const idx = SORT_ORDERS.indexOf(current)
  return SORT_ORDERS[(idx + 1) % SORT_ORDERS.length]!
}

export function sortEntries(entries: ViewEntry[], order: SortOrder): ViewEntry[] {
  const sorted = [...entries]
  switch (order) {
    case 'recipe':
      sorted.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      break
    case 'date':
      sorted.sort((a, b) => a.mtime.getTime() - b.mtime.getTime())
      break
    case 'size':
      sorted.sort((a, b) => b.sizeBytes - a.sizeBytes || a.relativePath.localeCompare(b.relativePath))
      break
  }
  return sorted
}

/**
 * dataDir 以下の全 .md ファイルを走査し、ViewEntry の配列を返す。
 */
export async function listViewEntries(dataDir: string): Promise<ViewEntry[]> {
  const glob = new Bun.Glob('**/*.md')
  const entries: ViewEntry[] = []

  for await (const relativePath of glob.scan(dataDir)) {
    const fullPath = join(dataDir, relativePath)
    const file = Bun.file(fullPath)
    const stat = await file.stat()

    entries.push({
      fullPath,
      relativePath,
      mtime: new Date(stat.mtimeMs),
      sizeBytes: stat.size,
    })
  }

  return entries
}

export function formatAgeFromDate(mtime: Date): string {
  return formatAge(Math.floor((Date.now() - mtime.getTime()) / 1000))
}

export function formatSizeKB(bytes: number): string {
  const kb = Math.max(1, Math.ceil(bytes / 1024))
  return kb.toLocaleString('en-US') + 'KB'
}

/**
 * ViewEntry をフォーマットする。
 * フォーマット: fullPath\tISO8601(mtime)\t(age  size  relativePath)
 * fzf --with-nth=3.. --delimiter=\t で表示列のみ見える。
 */
export function formatViewEntry(entry: ViewEntry, maxAgeLen: number, maxSizeLen: number): string {
  const mtimeIso = entry.mtime.toISOString()
  const age = formatAgeFromDate(entry.mtime).padStart(maxAgeLen)
  const size = formatSizeKB(entry.sizeBytes).padStart(maxSizeLen)
  return `${entry.fullPath}\t${mtimeIso}\t${age}  ${size}  ${entry.relativePath}`
}

const view = define({
  name: 'view',
  description: 'Browse diary entries with fzf + mdp',
  args: {
    sort: {
      type: 'string',
      description: 'Sort order: recipe, date, size',
      short: 's',
    },
  },
  run: async (ctx) => {
    const sort = parseSortOrder(ctx.values.sort as string | undefined)
    const dataDir = getDataDir()
    const entries = await listViewEntries(dataDir)

    if (entries.length === 0) {
      console.error(`No .md files found in ${dataDir}`)
      process.exit(1)
    }

    const sorted = sortEntries(entries, sort)

    const ages = sorted.map(e => formatAgeFromDate(e.mtime))
    const sizes = sorted.map(e => formatSizeKB(e.sizeBytes))
    const maxAgeLen = Math.max(...ages.map(a => a.length))
    const maxSizeLen = Math.max(...sizes.map(s => s.length))

    const input = sorted.map(e => formatViewEntry(e, maxAgeLen, maxSizeLen)).join('\n')

    const hasMdp = Bun.spawnSync(['which', 'mdp']).exitCode === 0
    const previewCmd = hasMdp ? 'mdp {1}' : 'cat {1}'
    const openCmd = hasMdp ? 'mdp {1} | less -R' : 'less {1}'

    const next = nextSortOrder(sort)
    const selfCmd = process.argv[1] ?? 'idea-storage'

    try {
      const fzf = Bun.spawn(
        [
          'fzf',
          '--with-nth=3..',
          '--delimiter=\t',
          '--preview',
          previewCmd,
          '--preview-window',
          'right:50%:wrap',
          '--bind',
          `ctrl-o:execute(${openCmd})`,
          '--bind',
          `ctrl-s:become(${selfCmd} article view --sort ${next})`,
          '--header',
          `sort: ${sort} (ctrl-s: → ${next}) | ctrl-o: open`,
          '--no-mouse',
          '--ansi',
          '--tac',
        ],
        {
          stdin: 'pipe',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      )

      fzf.stdin.write(input)
      fzf.stdin.end()

      await fzf.exited
    } catch (err) {
      if (err instanceof Error && err.message.includes('ENOENT')) {
        console.error('Error: fzf is required. Install it with: brew install fzf')
        process.exit(1)
      }
      throw err
    }
  },
})

export default view
