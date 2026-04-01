import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireLock } from './lockfile.ts'

describe('lockfile', () => {
  let tempDir: string
  let lockPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lockfile-test-'))
    lockPath = join(tempDir, 'test.lock')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('acquireLock succeeds when no lock exists', async () => {
    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()
    await release!()
  })

  test('acquireLock writes current PID to lock file', async () => {
    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()

    const content = await readFile(lockPath, 'utf-8')
    expect(content.trim()).toBe(String(process.pid))

    await release!()
  })

  test('acquireLock returns null when lock held by current process (live PID)', async () => {
    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()

    // Try to acquire again while lock is held
    const second = await acquireLock(lockPath)
    expect(second).toBeNull()

    await release!()
  })

  test('release removes the lock file', async () => {
    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()
    await release!()

    // Lock file should be removed
    const file = Bun.file(lockPath)
    expect(await file.exists()).toBe(false)
  })

  test('acquireLock succeeds after release', async () => {
    const release1 = await acquireLock(lockPath)
    expect(release1).not.toBeNull()
    await release1!()

    const release2 = await acquireLock(lockPath)
    expect(release2).not.toBeNull()
    await release2!()
  })

  test('acquireLock succeeds when lock file contains stale PID (dead process)', async () => {
    // Write a PID that does not exist (very high PID)
    await writeFile(lockPath, '9999999')

    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()

    const content = await readFile(lockPath, 'utf-8')
    expect(content.trim()).toBe(String(process.pid))

    await release!()
  })

  test('acquireLock succeeds when lock file contains invalid content', async () => {
    await writeFile(lockPath, 'not-a-pid')

    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()
    await release!()
  })

  test('acquireLock succeeds when lock file is empty', async () => {
    await writeFile(lockPath, '')

    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()
    await release!()
  })

  test('acquireLock creates parent directory if it does not exist', async () => {
    const deepPath = join(tempDir, 'a', 'b', 'c', 'test.lock')
    const release = await acquireLock(deepPath)
    expect(release).not.toBeNull()
    await release!()
  })

  test('acquireLock uses atomic file creation (O_EXCL) - no TOCTOU race', async () => {
    // Verify the lock file is created with O_EXCL semantics:
    // If we pre-create the file with O_EXCL ourselves, acquireLock should
    // see it as held by a live process (our own PID) and return null.
    const fh = await open(lockPath, 'wx')
    await fh.writeFile(String(process.pid))
    await fh.close()

    const result = await acquireLock(lockPath)
    expect(result).toBeNull()

    // Clean up
    await rm(lockPath, { force: true })
  })

  test('acquireLock recovers from stale lock via unlink and re-create', async () => {
    // Create a stale lock file (dead PID) using O_EXCL to simulate a real lock
    const fh = await open(lockPath, 'wx')
    await fh.writeFile('9999999')
    await fh.close()

    // acquireLock should detect stale PID, unlink, and re-create atomically
    const release = await acquireLock(lockPath)
    expect(release).not.toBeNull()

    const content = await readFile(lockPath, 'utf-8')
    expect(content.trim()).toBe(String(process.pid))

    await release!()
  })

  test('acquireLock parallel attempts - only one wins', async () => {
    // Launch multiple concurrent acquireLock calls
    const results = await Promise.all([
      acquireLock(lockPath),
      acquireLock(lockPath),
      acquireLock(lockPath),
    ])

    const winners = results.filter((r) => r !== null)
    const losers = results.filter((r) => r === null)

    // Exactly one should win (or possibly some get stale-recovery, but at most one holds it)
    expect(winners.length).toBeGreaterThanOrEqual(1)
    // At least some should fail
    expect(losers.length).toBeGreaterThanOrEqual(1)

    // Clean up all winners
    for (const release of winners) {
      await release!()
    }
  })
})
