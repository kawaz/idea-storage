/**
 * ANTHROPIC_LOG=debug の stdout から anthropic-ratelimit-unified-* ヘッダを抽出する。
 *
 * claude CLI を ANTHROPIC_LOG=debug 付きで呼ぶと、stdout に debug ログが混入し、
 * その中に /v1/messages のレスポンスヘッダ（以下形式）が含まれる:
 *
 *   "anthropic-ratelimit-unified-5h-utilization": "0.13"
 *   "anthropic-ratelimit-unified-5h-reset": "1776056400"
 *   "anthropic-ratelimit-unified-5h-status": "allowed"
 *   "anthropic-ratelimit-unified-7d-utilization": "0.02"
 *   "anthropic-ratelimit-unified-7d-reset": "1776646800"
 *   "anthropic-ratelimit-unified-7d-status": "allowed"
 *
 * Design rationale: ヘッダ名ベースで抽出することで、周辺の debug フォーマット変化に強くする。
 * claude の debug ログフォーマットは将来変わるかもしれないが、HTTP レスポンスヘッダ名は
 * サーバ側の仕様で stable。
 */

export interface BucketObservation {
  util: number // 0.0 - 1.0
  reset: number // unix epoch seconds
  status?: string // "allowed" | "warning" | "rate_limited" 等
}

export interface RateLimitObservation {
  fiveHour: BucketObservation | null
  sevenDay: BucketObservation | null
}

function extractHeader(input: string, headerName: string): string | null {
  const re = new RegExp(`"${headerName}"\\s*:\\s*"([^"]*)"`)
  const m = input.match(re)
  return m ? m[1]! : null
}

function parseBucket(input: string, prefix: '5h' | '7d'): BucketObservation | null {
  const utilStr = extractHeader(input, `anthropic-ratelimit-unified-${prefix}-utilization`)
  const resetStr = extractHeader(input, `anthropic-ratelimit-unified-${prefix}-reset`)
  const status = extractHeader(input, `anthropic-ratelimit-unified-${prefix}-status`) ?? undefined

  if (utilStr === null || resetStr === null) {
    return null
  }
  const util = Number(utilStr)
  const reset = Number(resetStr)
  if (!Number.isFinite(util) || !Number.isFinite(reset)) {
    return null
  }
  const bucket: BucketObservation = { util, reset }
  if (status !== undefined) {
    bucket.status = status
  }
  return bucket
}

export function parseRateLimitHeaders(input: string): RateLimitObservation | null {
  if (!input) return null

  const fiveHour = parseBucket(input, '5h')
  const sevenDay = parseBucket(input, '7d')

  if (fiveHour === null && sevenDay === null) {
    return null
  }

  return { fiveHour, sevenDay }
}
