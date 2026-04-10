import { readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { QueueDirs } from './queue.ts'
import { getDb } from './queue.ts'
import { getQueueDir, getDoneDir, getFailedDir } from './paths.ts'

interface ResolvedDirs {
  queueDir: string
  doneDir: string
  failedDir: string
}

function resolveDirs(dirs?: QueueDirs): ResolvedDirs {
  if (dirs) {
    return {
      queueDir: dirs.queueDir,
      doneDir: dirs.doneDir,
      failedDir: dirs.failedDir,
    }
  }
  return {
    queueDir: getQueueDir(),
    doneDir: getDoneDir(),
    failedDir: getFailedDir(),
  }
}

/** Strip trailing slash and append .bak */
function bakPath(dirPath: string): string {
  return dirPath.replace(/\/$/, '') + '.bak'
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path.replace(/\/$/, ''))
    return s.isDirectory()
  } catch {
    return false
  }
}

async function readFiles(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath)
  } catch {
    return []
  }
}

/**
 * ファイルベースのキューデータを SQLite に移行する。
 * 既にマイグレーション済み（.bak ディレクトリが存在）の場合はスキップ。
 *
 * @returns 移行したエントリ数、またはスキップ時は null
 */
export async function migrateIfNeeded(dirs?: QueueDirs): Promise<number | null> {
  const resolved = resolveDirs(dirs)

  // 1. .bak ディレクトリの存在チェック
  if (await dirExists(bakPath(resolved.queueDir))) {
    return null
  }

  // 2. queue/ ディレクトリの存在チェック
  if (!(await dirExists(resolved.queueDir))) {
    return null
  }

  // 3. SQLite DB を open
  const db = getDb(dirs)
  let count = 0

  try {
    // 4. トランザクション内で移行
    db.run('BEGIN')

    // Collect done keys first to handle queue/done duplicates
    const doneKeys = new Set<string>()

    // 4b. done/ の全ファイルを読む
    const doneFiles = await readFiles(resolved.doneDir)
    for (const filename of doneFiles) {
      const filePath = join(resolved.doneDir, filename)
      const content = await Bun.file(filePath).text()
      const lineCount = content.trim() === '' ? 0 : parseInt(content.trim(), 10)
      const fileStat = await stat(filePath)

      const key = filename
      const firstDot = key.indexOf('.')
      const sessionId = key.slice(0, firstDot)
      const recipeName = key.slice(firstDot + 1)

      db.run(
        `INSERT OR REPLACE INTO queue_entries (key, session_id, recipe_name, status, line_count, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, 'done', ?, 0, ?, ?)`,
        [key, sessionId, recipeName, lineCount, fileStat.mtimeMs, fileStat.mtimeMs],
      )
      doneKeys.add(key)
      count++
    }

    // 4a. queue/ の全ファイルを読む（done にある key はスキップ）
    const queueFiles = await readFiles(resolved.queueDir)
    for (const filename of queueFiles) {
      const key = filename
      if (doneKeys.has(key)) continue // done を優先

      const filePath = join(resolved.queueDir, filename)
      const fileStat = await stat(filePath)

      const firstDot = key.indexOf('.')
      const sessionId = key.slice(0, firstDot)
      const recipeName = key.slice(firstDot + 1)

      db.run(
        `INSERT OR IGNORE INTO queue_entries (key, session_id, recipe_name, status, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
        [key, sessionId, recipeName, fileStat.mtimeMs, fileStat.mtimeMs],
      )
      count++
    }

    // 4c. failed/ の全ファイルを読む（.log は除く）
    const failedFiles = await readFiles(resolved.failedDir)
    for (const filename of failedFiles) {
      if (filename.endsWith('.log')) continue

      const filePath = join(resolved.failedDir, filename)
      const content = await Bun.file(filePath).text()
      const fileStat = await stat(filePath)

      let retryCount = 0
      let reason: string | null = null

      if (content.trim() !== '') {
        try {
          const meta = JSON.parse(content) as { retryCount?: number; reason?: string }
          retryCount = meta.retryCount ?? 0
          reason = meta.reason ?? null
        } catch {
          // Non-JSON content, treat as empty
        }
      }

      const key = filename
      const firstDot = key.indexOf('.')
      const sessionId = key.slice(0, firstDot)
      const recipeName = key.slice(firstDot + 1)

      db.run(
        `INSERT OR IGNORE INTO queue_entries (key, session_id, recipe_name, status, retry_count, fail_reason, created_at, updated_at)
         VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`,
        [key, sessionId, recipeName, retryCount, reason, fileStat.mtimeMs, fileStat.mtimeMs],
      )
      count++
    }

    db.run('COMMIT')
  } catch (err) {
    db.run('ROLLBACK')
    throw err
  } finally {
    // 5. DB を close
    db.close()
  }

  // 6. ディレクトリをリネーム
  if (await dirExists(resolved.queueDir)) {
    await rename(resolved.queueDir.replace(/\/$/, ''), bakPath(resolved.queueDir))
  }
  if (await dirExists(resolved.doneDir)) {
    await rename(resolved.doneDir.replace(/\/$/, ''), bakPath(resolved.doneDir))
  }
  if (await dirExists(resolved.failedDir)) {
    await rename(resolved.failedDir.replace(/\/$/, ''), bakPath(resolved.failedDir))
  }

  // 7. 移行したエントリ数を返す
  return count
}
