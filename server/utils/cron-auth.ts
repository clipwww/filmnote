import type { H3Event } from 'h3'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import process from 'node:process'

/** 固定時間比較。長度不同直接回 false（長度本身不是秘密）。 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * cron 路由的呼叫者驗證。只收 `Authorization: Bearer`（query string 會被記進存取紀錄）。
 * `CRON_SECRET`（Vercel 設了才會帶 header）與 `NUXT_CRON_SECRET`（本機）兩個都接受：
 * 只認一個會變成「排程有觸發但每次 401」的安靜失敗。★ 一個都沒設回 503，不是放行。
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
