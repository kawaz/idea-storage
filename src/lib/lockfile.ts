import { writeFile, link, readFile, unlink, mkdir, utimes, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
export const STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 does not kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically create the lock file with content already written.
 *
 * Design rationale: We deliberately avoid the naive `open(path, "wx")` then
 * `writeFile(pid)` pattern. That pattern has a race window where another
 * caller can `readFile()` the just-created (still empty) lock file, see no
 * valid PID, conclude it is stale, `unlink()` the winner's lock, and steal
 * it. Instead we write the PID to a unique temp file first, then `link()`
 * it to the target path. `link(2)` is atomic and fails with EEXIST if the
 * target already exists, so the lock file is never observable in an empty
 * state to other callers.
 *
 * @returns true if the lock was created by this call.
 * @throws on EEXIST (caller distinguishes via {@link isEexist}).
 */
async function tryCreateLockAtomically(lockPath: string, pid: number): Promise<void> {
  const tmpPath = join(
    dirname(lockPath),
    `.${basename(lockPath)}.${pid}.${process.hrtime.bigint().toString(36)}.tmp`,
  );
  await writeFile(tmpPath, String(pid), { flag: "wx" });
  try {
    await link(tmpPath, lockPath);
  } finally {
    // Always remove the temp file: link() copies the inode, the temp name is
    // no longer needed regardless of success/failure.
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Acquire a lock file atomically using a write-then-link pattern.
 * Writes the current PID to the lock file. If a lock file already exists,
 * checks whether the PID is still alive (stale lock detection).
 *
 * @returns A release function if the lock was acquired, or null if the lock is held by a live process.
 */
export async function acquireLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  // Ensure parent directory exists
  await mkdir(dirname(lockPath), { recursive: true });

  // First atomic creation attempt
  try {
    await tryCreateLockAtomically(lockPath, process.pid);
    return createRelease(lockPath, startHeartbeat(lockPath));
  } catch (err: unknown) {
    if (!isEexist(err)) {
      throw err;
    }
  }

  // Lock file already exists (EEXIST) — check if stale
  if (!(await isLockStale(lockPath))) {
    return null; // active lock with live PID and fresh heartbeat
  }

  // Stale lock — remove and retry atomically
  try {
    await unlink(lockPath);
  } catch {
    // Another process may have already removed it — that's fine
  }

  try {
    await tryCreateLockAtomically(lockPath, process.pid);
    return createRelease(lockPath, startHeartbeat(lockPath));
  } catch (err: unknown) {
    if (isEexist(err)) {
      // Another process won the race after stale removal
      return null;
    }
    throw err;
  }
}

/**
 * Determine whether an existing lock file is stale (held by a dead or hung process).
 *
 * Returns true if the lock should be considered stale (safe to remove and retry).
 * Returns false if the lock is actively held.
 *
 * If the file content cannot yet be parsed as a PID we conservatively treat
 * the lock as active — the writer may simply be in flight. With the
 * write-then-link creation pattern this case should not occur, but we keep
 * the conservative behavior to avoid false stale-recovery if the lock file
 * is ever populated by other means.
 */
async function isLockStale(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(lockPath, "utf-8");
  } catch {
    // File may have been removed between our open attempt and readFile.
    return true;
  }

  const pid = parseInt(content.trim(), 10);
  if (isNaN(pid)) {
    // Non-PID content: treat as stale (legacy/garbage lock file).
    return true;
  }

  if (!isProcessAlive(pid)) {
    return true;
  }

  // PID alive — check heartbeat freshness via mtime.
  try {
    const s = await stat(lockPath);
    return Date.now() - s.mtimeMs >= STALE_THRESHOLD_MS;
  } catch {
    // stat failed — file vanished, treat as stale.
    return true;
  }
}

function startHeartbeat(lockPath: string): ReturnType<typeof setInterval> {
  const id = setInterval(async () => {
    try {
      const now = new Date();
      await utimes(lockPath, now, now);
    } catch {
      // Best effort: file may have been removed
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't let the heartbeat timer prevent process exit
  id.unref();
  return id;
}

function createRelease(
  lockPath: string,
  heartbeatId: ReturnType<typeof setInterval>,
): () => Promise<void> {
  return async () => {
    clearInterval(heartbeatId);
    try {
      await unlink(lockPath);
    } catch {
      // Best effort: file may already be removed
    }
  };
}

function isEexist(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "EEXIST";
}
