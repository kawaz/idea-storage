import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Track markFailed calls
const markFailedCalls: string[] = []

let claudeDir: string
let tempDir: string

// Mock modules before importing runProcess
mock.module('../lib/queue.ts', () => ({
  dequeue: mock(async () => ({
    sessionId: 'missing-session-id',
    recipeName: 'diary',
    key: 'missing-session-id.diary',
  })),
  markDone: mock(async () => {}),
  markFailed: mock(async (key: string) => {
    markFailedCalls.push(key)
  }),
}))

// loadConfig will be set up in beforeEach with real temp dir
let loadConfigResult: { claudeDirs: string[]; minAgeMinutes: number }

mock.module('../lib/config.ts', () => ({
  loadConfig: mock(async () => loadConfigResult),
}))

describe('session-process', () => {
  beforeEach(async () => {
    markFailedCalls.length = 0
    tempDir = await mkdtemp(join(tmpdir(), 'session-process-test-'))
    claudeDir = join(tempDir, 'claude')
    // Create projects dir so Bun.Glob.scan doesn't throw
    await mkdir(join(claudeDir, 'projects'), { recursive: true })
    loadConfigResult = {
      claudeDirs: [claudeDir],
      minAgeMinutes: 120,
    }
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('calls markFailed when session file is not found', async () => {
    const { runProcess } = await import('./session-process.ts')
    await runProcess()

    expect(markFailedCalls).toContain('missing-session-id.diary')
  })
})

// --- チャンク分割パスのユニットテスト ---
import { buildSectionPrompt, buildSynthesisPrompt } from './session-process.ts'
import type { TimelineChunk } from '../lib/chunker.ts'

describe('buildSectionPrompt', () => {
  const recipePrompt = '日記を書いてください'
  const sessionInfo = '- Session ID: abc123\n- Project: my-project\n- Created: 2025-01-01T00:00:00Z'

  function makeChunk(overrides: Partial<TimelineChunk> = {}): TimelineChunk {
    return {
      index: 0,
      turns: [],
      startTime: new Date('2025-01-01T00:00:00Z'),
      endTime: new Date('2025-01-01T01:00:00Z'),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: '1/1 00:00-01:00',
      ...overrides,
    }
  }

  test('レシピの指示がプロンプトに含まれる', () => {
    const chunk = makeChunk()
    const result = buildSectionPrompt(recipePrompt, chunk, 'チャンクのテキスト', sessionInfo)
    expect(result).toContain(recipePrompt)
  })

  test('チャンク情報（index, label, turnCount）がプロンプトに含まれる', () => {
    const chunk = makeChunk({ index: 2, label: '1/1-1/2', turnCount: 10 })
    const result = buildSectionPrompt(recipePrompt, chunk, 'テキスト', sessionInfo)
    // index は 0-based なので表示は +1
    expect(result).toContain('3')
    expect(result).toContain('1/1-1/2')
    expect(result).toContain('10')
  })

  test('セッション情報がプロンプトに含まれる', () => {
    const chunk = makeChunk()
    const result = buildSectionPrompt(recipePrompt, chunk, 'テキスト', sessionInfo)
    expect(result).toContain('abc123')
    expect(result).toContain('my-project')
  })

  test('chunkText がプロンプト末尾に含まれる', () => {
    const chunk = makeChunk()
    const chunkText = 'ユーザーがコードをレビューしました'
    const result = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo)
    expect(result).toContain(chunkText)
  })

  test('セクション見出しの指示が含まれる', () => {
    const chunk = makeChunk()
    const result = buildSectionPrompt(recipePrompt, chunk, 'テキスト', sessionInfo)
    expect(result).toContain('セクション見出し')
  })
})

describe('buildSynthesisPrompt', () => {
  const sessionInfo = '- Session ID: abc123\n- Project: my-project\n- Created: 2025-01-01T00:00:00Z'

  test('全セクションがプロンプトに含まれる', () => {
    const sections = ['## セクション1\n内容A', '## セクション2\n内容B']
    const result = buildSynthesisPrompt(sections, sessionInfo)
    expect(result).toContain('内容A')
    expect(result).toContain('内容B')
  })

  test('セクション番号が付与される', () => {
    const sections = ['セクションA', 'セクションB', 'セクションC']
    const result = buildSynthesisPrompt(sections, sessionInfo)
    expect(result).toContain('セクション 1')
    expect(result).toContain('セクション 2')
    expect(result).toContain('セクション 3')
  })

  test('セッション情報がプロンプトに含まれる', () => {
    const sections = ['内容']
    const result = buildSynthesisPrompt(sections, sessionInfo)
    expect(result).toContain('abc123')
    expect(result).toContain('my-project')
  })

  test('タイトルとまとめの指示が含まれる', () => {
    const sections = ['内容']
    const result = buildSynthesisPrompt(sections, sessionInfo)
    expect(result).toContain('タイトル')
    expect(result).toContain('まとめ')
  })

  test('Markdown出力指示が含まれる', () => {
    const sections = ['内容']
    const result = buildSynthesisPrompt(sections, sessionInfo)
    expect(result).toContain('Markdown')
  })
})

// --- フォークセッションのタイムライン切り詰めテスト ---
import { trimTimelineForFork } from './session-process.ts'

describe('trimTimelineForFork', () => {
  // CSA timeline --md 形式のサンプル
  const sampleTimeline = `---
session: test-session
---
2024-01-01T10:00:00+09:00 Uaaa11111 User message 1
Some user content

---
2024-01-01T10:00:05+09:00 Tbbb22222 Assistant reply 1
Some assistant content

---
2024-01-01T10:01:00+09:00 Uccc33333 User message 2
More user content

---
2024-01-01T10:01:10+09:00 Tddd44444 Assistant reply 2
More assistant content

---
2024-01-01T11:00:00+09:00 Ueee55555 Fork user message
Fork content here

---
2024-01-01T11:00:10+09:00 Tfff66666 Fork assistant reply
Fork reply content`

  test('firstNewUuid の先頭8文字でブロックを特定し、そのブロック以降を返す', () => {
    // eee55555 = uuid "eee55555-..." の先頭8文字
    const result = trimTimelineForFork(sampleTimeline, 'eee55555-0000-0000-0000-000000000000')
    expect(result).toContain('Ueee55555')
    expect(result).toContain('Fork user message')
    expect(result).toContain('Tfff66666')
    expect(result).toContain('Fork reply content')
    // 親の行は含まれない
    expect(result).not.toContain('Uaaa11111')
    expect(result).not.toContain('Uccc33333')
    expect(result).not.toContain('Tddd44444')
  })

  test('firstNewUuid が空の場合、元のタイムラインをそのまま返す', () => {
    const result = trimTimelineForFork(sampleTimeline, '')
    expect(result).toBe(sampleTimeline)
  })

  test('firstNewUuid がタイムラインに見つからない場合、元のタイムラインをそのまま返す', () => {
    const result = trimTimelineForFork(sampleTimeline, 'zzzzzzzz-0000-0000-0000-000000000000')
    expect(result).toBe(sampleTimeline)
  })

  test('firstNewUuid が最初のブロックの場合、ヘッダー以降全て返す', () => {
    const result = trimTimelineForFork(sampleTimeline, 'aaa11111-0000-0000-0000-000000000000')
    expect(result).toContain('Uaaa11111')
    expect(result).toContain('Tfff66666')
  })

  test('メッセージ本文中に同じ8文字hexが含まれても誤マッチしない', () => {
    const timelineWithContent = `---
session: test
---
2024-01-01T10:00:00+09:00 Uaaa11111 User message
The commit hash is eee55555abc and some content

---
2024-01-01T11:00:00+09:00 Ueee55555 Real fork point
Fork content here`

    const result = trimTimelineForFork(timelineWithContent, 'eee55555-0000-0000-0000-000000000000')
    // ブロックIDの Ueee55555 にマッチし、本文中の eee55555 には誤マッチしない
    expect(result).toContain('Ueee55555')
    expect(result).not.toContain('Uaaa11111')
  })
})
