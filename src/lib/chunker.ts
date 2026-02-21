/**
 * CSA timeline --md 形式のタイムラインテキストをチャンクに分割するライブラリ。
 *
 * 移植元: csa-timeline-analyzer.ts
 * - parseTimeline: タイムラインテキストをブロックに分解
 * - buildTurns: ブロックからターンを構築（Uで区切り）
 * - splitTimeline (proposeSplits): 時間ギャップ+日付境界+サイズ制約でチャンク分割
 * - extractChunkText: チャンクの行範囲からテキストを抽出
 */

// --- Types ---

export interface TimelineBlock {
  lineStart: number
  lineEnd: number
  rawBytes: number
  timestamp: Date
  type: string // U, T, R, B, F, G, W, S 等
  id: string
  raw: string
}

export interface Turn {
  index: number
  blocks: TimelineBlock[]
  startTime: Date
  endTime: Date
  bytes: number
  lineStart: number
  lineEnd: number
}

export interface TimelineChunk {
  index: number
  turns: Turn[]
  startTime: Date
  endTime: Date
  bytes: number
  turnCount: number
  lineStart: number
  lineEnd: number
  label: string
}

export interface SplitOptions {
  maxChunkBytes?: number // default 35000
  minChunkBytes?: number // default 8192
  maxChunks?: number // default 8
}

// --- 内部定数 ---

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\s+([A-Za-z])([0-9a-f]+)/

const DEFAULT_MAX_CHUNK_BYTES = 35000
const DEFAULT_MIN_CHUNK_BYTES = 8192
const DEFAULT_MAX_CHUNKS = 8

// --- Parse ---

/**
 * タイムラインテキストをブロックに分解する。
 * ヘッダー（最初の --- ... --- ）はスキップし、--- 区切りでブロックを分割する。
 * 各ブロックの最初のタイムスタンプ行をプライマリとして扱う。
 */
export function parseTimeline(text: string): TimelineBlock[] {
  const lines = text.split('\n')
  const blocks: TimelineBlock[] = []

  // ヘッダーをスキップ（最初の --- ... --- のペア）
  let i = 0
  if (lines[i]?.trim() === '---') {
    i++
    while (i < lines.length && lines[i]?.trim() !== '---') i++
    i++ // 閉じの --- をスキップ
  }

  // --- 区切りでブロックをパース
  let blockLines: string[] = []
  let blockLineStart = i + 1 // 1-based

  for (; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      if (blockLines.length > 0) {
        const block = parseBlock(blockLines, blockLineStart)
        if (block) blocks.push(block)
      }
      blockLines = []
      blockLineStart = i + 2 // 次の行、1-based
    } else {
      blockLines.push(lines[i]!)
    }
  }
  // 最後のブロック
  if (blockLines.length > 0) {
    const block = parseBlock(blockLines, blockLineStart)
    if (block) blocks.push(block)
  }

  return blocks
}

/**
 * ブロック内の行をパースしてTimelineBlockを生成する。
 * 最初のタイムスタンプ行のみをプライマリとし、インラインのツールコール(B,F,G等)は
 * 同一ブロック内に含める（別ブロックにしない）。
 */
function parseBlock(lines: string[], lineStart: number): TimelineBlock | null {
  // 最初のタイムスタンプ行を探す
  for (const line of lines) {
    const m = line.match(TS_RE)
    if (m) {
      const raw = lines.join('\n')
      return {
        lineStart,
        lineEnd: lineStart + lines.length - 1,
        rawBytes: new TextEncoder().encode(raw).length,
        timestamp: new Date(m[1]!),
        type: m[2]!,
        id: m[3]!,
        raw,
      }
    }
  }
  return null
}

// --- Build Turns ---

/**
 * ブロック列からターンを構築する。
 * Uブロックが出現するたびに新しいターンを開始する。
 */
