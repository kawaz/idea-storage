import { define } from 'gunshi'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { loadConfig } from '../lib/config.ts'
import { loadRecipes } from '../lib/recipe.ts'
import { getRecipesDir, getDataDir, getDoneDir } from '../lib/paths.ts'
import { getSessionMeta } from '../lib/conversation.ts'
import { generateFrontmatter } from '../lib/frontmatter.ts'
import { runClaude, ClaudeTimeoutError, ClaudeAbortError } from '../lib/claude-runner.ts'
import type { ClaudeRunOptions } from '../lib/claude-runner.ts'
import { dequeue, markDone, markFailed } from '../lib/queue.ts'
import { exitWithError } from '../lib/errors.ts'
import { splitTimeline, extractChunkText, DEFAULT_MAX_CHUNK_BYTES, type TimelineChunk } from '../lib/chunker.ts'
import { spawnWithTimeout, SpawnTimeoutError } from '../lib/spawn-timeout.ts'
import { log, logError } from '../lib/logging.ts'
import { formatDatePath, formatFileTimestamp } from '../lib/format.ts'
import { findSessionFile } from '../lib/session-finder.ts'
import type { Recipe, SessionMeta } from '../types/index.ts'

const csaBin = 'claude-session-analysis'

/** CSA subprocess timeout: 10 minutes (実測では1.7MBセッションでも50ms以内だが余裕を持たせる) */
export const CSA_TIMEOUT_MS = 10 * 60 * 1000

function findRecipeByName(recipes: Recipe[], name: string): Recipe | undefined {
  return recipes.find(r => r.name === name)
}

// --- フォークセッション用のタイムライン切り詰め ---

/**
 * フォークセッションのタイムラインから、フォーク後の新規部分のみを抽出する。
 * firstNewUuid の先頭8文字を CSA ブロックID として検索し、
 * そのブロック以降（--- 区切り含む）を返す。
 */
export function trimTimelineForFork(timelineText: string, firstNewUuid: string): string {
  if (!firstNewUuid) return timelineText

  const blockIdPrefix = firstNewUuid.slice(0, 8)
  const lines = timelineText.split('\n')

  // ヘッダー（最初の --- ... --- ペア）を特定
  let headerEnd = 0
  if (lines[0]?.trim() === '---') {
    let i = 1
    while (i < lines.length && lines[i]?.trim() !== '---') i++
    headerEnd = i + 1 // 閉じの --- の次
  }

  // CSA ブロックID パターン: タイプ文字(U,T,B,F,G,R,W,S等) + 8文字hex
  // .includes() だとメッセージ本文中の偶然の一致で誤マッチするため、
  // CSA のブロックIDフォーマットに限定してマッチする
  const blockIdPattern = new RegExp(`[A-Z]${blockIdPrefix}\\b`)

  // ブロックIDを含む行を探す
  for (let i = headerEnd; i < lines.length; i++) {
    if (blockIdPattern.test(lines[i] ?? '')) {
      // この行を含むブロックの開始位置（直前の --- か headerEnd）を見つける
      let blockStart = i
      for (let j = i - 1; j >= headerEnd; j--) {
        if (lines[j]?.trim() === '---') {
          blockStart = j
          break
        }
      }
      // ヘッダー + このブロック以降を返す
      const header = lines.slice(0, headerEnd).join('\n')
      const body = lines.slice(blockStart).join('\n')
      return header + '\n' + body
    }
  }

  // 見つからない場合はそのまま返す
  return timelineText
}

// --- チャンク分割パス用のプロンプトビルダー ---

/**
 * セクションプロンプトを生成する。
 * 各チャンクを個別に処理するための指示をレシピの指示と組み合わせる。
 */
export function buildSectionPrompt(
  recipePrompt: string,
  chunk: TimelineChunk,
  chunkText: string,
  sessionInfo: string,
): string {
  return `あなたはこれからセッションの一部分（チャンク）を読みます。
以下のレシピの指示に従って、このチャンクについてのセクションを書いてください。

--- レシピの指示 ---
${recipePrompt}
---

重要:
- このチャンクの内容に集中して、深く具体的に書いてください
- 短くまとめすぎないでください。このセクションはそのまま最終出力の一部になります
- セクション見出し（## ）を1つ付けてください。内容に合った見出しにしてください
- 他のチャンクの内容は知らなくて構いません

---
## チャンク情報
- チャンク: ${chunk.index + 1}/${chunk.label}
- ターン数: ${chunk.turnCount}

## セッション情報
${sessionInfo}

## 会話タイムライン（このチャンクの部分）
${chunkText}`
}

