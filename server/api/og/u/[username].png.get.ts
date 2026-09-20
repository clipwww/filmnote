import { profileCard } from '~~/server/utils/og-card'

/**
 * 版面②：公開個人頁的 OG 圖，以 YearStrip 為英雄（`SCREENS §16.2`）。年表是全站簽名
 * 且**零字型成本**（方塊 + 拉丁數字），而 username 受 DB 約束為純 ASCII ⇒ 這張圖
 * **結構上不可能缺字**，沒有降級態。⚠️ 站上還沒有年表，照規格做，不是規格錯了。
 */
export default defineEventHandler(async (event) => {
  // ⚠️ 不要換回 getRouterParam('username')：那個鍵實際上叫 `username.png`，
  //    兩支 OG 端點因此對每一個請求都回 400。理由見 og-route.ts。
  const username = ogRouteId(event)
  if (!username)
    throw createError({ statusCode: 400, statusMessage: '缺少 username' })

  const db = publicSupabase()
  const { data: profile } = await db
    .from('profile')
    .select('id,username')
    .eq('username', username)
    .maybeSingle()

  if (!profile?.id)
    throw createError({ statusCode: 404, statusMessage: '找不到這位使用者' })

  // 只取得年份與筆數。★ 不算金額——爬蟲是 anon，算出來只會是 0，而那個 0 比
  // 不顯示更誤導（同 /api/u/[username] 檔頭的推理）。
  const { data: rows } = await db
    .from('viewing_record_public')
    .select('watched_on')
    .eq('user_id', profile.id)
    .limit(5000)

  const byYear = new Map<number, number>()
  for (const r of rows ?? []) {
    if (!r.watched_on)
      continue
    const y = Number(String(r.watched_on).slice(0, 4))
    byYear.set(y, (byYear.get(y) ?? 0) + 1)
  }
  const years = [...byYear.entries()].sort((a, b) => a[0] - b[0]).map(([year, n]) => ({ year, n }))

  const { fonts } = await loadOgFonts()
  const png = await renderPng(profileCard({
    username: profile.username,
    count: rows?.length ?? 0,
    years,
    attribution: '片名資料：文化部影視及流行音樂產業局 · TMDB',
  }), fonts)

  setResponseHeaders(event, {
    'content-type': 'image/png',
    'cache-control': OG_CACHE_CONTROL,
  })
  return png
})
