import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dirExists } from './dir-exists.ts'

describe('dirExists', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dir-exists-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('returns true for an existing directory', async () => {
    const dir = join(tempDir, 'subdir')
    await mkdir(dir)
    expect(await dirExists(dir)).toBe(true)
  })

  test('returns false for a non-existent path', async () => {
    const dir = join(tempDir, 'nonexistent')
    expect(await dirExists(dir)).toBe(false)
  })

  test('returns false for a file (not a directory)', async () => {
    const filePath = join(tempDir, 'file.txt')
    await Bun.write(filePath, 'content')
    expect(await dirExists(filePath)).toBe(false)
  })
})
