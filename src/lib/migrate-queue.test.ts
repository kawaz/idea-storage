import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { QueueDirs } from './queue.ts'
import { getDb } from './queue.ts'
import { migrateIfNeeded } from './migrate-queue.ts'

const SID1 = '00000000-0000-4000-a000-000000000001'
const SID2 = '00000000-0000-4000-a000-000000000002'
const SID3 = '00000000-0000-4000-a000-000000000003'

describe('migrateIfNeeded', () => {
  let dirs: QueueDirs
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'migrate-test-'))
    dirs = {
      queueDir: join(tempDir, 'queue') + '/',
      doneDir: join(tempDir, 'done') + '/',
      failedDir: join(tempDir, 'failed') + '/',
    }
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('queue, done, failed ディレクトリがない場合は null を返す', async () => {
    const result = await migrateIfNeeded(dirs)
    expect(result).toBeNull()
  })

  test('queue.bak が既に存在する場合はスキップして null を返す', async () => {
    await mkdir(join(tempDir, 'queue.bak'))
    await mkdir(dirs.queueDir, { recursive: true })
    await Bun.write(join(dirs.queueDir, `${SID1}.diary`), '')

    const result = await migrateIfNeeded(dirs)
    expect(result).toBeNull()
  })

  test('queue ファイルを SQLite に移行する', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await Bun.write(join(dirs.queueDir, `${SID1}.diary`), '')
    await Bun.write(join(dirs.queueDir, `${SID2}.report`), '')

    const result = await migrateIfNeeded(dirs)
    expect(result).toBe(2)

    // DB に queued エントリが存在する
    const db = getDb(dirs)
    const rows = db.query("SELECT key, status FROM queue_entries WHERE status = 'queued'").all() as { key: string; status: string }[]
    db.close()
    expect(rows.length).toBe(2)
  })

  test('done ファイルを SQLite に移行する', async () => {
    await mkdir(dirs.queueDir, { recursive: true }) // queue dir must exist for migration trigger
    await mkdir(dirs.doneDir, { recursive: true })
    await Bun.write(join(dirs.doneDir, `${SID1}.diary`), '42')

    const result = await migrateIfNeeded(dirs)
    expect(result).toBe(1)

    const db = getDb(dirs)
    const row = db.query("SELECT line_count FROM queue_entries WHERE key = ? AND status = 'done'").get(`${SID1}.diary`) as { line_count: number } | null
    db.close()
    expect(row).not.toBeNull()
    expect(row!.line_count).toBe(42)
  })

  test('failed ファイル（JSON）を SQLite に移行する', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await mkdir(dirs.failedDir, { recursive: true })
    await Bun.write(join(dirs.failedDir, `${SID1}.diary`), JSON.stringify({ retryCount: 2, reason: 'timeout' }))

    const result = await migrateIfNeeded(dirs)
    expect(result).toBe(1)

    const db = getDb(dirs)
    const row = db.query("SELECT retry_count, fail_reason FROM queue_entries WHERE key = ? AND status = 'failed'").get(`${SID1}.diary`) as { retry_count: number; fail_reason: string | null } | null
    db.close()
    expect(row).not.toBeNull()
    expect(row!.retry_count).toBe(2)
    expect(row!.fail_reason).toBe('timeout')
  })

  test('failed の空ファイルは retryCount=0 で移行する', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await mkdir(dirs.failedDir, { recursive: true })
    await Bun.write(join(dirs.failedDir, `${SID1}.diary`), '')

    await migrateIfNeeded(dirs)

    const db = getDb(dirs)
    const row = db.query("SELECT retry_count FROM queue_entries WHERE key = ?").get(`${SID1}.diary`) as { retry_count: number } | null
    db.close()
    expect(row!.retry_count).toBe(0)
  })

  test('failed の .log ファイルは無視する', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await mkdir(dirs.failedDir, { recursive: true })
    await Bun.write(join(dirs.failedDir, 'some.log'), 'error log')
    await Bun.write(join(dirs.failedDir, `${SID1}.diary`), JSON.stringify({ retryCount: 1 }))

    const result = await migrateIfNeeded(dirs)
    expect(result).toBe(1) // .log は無視
  })

  test('done と queue の重複がある場合 done を優先する', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await mkdir(dirs.doneDir, { recursive: true })
    await Bun.write(join(dirs.queueDir, `${SID1}.diary`), '')
    await Bun.write(join(dirs.doneDir, `${SID1}.diary`), '100')

    await migrateIfNeeded(dirs)

    const db = getDb(dirs)
    const row = db.query("SELECT status, line_count FROM queue_entries WHERE key = ?").get(`${SID1}.diary`) as { status: string; line_count: number | null } | null
    db.close()
    expect(row!.status).toBe('done')
    expect(row!.line_count).toBe(100)
  })

  test('移行後に queue, done, failed ディレクトリが .bak にリネームされる', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await mkdir(dirs.doneDir, { recursive: true })
    await mkdir(dirs.failedDir, { recursive: true })
    await Bun.write(join(dirs.queueDir, `${SID1}.diary`), '')

    await migrateIfNeeded(dirs)

    // .bak が存在する
    const queueBak = await stat(join(tempDir, 'queue.bak')).catch(() => null)
    expect(queueBak).not.toBeNull()

    // 元のディレクトリは存在しない
    const queueDir = await stat(dirs.queueDir.replace(/\/$/, '')).catch(() => null)
    expect(queueDir).toBeNull()
  })

  test('混合データの移行', async () => {
    await mkdir(dirs.queueDir, { recursive: true })
    await mkdir(dirs.doneDir, { recursive: true })
    await mkdir(dirs.failedDir, { recursive: true })
    await Bun.write(join(dirs.queueDir, `${SID1}.diary`), '')
    await Bun.write(join(dirs.doneDir, `${SID2}.report`), '75')
    await Bun.write(join(dirs.failedDir, `${SID3}.summary`), JSON.stringify({ retryCount: 1, reason: 'api error' }))

    const result = await migrateIfNeeded(dirs)
    expect(result).toBe(3)

    const db = getDb(dirs)
    const all = db.query('SELECT key, status FROM queue_entries ORDER BY key').all() as { key: string; status: string }[]
    db.close()
    expect(all).toEqual([
      { key: `${SID1}.diary`, status: 'queued' },
      { key: `${SID2}.report`, status: 'done' },
      { key: `${SID3}.summary`, status: 'failed' },
    ])
  })
})