/**
 * 合成プロンプトを生成する。
 * 各セクションの結果を統合して最終出力を作るための指示。
 */
export function buildSynthesisPrompt(sections: string[], sessionInfo: string): string {
  return `出力はMarkdown形式で。

以下は、あるセッションの出力を分割して書いたセクションです。
あなたの仕事は：

1. 全セクションをそのまま並べる（各セクションの見出しと本文はそのまま維持）
2. 冒頭にタイトル（# ）を付ける
3. 末尾に「## まとめ」セクションを追加する
   - 全体を通して感じたことを自分の言葉で書く
   - 各セクションの繰り返しにならないように、俯瞰的な視点で
   - セッション全体の流れや変化について

各セクションは編集しないでください。追加するのはタイトルとまとめだけです。

---
## セッション情報
${sessionInfo}

## セクション一覧
${sections.map((s, i) => `### --- セクション ${i + 1} ---\n${s}`).join('\n\n')}`
}

/**
 * チャンク分割パスで処理する。
 * 各チャンクを並列で処理し、結果を合成する。
 *
 * フォールバック戦略:
 * 1. 全チャンクを並列実行
 * 2. 失敗チャンクがあれば1回リトライ
 * 3. まだ失敗があり、全体サイズが maxChunkBytes 以内なら分割なしで1回再試行
 * 4. それでも失敗なら例外を投げる
 *
 * @param _runClaudeOverride - テスト用: runClaude の差し替え関数
 */
export async function processChunked(
  convText: string,
  chunks: TimelineChunk[],
  recipePrompt: string,
  sessionId: string,
  meta: SessionMeta,
  timeoutMs?: number,
  _runClaudeOverride?: (options: ClaudeRunOptions) => Promise<string>,
  externalSignal?: AbortSignal,
): Promise<string> {
  const run = _runClaudeOverride ?? runClaude
  const sessionInfo = `- Session ID: ${sessionId}\n- Project: ${meta.project || 'unknown'}\n- Created: ${meta.startTime.toISOString()}`

  const controller = new AbortController()

  // 外部 signal が abort されたら内部の controller も abort する
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }

  // --- Step 1: 全チャンクを並列実行 ---
  const sectionSettled = await Promise.allSettled(
    chunks.map(async (chunk) => {
      const chunkText = extractChunkText(convText, chunk)
      const sectionPrompt = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo)
      return await run({ prompt: sectionPrompt, timeoutMs, signal: controller.signal })
    })
  )

  // 結果を集約: index をキーにした Map で管理
  const sectionResults = new Map<number, string>()
  const failedIndices: number[] = []
  let hasAbortError = false

  for (let i = 0; i < sectionSettled.length; i++) {
    const result = sectionSettled[i]!
    if (result.status === 'fulfilled') {
      sectionResults.set(i, result.value)
    } else if (result.reason instanceof ClaudeAbortError) {
      hasAbortError = true
    } else {
      failedIndices.push(i)
    }
  }

  // 外部 signal による中断: リトライやフォールバックをスキップ
  if (hasAbortError && sectionResults.size === 0) {
    throw new ClaudeAbortError()
  }

  // --- Step 2: 失敗チャンクを1回リトライ ---
  let lastError: unknown = null

  if (failedIndices.length > 0) {
    log({ msg: 'chunk_retry', failedChunks: failedIndices.length, totalChunks: chunks.length })

    const retrySettled = await Promise.allSettled(
      failedIndices.map(async (idx) => {
        const chunk = chunks[idx]!
        const chunkText = extractChunkText(convText, chunk)
        const sectionPrompt = buildSectionPrompt(recipePrompt, chunk, chunkText, sessionInfo)
        return { idx, result: await run({ prompt: sectionPrompt, timeoutMs, signal: controller.signal }) }
      })
    )

    const stillFailedIndices: number[] = []
    for (const settled of retrySettled) {
      if (settled.status === 'fulfilled') {
        sectionResults.set(settled.value.idx, settled.value.result)
      } else {
        lastError = settled.reason
        // リトライ結果から失敗したindexを特定
        // Promise.allSettled は入力と同じ順序なので、failedIndices[i] で追跡
        stillFailedIndices.push(failedIndices[retrySettled.indexOf(settled)]!)
      }
    }

    // --- Step 3: まだ失敗があり、全体サイズが許容内なら分割なしフォールバック ---
    if (stillFailedIndices.length > 0) {
      const totalBytes = new TextEncoder().encode(convText).length
      if (totalBytes <= DEFAULT_MAX_CHUNK_BYTES) {
        log({ msg: 'fallback_unsplit', totalBytes, maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES })
        try {
          const fullPrompt = `${recipePrompt}

---
## セッション情報
${sessionInfo}

## 会話タイムライン
${convText}`
          const result = await run({ prompt: fullPrompt, timeoutMs, signal: controller.signal })
          // 分割なしフォールバック成功: synthesis 不要（1チャンク相当）
          return result
        } catch (err) {
          // Step 4: それでもダメなら例外を投げる
          throw err
        }
      } else {
        log({ msg: 'fallback_unsplit_skipped', reason: 'text_too_large', totalBytes, maxChunkBytes: DEFAULT_MAX_CHUNK_BYTES })
        throw lastError
      }
    }
  }

  // 全チャンク成功
  const orderedResults = chunks.map((_, i) => sectionResults.get(i)!)

  // チャンク1つの場合は synthesis 不要: セクション結果をそのまま返す
  if (orderedResults.length === 1) {
    return orderedResults[0]!
  }

  // 複数チャンク: 合成 (外部signalも渡す)
  const synthesisPrompt = buildSynthesisPrompt(orderedResults, sessionInfo)
  return run({ prompt: synthesisPrompt, timeoutMs, signal: externalSignal })
}