export function buildTurns(blocks: TimelineBlock[]): Turn[] {
  const turns: Turn[] = []
  let current: TimelineBlock[] = []

  for (const block of blocks) {
    if (block.type === 'U' && current.length > 0) {
      turns.push(makeTurn(turns.length, current))
      current = []
    }
    current.push(block)
  }
  if (current.length > 0) {
    turns.push(makeTurn(turns.length, current))
  }

  return turns
}

/** ターンを生成するヘルパー */
function makeTurn(index: number, blocks: TimelineBlock[]): Turn {
  return {
    index,
    blocks,
    startTime: blocks[0]!.timestamp,
    endTime: blocks[blocks.length - 1]!.timestamp,
    bytes: blocks.reduce((s, b) => s + b.rawBytes, 0),
    lineStart: blocks[0]!.lineStart,
    lineEnd: blocks[blocks.length - 1]!.lineEnd,
  }
}

// --- Split ---

interface GapInfo {
  afterTurnIndex: number
  gapMs: number
  isDayBoundary: boolean
}

/**
 * タイムラインテキストをチャンクに分割する（メインAPI）。
 *
 * 分割戦略:
 * 1. 日付境界で必ず分割
 * 2. オーバーサイズのチャンクを時間ギャップの大きい箇所で分割
 * 3. minChunkBytes未満のチャンクを前のチャンクにマージ
 * 4. maxChunksを超えないよう隣接する最小ペアをマージ
 */
export function splitTimeline(timelineText: string, options?: SplitOptions): TimelineChunk[] {
  const blocks = parseTimeline(timelineText)
  const turns = buildTurns(blocks)

  const opts = {
    maxChunkBytes: options?.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
    minChunkBytes: options?.minChunkBytes ?? DEFAULT_MIN_CHUNK_BYTES,
    maxChunks: options?.maxChunks ?? DEFAULT_MAX_CHUNKS,
  }

  return proposeSplits(turns, opts)
}

/**
 * 時間ギャップ+日付境界+サイズ制約でチャンク分割を提案する。
 */
