import { describe, expect, test } from 'bun:test'
import { parseRateLimitHeaders } from './rate-limit-parser.ts'

describe('rate-limit-parser', () => {
  describe('parseRateLimitHeaders', () => {
    test('returns null for empty input', () => {
      expect(parseRateLimitHeaders('')).toBeNull()
    })

    test('returns null when no ratelimit headers present', () => {
      expect(parseRateLimitHeaders('no headers here')).toBeNull()
    })

    test('parses full header set from ANTHROPIC_LOG=debug output', () => {
      const input = `
        some debug prefix
        "anthropic-ratelimit-unified-5h-utilization": "0.13",
        "anthropic-ratelimit-unified-5h-reset": "1776056400",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.02",
        "anthropic-ratelimit-unified-7d-reset": "1776646800",
        "anthropic-ratelimit-unified-7d-status": "allowed",
        other stuff
      `
      const result = parseRateLimitHeaders(input)
      expect(result).toEqual({
        fiveHour: { util: 0.13, reset: 1776056400, status: 'allowed' },
        sevenDay: { util: 0.02, reset: 1776646800, status: 'allowed' },
      })
    })

    test('returns partial result when only 5h present', () => {
      const input = `
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "anthropic-ratelimit-unified-5h-reset": "1776056400",
        "anthropic-ratelimit-unified-5h-status": "allowed",
      `
      const result = parseRateLimitHeaders(input)
      expect(result).toEqual({
        fiveHour: { util: 0.5, reset: 1776056400, status: 'allowed' },
        sevenDay: null,
      })
    })

    test('returns null when util and reset are missing for both buckets', () => {
      const input = `
        "anthropic-ratelimit-unified-5h-status": "allowed"
      `
      // status alone without util/reset is not a useful observation
      expect(parseRateLimitHeaders(input)).toBeNull()
    })

    test('uses first occurrence when headers appear multiple times (request + response)', () => {
      const input = `
        request log:
        "anthropic-ratelimit-unified-5h-utilization": "0.10",
        "anthropic-ratelimit-unified-5h-reset": "1776056400",
        response log:
        "anthropic-ratelimit-unified-5h-utilization": "0.10",
        "anthropic-ratelimit-unified-5h-reset": "1776056400",
      `
      const result = parseRateLimitHeaders(input)
      expect(result?.fiveHour?.util).toBe(0.10)
    })

    test('handles various whitespace and quote styles', () => {
      const input = `"anthropic-ratelimit-unified-5h-utilization":"0.5","anthropic-ratelimit-unified-5h-reset":"1000"`
      const result = parseRateLimitHeaders(input)
      expect(result?.fiveHour?.util).toBe(0.5)
      expect(result?.fiveHour?.reset).toBe(1000)
    })

    test('missing status defaults to undefined', () => {
      const input = `
        "anthropic-ratelimit-unified-5h-utilization": "0.5",
        "anthropic-ratelimit-unified-5h-reset": "1776056400"
      `
      const result = parseRateLimitHeaders(input)
      expect(result?.fiveHour?.status).toBeUndefined()
    })

    test('ignores non-numeric values gracefully', () => {
      const input = `
        "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
        "anthropic-ratelimit-unified-5h-reset": "1776056400"
      `
      const result = parseRateLimitHeaders(input)
      expect(result).toBeNull()
    })
  })
})
