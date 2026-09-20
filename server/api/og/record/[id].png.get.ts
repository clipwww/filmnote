import { recordCard, safeHero } from '~~/server/utils/og-card'

/**
 * 版面①：單筆紀錄的 OG 圖（`SCREENS §16.2`、US-32）。主力版面。
 * ★ 一律匿名視角：這張圖對所有人必須逐位元組相同，用帶 cookie 的 client 會讓「誰先
 *   造訪」決定 CDN 裡那張圖長什麼樣。票價因此在結構上就進不來（§16.3）。
 */
export default defineEventHandler(async (event) => {
  // ⚠️ 不要換回 getRouterParam('id')：那個鍵實際上叫 `id.png`。見 og-route.ts。
  const id = ogRouteId(event)
  if (!id || !/^[0-9a-f-]{36}$/i.test(id))
    throw createError({ statusCode: 400, statusMessage: '紀錄 id 格式不正確' })

  const db = publicSupabase()
  const { data: rec } = await db
    .from('viewing_record_public')
    .select('id,username,film_id,venue_id,watched_on,watched_time,ticket_count,hall_label,format_code')
    .eq('id', id)
    .maybeSingle()

  if (!rec)
    throw createError({ statusCode: 404, statusMessage: '找不到這筆紀錄' })

  const [{ data: film }, { data: venue }] = await Promise.all([
    rec.film_id
      ? db.from('film_public').select('title_zh').eq('id', rec.film_id).maybeSingle()
      : Promise.resolve({ data: null }),
    rec.venue_id
      ? db.from('venue').select('name').eq('id', rec.venue_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const { fonts, cmap } = await loadOgFonts()

  // 缺字降級態（§16.4）：畫不出來就換掉片名那一行，其餘全部保留。絕不渲染豆腐格。
  const hero = safeHero(film?.title_zh, cmap.codepoints)

  const meta = [
    rec.format_code,
    rec.ticket_count ? `${rec.ticket_count}張` : null,
  ].filter(Boolean).join('　')

  const png = await renderPng(recordCard({
    hero,
    kicker: [rec.watched_on?.replace(/-/g, ' / '), rec.watched_time?.slice(0, 5)]
      .filter(Boolean)
      .join('　'),
    venue: venue?.name ? `${venue.name}${rec.hall_label ? `（${rec.hall_label}）` : ''}` : null,
    meta: meta || null,
    attribution: '片名資料：文化部影視及流行音樂產業局 · TMDB',
  }), fonts)

  setResponseHeaders(event, {
    'content-type': 'image/png',
    'cache-control': OG_CACHE_CONTROL,
  })
  return png
})
