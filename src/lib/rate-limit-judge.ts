import type { ObservationRow } from './rate-limit-store.ts'

export interface SkipDecision {
  skip: boolean
  reason: string
}

export interface ShouldSkipOptions {
  /** 観測データがこの秒数より古い場合は stale とみなす (デフォルト: 無制限) */
  staleThresholdSec?: number
}

const FIVE_HOUR_WINDOW_SEC = 5 * 3600
const SEVEN_DAY_WINDOW_SEC = 7 * 86400

/**
 * resets_at と window length から elapsed ratio を計算する。
 * windowStart = resetsAt - windowLengthSec
 * elapsed = (now - windowStart) / windowLengthSec
 *
 * 範囲外は [0,1] にクランプする。
 */
export function computeElapsedRatio(resetsAt: number, windowLengthSec: number, nowSec: number): number {
  const windowStart = resetsAt - windowLengthSec
  const elapsed = (nowSec - windowStart) / windowLengthSec
  if (elapsed < 0) return 0
  if (elapsed > 1) return 1
  return elapsed
}

/**
 * 単一バケツについて skip 条件を評価する。
 *
 * skip if (token% > 30 || elapsed% > 30) && token% > elapsed% * 0.9
 *
 * 入力がなければ null を返す (= proceed に寄与しない)。
 * reset が既に過去になっている場合、観測はリセット済みのバケツを指しており
 * 現在のバケツ状態は不明なので同じく null を返す (stale window)。
 */
function evaluateBucket(
  util: number | null,
  reset: number | null,
  windowLengthSec: number,
  nowSec: number,
): { skip: boolean; util: number; elapsed: number } | null {
  if (util === null || reset === null) return null
  // If the window has already reset, the observation is for the *previous*
  // window and tells us nothing about the current one. Treat as unknown.
  if (reset <= nowSec) return null

  const elapsed = computeElapsedRatio(reset, windowLengthSec, nowSec)
  const gateCrossed = util > 0.3 || elapsed > 0.3
  const overPace = util > elapsed * 0.9
  return { skip: gateCrossed && overPace, util, elapsed }
}

/**
 * 現在時刻における worker の skip 判定。
 *
 * ロジック:
 * 1. 最新の観測を取り出す (rows は DESC 順、先頭が最新の想定)
 * 2. stale threshold を超えていたら proceed (保守的に動かない選択肢もあるが、
 *    データ不在は「未観測＝制限判断できず」なので処理を進めて worker 側の次の観測を待つ)
 * 3. 5h / 7d それぞれを evaluateBucket で判定
 * 4. どちらか一方でも skip 条件を満たせば skip
 */
export function shouldSkip(
  rows: ObservationRow[],
  nowSec: number,
  options: ShouldSkipOptions = {},
): SkipDecision {
  if (rows.length === 0) {
    return { skip: false, reason: 'no-observation' }
  }
  const latest = rows[0]!

  if (options.staleThresholdSec !== undefined) {
    const age = nowSec - latest.ts
    if (age > options.staleThresholdSec) {
      return { skip: false, reason: `stale (${age}s old)` }
    }
  }

  const fiveHour = evaluateBucket(latest.fiveHourUtil, latest.fiveHourReset, FIVE_HOUR_WINDOW_SEC, nowSec)
  const sevenDay = evaluateBucket(latest.sevenDayUtil, latest.sevenDayReset, SEVEN_DAY_WINDOW_SEC, nowSec)

  if (fiveHour?.skip) {
    return {
      skip: true,
      reason: `five-hour over pace: util=${(fiveHour.util * 100).toFixed(1)}% > elapsed=${(
        fiveHour.elapsed * 100
      ).toFixed(1)}% * 0.9`,
    }
  }

  if (sevenDay?.skip) {
    return {
      skip: true,
      reason: `seven-day over pace: util=${(sevenDay.util * 100).toFixed(1)}% > elapsed=${(
        sevenDay.elapsed * 100
      ).toFixed(1)}% * 0.9`,
    }
  }

  return { skip: false, reason: 'within budget' }
}
