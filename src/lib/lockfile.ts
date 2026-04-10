import { open, readFile, unlink, mkdir, utimes, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

export const HEARTBEAT_INTERVAL_MS = 30_000 // 30 seconds
export const STALE_THRESHOLD_MS = 5 * 60_000 // 5 minutes

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 does not kill the process, just checks if it exists
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Acquire a lock file atomically using O_CREAT | O_EXCL.
 * Writes the current PID to the lock file.
 * If a lock file already exists, checks whether the PID is still alive (stale lock detection).
 *
 * @returns A release function if the lock was acquired, or null if the lock is held by a live process.
 */
export async function acquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  // Ensure parent directory exists
  await mkdir(dirname(lockPath), { recursive: true })

  // Attempt atomic creation with O_CREAT | O_EXCL | O_WRONLY ('wx' flag)
  try {
    const fh = await open(lockPath, 'wx')
    await fh.writeFile(String(process.pid))
    await fh.close()
    return createRelease(lockPath, startHeartbeat(lockPath))
  } catch (err: unknown) {
    if (!isEexist(err)) {
      throw err
    }
  }

  // Lock file already exists (EEXIST) — check if stale
  try {
    const content = await readFile(lockPath, 'utf-8')
    const pid = parseInt(content.trim(), 10)
    if (!isNaN(pid) && isProcessAlive(pid)) {
      // PID alive — check heartbeat freshness
      try {
        const s = await stat(lockPath)
        if (Date.now() - s.mtimeMs < STALE_THRESHOLD_MS) {
          return null // active lock with fresh heartbeat
        }
        // Heartbeat stale — hung process
      } catch {
        // stat failed — treat as stale
      }
    }
  } catch {
    // File may have been removed between our open attempt and readFile — treat as stale
  }

  // Stale lock — remove and retry atomically
  try {
    await unlink(lockPath)
  } catch {
    // Another process may have already removed it — that's fine
  }

  try {
    const fh = await open(lockPath, 'wx')
    await fh.writeFile(String(process.pid))
    await fh.close()
    return createRelease(lockPath, startHeartbeat(lockPath))
  } catch (err: unknown) {
    if (isEexist(err)) {
      // Another process won the race after stale removal
      return null
    }
    throw err
  }
}

function startHeartbeat(lockPath: string): ReturnType<typeof setInterval> {
  const id = setInterval(async () => {
    try {
      const now = new Date()
      await utimes(lockPath, now, now)
    } catch {
      // Best effort: file may have been removed
    }
  }, HEARTBEAT_INTERVAL_MS)
  // Don't let the heartbeat timer prevent process exit
  id.unref()
  return id
}

function createRelease(lockPath: string, heartbeatId: ReturnType<typeof setInterval>): () => Promise<void> {
  return async () => {
    clearInterval(heartbeatId)
    try {
      await unlink(lockPath)
    } catch {
      // Best effort: file may already be removed
    }
  }
}

function isEexist(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST'
}
