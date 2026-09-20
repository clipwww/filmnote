/**
 * 改名後的舊網址 301 到現用名（US-25）。用 Nitro middleware 而不是
 * `routeRules.redirect`：後者是建置期靜態的、查不了資料庫（§3 注意事項 3）。
 * 用匿名 client：轉向與否不該取決於誰在看。`resolve_username()` 是單向解析（回字串
 * 不回 user_id，內含 account_is_servable）⇒ 被終止服務者的舊名不轉向也不洩漏他還在不在。
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