function proposeSplits(
  turns: Turn[],
  opts: { maxChunkBytes: number; minChunkBytes: number; maxChunks: number },
): TimelineChunk[] {
  if (turns.length === 0) return []

  // ターン間のギャップを計算
  const gaps: GapInfo[] = []
  for (let i = 0; i < turns.length - 1; i++) {
    const gapMs = turns[i + 1]!.startTime.getTime() - turns[i]!.endTime.getTime()
    const dayA = turns[i]!.endTime.toLocaleDateString()
    const dayB = turns[i + 1]!.startTime.toLocaleDateString()
    gaps.push({
      afterTurnIndex: i,
      gapMs,
      isDayBoundary: dayA !== dayB,
    })
  }

  const totalBytes = turns.reduce((s, t) => s + t.bytes, 0)
  const hasDayBoundary = gaps.some((g) => g.isDayBoundary)

  // 小さいタイムラインかつ日付境界なしの場合は分割しない
  if (totalBytes <= opts.maxChunkBytes && !hasDayBoundary) {
    const chunk = makeChunk(0, turns)
    chunk.label = generateLabel(chunk)
    return [chunk]
  }

  // 各ギャップにスコアを付ける（高いほど良い分割点）
  const scored = gaps.map((g) => ({
    ...g,
    score: g.gapMs / 1000 + (g.isDayBoundary ? 100000 : 0),
  }))

  // 貪欲分割: 分割点なしから始めて、制約を満たすまで最良の分割点を追加
  const splitIndices = new Set<number>()

  // 日付境界では必ず分割
  for (const g of scored) {
    if (g.isDayBoundary) splitIndices.add(g.afterTurnIndex)
  }

  // チャンクを構築するヘルパー
  function buildChunks(): TimelineChunk[] {
    const sortedSplits = [...splitIndices].sort((a, b) => a - b)
    const chunks: TimelineChunk[] = []
    let start = 0
    for (const splitAfter of sortedSplits) {
      const chunkTurns = turns.slice(start, splitAfter + 1)
      if (chunkTurns.length > 0) {
        chunks.push(makeChunk(chunks.length, chunkTurns))
      }
      start = splitAfter + 1
    }
    if (start < turns.length) {
      chunks.push(makeChunk(chunks.length, turns.slice(start)))
    }
    return chunks
  }

  // オーバーサイズのチャンクを反復的に分割
  for (let iter = 0; iter < 20; iter++) {
    const chunks = buildChunks()
    const oversized = chunks.find((c) => c.bytes > opts.maxChunkBytes)
    if (!oversized) break

    // オーバーサイズチャンク内の最良ギャップを見つける
    const chunkTurnIndices = oversized.turns.map((t) => t.index)
    const candidateGaps = scored.filter(
      (g) =>
        chunkTurnIndices.includes(g.afterTurnIndex) && !splitIndices.has(g.afterTurnIndex),
    )
    if (candidateGaps.length === 0) break

    // 最高スコアのギャップを選択
    candidateGaps.sort((a, b) => b.score - a.score)
    splitIndices.add(candidateGaps[0]!.afterTurnIndex)
  }

  let chunks = buildChunks()

  // アンダーサイズのチャンクを前のチャンクにマージ
  const finalChunks: TimelineChunk[] = []
  for (const chunk of chunks) {
    if (finalChunks.length > 0 && chunk.bytes < opts.minChunkBytes) {
      const prev = finalChunks[finalChunks.length - 1]!
      prev.turns.push(...chunk.turns)
      prev.endTime = chunk.endTime
      prev.bytes += chunk.bytes
      prev.turnCount += chunk.turnCount
      prev.lineEnd = chunk.lineEnd
    } else {
      finalChunks.push(chunk)
    }
  }

  // チャンク数の上限を超えないよう、隣接する最小ペアをマージ
  while (finalChunks.length > opts.maxChunks) {
    let minSum = Infinity
    let minIdx = 0
    for (let i = 0; i < finalChunks.length - 1; i++) {
      const sum = finalChunks[i]!.bytes + finalChunks[i + 1]!.bytes
      if (sum < minSum) {
        minSum = sum
        minIdx = i
      }
    }
    const a = finalChunks[minIdx]!
    const b = finalChunks[minIdx + 1]!
    a.turns.push(...b.turns)
    a.endTime = b.endTime
    a.bytes += b.bytes
    a.turnCount += b.turnCount
    a.lineEnd = b.lineEnd
    finalChunks.splice(minIdx + 1, 1)
  }

  // インデックスを振り直してラベルを生成
  finalChunks.forEach((c, i) => {
    c.index = i
    c.label = generateLabel(c)
  })

  return finalChunks
}

/** チャンクを生成するヘルパー */
function makeChunk(index: number, turns: Turn[]): TimelineChunk {
  return {
    index,
    turns,
    startTime: turns[0]!.startTime,
    endTime: turns[turns.length - 1]!.endTime,
    bytes: turns.reduce((s, t) => s + t.bytes, 0),
    turnCount: turns.length,
    lineStart: turns[0]!.lineStart,
    lineEnd: turns[turns.length - 1]!.lineEnd,
    label: '',
  }
}

/** チャンクのラベルを生成する（日時範囲の表示用） */
function generateLabel(chunk: TimelineChunk): string {
  const startDay = chunk.startTime.toLocaleDateString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
  })
  const endDay = chunk.endTime.toLocaleDateString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
  })
  const startHour = chunk.startTime.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })
  const endHour = chunk.endTime.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  })

  if (startDay === endDay) {
    return `${startDay} ${startHour}-${endHour}`
  }
  return `${startDay}-${endDay}`
}

// --- Extract ---

/**
 * タイムラインテキストからチャンクの行範囲のテキストを抽出する。
 * lineStart, lineEnd は1-basedの行番号。
 */
export function extractChunkText(timelineText: string, chunk: TimelineChunk): string {
  const lines = timelineText.split('\n')
  // lineStart, lineEnd は 1-based なので 0-based に変換
  const extracted = lines.slice(chunk.lineStart - 1, chunk.lineEnd)
  return extracted.join('\n')
}
