import { mkdir, readdir, unlink, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getQueueDir, getDoneDir, getFailedDir } from './paths.ts'
import type { QueueEntry } from '../types/index.ts'

export interface QueueDirs {
  queueDir: string
  doneDir: string
  failedDir: string
}

function defaultDirs(): QueueDirs {
  return {
    queueDir: getQueueDir(),
    doneDir: getDoneDir(),
    failedDir: getFailedDir(),
  }
}

function makeKey(sessionId: string, recipeName: string): string {
  return `${sessionId}.${recipeName}`
}

function parseKey(key: string): { sessionId: string; recipeName: string } {
  const lastDot = key.lastIndexOf('.')
  return {
    sessionId: key.slice(0, lastDot),
    recipeName: key.slice(lastDot + 1),
  }
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

export async function enqueue(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.queueDir)
  const key = makeKey(sessionId, recipeName)
  await Bun.write(join(d.queueDir, key), '')
}

export async function dequeue(dirs?: QueueDirs): Promise<QueueEntry | null> {
  const d = dirs ?? defaultDirs()
  const files = await listFiles(d.queueDir)
  if (files.length === 0) return null

  // Find the newest file by mtime (prioritize recent sessions)
  let newest: { name: string; mtime: number } | null = null
  for (const name of files) {
    try {
      const s = await stat(join(d.queueDir, name))
      if (newest === null || s.mtimeMs > newest.mtime) {
        newest = { name, mtime: s.mtimeMs }
      }
    } catch {
      // File may have been removed concurrently
    }
  }

  if (newest === null) return null

  const { sessionId, recipeName } = parseKey(newest.name)
  await unlink(join(d.queueDir, newest.name))

  return { sessionId, recipeName, key: newest.name }
}

export async function markDone(key: string, lineCount: number, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.doneDir)
  await Bun.write(join(d.doneDir, key), String(lineCount))
  // Remove from queue if present
  try {
    await unlink(join(d.queueDir, key))
  } catch {
    // May not exist in queue
  }
}

export async function markFailed(key: string, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.failedDir)
  try {
    await rename(join(d.queueDir, key), join(d.failedDir, key))
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Queue file may already be removed (e.g. by dequeue), create failed marker directly
      await Bun.write(join(d.failedDir, key), '')
    } else {
      throw err
    }
  }
}

export async function isDone(sessionId: string, recipeName: string, currentLineCount: number, dirs?: QueueDirs): Promise<boolean> {
  const d = dirs ?? defaultDirs()
  const key = makeKey(sessionId, recipeName)
  try {
    const file = Bun.file(join(d.doneDir, key))
    const content = await file.text()
    const doneLines = parseInt(content, 10)
    return !isNaN(doneLines) && doneLines >= currentLineCount
  } catch {
    return false
  }
}

export async function isQueued(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<boolean> {
  const d = dirs ?? defaultDirs()
  const key = makeKey(sessionId, recipeName)
  const file = Bun.file(join(d.queueDir, key))
  return file.exists()
}

export async function isFailed(sessionId: string, recipeName: string, dirs?: QueueDirs): Promise<boolean> {
  const d = dirs ?? defaultDirs()
  const key = makeKey(sessionId, recipeName)
  const file = Bun.file(join(d.failedDir, key))
  return file.exists()
}

export async function retry(key: string, dirs?: QueueDirs): Promise<void> {
  const d = dirs ?? defaultDirs()
  await ensureDir(d.queueDir)
  await rename(join(d.failedDir, key), join(d.queueDir, key))
}

export async function getStatus(dirs?: QueueDirs): Promise<{ queued: number; done: number; failed: number }> {
  const d = dirs ?? defaultDirs()
  const [queueFiles, doneFiles, failedFiles] = await Promise.all([
    listFiles(d.queueDir),
    listFiles(d.doneDir),
    listFiles(d.failedDir),
  ])
  return {
    queued: queueFiles.length,
    done: doneFiles.length,
    // Exclude .log files from failed count (matching shell script behavior)
    failed: failedFiles.filter(f => !f.endsWith('.log')).length,
  }
}

export async function cleanup(
  isSessionExists: (sid: string) => Promise<boolean>,
  dirs?: QueueDirs,
): Promise<number> {
  const d = dirs ?? defaultDirs()
  const files = await listFiles(d.failedDir)
  let removed = 0

  for (const name of files) {
    // Skip .log files
    if (name.endsWith('.log')) continue

    const { sessionId } = parseKey(name)
    const exists = await isSessionExists(sessionId)
    if (!exists) {
      await unlink(join(d.failedDir, name))
      removed++
    }
  }

  return removed
}
