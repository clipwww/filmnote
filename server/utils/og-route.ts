import type { H3Event } from 'h3'

/**
 * 從 `/api/og/**` 的路徑取出那個識別字（username 或 record id）。
 *
 * ── 為什麼需要這支，而不是直接 getRouterParam ────────────────────────────
 * 檔名是 `[username].png.get.ts`，Nitro 由它產出的路由是 `/api/og/u/:username.png`
 * ——**參數的鍵是 `username.png`，不是 `username`**。
 *
 * 實測 2026-09-06（dev，把 `event.context.params` 直接回傳出來看）：
 *
 *   GET /api/og/u/clipwww.png  → params = { "username.png": "clipwww.png" }
 *   GET /api/og/u/clipwww      → params = { "username.png": "clipwww" }
 *
 * 於是 `getRouterParam(event, 'username')` 永遠是 `undefined`，兩支 OG 端點
 * **對每一個請求都回 400**。這件事在 dev 就成立，不是部署才會出現的問題。
 *
 * 它為什麼一直沒被發現：`scripts/og-preview.ts` 是直接呼叫 render 函式產圖的，
 * 完全不經過 HTTP 路由；而 OG 圖壞掉的樣子是**社群分享卡片沒有圖**——
 * 站上任何一頁都看不出異狀，沒有人會去點自己的分享連結。
 *
 * ── 為什麼從 event.path 取而不是查那個鍵 ─────────────────────────────────
 * `'username.png'` 這個鍵是 Nitro 的路由實作細節。寫死它等於把兩支端點綁在
 * 一個沒有文件保證的行為上，而它變動時的症狀又是靜默的 400。
 * 路徑本身是 HTTP 契約的一部分，不會變。
 */
export function ogRouteId(event: H3Event): string | null {
  const path = event.path.split('?')[0] ?? ''
  const last = path.split('/').filter(Boolean).pop() ?? ''
  let id: string
  try {
    id = decodeURIComponent(last)
  }
  catch {
    // 壞掉的百分比編碼。當作沒有給，讓呼叫端回 400。
    return null
  }
  // `.png` 是可有可無的：路由對 `/api/og/u/clipwww` 也會命中（實測），
  // 兩種寫法都該得到同一張圖。
  const stripped = id.replace(/\.png$/i, '').trim()
  return stripped || null
}
