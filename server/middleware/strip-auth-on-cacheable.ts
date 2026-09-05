/**
 * 在「會被快取的路由」上，讓 SSR 完全看不到來訪者的 session。
 *
 * ── 為什麼需要這支 ────────────────────────────────────────────────
 * @nuxtjs/supabase 的 server plugin 會無條件把 session 與 user 寫進
 * useState（dist/runtime/plugins/supabase.server.js）：
 *
 *     if (useSsrCookies) {
 *       useSupabaseSession().value = session   // ← 含 access_token
 *       useSupabaseUser().value    = user      // ← 含 email、sub
 *     }
 *
 * 而 Nuxt 會把所有 useState 序列化進 __NUXT_DATA__。於是**任何** SSR 頁面
 * 的 HTML 都夾帶著該次來訪者的身分——與該頁自己抓了什麼資料無關。
 *
 * 實測（2026-09-05，本機 dev）：已登入者造訪 /film/{slug} 時，payload 從
 * 411 bytes 變成 1847 bytes，內含 email、sub，以及一枚 role=authenticated、
 * 還有約 59 分鐘效期的合法 access_token。
 *
 * /film/** 走 ISR，Vercel 以「路徑」為單位快取 ⇒ 第一位登入者的 token 會被
 * 存進 CDN 並發給之後所有訪客。docs/BUILD_PLAN.md 踩雷 #1 只針對 /u/**
 * 提出這個風險（理由是「RLS 依觀看者而異」），沒有意識到框架本身就會注入
 * 身分，因此**每一條可快取的 SSR 路由都中招**，即使該頁的資料完全與觀看者
 * 無關（/film/** 的 API 用的是 cookie-free 的匿名 client，實測回應逐位元組
 * 相同——那仍然救不了，因為外洩發生在框架的狀態序列化，不在我們的資料層）。
 *
 * ── 為什麼是「拔 cookie」而不是別的做法 ──────────────────────────
 * 模組沒有逐路由關閉的選項；`useSsrCookies: false` 是全域的，會一併讓
 * serverSupabaseUser() 失效（Step 7 的管理端點需要它驗身分）。
 * 在這裡把 cookie 從請求上拔掉，等於讓那段 if 拿到 null，狀態自然是空的，
 * 不必對已產生的 payload 做字串手術。
 *
 * 代價：這些頁面的 SSR 一律 render 成未登入的樣子，hydration 後前端才會
 * 補上登入狀態（導覽列會閃一下）。對本來就要給所有人看同一份 HTML 的頁面
 * 而言，這正是應該的行為。
 */

/** 與 nuxt.config.ts 的 routeRules 中「會被快取」的那幾條保持一致。 */
function isCacheable(path: string): boolean {
  if (path === '/' || path.startsWith('/?'))
    return true
  return /^\/(?:film|venue|legal)(?:\/|$|\?)/.test(path)
}

export default defineEventHandler((event) => {
  if (!isCacheable(event.path))
    return

  const raw = getHeader(event, 'cookie')
  if (!raw)
    return

  // cookiePrefix 本身就是完整的 cookie 名稱（實測值 `sb-<project-ref>-auth-token`），
  // 不要再接一次 `-auth-token`。
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
