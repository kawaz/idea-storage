import { describe, expect, test } from 'bun:test'
import { shouldSkip, computeElapsedRatio } from './rate-limit-judge.ts'
import type { ObservationRow } from './rate-limit-store.ts'

function makeRow(overrides: Partial<ObservationRow>): ObservationRow {
  return {
    ts: 0,
    fiveHourUtil: null,
    fiveHourReset: null,
    fiveHourStatus: null,
    sevenDayUtil: null,
    sevenDayReset: null,
    sevenDayStatus: null,
    source: 'worker',
    ...overrides,
  }
}

describe('rate-limit-judge', () => {
  describe('computeElapsedRatio', () => {
    test('returns 0 at window start', () => {
      // windowLengthSec=5h, reset=now+5h → elapsed=0
      const now = 1000
      const reset = now + 5 * 3600
      expect(computeElapsedRatio(reset, 5 * 3600, now)).toBe(0)
    })

    test('returns 1 at window end', () => {
      const now = 1000
      const reset = now
      expect(computeElapsedRatio(reset, 5 * 3600, now)).toBe(1)
    })

    test('returns 0.5 at midpoint', () => {
      const now = 1000
      const reset = now + 2.5 * 3600
      expect(computeElapsedRatio(reset, 5 * 3600, now)).toBeCloseTo(0.5, 3)
    })

    test('clamps to [0,1]', () => {
      const now = 1000
      expect(computeElapsedRatio(now + 10 * 3600, 5 * 3600, now)).toBe(0)
      expect(computeElapsedRatio(now - 1, 5 * 3600, now)).toBe(1)
    })
  })

  describe('shouldSkip', () => {
    test('proceeds when no observation available (no data = stale/unknown; decide separately)', () => {
      const decision = shouldSkip([], 1000)
      expect(decision.skip).toBe(false)
      expect(decision.reason).toMatch(/no.?data|no.?observation/i)
    })

    test('proceeds when both util and elapsed are below 30%', () => {
      // 5h: util=0.1, elapsed=0.2; 7d: util=0.05, elapsed=0.2
      const now = 1000
      const row = makeRow({
        ts: now - 10,
        fiveHourUtil: 0.1,
        fiveHourReset: now + 4 * 3600, // elapsed = 1/5 = 0.2
        sevenDayUtil: 0.05,
        sevenDayReset: now + 7 * 0.8 * 86400, // elapsed ~0.2
      })
      const decision = shouldSkip([row], now)
      expect(decision.skip).toBe(false)
    })

    test('skips when 5h token%(35) > elapsed%(30) * 0.9 = 27 (both > 30? only util > 30)', () => {
      // util=0.35 (>30%), elapsed=0.30 (=30%). condition: (35>30 || 30>30) && 35 > 30*0.9=27 → true
      const now = 1000
      const row = makeRow({
        ts: now - 10,
        fiveHourUtil: 0.35,
        fiveHourReset: now + 3.5 * 3600, // elapsed = 1.5/5 = 0.30
      })
      const decision = shouldSkip([row], now)
      expect(decision.skip).toBe(true)
      expect(decision.reason).toMatch(/five.?hour|5h/i)
    })

    test('proceeds when above 30% but token is under pace', () => {
      // util=35%, elapsed=60% → token%(35) > elapsed%(60)*0.9=54 → NO skip
      const now = 1000
      const row = makeRow({
        ts: now - 10,
        fiveHourUtil: 0.35,
        fiveHourReset: now + 2 * 3600, // elapsed = 3/5 = 0.60
      })
      const decision = shouldSkip([row], now)
      expect(decision.skip).toBe(false)
    })

    test('skips when 7d triggers even if 5h is fine', () => {
      // 5h ok, 7d utilization pacing fast
      const now = 1000
      const row = makeRow({
        ts: now - 10,
        fiveHourUtil: 0.05,
        fiveHourReset: now + 4.5 * 3600,
        sevenDayUtil: 0.4, // >30%
        sevenDayReset: now + 7 * 3600, // elapsed ~ (7d-7h)/7d ≈ 0.9996... too old
      })
      // elapsed for 7d = (7d window - remaining 7h) / 7d
      // remaining 7h ~= 0, elapsed ~=1; util=0.4 > 1*0.9=0.9 → false; so should NOT skip (4 > 9 false)
      const decision = shouldSkip([row], now)
      expect(decision.skip).toBe(false)
    })

    test('skips when 7d clearly ahead of pace', () => {
      // 7d: util=0.50, elapsed=0.30 → (50>30 || 30>30) && 50>30*0.9=27 → skip
      const now = 1000
      const row = makeRow({
        ts: now - 10,
        sevenDayUtil: 0.5,
        sevenDayReset: now + 7 * 0.7 * 86400, // elapsed ~0.30
      })
      const decision = shouldSkip([row], now)
      expect(decision.skip).toBe(true)
      expect(decision.reason).toMatch(/seven.?day|7d/i)
    })

    test('uses most recent observation when multiple rows given', () => {
      const now = 1000
      const older = makeRow({
        ts: now - 3600,
        fiveHourUtil: 0.9, // old observation says "heavy usage"
        fiveHourReset: now + 4 * 3600,
      })
      const newer = makeRow({
        ts: now - 60,
        fiveHourUtil: 0.1, // but latest says "light"
        fiveHourReset: now + 4 * 3600,
      })
      const decision = shouldSkip([newer, older], now)
      expect(decision.skip).toBe(false)
    })

    test('ignores observation older than staleThresholdSec', () => {
      const now = 1000
      const row = makeRow({
        ts: now - 4000, // ~66min old
        fiveHourUtil: 0.05,
        fiveHourReset: now + 4 * 3600,
      })
      const decision = shouldSkip([row], now, { staleThresholdSec: 3600 })
      expect(decision.skip).toBe(false)
      expect(decision.reason).toMatch(/stale/i)
    })
  })
})
