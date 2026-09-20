/**
 * 公開作品頁的資料來源。匿名視角讀取，輸出與觀看者無關 ⇒ 可被 ISR 快取。
 * ★ 刻意**完全不選取票價欄位**：RLS 本來就會擋，但 ISR 會把回應連同
 *   `_payload.json` 一起快取並公開可讀 ⇒ 票價不該從一開始就進到這條路徑（踩雷 #10）。
 */
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug)
    throw createError({ statusCode: 400, statusMessage: '缺少 slug' })

  const db = publicSupabase()

  const { data: film, error } = await db
    .from('film_public')
    .select('id,slug,title_zh,title_original,country,language,runtime_minutes,release_year,first_seen_roc_year,origin,tmdb_id,ugc_poster_path,tmdb_poster_path,tmdb_backdrop_path,overview,tw_release_date')
    .eq('slug', slug)
    .maybeSingle()

  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })
  if (!film?.id)
    throw createError({ statusCode: 404, statusMessage: '找不到這部作品' })

  // view 的欄位在 Postgres 目錄裡一律是 nullable（view 沒有 NOT NULL 約束），
  // 產型別時如實反映，所以這裡要先收窄。
  const filmId = film.id

  // 政府核准紀錄是開放資料，可公開顯示（分級、年度、版本標註）
  const { data: certificates } = await db
    .from('certificate')
    .select('id,permit_no,roc_year,gregorian_year,rating,version_note,runtime_minutes')
    .eq('film_id', filmId)
    .order('roc_year', { ascending: true })

  // US-27：有哪些人看過這部片。只取公開紀錄，且不含票價與備註。
  const { data: watchers } = await db
    .from('viewing_record_public')
    .select('id,username,watched_on,venue_id')
    .eq('film_id', filmId)
    .order('watched_on', { ascending: false })
    .limit(20)

  return {
    film,
    certificates: certificates ?? [],
    watchers: watchers ?? [],
  }
})
