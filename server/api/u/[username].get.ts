/**
 * 公開個人頁的資料來源。**一律以匿名視角讀取**：`/u/**` 雖然不快取，但 SSR 結果會被
 * 序列化進 `__NUXT_DATA__` 一起送出 ⇒ 只要 SSR 期間碰過觀看者身分，就得為「這份 HTML
 * 會不會被中間層存下來」負責。個人化內容留給 client（§5 Step 4 第 4 點）。
 */
// ★ 聚合是推論通道不是安全邊界：這裡只回筆數，**完全不算金額**。單筆票價被 RLS 擋住時
//   一個 sum 也會把它以總額漏光；而 anon 視角下票價根本讀不到，算出來的 0 反而會誤導。
//   金額統計走 SECURITY INVOKER 的 RPC 並附 spend_is_partial（Step 6）。
//
// ★ 列表分頁與年表聚合是兩個需求，不共用上限：兩者吃同一批「最多 200 筆」時，超過
//   200 筆的使用者年表會缺格子而且沒有提示。現在列表走 limit/offset，年表與總計走
//   `user_year_counts` 全量 group by（SECURITY INVOKER ⇒ 母體與列表看得到的完全一致）。
//
// ⚠️ `limit` 預設**刻意仍是 200**：改小會讓還沒接分頁的前端安靜地少顯示一半紀錄。

/** 一次最多回這麼多筆。與 PostgREST 的預設上限無關，是這支端點自己的契約。 */
const MAX_LIMIT = 200

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n))
    return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

export default defineEventHandler(async (event) => {
  const username = getRouterParam(event, 'username')
  if (!username)
    throw createError({ statusCode: 400, statusMessage: '缺少 username' })

  const query = getQuery(event)
  const limit = clampInt(query.limit, MAX_LIMIT, 1, MAX_LIMIT)
  const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)

  const db = publicSupabase()

  // profile_read policy 會讓被終止服務者的個人頁對外直接消失
  const { data: profile, error } = await db
    .from('profile')
    .select('id,username,display_name,avatar_url,bio,show_cost,created_at')
    .eq('username', username)
    .maybeSingle()

  if (error)
    throw createError({ statusCode: 500, statusMessage: error.message })
  if (!profile?.id)
    throw createError({ statusCode: 404, statusMessage: '找不到這位使用者' })

  const userId = profile.id

  // view 只含公開且未被取下者，再經 RLS 過濾。刻意不選 cost_*（見檔頭）。
  // ★ 後兩個 order 是必要的：同日紀錄很多，只以日期排序時 PostgreSQL 不保證跨頁的
  //   相對順序 ⇒ 分頁會重複或漏列。id 是最後的破平手。
  const { data: records } = await db
    .from('viewing_record_public')
    .select('id,film_id,venue_id,watched_on,watched_time,ticket_count,hall_label,format_code,memo')
    .eq('user_id', userId)
    .order('watched_on', { ascending: false })
    .order('watched_time', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)

  const rows = records ?? []

  // 年表與總計走全量聚合，不從 rows 算。RPC 是 SECURITY INVOKER 且讀同一支 view ⇒
  // 「年表有格子但列表翻不到」在結構上不可能發生。
  const { data: summaryRaw } = await db.rpc('user_year_counts', { p_username: profile.username })
  const summary = summaryRaw as unknown as {
    records: number
    films: number
    venues: number
    by_year: { year: number, n: number, films: number }[]
  } | null

  // 片名與場所另外撈，避免 embed 在 view 上的關聯推導問題
  const filmIds = [...new Set(rows.map(r => r.film_id).filter((v): v is string => !!v))]
  const venueIds = [...new Set(rows.map(r => r.venue_id).filter((v): v is string => !!v))]

  // ★ `country` 可以回：它是作品的公開屬性，不是金額那一類的推論通道——`film_public`
  //   的 where 與 `film_read` 給 anon 的條件**逐字相同** ⇒ 匿名本來就讀得到這一列。
  //   加它是因為國別分布長條的抽屜要靠它比對（`matchesDistPick()`），少了就永遠是空的。
  // ⚠️ `filmById` 是 `{ ...f, ugc_poster_url }`，加進 select 就會原樣出現在
  //    `items[].film.country`，不要再 map 一次。
  const [{ data: films }, { data: venues }] = await Promise.all([
    filmIds.length
      ? db.from('film_public').select('id,slug,title_zh,title_original,country,tmdb_poster_path,ugc_poster_path').in('id', filmIds)
      : Promise.resolve({ data: [] as never[] }),
    venueIds.length
      ? db.from('venue').select('id,name,kind,city').in('id', venueIds)
      : Promise.resolve({ data: [] as never[] }),
  ])

  // UGC 海報在 private bucket，`ugc_poster_path` 是**路徑不是 URL**（直接塞 `<img src>`
  // 會 400）⇒ 換成 signed URL 且**批次簽一次**。★ 用匿名 client：未審核的海報因此簽不
  // 出來，那正是要的——這支端點的輸出對所有人相同。簽不出來就當作沒有海報。
  const ugcPaths = (films ?? [])
    .map(f => f.ugc_poster_path)
    .filter((p): p is string => !!p)

  const signedByPath = new Map<string, string>()
  if (ugcPaths.length) {
    const { data: signed } = await db.storage
      .from('ugc-poster')
      .createSignedUrls(ugcPaths, 60 * 60)
    for (const s of signed ?? []) {
      if (s.path && s.signedUrl)
        signedByPath.set(s.path, s.signedUrl)
    }
  }

  const filmById = new Map((films ?? []).map(f => [
    f.id,
    { ...f, ugc_poster_url: f.ugc_poster_path ? signedByPath.get(f.ugc_poster_path) ?? null : null },
  ]))
  const venueById = new Map((venues ?? []).map(v => [v.id, v]))

  const items = rows.map(r => ({
    id: r.id,
    watchedOn: r.watched_on,
    watchedTime: r.watched_time,
    ticketCount: r.ticket_count,
    hallLabel: r.hall_label,
    formatCode: r.format_code,
    memo: r.memo,
    film: r.film_id ? filmById.get(r.film_id) ?? null : null,
    venue: r.venue_id ? venueById.get(r.venue_id) ?? null : null,
  }))

  // ★ 聚合拿不到時**不要退回「從這一頁算」**：那個退路的失敗樣子是年表看起來好好的、
  //   只是少了幾年而沒人會發現。寧可標成 null，讓呼叫端知道自己不知道。
  const total = summary?.records ?? null

  return {
    profile: {
      username: profile.username,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      showCost: profile.show_cost,
    },
    items,
    page: {
      limit,
      offset,
      returned: rows.length,
      total,
      // total 未知時以「這一頁滿了」推測還有下一頁，而不是假裝沒有了
      hasMore: total === null ? rows.length === limit : offset + rows.length < total,
    },
    // counts 仍是「這個人的全部」，只是現在真的是全部，不是「前 200 筆算出來的全部」。
    counts: {
      records: summary?.records ?? rows.length,
      films: summary?.films ?? filmIds.length,
      venues: summary?.venues ?? venueIds.length,
      byYear: (summary?.by_year ?? []).map(y => ({ year: y.year, n: y.n, films: y.films })),
    },
  }
})
