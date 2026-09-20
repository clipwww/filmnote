import type { H3Event } from 'h3'

/**
 * 從 `/api/og/**` 的路徑取出識別字。⚠️ 不要改用 `getRouterParam(event, 'username')`：
 * 檔名 `[username].png.get.ts` 產出的參數鍵是 `username.png`（2026-09-06 dev 實測），
 * 那樣寫永遠是 undefined ⇒ 兩支 OG 端點對每個請求回 400（§7 #118）。
 * 當初沒被發現，是因為 `scripts/og-preview.ts` 直接呼叫 render 函式、繞過 HTTP 路由。
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
