/**
 * 片庫搜尋。雙欄比對：中文片名與原文片名任一命中即可（US-3）。
 *
 * 過濾一律交給 Postgres，不靠前端元件的子字串比對——`USelectMenu` 的搜尋是
 * reka-ui 的 `useFilter`（Intl.Collator, sensitivity:'base'），對 2,669 筆片庫
 * 既不準也不該把整包資料送到瀏覽器（踩雷 #50/#51）。
 */
export default defineEventHandler(async (event) => {
  const q = (getQuery(event).q as string | undefined)?.trim() ?? ''
  if (q.length < 1)
    return { items: [], query: q }

  // 比對 `search_text`（generated column：lower(title_zh || ' ' || title_original)），
  // 中文與原文片名兩欄一次覆蓋，且走得到 film_search_trgm（gin_trgm_ops）索引。
  // 實測 2,669 列：走索引 4 個 buffer；改對兩欄各做 ilike 是 seq scan、144 個 buffer。
  // 用 like 而非 ilike：欄位已 lower 過，needle 也先 lower，不必再做大小寫摺疊。
  // `%` `_` 是 LIKE 的萬用字元、`\` 是跳脫字元，都要中和掉。
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
