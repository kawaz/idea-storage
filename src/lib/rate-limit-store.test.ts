import { describe, expect, test, beforeEach } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  recordObservation,
  getLatestObservations,
  cleanupOldObservations,
  RateLimitStoreDirs,
} from './rate-limit-store.ts'

function makeTestDirs(): RateLimitStoreDirs {
  const base = join(tmpdir(), `rl-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  return { stateDir: base }
}

describe('rate-limit-store', () => {
  describe('recordObservation', () => {
    test('records a single observation', () => {
      const dirs = makeTestDirs()
      const ts = 1776046000
      recordObservation(
        {
          ts,
          fiveHour: { util: 0.13, reset: 1776056400, status: 'allowed' },
          sevenDay: { util: 0.02, reset: 1776646800, status: 'allowed' },
          source: 'worker',
        },
        dirs,
      )
      const rows = getLatestObservations(10, dirs)
      expect(rows.length).toBe(1)
      expect(rows[0]).toMatchObject({
        ts,
        fiveHourUtil: 0.13,
        fiveHourReset: 1776056400,
        fiveHourStatus: 'allowed',
        sevenDayUtil: 0.02,
        source: 'worker',
      })
    })

    test('records observation with null buckets', () => {
      const dirs = makeTestDirs()
      recordObservation(
        {
          ts: 1776046000,
          fiveHour: { util: 0.5, reset: 1776056400, status: 'allowed' },
          sevenDay: null,
          source: 'probe',
        },
        dirs,
      )
      const rows = getLatestObservations(10, dirs)
      expect(rows.length).toBe(1)
      expect(rows[0]!.sevenDayUtil).toBeNull()
      expect(rows[0]!.sevenDayReset).toBeNull()
      expect(rows[0]!.source).toBe('probe')
    })

    test('duplicate ts is ignored (INSERT OR IGNORE)', () => {
      const dirs = makeTestDirs()
      const ts = 1776046000
      recordObservation(
        { ts, fiveHour: { util: 0.1, reset: 1, status: 'allowed' }, sevenDay: null, source: 'worker' },
        dirs,
      )
      recordObservation(
        { ts, fiveHour: { util: 0.9, reset: 1, status: 'allowed' }, sevenDay: null, source: 'worker' },
        dirs,
      )
      const rows = getLatestObservations(10, dirs)
      expect(rows.length).toBe(1)
      expect(rows[0]!.fiveHourUtil).toBe(0.1) // 初回の値が残る
    })
  })

  describe('getLatestObservations', () => {
    test('returns rows ordered by ts DESC, up to limit', () => {
      const dirs = makeTestDirs()
      for (const ts of [100, 200, 300, 400, 500]) {
        recordObservation(
          { ts, fiveHour: { util: 0.1, reset: 1, status: 'allowed' }, sevenDay: null, source: 'worker' },
          dirs,
        )
      }
      const rows = getLatestObservations(3, dirs)
      expect(rows.map((r) => r.ts)).toEqual([500, 400, 300])
    })

    test('returns empty array when no observations', () => {
      const dirs = makeTestDirs()
      expect(getLatestObservations(10, dirs)).toEqual([])
    })
  })

  describe('cleanupOldObservations', () => {
    test('deletes rows older than 8d', () => {
      const dirs = makeTestDirs()
      const now = 1000000000
      const eightDaysSec = 8 * 86400
      // older than 8d
      recordObservation(
        {
          ts: now - eightDaysSec - 10,
          fiveHour: { util: 0.1, reset: 1, status: 'allowed' },
          sevenDay: null,
          source: 'worker',
        },
        dirs,
      )
      // within 8d but older than 1d
      recordObservation(
        {
          ts: now - 86400 * 2,
          fiveHour: { util: 0.2, reset: 1, status: 'allowed' },
          sevenDay: null,
          source: 'worker',
        },
        dirs,
      )
      // within 1d
      recordObservation(
        {
          ts: now - 3600,
          fiveHour: { util: 0.3, reset: 1, status: 'allowed' },
          sevenDay: null,
          source: 'worker',
        },
        dirs,
      )

      cleanupOldObservations(now, dirs)

      const rows = getLatestObservations(100, dirs)
      expect(rows.map((r) => r.ts).sort()).toEqual([now - 86400 * 2, now - 3600].sort())
    })

    test('aggregates 24h-8d range to 1 sample per hour (keeps newest in each hour bucket)', () => {
      const dirs = makeTestDirs()
      const now = 1000000000
      // Put 3 samples in the same 1-hour bucket, within 1d-8d range of `now`
      // now - 8d = 999_308_800, now - 1d = 999_913_600
      // Choose a bucket inside this range
      const hourBucket = 277700 // 277700 * 3600 = 999_720_000 (within 1d..8d)
      const base = hourBucket * 3600
      for (let i = 0; i < 3; i++) {
        recordObservation(
          {
            ts: base + i * 300, // 5 min apart
            fiveHour: { util: 0.1 + i * 0.1, reset: 1, status: 'allowed' },
            sevenDay: null,
            source: 'worker',
          },
          dirs,
        )
      }

      cleanupOldObservations(now, dirs)

      const rows = getLatestObservations(100, dirs)
      // Only 1 sample in this hour bucket should remain (the latest = base + 600)
      const inBucket = rows.filter((r) => Math.floor(r.ts / 3600) === hourBucket)
      expect(inBucket.length).toBe(1)
      expect(inBucket[0]!.ts).toBe(base + 600)
    })

    test('preserves all rows within 24h (no aggregation)', () => {
      const dirs = makeTestDirs()
      const now = 1000000000
      // 5 samples in the past hour
      for (let i = 0; i < 5; i++) {
        recordObservation(
          {
            ts: now - 60 * (i + 1),
            fiveHour: { util: 0.1, reset: 1, status: 'allowed' },
            sevenDay: null,
            source: 'worker',
          },
          dirs,
        )
      }
      cleanupOldObservations(now, dirs)
      const rows = getLatestObservations(100, dirs)
      expect(rows.length).toBe(5)
    })
  })
})
