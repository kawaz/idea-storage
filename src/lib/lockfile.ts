import { open, readFile, unlink, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

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
    return createRelease(lockPath)
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
      // Lock held by a live process
      return null
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
    return createRelease(lockPath)
  } catch (err: unknown) {
    if (isEexist(err)) {
      // Another process won the race after stale removal
      return null
    }
    throw err
  }
}

function createRelease(lockPath: string): () => Promise<void> {
  return async () => {
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
