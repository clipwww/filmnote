/**
 * 片庫搜尋。雙欄比對：中文片名與原文片名任一命中即可（US-3）。
 * 過濾一律交給 Postgres：前端元件的子字串比對對 2,669 筆片庫既不準，也不該把整包
 * 資料送到瀏覽器（踩雷 #50/#51）。
 */
export default defineEventHandler(async (event) => {
  const q = (getQuery(event).q as string | undefined)?.trim() ?? ''
  if (q.length < 1)
    return { items: [], query: q }

  // 比對 generated column `search_text`，一次覆蓋兩欄且走得到 film_search_trgm 索引：
  // 實測 2,669 列走索引 4 個 buffer，改對兩欄各做 ilike 是 seq scan、144 個 buffer。
  // 用 like 而非 ilike（欄位與 needle 都已 lower）；`%` `_` `\` 要中和掉。
  const safe = q.toLowerCase().replace(/[\\%_]/g, ' ').trim()
  if (!safe)
    return { items: [], query: q }

  const db = publicSupabase()
  const { data, error } = await db
    .from('film_public')
    .select('id,slug,title_zh,title_original,country,release_year,first_seen_roc_year,tmdb_poster_path,ugc_poster_path')
    .like('search_text', `%${safe}%`)
    .limit(30)

  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })

  return { items: data ?? [], query: q }
})
