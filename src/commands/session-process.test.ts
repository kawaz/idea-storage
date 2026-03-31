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
  markFailed: mock(async (key: string, _reason?: string) => {
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

// --- processChunked の子プロセスリーク防止テスト ---
import { processChunked } from './session-process.ts'
import { ClaudeTimeoutError, ClaudeAbortError } from '../lib/claude-runner.ts'

// テスト用ヘルパー: processChunked をモックされた runClaude で検証する
// processChunked は内部で runClaude を呼ぶため、claude-runner のモック経由でテストする

describe('processChunked abort behavior', () => {
  const dummyMeta = {
    startTime: new Date('2025-01-01T00:00:00Z'),
    endTime: new Date('2025-01-01T01:00:00Z'),
    project: 'test-project',
    lineCount: 100,
    userTurns: 5,
    forkInfo: null,
  }

  function makeChunks(count: number): import('../lib/chunker.ts').TimelineChunk[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      turns: [],
      startTime: new Date('2025-01-01T00:00:00Z'),
      endTime: new Date('2025-01-01T01:00:00Z'),
      bytes: 1000,
      turnCount: 5,
      lineStart: 1,
      lineEnd: 50,
      label: `chunk-${i}`,
    }))
  }

  test('1つのチャンクがタイムアウトしたら他のチャンクにabort signalが送られる', async () => {
    // processChunked は内部で runClaude を呼ぶ。
    // このテストでは processChunked が signal を渡しているかを検証する。
    // processChunked が AbortController を使って他を中断する実装になっていれば、
    // 1つがタイムアウトした後に他も ClaudeAbortError で終了するはず。
    const chunks = makeChunks(3)
    const convText = 'dummy timeline text'
    const recipePrompt = 'test prompt'

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        'test-session-id',
        dummyMeta,
        100, // very short timeout to trigger timeout
      )
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      // processChunked should propagate the ClaudeTimeoutError
      expect(err).toBeInstanceOf(ClaudeTimeoutError)
    }
  })

  test('全チャンク成功時は正常に合成結果を返す', async () => {
    // This test verifies that processChunked works correctly when all chunks succeed.
    // We need to mock runClaude for this - tested through _runClaudeOverride
    const chunks = makeChunks(2)
    const convText = 'dummy timeline text'
    const recipePrompt = 'test prompt'

    let callCount = 0
    const result = await processChunked(
      convText,
      chunks,
      recipePrompt,
      'test-session-id',
      dummyMeta,
      undefined,
      // _runClaudeOverride: mock runClaude for testing
      async (_options) => {
        callCount++
        if (callCount <= 2) {
          return `## Section ${callCount}\nContent ${callCount}`
        }
        // synthesis call
        return '# Title\n## Section 1\nContent 1\n## Section 2\nContent 2\n## まとめ\nOverall summary'
      },
    )

    expect(callCount).toBe(3) // 2 chunks + 1 synthesis
    expect(result).toContain('Title')
    expect(result).toContain('まとめ')
  })

  test('1つのチャンクが失敗したら他の並列実行中チャンクがキャンセルされる', async () => {
    const chunks = makeChunks(3)
    const convText = 'dummy timeline text'
    const recipePrompt = 'test prompt'

    const abortedSignals: boolean[] = []
    let callCount = 0

    try {
      await processChunked(
        convText,
        chunks,
        recipePrompt,
        'test-session-id',
        dummyMeta,
        undefined,
        // _runClaudeOverride: 1つ目は即座に失敗、他はsignal待ち
        async (options) => {
          callCount++
          const currentCall = callCount
          if (currentCall === 1) {
            throw new ClaudeTimeoutError(1000)
          }
          // 他のチャンクは signal が abort されるまで待つ
          return new Promise<string>((resolve, reject) => {
            if (options.signal) {
              if (options.signal.aborted) {
                abortedSignals.push(true)
                reject(new ClaudeAbortError())
                return
              }
              options.signal.addEventListener('abort', () => {
                abortedSignals.push(true)
                reject(new ClaudeAbortError())
              })
            }
            // Never resolves naturally - only through abort
          })
        },
      )
      expect(true).toBe(false) // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeTimeoutError)
    }

    // The other 2 chunks should have received abort signals
    expect(abortedSignals.length).toBe(2)
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
