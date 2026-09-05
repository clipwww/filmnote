/**
 * 改名後的舊網址 301 到現用名（US-25）。
 *
 * 為什麼是 Nitro middleware 而不是 routeRules.redirect：後者是建置期靜態的，
 * 查不了資料庫（docs/BUILD_PLAN.md §3 注意事項 3）。
 *
 * 用匿名 client：轉向與否不該取決於誰在看。resolve_username() 是單向解析——
 * 回傳字串、不回傳 user_id，且內含 account_is_servable 檢查，所以被終止服務者
 * 的舊名不會轉向、也不會洩漏他還在不在。`username` 表本身對 anon 只開放
 * kind='active'，historical 無法列舉（§1.1 修正 D）。
 */
export default defineEventHandler(async (event) => {
  const m = /^\/u\/([^/?#]+)(\/[^?#]*)?/.exec(event.path)
  if (!m)
    return

  const name = decodeURIComponent(m[1]!)
  const rest = m[2] ?? ''
  const db = publicSupabase()

  const { data: existing } = await db
    .from('profile')
    .select('username')
    .eq('username', name)
    .maybeSingle()
  if (existing)
    return

  const { data: current } = await db.rpc('resolve_username', { p_name: name })
  if (current && current !== name)
    return sendRedirect(event, `/u/${encodeURIComponent(current)}${rest}`, 301)
})
