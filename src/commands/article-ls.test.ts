import { describe, test, expect } from 'bun:test'
import { toJSTISOString, formatSmartSize } from '../lib/format.ts'
import { validateSortOrder } from './article-ls.ts'

describe('article-ls', () => {
  describe('validateSortOrder', () => {
    test('does not throw for valid sort orders', () => {
      expect(() => validateSortOrder('recipe')).not.toThrow()
      expect(() => validateSortOrder('date')).not.toThrow()
      expect(() => validateSortOrder('size')).not.toThrow()
      expect(() => validateSortOrder(undefined)).not.toThrow()
    })

    test('throws for invalid sort order with available values in message', () => {
      expect(() => validateSortOrder('bogus')).toThrow(/invalid sort order.*bogus/i)
      expect(() => validateSortOrder('bogus')).toThrow(/recipe.*date.*size/)
    })
  })

  describe('toJSTISOString', () => {
    test('formats UTC midnight as JST 09:00', () => {
      const date = new Date('2026-03-07T00:00:00Z')
      expect(toJSTISOString(date)).toBe('2026-03-07T09:00:00+09:00')
    })

    test('formats a specific UTC time correctly', () => {
      // 2026-03-07T03:02:21Z => JST 2026-03-07T12:02:21+09:00
      const date = new Date('2026-03-07T03:02:21Z')
      expect(toJSTISOString(date)).toBe('2026-03-07T12:02:21+09:00')
    })

    test('handles date rollover (UTC 15:00 => JST next day 00:00)', () => {
      const date = new Date('2026-03-07T15:00:00Z')
      expect(toJSTISOString(date)).toBe('2026-03-08T00:00:00+09:00')
    })

    test('returns fixed 25-character string', () => {
      const date = new Date('2026-01-01T00:00:00Z')
      expect(toJSTISOString(date)).toHaveLength(25)
    })

    test('pads single-digit month and day', () => {
      const date = new Date('2026-01-02T00:00:00Z')
      expect(toJSTISOString(date)).toBe('2026-01-02T09:00:00+09:00')
    })
  })

  describe('formatSmartSize', () => {
    test('returns 0.1K for very small files (< 0.1K)', () => {
      expect(formatSmartSize(0)).toBe('0.1K')
      expect(formatSmartSize(50)).toBe('0.1K')
      expect(formatSmartSize(102)).toBe('0.1K')
    })

    test('returns fractional K for < 10K', () => {
      // 1024 bytes = 1.0K
      expect(formatSmartSize(1024)).toBe('1.0K')
      // 6144 bytes = 6.0K
      expect(formatSmartSize(6144)).toBe('6.0K')
      // 5120 bytes = 5.0K
      expect(formatSmartSize(5120)).toBe('5.0K')
      // 1536 bytes = 1.5K
      expect(formatSmartSize(1536)).toBe('1.5K')
    })

    test('returns integer K for >= 10K', () => {
      // 10240 bytes = 10K
      expect(formatSmartSize(10240)).toBe('10K')
      // 13312 bytes = 13K
      expect(formatSmartSize(13312)).toBe('13K')
      // 102400 bytes = 100K
      expect(formatSmartSize(102400)).toBe('100K')
    })

    test('returns fractional M for >= 1M and < 10M', () => {
      // 1MB = 1048576 bytes
      expect(formatSmartSize(1048576)).toBe('1.0M')
      // 5.5MB
      expect(formatSmartSize(5767168)).toBe('5.5M')
    })

    test('returns integer M for >= 10M', () => {
      // 10MB
      expect(formatSmartSize(10485760)).toBe('10M')
      // 100MB
      expect(formatSmartSize(104857600)).toBe('100M')
    })

    test('returns fractional G for >= 1G and < 10G', () => {
      // 1GB
      expect(formatSmartSize(1073741824)).toBe('1.0G')
      // 2.5GB
      expect(formatSmartSize(2684354560)).toBe('2.5G')
    })

    test('returns integer G for >= 10G', () => {
      // 10GB
      expect(formatSmartSize(10737418240)).toBe('10G')
    })
  })
})
