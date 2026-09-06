/**
 * 公開個人頁的**圖表**資料。`GET /api/u/{username}/stats?year=2019`
 *
 * ── 為什麼是一支獨立的端點，而不是塞進 `/api/u/[username]` ────────────────
 * 那一支回的是**列表**（有 limit/offset 分頁），這一支回的是**聚合**（全量）。
 * 兩者的分頁語意不同：列表翻到第三頁時，圖表不該跟著只剩第三頁的資料。
 * 而切換年份時只有這一支要重取，列表那支的 200 筆不必再搬一次。
 *
 * ── ★ 一律匿名視角，跟列表同一條路 ────────────────────────────────────────
 * `user_year_stats` 是 **SECURITY INVOKER**，所以它看得到什麼完全由觀看者的
 * RLS 決定。這裡用 `publicSupabase()`（匿名）而不是讓瀏覽器帶自己的 session
 * 直接打 RPC，理由是**圖與列表必須是同一個母體**：
 * `/api/u/[username]` 的列表是匿名視角，圖表若改用觀看者視角，本人看自己的
 * 公開頁時就會出現「圖上有 12 場、列表只列得出 8 張卡」——而兩邊都「看起來正常」。
 *
 * 代價是本人在自己的 `/u/` 上看到的是**別人看得到的那一份**。那不是缺陷，
 * 那正是這一頁要回答的問題（「我分享出去，別人看到什麼」）；自己的完整視角在 `/app`。
 *
 * ── ★ 金額一個都不回 ──────────────────────────────────────────────────────
 * `user_year_stats` 的回傳裡有 `totals.spend`、`monthly[].spend`、
 * `monthly_baseline[].avg_spend`。匿名視角下票價列讀不到 ⇒ 那些欄位一律是 **0**，
 * 而 **0 比不給更糟**：它會被讀成「這個人沒花錢」（`/api/u/[username]` 的檔頭
 * 記過同一件事）。所以這裡**逐欄挑出要的東西**，不是把 RPC 的回傳整包轉發。
 *
 * ⚠️ 用挑白名單而不是刪黑名單：日後 RPC 多一個帶金額的欄位時，
 *    白名單不會自動放它過去，黑名單會。
 *
 * ── 快取 ──────────────────────────────────────────────────────────────────
 * ⚠️ **這支不快取，也不要加 `defineCachedEventHandler`**（踩雷 #1 的同一族）。
 *    它的輸出雖然對所有人相同（匿名視角），但 `/u/**` 整條路由的規矩是
 *    `private, no-store`；在這裡開一個快取的洞，日後有人把它改成帶 session
 *    的視角時，就會變成「第一個造訪者的資料發給所有人」而沒有任何症狀。
 */

/** RPC 回傳的形狀。只宣告這支端點會用到的欄位。 */
interface RpcStats {
  available_years: number[]
  totals: {
    records: number
    films: number
    tickets: number
    records_without_time: number
  }
  daily: { date: string, records: number, tickets: number }[]
  weekday_hour: { weekday: number, hour: number, records: number }[]
  monthly: { month: number, records: number, tickets: number }[]
  monthly_baseline: { month: number, years_observed: number, records: number, avg_records: number }[]
  by_year: { year: number, records: number, films: number, tickets: number }[]
  venues: { venue_id: string | null, name: string | null, city: string | null, kind: string | null, records: number }[]
  countries: { country: string, records: number }[]
  formats: { code: string, label: string, records: number }[]
  repeats: { film_id: string, title_zh: string | null, slug: string | null, poster_path: string | null, records: number }[]
}

export default defineEventHandler(async (event) => {
  const username = getRouterParam(event, 'username')
  if (!username)
    throw createError({ statusCode: 400, statusMessage: '缺少 username' })

  // `?year=` 缺席或看不懂就是全期（RPC 的 p_year = null）。垃圾參數不 400，
  // 退回全期——一個壞掉的網址列參數不該讓整頁掛掉。
  const raw = Number(getQuery(event).year)
  const year = Number.isInteger(raw) && raw >= 1900 && raw <= 2999 ? raw : null

  const db = publicSupabase()

  // profile_read policy 會讓被終止服務者的個人頁對外直接消失
  const { data: profile } = await db
    .from('profile')
    .select('username')
    .eq('username', username)
    .maybeSingle()

  if (!profile?.username)
    throw createError({ statusCode: 404, statusMessage: '找不到這位使用者' })

  const { data, error } = await db.rpc('user_year_stats', {
    p_username: profile.username,
    // 型別產生器讀不出參數預設值，把 p_year 標成必填的 number，
    // 但 SQL 是 `default null`，而 null 正是「涵蓋全部年度」的意思。
    p_year: year as number,
  })

  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })

  const s = data as unknown as RpcStats | null
  if (!s)
    throw createError({ statusCode: 404, statusMessage: '找不到這位使用者' })

  // ★ 逐欄挑出要的東西。金額相關的欄位一個都不出現在這個物件裡。
  return {
    year,
    availableYears: s.available_years ?? [],
    totals: {
      records: s.totals?.records ?? 0,
      films: s.totals?.films ?? 0,
      tickets: s.totals?.tickets ?? 0,
      recordsWithoutTime: s.totals?.records_without_time ?? 0,
    },
    daily: (s.daily ?? []).map(d => ({ date: d.date, records: d.records, tickets: d.tickets })),
    weekdayHour: (s.weekday_hour ?? []).map(w => ({ weekday: w.weekday, hour: w.hour, records: w.records })),
    monthly: (s.monthly ?? []).map(m => ({ month: m.month, records: m.records, tickets: m.tickets })),
    monthlyBaseline: (s.monthly_baseline ?? []).map(b => ({
      month: b.month,
      years_observed: b.years_observed,
      records: b.records,
      avg_records: b.avg_records,
    })),
    byYear: (s.by_year ?? []).map(y => ({ year: y.year, records: y.records, films: y.films, tickets: y.tickets })),
    venues: (s.venues ?? []).map(v => ({ name: v.name, records: v.records })),
    countries: (s.countries ?? []).map(c => ({ country: c.country, records: c.records })),
    formats: (s.formats ?? []).map(f => ({ label: f.label, records: f.records })),
    repeats: (s.repeats ?? []).map(r => ({
      film_id: r.film_id,
      title_zh: r.title_zh,
      slug: r.slug,
      poster_path: r.poster_path,
      records: r.records,
    })),
  }
})
