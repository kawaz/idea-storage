import { define } from 'gunshi'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { getDataDir } from '../lib/paths.ts'
import { parseFrontmatter } from '../lib/frontmatter.ts'
import { listViewEntries } from './article-view.ts'
import {
  formatSmartSize as formatSmartSizePlain,
  formatDuration as formatDurationPlain,
  formatTimestamp as formatTimestampPlain,
} from '../lib/format.ts'

const C = {
  red: '\x1b[0;31m',
  redDim: '\x1b[2;31m',
  green: '\x1b[0;32m',
  greenDim: '\x1b[2;32m',
  yellow: '\x1b[0;33m',
  yellowDim: '\x1b[2;33m',
  blue: '\x1b[0;34m',
  magenta: '\x1b[0;35m',
  blackBright: '\x1b[0;90m',
  reset: '\x1b[0m',
}

interface ListEntry {
  fullPath: string
  sizeBytes: number
  recipe: string
  sessionId: string
  sessionStart: Date | null
  sessionEnd: Date | null
  durationMs: number | null
  userTurns: number | null
  sessionBytes: number | null
  project: string
}

const HOME = process.env.HOME ?? ''

function tildefy(path: string): string {
  return HOME && path.startsWith(HOME) ? '~' + path.slice(HOME.length) : path
}

