import { describe, test, expect } from 'bun:test'
import {
  formatSmartSize,
  formatDuration,
  formatTimestamp,
  parseProject,
  parseSortKeys,
  validateSortKeys,
  sortEntries,
  stripAnsi,
  validateRegex,
} from './article-list.ts'

describe('article-list', () => {
  describe('formatSmartSize', () => {
    test('returns 0.1K for very small files', () => {
      expect(stripAnsi(formatSmartSize(0))).toBe('0.1K')
      expect(stripAnsi(formatSmartSize(50))).toBe('0.1K')
      expect(stripAnsi(formatSmartSize(102))).toBe('0.1K')
    })

    test('returns fractional K for < 10K', () => {
      expect(stripAnsi(formatSmartSize(1024))).toBe('1.0K')
      expect(stripAnsi(formatSmartSize(1536))).toBe('1.5K')
      expect(stripAnsi(formatSmartSize(6144))).toBe('6.0K')
    })

    test('returns integer K for >= 10K', () => {
      expect(stripAnsi(formatSmartSize(10240))).toBe('10K')
      expect(stripAnsi(formatSmartSize(13312))).toBe('13K')
    })

    test('uses blue for small K files', () => {
      expect(formatSmartSize(1024)).toContain('\x1b[0;34m')
    })

    test('uses yellow for >= 500K files', () => {
      expect(formatSmartSize(500 * 1024)).toContain('\x1b[0;33m')
    })

    test('returns fractional M for >= 1M and < 10M', () => {
      expect(stripAnsi(formatSmartSize(1048576))).toBe('1.0M')
      expect(stripAnsi(formatSmartSize(5767168))).toBe('5.5M')
    })

    test('uses blue for <= 2M', () => {
      expect(formatSmartSize(2 * 1024 * 1024)).toContain('\x1b[0;34m')
    })

    test('uses red for > 2M', () => {
      expect(formatSmartSize(2 * 1024 * 1024 + 1)).toContain('\x1b[0;31m')
    })

    test('returns integer M for >= 10M', () => {
      expect(stripAnsi(formatSmartSize(10485760))).toBe('10M')
    })

    test('returns fractional G for >= 1G and < 10G', () => {
      expect(stripAnsi(formatSmartSize(1073741824))).toBe('1.0G')
      expect(stripAnsi(formatSmartSize(2684354560))).toBe('2.5G')
    })

    test('returns integer G for >= 10G', () => {
      expect(stripAnsi(formatSmartSize(10737418240))).toBe('10G')
    })

    test('uses red for G files', () => {
      expect(formatSmartSize(1073741824)).toContain('\x1b[0;31m')
    })
  })

  describe('formatDuration', () => {
    test('formats days + hours', () => {
      const dur = 3 * 86400 + 12 * 3600
      expect(stripAnsi(formatDuration(0, dur * 1000))).toBe('3d12h')
    })

    test('formats hours + minutes', () => {
      const dur = 2 * 3600 + 30 * 60
      expect(stripAnsi(formatDuration(0, dur * 1000))).toBe('2h30m')
    })

    test('formats minutes + seconds', () => {
      const dur = 5 * 60 + 30
      expect(stripAnsi(formatDuration(0, dur * 1000))).toBe('5m30s')
    })

    test('formats sub-minute with dim 0m prefix', () => {
      const dur = 42
      const result = formatDuration(0, dur * 1000)
      expect(stripAnsi(result)).toBe('0m42s')
      // Should contain ANSI codes for the 0m part
      expect(result).toContain('\x1b[')
    })

    test('formats 0 seconds', () => {
      const result = formatDuration(0, 0)
      expect(stripAnsi(result)).toBe('0m00s')
    })

    test('returns - for negative duration', () => {
      expect(formatDuration(1000, 0)).toBe('-')
    })

    test('pads h/m/s with leading zero', () => {
      // 1d 2h
      const dur1 = 86400 + 2 * 3600
      expect(stripAnsi(formatDuration(0, dur1 * 1000))).toBe('1d02h')

      // 1h 5m
      const dur2 = 3600 + 5 * 60
      expect(stripAnsi(formatDuration(0, dur2 * 1000))).toBe('1h05m')

      // 1m 3s
      const dur3 = 60 + 3
      expect(stripAnsi(formatDuration(0, dur3 * 1000))).toBe('1m03s')
    })
  })

  describe('formatTimestamp', () => {
    test('formats UTC midnight as JST 09:00 with / separator', () => {
      const date = new Date('2026-03-07T00:00:00Z')
      const result = formatTimestamp(date)
      expect(stripAnsi(result)).toBe('2026/03/07T09:00')
    })

    test('handles date rollover', () => {
      const date = new Date('2026-03-07T15:00:00Z')
      const result = formatTimestamp(date)
      expect(stripAnsi(result)).toBe('2026/03/08T00:00')
    })

    test('contains ANSI color codes for T only', () => {
      const date = new Date('2026-03-07T00:00:00Z')
      const result = formatTimestamp(date)
      expect(result).toContain('\x1b[0;90m')   // blackBright for T
      expect(result).toContain('\x1b[0m')      // reset
    })

    test('plain text is always 16 characters', () => {
      const date = new Date('2026-01-02T03:04:05Z')
      expect(stripAnsi(formatTimestamp(date))).toHaveLength(16)
    })
  })

  describe('parseProject', () => {
    test('extracts matchPath from standard github repos path', () => {
      const result = parseProject(
        '/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main',
      )
      expect(result.matchPath).toBe('kawaz/idea-storage/main')
      expect(stripAnsi(result.displayPath)).toBe('kawaz/idea-storage/main')
    })

    test('extracts matchPath from dotfiles repos path', () => {
      const result = parseProject(
        '/Users/kawaz/.dotfiles/local/share/repos/github.com/emeradaco/antenna/main',
      )
      expect(result.matchPath).toBe('emeradaco/antenna/main')
    })

    test('handles path ending at repo level', () => {
      const result = parseProject(
        '/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage',
      )
      expect(result.matchPath).toBe('kawaz/idea-storage')
    })

    test('handles trailing slash', () => {
      const result = parseProject(
        '/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main/',
      )
      expect(result.matchPath).toBe('kawaz/idea-storage/main')
    })

    test('includes host prefix for non-github hosts', () => {
      const result = parseProject(
        '/home/user/repos/gitlab.com/org/project/main',
      )
      expect(result.matchPath).toBe('gitlab.com/org/project/main')
    })

    test('includes full sub-path in matchPath', () => {
      const result = parseProject(
        '/Users/kawaz/.local/share/repos/github.com/kawaz/idea-storage/main/src/lib',
      )
      expect(result.matchPath).toBe('kawaz/idea-storage/main/src/lib')
      expect(stripAnsi(result.displayPath)).toBe('kawaz/idea-storage/main/src/lib')
    })

    test('fallback: returns full path for non-repos path', () => {
      const result = parseProject('/some/random/path/owner/repo')
      expect(result.matchPath).toBe('/some/random/path/owner/repo')
      expect(stripAnsi(result.displayPath)).toBe('/some/random/path/owner/repo')
    })

    test('returns empty string for empty input', () => {
      const result = parseProject('')
      expect(result.matchPath).toBe('')
      expect(stripAnsi(result.displayPath)).toBe('')
    })
  })

  describe('parseSortKeys', () => {
    test('defaults to start when undefined', () => {
      expect(parseSortKeys(undefined)).toEqual(['start'])
    })

    test('defaults to start when empty string', () => {
      expect(parseSortKeys('')).toEqual(['start'])
    })

    test('parses single key', () => {
      expect(parseSortKeys('turn')).toEqual(['turn'])
    })

    test('parses comma-separated keys', () => {
      expect(parseSortKeys('rule,start')).toEqual(['rule', 'start'])
    })

    test('trims whitespace around keys', () => {
      expect(parseSortKeys('rule , turn')).toEqual(['rule', 'turn'])
    })

    test('ignores invalid keys', () => {
      expect(parseSortKeys('rule,invalid,turn')).toEqual(['rule', 'turn'])
    })

    test('defaults to start when all keys are invalid', () => {
      expect(parseSortKeys('foo,bar')).toEqual(['start'])
    })
  })

  describe('validateSortKeys', () => {
    test('does not throw for valid keys', () => {
      expect(() => validateSortKeys('start')).not.toThrow()
      expect(() => validateSortKeys('start,end,duration')).not.toThrow()
      expect(() => validateSortKeys(undefined)).not.toThrow()
    })

    test('throws for invalid keys with available keys in message', () => {
      expect(() => validateSortKeys('foo')).toThrow(/invalid sort key.*foo/i)
      expect(() => validateSortKeys('foo')).toThrow(/start.*end.*duration.*turn.*rule/)
    })

    test('throws for mixed valid/invalid keys listing only invalid ones', () => {
      expect(() => validateSortKeys('start,bogus')).toThrow(/bogus/)
    })

    test('accepts all valid keys', () => {
      expect(parseSortKeys('start,end,duration,turn,rule')).toEqual([
        'start', 'end', 'duration', 'turn', 'rule',
      ])
    })
  })

  describe('sortEntries', () => {
    function makeEntry(overrides: Partial<{
      recipe: string
      sessionStart: Date | null
      sessionEnd: Date | null
      userTurns: number | null
    }> = {}) {
      return {
        fullPath: '/tmp/test.md',
        sizeBytes: 100,
        recipe: overrides.recipe ?? '',
        sessionId: '',
        sessionStart: overrides.sessionStart ?? null,
        sessionEnd: overrides.sessionEnd ?? null,
        durationMs: null,
        userTurns: overrides.userTurns ?? null,
        sessionBytes: null,
        project: '',
      }
    }

    test('sorts by start descending', () => {
      const entries = [
        makeEntry({ sessionStart: new Date('2026-01-01') }),
        makeEntry({ sessionStart: new Date('2026-03-01') }),
        makeEntry({ sessionStart: new Date('2026-02-01') }),
      ]
      sortEntries(entries, ['start'])
      expect(entries[0]!.sessionStart!.getMonth()).toBe(2) // March (0-indexed)
      expect(entries[1]!.sessionStart!.getMonth()).toBe(1) // February
      expect(entries[2]!.sessionStart!.getMonth()).toBe(0) // January
    })

    test('sorts by rule ascending', () => {
      const entries = [
        makeEntry({ recipe: 'diary' }),
        makeEntry({ recipe: 'code-review' }),
        makeEntry({ recipe: 'meeting' }),
      ]
      sortEntries(entries, ['rule'])
      expect(entries[0]!.recipe).toBe('code-review')
      expect(entries[1]!.recipe).toBe('diary')
      expect(entries[2]!.recipe).toBe('meeting')
    })

    test('sorts by turn descending', () => {
      const entries = [
        makeEntry({ userTurns: 5 }),
        makeEntry({ userTurns: 20 }),
        makeEntry({ userTurns: 10 }),
      ]
      sortEntries(entries, ['turn'])
      expect(entries[0]!.userTurns).toBe(20)
      expect(entries[1]!.userTurns).toBe(10)
      expect(entries[2]!.userTurns).toBe(5)
    })

    test('multi-key sort: rule then start', () => {
      const entries = [
        makeEntry({ recipe: 'diary', sessionStart: new Date('2026-01-01') }),
        makeEntry({ recipe: 'diary', sessionStart: new Date('2026-03-01') }),
        makeEntry({ recipe: 'code', sessionStart: new Date('2026-02-01') }),
      ]
      sortEntries(entries, ['rule', 'start'])
      // 'code' first (ascending), then 'diary' with newest first
      expect(entries[0]!.recipe).toBe('code')
      expect(entries[1]!.recipe).toBe('diary')
      expect(entries[1]!.sessionStart!.getMonth()).toBe(2) // March
      expect(entries[2]!.recipe).toBe('diary')
      expect(entries[2]!.sessionStart!.getMonth()).toBe(0) // January
    })

    test('sorts by duration descending', () => {
      const entries = [
        makeEntry({
          sessionStart: new Date('2026-01-01T00:00:00Z'),
          sessionEnd: new Date('2026-01-01T01:00:00Z'), // 1h
        }),
        makeEntry({
          sessionStart: new Date('2026-01-01T00:00:00Z'),
          sessionEnd: new Date('2026-01-01T03:00:00Z'), // 3h
        }),
        makeEntry({
          sessionStart: new Date('2026-01-01T00:00:00Z'),
          sessionEnd: new Date('2026-01-01T02:00:00Z'), // 2h
        }),
      ]
      sortEntries(entries, ['duration'])
      // 3h, 2h, 1h
      expect(entries[0]!.sessionEnd!.getHours()).toBe(3)
      expect(entries[1]!.sessionEnd!.getHours()).toBe(2)
      expect(entries[2]!.sessionEnd!.getHours()).toBe(1)
    })
  })

  describe('validateRegex', () => {
    test('returns RegExp for valid pattern', () => {
      const re = validateRegex('foo.*bar', 'test')
      expect(re).toBeInstanceOf(RegExp)
      expect(re.test('fooXbar')).toBe(true)
    })

    test('throws for invalid regex with user-friendly message', () => {
      expect(() => validateRegex('[invalid', 'rule')).toThrow(/invalid regular expression.*rule/i)
    })

    test('includes the original pattern in error message', () => {
      expect(() => validateRegex('(unclosed', 'path')).toThrow(/\(unclosed/)
    })
  })

  describe('stripAnsi', () => {
    test('removes ANSI escape sequences', () => {
      expect(stripAnsi('\x1b[0;32mhello\x1b[0m')).toBe('hello')
    })

    test('returns plain text unchanged', () => {
      expect(stripAnsi('hello world')).toBe('hello world')
    })
  })
})
