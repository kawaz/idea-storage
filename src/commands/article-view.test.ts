import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  listViewEntries,
  formatViewEntry,
  formatAgeFromDate,
  formatSizeKB,
  sortEntries,
  nextSortOrder,
  type ViewEntry,
} from './article-view.ts'

describe('view command', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'idea-storage-view-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  describe('listViewEntries', () => {
    test('returns empty array for empty directory', async () => {
      const entries = await listViewEntries(tempDir)
      expect(entries).toEqual([])
    })

    test('detects .md files with correct fields', async () => {
      const recipeDir = join(tempDir, 'ai-diary', '2025', '01', '15')
      await Bun.write(join(recipeDir, 'diary.md'), 'line1\nline2\nline3\n')

      const entries = await listViewEntries(tempDir)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.fullPath).toBe(join(recipeDir, 'diary.md'))
      expect(entries[0]!.relativePath).toBe('ai-diary/2025/01/15/diary.md')
      expect(entries[0]!.mtime).toBeInstanceOf(Date)
      expect(entries[0]!.sizeBytes).toBeGreaterThan(0)
    })

    test('detects files across multiple recipe directories', async () => {
      await Bun.write(join(tempDir, 'ai-diary', '2025', '01', '15', 'diary.md'), 'line1\n')
      await Bun.write(join(tempDir, 'roast', '2025', '01', '15', 'roast.md'), 'line1\nline2\n')

      const entries = await listViewEntries(tempDir)
      expect(entries).toHaveLength(2)
    })

    test('captures file size correctly', async () => {
      const content = 'hello world\n'
      await Bun.write(join(tempDir, 'recipe', 'test.md'), content)

      const entries = await listViewEntries(tempDir)
      expect(entries[0]!.sizeBytes).toBe(Buffer.byteLength(content))
    })

    test('reports size 0 for empty file', async () => {
      await Bun.write(join(tempDir, 'recipe', 'empty.md'), '')

      const entries = await listViewEntries(tempDir)
      expect(entries[0]!.sizeBytes).toBe(0)
    })

    test('ignores non-.md files', async () => {
      await Bun.write(join(tempDir, 'recipe', 'test.md'), 'md\n')
      await Bun.write(join(tempDir, 'recipe', 'test.txt'), 'txt\n')
      await Bun.write(join(tempDir, 'recipe', 'test.json'), '{}')

      const entries = await listViewEntries(tempDir)
      expect(entries).toHaveLength(1)
      expect(entries[0]!.relativePath).toBe('recipe/test.md')
    })

    test('builds relativePath from dataDir', async () => {
      await Bun.write(join(tempDir, 'my-recipe', 'sub', 'deep', 'file.md'), 'content\n')

      const entries = await listViewEntries(tempDir)
      expect(entries[0]!.relativePath).toBe('my-recipe/sub/deep/file.md')
    })

    test('handles .md files directly under dataDir', async () => {
      await Bun.write(join(tempDir, 'root-file.md'), 'content\n')

      const entries = await listViewEntries(tempDir)
      expect(entries[0]!.relativePath).toBe('root-file.md')
    })
  })

  describe('formatAgeFromDate', () => {
    test('returns seconds for < 60s', () => {
      const mtime = new Date(Date.now() - 30 * 1000)
      expect(formatAgeFromDate(mtime)).toBe('30s')
    })

    test('returns minutes for >= 60s and < 3600s', () => {
      const mtime = new Date(Date.now() - 5 * 60 * 1000)
      expect(formatAgeFromDate(mtime)).toBe('5m')
    })

    test('returns hours for >= 3600s and < 86400s', () => {
      const mtime = new Date(Date.now() - 12 * 3600 * 1000)
      expect(formatAgeFromDate(mtime)).toBe('12h')
    })

    test('returns days for >= 86400s', () => {
      const mtime = new Date(Date.now() - 3 * 86400 * 1000)
      expect(formatAgeFromDate(mtime)).toBe('3d')
    })

    test('truncates (floors) fractional values', () => {
      // 89 seconds => 1m (not 1.48m)
      const mtime = new Date(Date.now() - 89 * 1000)
      expect(formatAgeFromDate(mtime)).toBe('1m')
    })
  })

  describe('formatSizeKB', () => {
    test('returns 1KB for 0 bytes', () => {
      expect(formatSizeKB(0)).toBe('1KB')
    })

    test('returns 1KB for 1 byte', () => {
      expect(formatSizeKB(1)).toBe('1KB')
    })

    test('returns 1KB for 1024 bytes', () => {
      expect(formatSizeKB(1024)).toBe('1KB')
    })

    test('returns 2KB for 1025 bytes', () => {
      expect(formatSizeKB(1025)).toBe('2KB')
    })

    test('adds comma separators for large sizes', () => {
      expect(formatSizeKB(1_500_000)).toBe('1,465KB')
    })

    test('adds comma separators for very large sizes', () => {
      expect(formatSizeKB(10_000_000)).toBe('9,766KB')
    })
  })

  describe('sortEntries', () => {
    const now = Date.now()
    const entries: ViewEntry[] = [
      {
        fullPath: '/data/roast/2025/b.md',
        relativePath: 'roast/2025/b.md',
        mtime: new Date(now - 1000),
        sizeBytes: 1024,
      },
      {
        fullPath: '/data/ai-diary/2025/a.md',
        relativePath: 'ai-diary/2025/a.md',
        mtime: new Date(now - 5000),
        sizeBytes: 51200,
      },
      {
        fullPath: '/data/todo/2025/c.md',
        relativePath: 'todo/2025/c.md',
        mtime: new Date(now - 3000),
        sizeBytes: 30720,
      },
    ]

    test('sorts by recipe (relativePath alphabetical)', () => {
      const sorted = sortEntries(entries, 'recipe')
      expect(sorted.map(e => e.relativePath)).toEqual([
        'ai-diary/2025/a.md',
        'roast/2025/b.md',
        'todo/2025/c.md',
      ])
    })

    test('sorts by date (mtime ascending)', () => {
      const sorted = sortEntries(entries, 'date')
      expect(sorted.map(e => e.relativePath)).toEqual([
        'ai-diary/2025/a.md',
        'todo/2025/c.md',
        'roast/2025/b.md',
      ])
    })

    test('sorts by size descending, then relativePath ascending', () => {
      const sorted = sortEntries(entries, 'size')
      expect(sorted.map(e => e.relativePath)).toEqual([
        'ai-diary/2025/a.md',
        'todo/2025/c.md',
        'roast/2025/b.md',
      ])
    })

    test('does not mutate original array', () => {
      const original = [...entries]
      sortEntries(entries, 'size')
      expect(entries).toEqual(original)
    })
  })

  describe('nextSortOrder', () => {
    test('rotates recipe -> date -> size -> recipe', () => {
      expect(nextSortOrder('recipe')).toBe('date')
      expect(nextSortOrder('date')).toBe('size')
      expect(nextSortOrder('size')).toBe('recipe')
    })
  })

  describe('formatViewEntry', () => {
    test('produces 3 tab-separated fields', () => {
      const entry: ViewEntry = {
        fullPath: '/data/ai-diary/2025/01/15/diary.md',
        relativePath: 'ai-diary/2025/01/15/diary.md',
        mtime: new Date(Date.now() - 3 * 86400 * 1000),
        sizeBytes: 42 * 1024,
      }

      const parts = formatViewEntry(entry, 3, 5).split('\t')
      expect(parts).toHaveLength(3)
      expect(parts[0]).toBe('/data/ai-diary/2025/01/15/diary.md')
      // field 2 is ISO string
      expect(parts[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    test('pads age and size correctly', () => {
      const entry: ViewEntry = {
        fullPath: '/path/to/file.md',
        relativePath: 'recipe/file.md',
        mtime: new Date(Date.now() - 3 * 86400 * 1000),
        sizeBytes: 42 * 1024,
      }

      const display = formatViewEntry(entry, 5, 4).split('\t')[2]!
      // age = "3d" padded to 5 => "   3d"
      // size = "42KB" padded to 4 => "42KB"
      expect(display).toBe('   3d  42KB  recipe/file.md')
    })

    test('includes relativePath in display', () => {
      const entry: ViewEntry = {
        fullPath: '/data/ai-diary/2025/01/15/diary.md',
        relativePath: 'ai-diary/2025/01/15/diary.md',
        mtime: new Date(),
        sizeBytes: 1024,
      }

      const display = formatViewEntry(entry, 3, 4).split('\t')[2]!
      expect(display).toContain('ai-diary/2025/01/15/diary.md')
    })

    test('formats size with comma separators', () => {
      const entry: ViewEntry = {
        fullPath: '/path/to/file.md',
        relativePath: 'recipe/file.md',
        mtime: new Date(Date.now() - 60 * 1000),
        sizeBytes: 1_500_000,
      }

      const display = formatViewEntry(entry, 3, 8).split('\t')[2]!
      expect(display).toContain('1,465KB')
    })
  })
})
