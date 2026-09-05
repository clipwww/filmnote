import type { H3Event } from 'h3'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import process from 'node:process'

/**
 * 以固定時間比較兩個字串。長度不同直接回 false（長度本身不是秘密）。
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * cron 路由的呼叫者驗證。不通過就 throw，通過則什麼都不回。
 *
 * ★ 授權一律走 `Authorization: Bearer <secret>` header，這是 Vercel Cron 唯一
 *   會自動帶上的憑證形式（設了專案環境變數 `CRON_SECRET` 之後）。不接受
 *   query string 帶 secret——那會被記進所有存取紀錄。
 *
 * ★ 兩個環境變數都接受，且兩邊都不必知道對方存在：
 *     - `CRON_SECRET`：Vercel 的約定名稱，設了它 Vercel 才會帶 header
 *     - `NUXT_CRON_SECRET`：本專案 `.env` / runtimeConfig 的名稱（本機測試用）
 *   只認一個的話，正式環境會出現「排程有觸發但每次都 401」這種安靜的失敗。
 *
 * ★ 一個都沒設時回 503 而不是放行。「沒設密鑰 ⇒ 端點裸奔」是最糟的預設值。
 */
export function assertCronCaller(event: H3Event): void {
  const accepted = [
    useRuntimeConfig(event).cronSecret,
    process.env.CRON_SECRET,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0)

  if (accepted.length === 0) {
    throw createError({
      statusCode: 503,
      statusMessage: '未設定 CRON_SECRET / NUXT_CRON_SECRET，cron 端點停用',
    })
  }

  const header = getRequestHeader(event, 'authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''

  if (!token || !accepted.some(secret => safeEqual(token, secret))) {
    // 不透露是「沒帶」還是「帶錯」。
    throw createError({ statusCode: 401, statusMessage: '未授權' })
  }
}
