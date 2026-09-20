/**
 * 在會被快取的路由上，讓 SSR 完全看不到來訪者的 session（踩雷 #1）。
 * @nuxtjs/supabase 的 server plugin 會無條件把 session／user 寫進 useState，而 Nuxt 把
 * useState 序列化進 `__NUXT_DATA__` ⇒ **任何** SSR 頁面的 HTML 都夾帶來訪者身分，
 * 與該頁自己抓了什麼資料無關。
 */
// 實測 2026-09-05（dev）：已登入者造訪 /film/{slug} 時 payload 從 411 bytes 變成
// 1847 bytes，內含 email、sub 與一枚效期約 59 分鐘的合法 access_token。ISR 以路徑為
// 單位快取 ⇒ 第一位登入者的 token 會被存進 CDN 發給所有訪客。**每一條可快取的 SSR
// 路由都中招**，即使該頁的資料與觀看者無關——外洩發生在框架的狀態序列化，不在資料層。
//
// 為什麼是拔 cookie：模組沒有逐路由關閉的選項，`useSsrCookies: false` 是全域的、會一併
// 讓 serverSupabaseUser() 失效。代價是這些頁面 SSR 成未登入的樣子（導覽列閃一下），
// 對本來就要給所有人看同一份 HTML 的頁面而言正是應該的行為。

// 不自己維護「哪些路由會被快取」的清單，而是問 Nitro 自己：原本那條寫死的正則宣稱
// 「與 routeRules 一致」，後來 `/legal` 改成 no-store 而這裡沒跟著改。危險的不是多拔一次
// cookie，是**兩份清單**——這次漂移的方向剛好安全，下次未必，而少寫一條的症狀是一枚
// 合法 access_token 進了 CDN 而**畫面完全正常**。
// ⚠️ `getRouteRules()` 回空物件時會判成「不快取」＝不拔，那是**不安全的方向** ⇒
//    `scripts/verify-http.ts`（已接進 `pnpm verify:all`）直接對真的 HTML 斷言「可快取
//    路由的 payload 裡不得出現 access_token」，測的是性質不是這支的機制。
function isCacheable(event: Parameters<typeof getRouteRules>[0]): boolean {
  const rules = getRouteRules(event)
  // ⚠️ 沒有 `rules.swr` 不是漏掉：`swr: true` 在建置期就被正規化成 `cache`，執行期讀不到
  //    那個鍵。照 nuxt.config 的字面去找 swr 會得到永遠 undefined 的判斷，而症狀是
  //    「設了 swr 的路由不拔 cookie」，畫面完全正常。
  return Boolean(rules.isr || rules.prerender || rules.cache)
}

export default defineEventHandler((event) => {
  if (!isCacheable(event))
    return

  const raw = getHeader(event, 'cookie')
  if (!raw)
    return

  // cookiePrefix 本身就是完整的 cookie 名稱（實測 `sb-<project-ref>-auth-token`）。
  const { cookiePrefix } = useRuntimeConfig(event).public.supabase

  // session cookie 超過 3180 bytes 會被 @supabase/ssr 分塊成 .0 / .1 …，
  // 所以用前綴比對而不是完全比對。
  const kept = raw
    .split(';')
    .filter(part => !part.trim().startsWith(cookiePrefix))
    .join(';')

  if (kept === raw)
    return
  event.node.req.headers.cookie = kept || undefined
})
