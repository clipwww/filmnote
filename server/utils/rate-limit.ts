import type { H3Event } from 'h3'

/**
 * 極簡的滑動視窗速率限制。
 *
 * ⚠️ **這是行程內記憶體，不是分散式的。** 在 Vercel 上每個 serverless 實例各有
 * 一份 Map，所以真實的上限是「每實例 N 次」而不是「全站 N 次」，冷啟動也會把
 * 計數歸零。它擋得住手滑連按與最粗糙的腳本，擋不住有意的分散式濫發。
 *
 * BUILD_PLAN §6.2 要求「Turnstile 或 rate limit」，這裡先做後者：Turnstile 需要
 * 一組站台金鑰，屬部署階段的事。**上線前應補上 Turnstile**，這支則保留為第二層。
 *
 * 為什麼還是要有它：`anon` 可以 INSERT `takedown_notice` 是 §90-4 的法定義務
 * （必須讓未登入的著作權人也能提通知），而資料庫層對此完全沒有防護——那張表
 * 是全站唯一對匿名開放寫入的地方。
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
 * 取呼叫端 IP。Vercel 會帶 `x-forwarded-for`，本機開發則兩者皆無。
 *
 * ★ 取不到 IP 時回傳固定字串而不是放行：那會讓所有取不到 IP 的請求**共用**
 *   同一個桶子，也就是更嚴格而不是更寬鬆。放行才是危險的預設值。
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
