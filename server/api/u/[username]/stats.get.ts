/**
 * 公開個人頁的**圖表**資料。`GET /api/u/{username}/stats?year=2019`
 * 獨立於 `/api/u/[username]`（那支回列表、有分頁；這支回全量聚合）：列表翻到第三頁
 * 時圖表不該跟著只剩第三頁，切年份時也只有這支要重取。
 */
// ★ 一律匿名視角（`publicSupabase()`），跟列表同一條路：RPC 是 SECURITY INVOKER，
//   圖表若改用觀看者視角，本人看自己的公開頁會出現「圖上 12 場、列表只列得出 8 張卡」
//   而兩邊都看起來正常。代價是本人看到的是別人看得到的那一份——那正是這頁要回答的
//   問題，自己的完整視角在 `/app`。
//
// ★ 金額一個都不回：匿名視角下票價讀不到 ⇒ RPC 的 spend 類欄位一律是 0，而 **0 比不給
//   更糟**（會被讀成「這個人沒花錢」）。所以逐欄挑白名單而不是整包轉發，也不是刪黑名單
//   ——日後 RPC 多一個帶金額的欄位，白名單不會自動放它過去。
//
// ⚠️ `venues[].venue_id` 與 `formats[].code` 可以在白名單裡（2026-09-14）：白名單擋的是
//    **金額**這種推論通道，這兩個是**維度識別**，值來自 `venue` / `screening_format`
//    兩張對 anon 全開的參照表。抽屜要把長條對回紀錄只能靠穩定識別（名稱不保證唯一，
//    「其他」更是 `coalesce(format_code,'other')` 聚出來的 code）。原則沒有放寬：
//    新欄位仍要逐一說明自己為什麼不是推論通道。
//
// ⚠️ 不快取，也不要加 `defineCachedEventHandler`（踩雷 #1 同族）：輸出雖然對所有人相同，
//    但 `/u/` 底下的規矩是 `private, no-store`。在這裡開一個洞，日後有人改成帶 session 的
//    視角時就會變成「第一個造訪者的資料發給所有人」而沒有任何症狀。

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
    // ★ `venue_id` / `code` 是分布長條抽屜的識別（為什麼可以在白名單裡見檔頭）。
    //   曾經宣告了卻在 map 時被丟掉——那正是「長條畫得出來、點下去是空的」的來源。
    venues: (s.venues ?? []).map(v => ({ venue_id: v.venue_id, name: v.name, records: v.records })),
    // `countries[].country` 本身就是識別（RPC 的 `coalesce(f.country, '')`，
    // 空字串＝畫面上的「未分類」），不必另外加欄位。
    countries: (s.countries ?? []).map(c => ({ country: c.country, records: c.records })),
    formats: (s.formats ?? []).map(f => ({ code: f.code, label: f.label, records: f.records })),
    repeats: (s.repeats ?? []).map(r => ({
      film_id: r.film_id,
      title_zh: r.title_zh,
      slug: r.slug,
      poster_path: r.poster_path,
      records: r.records,
    })),
  }
})