export interface RunProcessOptions {
  taskTimeoutMs?: number
  /** AbortSignal from the overall timeout. Propagated to runClaude calls. */
  signal?: AbortSignal
}

export async function runProcess(options: RunProcessOptions = {}): Promise<boolean> {
  const entry = await dequeue()
  if (!entry) {
    log({ msg: 'no_items_in_queue' })
    return false
  }

  const { sessionId, recipeName, key } = entry
  const config = await loadConfig()
  const dataDir = getDataDir()

  // Find session file
  const sessionFile = await findSessionFile(config.claudeDirs, sessionId)
  if (!sessionFile) {
    log({ key, msg: 'session_file_not_found' })
    await markFailed(key, 'session file not found')
    return true
  }

  // Find recipe
  let recipes: Recipe[]
  try {
    recipes = await loadRecipes(getRecipesDir())
  } catch {
    exitWithError(`No recipes found in ${getRecipesDir()}`)
  }

  const recipe = findRecipeByName(recipes, recipeName)
  if (!recipe) {
    log({ key, msg: 'recipe_not_found', recipe: recipeName })
    await markFailed(key, `recipe not found: ${recipeName}`)
    return true
  }

  // Get session metadata
  const meta = await getSessionMeta(sessionFile)

  // Early skip for empty session files (0 lines = no parseable JSONL content)
  if (meta.lineCount === 0) {
    log({ key, msg: 'empty_session' })
    await markFailed(key, 'empty session (0 lines)')
    return true
  }

  // Get session stats from claude-session-analysis (early fetch for log + frontmatter)
  let sessionStats: { turns?: number; bytes?: number; duration_ms?: number } = {}
  try {
    const statsResult = await spawnWithTimeout({
      cmd: [csaBin, 'sessions', '--format', 'jsonl', sessionId],
      timeoutMs: CSA_TIMEOUT_MS,
    })
    const line = statsResult.stdout.trim().split('\n')[0]
    if (line) sessionStats = JSON.parse(line)
  } catch (err) {
    if (err instanceof SpawnTimeoutError) {
      logError({ key, msg: 'csa_stats_timeout', timeoutMs: CSA_TIMEOUT_MS })
    }
    // fallback: use meta values
  }

  // Determine mode based on on_existing and done state
  let prompt = recipe.prompt
  let hasPreviousRun = false
  try {
    const doneFilePath = join(getDoneDir(), key)
    const doneFile = Bun.file(doneFilePath)
    if (await doneFile.exists()) {
      const prevLines = parseInt(await doneFile.text(), 10)
      if (!isNaN(prevLines) && meta.lineCount > prevLines) {
        hasPreviousRun = true
      }
    }
  } catch {
    // No previous done entry
  }

  if (hasPreviousRun) {
    switch (recipe.onExisting) {
      case 'skip':
        log({ key, msg: 'skip', reason: 'already_processed' })
        return true
      case 'append':
        prompt += '\n\n---\nNote: Session continued. Please append to existing entry.'
        break
      case 'separate':
        // New file, no modification needed
        break
    }
  }

  const sizeBytes = sessionStats.bytes ?? null
  const turns = sessionStats.turns ?? meta.userTurns
  const project = meta.project || 'unknown'
  log({ key, msg: 'start', recipe: recipeName, sizeBytes, turns, project })

  // Extract conversation timeline via claude-session-analysis
  let convText: string
  try {
    const csaResult = await spawnWithTimeout({
      cmd: [csaBin, 'timeline', sessionId, '--md', '--no-emoji'],
      timeoutMs: CSA_TIMEOUT_MS,
    })

    if (csaResult.exitCode !== 0) {
      logError({ key, msg: 'csa_failed', exitCode: csaResult.exitCode, stderr: csaResult.stderr })
      await markFailed(key, `csa failed with exit code ${csaResult.exitCode}`)
      return true
    }
    convText = csaResult.stdout
  } catch (err) {
    if (err instanceof SpawnTimeoutError) {
      logError({ key, msg: 'csa_timeline_timeout', timeoutMs: CSA_TIMEOUT_MS })
      await markFailed(key, `csa timeline timed out after ${CSA_TIMEOUT_MS}ms`)
      return true
    }
    throw err
  }

  if (!convText.trim()) {
    log({ key, msg: 'skip', reason: 'no_conversation' })
    await markDone(key, meta.lineCount)
    return true
  }

  // フォークセッションの場合、タイムラインを切り詰め＋プロンプト調整
  let timelineText = convText
  if (meta.forkInfo) {
    log({ key, msg: 'fork', parent: meta.forkInfo.parentSessionId })

    if (!meta.forkInfo.firstNewUuid) {
      log({ key, msg: 'skip', reason: 'fork_no_new_conversation' })
      await markDone(key, meta.lineCount)
      return true
    }

    const originalLen = convText.length
    timelineText = trimTimelineForFork(convText, meta.forkInfo.firstNewUuid)
    log({ key, msg: 'trimmed', from: originalLen, to: timelineText.length })
    prompt += `\n\n---\nNote: このセッションは元セッション ${meta.forkInfo.parentSessionId} からフォークされたものです。以下のタイムラインはフォーク後の新規会話のみです。`
  }

  // チャンク分割の判定
  const chunks = splitTimeline(timelineText)

  const { taskTimeoutMs, signal } = options

  try {
    let output: string
    const sessionStart = meta.startTime.toISOString()

    if (chunks.length > 1) {
      log({ key, msg: 'chunked', chunks: chunks.length })
      output = await processChunked(timelineText, chunks, prompt, sessionId, meta, taskTimeoutMs, undefined, signal)
    } else {
      // 既存の単一パス（変更なし）
      const fullPrompt = `${prompt}

---
## セッション情報
- Session ID: ${sessionId}
- Project: ${meta.project || 'unknown'}
- Created: ${sessionStart}

## 会話タイムライン
${timelineText}`
      output = await runClaude({ prompt: fullPrompt, addDir: dataDir, timeoutMs: taskTimeoutMs, signal })
    }

    // Generate frontmatter
    const sessionEnd = meta.endTime ? meta.endTime.toISOString() : 'unknown'
    const generatedAt = new Date().toISOString()
    const fmData: Record<string, unknown> = {
      session_id: sessionId,
      project: meta.project || 'unknown',
      session_start: sessionStart,
      session_end: sessionEnd,
      generated_at: generatedAt,
      recipe: recipeName,
      user_turns: sessionStats.turns ?? meta.userTurns,
      session_bytes: sessionStats.bytes,
      duration_ms: sessionStats.duration_ms,
    }
    if (meta.forkInfo) {
      fmData.forked_from = meta.forkInfo.parentSessionId
    }
    const fm = generateFrontmatter(fmData)

    // Output file path: {dataDir}/{recipeName}/YYYY/MM/DD/{yyyymmddTHHMMSSZ}.{sessionId}.md
    const datePath = formatDatePath(meta.startTime)
    const outputDir = join(dataDir, recipeName, datePath)
    await mkdir(outputDir, { recursive: true })

    const fileTs = formatFileTimestamp(meta.startTime)
    const outputFile = join(outputDir, `${fileTs}.${sessionId}.md`)

    await Bun.write(outputFile, fm + output)
    await markDone(key, meta.lineCount)
    log({ key, msg: 'success', output: outputFile })
  } catch (err) {
    const reason = err instanceof ClaudeTimeoutError
      ? `task timeout after ${err.timeoutMs}ms`
      : err instanceof Error ? err.message : String(err)
    if (err instanceof ClaudeTimeoutError) {
      logError({ key, msg: 'task_timeout', timeoutMs: err.timeoutMs })
    } else {
      logError({ key, msg: 'failed', error: reason })
    }
    await markFailed(key, reason)
  }

  return true
}

const sessionProcess = define({
  name: 'process',
  description: 'Process one item from the queue',
  run: async () => {
    await runProcess()
  },
})

export default sessionProcess
