import type { H3Event } from 'h3'

/**
 * 極簡滑動視窗限流。⚠️ 行程內記憶體、非分散式：Vercel 每個實例各一份 Map ⇒ 實際
 * 是「每實例 N 次」，冷啟動歸零，擋不住有意的分散式濫發。**上線前補 Turnstile**（§6.2）。
 * 仍需要它：`takedown_notice` 是全站唯一對 anon 開放寫入的表（§90-4 的法定義務）。
 */

interface Bucket {
  hits: number[]
}

const buckets = new Map<string, Bucket>()

/** 超過這個數量的 key 就整份清掉。避免長命實例把記憶體吃光。 */
const MAX_KEYS = 10_000

export interface RateLimitOptions {
  /** 視窗長度（毫秒）。 */
  windowMs: number
  /** 視窗內允許的次數。 */
  max: number
  /** 同一個限制器內的命名空間，避免不同端點互相干擾。 */
  scope: string
}

/**
 * 取呼叫端 IP。★ 取不到時回固定字串而不是放行：那讓這些請求**共用**同一個桶子，
 * 也就是更嚴格而不是更寬鬆。放行才是危險的預設值。
 */
function clientKey(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
}

/** 超過上限時 throw 429，否則什麼都不做。 */
export function assertWithinRateLimit(event: H3Event, options: RateLimitOptions): void {
  const now = Date.now()
  const key = `${options.scope}:${clientKey(event)}`

  if (buckets.size > MAX_KEYS)
    buckets.clear()

  const bucket = buckets.get(key) ?? { hits: [] }
  bucket.hits = bucket.hits.filter(t => now - t < options.windowMs)

  if (bucket.hits.length >= options.max) {
    const retryAfter = Math.ceil((options.windowMs - (now - bucket.hits[0]!)) / 1000)
    setResponseHeader(event, 'retry-after', retryAfter)
    throw createError({ statusCode: 429, statusMessage: '請求過於頻繁，請稍後再試' })
  }

  bucket.hits.push(now)
  buckets.set(key, bucket)
}
