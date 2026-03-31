import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
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
 * Acquire a lock file. Writes the current PID to the lock file.
 * If a lock file already exists, checks whether the PID is still alive (stale lock detection).
 *
 * @returns A release function if the lock was acquired, or null if the lock is held by a live process.
 */
export async function acquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  // Ensure parent directory exists
  await mkdir(dirname(lockPath), { recursive: true })

  // Check existing lock
  try {
    const content = await readFile(lockPath, 'utf-8')
    const pid = parseInt(content.trim(), 10)
    if (!isNaN(pid) && isProcessAlive(pid)) {
      // Lock held by a live process
      return null
    }
    // Stale lock (dead PID, invalid content, or empty) — proceed to overwrite
  } catch {
    // No existing lock file — proceed to create
  }

  // Write current PID
  await writeFile(lockPath, String(process.pid))

  // Return release function
  return async () => {
    try {
      await unlink(lockPath)
    } catch {
      // Best effort: file may already be removed
    }
  }
}