function oscLink(url: string, text: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export function formatSmartSize(bytes: number): string {
  const plain = formatSmartSizePlain(bytes)
  const num = plain.slice(0, -1)
  const unit = plain.slice(-1)
  let color: string
  if (unit === 'G') {
    color = C.red
  } else if (unit === 'M') {
    color = bytes > 2 * 1024 * 1024 ? C.red : C.blue
  } else {
    color = bytes >= 500 * 1024 ? C.yellow : C.blue
  }
  return `${color}${num}${C.reset}${unit}`
}

export function formatDuration(startMs: number, endMs: number): string {
  const plain = formatDurationPlain(startMs, endMs)
  if (plain === '-') return '-'
  if (plain.includes('d')) return `${C.red}${plain}${C.reset}`
  if (plain.includes('h')) return `${C.yellow}${plain}${C.reset}`
  if (plain.startsWith('0m')) return `${C.blackBright}0m${C.green}${plain.slice(2)}${C.reset}`
  return `${C.green}${plain}${C.reset}`
}

export function formatTimestamp(date: Date): string {
  const plain = formatTimestampPlain(date)
  return plain.replace('T', `${C.blackBright}T${C.reset}`)
}

export function parseProject(project: string): { matchPath: string; displayPath: string } {
  const reposIdx = project.indexOf('/repos/')
  if (reposIdx === -1) {
    // パターン不一致: フルパスをそのまま
    const clean = project.replace(/\/$/, '')
    return { matchPath: clean, displayPath: tildefy(clean) }
  }
  // /repos/{host}/{owner}/{repo}[/rest...]
  const after = project.slice(reposIdx + '/repos/'.length).replace(/\/$/, '')
  const parts = after.split('/')
  const host = parts[0] ?? ''
  const owner = parts[1] ?? ''
  const repo = parts[2] ?? ''
  const rest = parts.slice(3).join('/')

  const isGithub = host === 'github.com'
  const hostPart = isGithub ? '' : `${host}/`
  const ownerColor = C.magenta

  // rest1 がワークスペース(.jj/.git あり)なら green
  const rest1 = parts[3] ?? ''
  const rest2 = parts.slice(4).join('/')
  let rest1Display = ''
  if (rest1) {
    const prefix = project.slice(0, reposIdx)
    const rest1Path = join(prefix, 'repos', host, owner, repo, rest1)
    const isWs = existsSync(join(rest1Path, '.jj')) || existsSync(join(rest1Path, '.git'))
    rest1Display = isWs
      ? `/${C.green}${rest1}${C.reset}`
      : `${C.blackBright}/${rest1}${C.reset}`
  }
  const rest2Display = rest2 ? `${C.blackBright}/${rest2}${C.reset}` : ''

  const matchPath = `${hostPart}${owner}/${repo}${rest ? `/${rest}` : ''}`
  const displayPath = `${hostPart}${ownerColor}${owner}${C.reset}/${C.blue}${repo}${C.reset}${rest1Display}${rest2Display}`

  return { matchPath, displayPath }
}

const VALID_SORT_KEYS = ['start', 'end', 'duration', 'turn', 'rule'] as const
type SortKey = typeof VALID_SORT_KEYS[number]

function isSortKey(s: string): s is SortKey {
  return (VALID_SORT_KEYS as readonly string[]).includes(s)
}

export function parseSortKeys(value: string | undefined): SortKey[] {
  if (!value) return ['start']
  const keys = value.split(',').map(s => s.trim()).filter(isSortKey)
  return keys.length > 0 ? keys : ['start']
}

export function sortEntries(entries: ListEntry[], sortKeys: SortKey[]): void {
  entries.sort((a, b) => {
    for (const key of sortKeys) {
      let cmp = 0
      switch (key) {
        case 'start':
          // 降順（最新が上）
          cmp = (b.sessionStart?.getTime() ?? 0) - (a.sessionStart?.getTime() ?? 0)
          break
        case 'end':
          cmp = (b.sessionEnd?.getTime() ?? 0) - (a.sessionEnd?.getTime() ?? 0)
          break
        case 'duration': {
          const aDur = a.durationMs ?? ((a.sessionStart && a.sessionEnd) ? a.sessionEnd.getTime() - a.sessionStart.getTime() : 0)
          const bDur = b.durationMs ?? ((b.sessionStart && b.sessionEnd) ? b.sessionEnd.getTime() - b.sessionStart.getTime() : 0)
          cmp = bDur - aDur // 降順
          break
        }
        case 'turn':
          cmp = (b.userTurns ?? 0) - (a.userTurns ?? 0) // 降順
          break
        case 'rule':
          cmp = a.recipe.localeCompare(b.recipe) // 昇順
          break
      }
      if (cmp !== 0) return cmp
    }
    return 0
  })
}

interface CsaSession {
  sessionId: string
  cwd: string
  startTime: string
  endTime: string
  duration_ms: number
  bytes: number
  turns: number
}

async function fetchSessionStats(sessionIds: string[]): Promise<Map<string, CsaSession>> {
  const map = new Map<string, CsaSession>()
  if (sessionIds.length === 0) return map
  // コマンドライン引数制限を避けるためバッチで分割
  const BATCH = 200
  for (let i = 0; i < sessionIds.length; i += BATCH) {
    const batch = sessionIds.slice(i, i + BATCH)
    try {
      const proc = Bun.spawn(['claude-session-analysis', 'sessions', '--format', 'jsonl', ...batch], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      for (const line of out.trim().split('\n')) {
        if (!line) continue
        const s = JSON.parse(line) as CsaSession
        map.set(s.sessionId, s)
      }
    } catch {
      // continue with next batch
    }
  }
  return map
}

const UUID_RE = /\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i

interface ArticleInfo {
  fullPath: string; sizeBytes: number; mtime: Date
  sessionId: string; recipe: string
}

/** ファイルスキャンのみ（glob + stat） */
async function scanArticles(dataDir: string): Promise<ArticleInfo[]> {
  const viewEntries = await listViewEntries(dataDir)
  return viewEntries.map(ve => ({
    fullPath: ve.fullPath,
    sizeBytes: ve.sizeBytes,
    mtime: ve.mtime,
    sessionId: ve.relativePath.match(UUID_RE)?.[1] ?? '',
    recipe: ve.relativePath.split('/')[0] ?? '',
  }))
}

const parseDateValue = (v: unknown) => {
  if (typeof v !== 'string' || !v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** CSA + frontmatter fallback で ListEntry を構築 */
async function enrichArticles(articles: ArticleInfo[]): Promise<ListEntry[]> {
  const uniqueIds = [...new Set(articles.map(a => a.sessionId).filter(Boolean))]
  const csaMap = await fetchSessionStats(uniqueIds)

  const fmCache = new Map<string, Record<string, unknown>>()
  const fmTargets = articles.filter(a => a.sessionId && !csaMap.has(a.sessionId))
  const fmResults = await Promise.all(
    fmTargets.map(async a => {
      const content = await Bun.file(a.fullPath).text()
      const { frontmatter } = parseFrontmatter(content)
      return { path: a.fullPath, frontmatter }
    })
  )
  for (const { path, frontmatter } of fmResults) {
    fmCache.set(path, frontmatter)
  }

  return articles.map(a => {
    const csa = csaMap.get(a.sessionId)
    if (csa) {
      return {
        fullPath: a.fullPath, sizeBytes: a.sizeBytes, recipe: a.recipe,
        sessionId: a.sessionId,
        sessionStart: new Date(csa.startTime),
        sessionEnd: new Date(csa.endTime),
        durationMs: csa.duration_ms,
        userTurns: csa.turns,
        sessionBytes: csa.bytes,
        project: csa.cwd,
      }
    }
    const fm = fmCache.get(a.fullPath)
    const fmProject = typeof fm?.project === 'string' ? fm.project : ''
    return {
      fullPath: a.fullPath, sizeBytes: a.sizeBytes, recipe: a.recipe,
      sessionId: a.sessionId,
      sessionStart: parseDateValue(fm?.session_start) ?? a.mtime,
      sessionEnd: parseDateValue(fm?.session_end),
      durationMs: typeof fm?.duration_ms === 'number' ? fm.duration_ms : null,
      userTurns: typeof fm?.user_turns === 'number' ? fm.user_turns : null,
      sessionBytes: typeof fm?.session_bytes === 'number' ? fm.session_bytes : null,
      project: fmProject.includes('/') ? fmProject : '',
    }
  })
}

function formatLine(
  entry: ListEntry,
  maxRuleLen: number,
  maxSizeLen: number,
  maxTurnLen: number,
  maxDurLen: number,
): string {
  // 1. Rule
  const rule = `${C.magenta}${entry.recipe.padEnd(maxRuleLen)}${C.reset}`

  // 2. Size
  const size = formatSmartSize(entry.sizeBytes).padStart(maxSizeLen)

  // 3. Turn
  const turn = entry.userTurns !== null
    ? String(entry.userTurns).padStart(maxTurnLen)
    : '-'.padStart(maxTurnLen)

  // 4. Duration (durationMs 優先、なければ start/end から計算)
  let dur: string
  if (entry.durationMs !== null) {
    dur = formatDuration(0, entry.durationMs)
  } else if (entry.sessionStart && entry.sessionEnd) {
    dur = formatDuration(entry.sessionStart.getTime(), entry.sessionEnd.getTime())
  } else {
    dur = '-'
  }
  const durPlain = stripAnsi(dur)
  const durPadded = ' '.repeat(Math.max(0, maxDurLen - durPlain.length)) + dur

  // 5. Timestamp（/ 区切り）
  const ts = entry.sessionStart
    ? formatTimestamp(entry.sessionStart)
    : '                ' // 16 spaces

  // 6-7. UUID + path（パディングなし）
  const uuid = entry.sessionId
    ? `${C.blackBright}${entry.sessionId}${C.reset}`
    : ''

  // 7. [F][V] clickable links + path
  const finderLink = oscLink(`file://${dirname(entry.fullPath)}`, `${C.blackBright}[F]${C.reset}`)
  const vscodeLink = oscLink(`vscode://file${entry.fullPath}`, `${C.blackBright}[V]${C.reset}`)
  const { displayPath } = parseProject(entry.project)
  const pathStr = entry.project ? displayPath : ''

  const tail = [uuid, `${finderLink}${vscodeLink}`, pathStr].filter(Boolean).join(' ')
  return `${rule}  ${size}  ${turn}  ${durPadded}  ${ts}${tail ? `  ${tail}` : ''}`
}

const articleList = define({
  name: 'list',
  description: 'List all articles with rich formatting',
  args: {
    sort: {
      type: 'string',
      description: 'Sort keys (comma-separated): start, end, duration, turn, rule',
    },
    rule: {
      type: 'string',
      description: 'Filter by rule name (regex)',
    },
    path: {
      type: 'string',
      description: 'Filter by project path (regex)',
    },
  },
  run: async (ctx) => {
    const sortKeys = parseSortKeys(ctx.values.sort as string | undefined)
    const rulePattern = ctx.values.rule as string | undefined
    const pathPattern = ctx.values.path as string | undefined
    const positional = (ctx.positionals as string[])?.slice(ctx.commandPath.length) ?? []

    const dataDir = getDataDir()

    // Phase 1: ファイルスキャン（I/O: glob + stat のみ）
    let articles = await scanArticles(dataDir)

    // Phase 2: recipe だけで判定できるフィルタを先に適用（CSA 不要）
    if (rulePattern) {
      const re = new RegExp(rulePattern)
      articles = articles.filter(a => re.test(a.recipe))
    }
    // positional のうち recipe だけで全マッチするものを先に適用
    let pathRegexes: RegExp[] = []
    if (positional.length > 0) {
      const regexes = positional.map(p => new RegExp(p))
      const recipeValues = new Set(articles.map(a => a.recipe))
      const recipeOnly: RegExp[] = []
      for (const re of regexes) {
        if ([...recipeValues].some(r => re.test(r))) {
          recipeOnly.push(re)
        } else {
          pathRegexes.push(re)
        }
      }
      // recipe でマッチする regex はここで適用
      if (recipeOnly.length > 0) {
        articles = articles.filter(a => recipeOnly.every(re => re.test(a.recipe)))
      }
    }

    if (articles.length === 0) {
      console.log('No articles found.')
      return
    }

    // Phase 3: path フィルタが必要な場合のみ CSA を呼ぶ
    const needsCsa = pathPattern || pathRegexes.length > 0
    let entries: ListEntry[]
    if (needsCsa || articles.length <= 500) {
      // CSA で enrich
      entries = await enrichArticles(articles)
      // path フィルタ適用
      if (pathPattern) {
        const re = new RegExp(pathPattern)
        entries = entries.filter(e => {
          const { matchPath } = parseProject(e.project)
          return re.test(matchPath)
        })
      }
      if (pathRegexes.length > 0) {
        entries = entries.filter(e => {
          const { matchPath } = parseProject(e.project)
          return pathRegexes.every(re => re.test(e.recipe) || re.test(matchPath))
        })
      }
    } else {
      // フィルタ不要で件数が多い場合もCSAで enrich（表示に必要）
      entries = await enrichArticles(articles)
    }

    if (entries.length === 0) {
      console.log('No articles found.')
      return
    }

    // Sort
    sortEntries(entries, sortKeys)

    // Calculate column widths
    const maxRuleLen = Math.max(...entries.map(e => e.recipe.length))

    const sizes = entries.map(e => formatSmartSize(e.sizeBytes))
    const maxSizeLen = Math.max(...sizes.map(s => s.length))

    const turns = entries.map(e => e.userTurns !== null ? String(e.userTurns) : '-')
    const maxTurnLen = Math.max(...turns.map(t => t.length))

    const durations = entries.map(e => {
      if (e.durationMs !== null) return stripAnsi(formatDuration(0, e.durationMs))
      if (e.sessionStart && e.sessionEnd) return stripAnsi(formatDuration(e.sessionStart.getTime(), e.sessionEnd.getTime()))
      return '-'
    })
    const maxDurLen = Math.max(...durations.map(d => d.length))

    for (const entry of entries) {
      console.log(formatLine(entry, maxRuleLen, maxSizeLen, maxTurnLen, maxDurLen))
    }
  },
})

export default articleList
