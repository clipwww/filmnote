/**
 * 公開個人頁的資料來源。**一律以匿名視角讀取**——SSR 產出的 HTML 對所有人相同。
 *
 * 為什麼連作者本人也走匿名視角：/u/** 雖然不快取（routeRules 是
 * `cache-control: private, no-store`，且絕不加 isr），但 SSR 的結果會被序列化
 * 進 __NUXT_DATA__ 一起送出。只要 SSR 期間碰過觀看者身分，就得為「這份 HTML
 * 會不會被中間層存下來」負責。以匿名視角 render、個人化內容留給 client，
 * 這個問題就不存在（docs/BUILD_PLAN.md §5 Step 4 第 4 點）。
 *
 * ★ 聚合是推論通道，不是安全邊界。
 *   這裡只回「筆數」類的聚合，**完全不算金額**。即使單筆票價被 RLS 擋住，
 *   一個 sum(amount) 也會把它以總額形式漏光；而 anon 視角下票價列根本讀不到，
 *   算出來的總額只會是 0——那個 0 反而會誤導使用者以為自己沒花錢。
 *   金額統計屬 Step 6，走 SECURITY INVOKER 的 RPC 並附 spend_is_partial 旗標。
 *
 * ★ 列表分頁與年表聚合是**兩個不同的需求**，不共用同一個上限。
 *   原本兩件事都吃同一批「最多 200 筆」：超過 200 筆的使用者，年表會缺格子，
 *   而且沒有任何提示（前端第二棒在交接筆記 §4-8 記下的 latent bug）。
 *   把上限調高只是把爆炸點往後推，還會讓每次載入都拖回全部資料。
 *   現在：列表走 limit/offset 分頁，年表與總計走 `user_year_counts` 這支
 *   全量 group by（SECURITY INVOKER，因此數到的正好是列表看得到的那些列）。
 *
 * ⚠️ `limit` 的**預設值刻意仍是 200**。改小會讓還沒接分頁的前端安靜地少顯示
 *   一半紀錄——那是「修一個沒人看得到的 bug、製造一個看得到的 bug」。
 *   前端接上 `page.hasMore` 之後再談預設值。
 */

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

  // viewing_record_public view 只含 visibility='public' 且未被取下者；
  // 再經 RLS 的 record_read 過濾（作品也要公開、作者未被終止服務）。
  // 刻意不選 cost_amount / cost_currency —— 見檔頭。
  // ★ 第二個 order 是必要的：watched_on 有大量同日紀錄，只以日期排序時
  //   PostgreSQL 不保證跨頁的相對順序 ⇒ 分頁會重複或漏掉列。id 是最後的破平手。
  const { data: records } = await db
    .from('viewing_record_public')
    .select('id,film_id,venue_id,watched_on,watched_time,ticket_count,hall_label,format_code,memo')
    .eq('user_id', userId)
    .order('watched_on', { ascending: false })
    .order('watched_time', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1)

  const rows = records ?? []

  /**
   * 年表與總計走全量聚合，**不從 rows 算**。
   *
   * user_year_counts 是 SECURITY INVOKER 且同樣讀 viewing_record_public，
   * 所以它數到的集合與上面那批 rows 的母體完全一致——換句話說「年表有格子但
   * 列表翻不到」這件事在結構上不可能發生。
   */
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

  const [{ data: films }, { data: venues }] = await Promise.all([
    filmIds.length
      ? db.from('film_public').select('id,slug,title_zh,title_original,tmdb_poster_path,ugc_poster_path').in('id', filmIds)
      : Promise.resolve({ data: [] as never[] }),
    venueIds.length
      ? db.from('venue').select('id,name,kind,city').in('id', venueIds)
      : Promise.resolve({ data: [] as never[] }),
  ])

  /**
   * UGC 海報在 private bucket，`ugc_poster_path` 是**路徑不是 URL**——直接塞進
   * `<img src>` 只會得到 400。要顯示必須換成 signed URL，而且**批次簽一次**，
   * 不要一部片一個往返。
   *
   * ★ 用的是匿名 client（`publicSupabase()`）。簽名需要對該物件有 SELECT 權限，
   *   而 `ugc_poster_read` policy 只在作品 public + approved + visible 時放行
   *   ⇒ **未審核的 UGC 海報在這裡簽不出來**，這正是我們要的：這支端點的輸出
   *   對所有人相同，不該因為誰在看而多出東西。簽不出來的就當作沒有海報。
   */
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

  /**
   * ★ 聚合拿不到時**不要退回「從這一頁算」**。
   *   那個退路的失敗樣子正是我們要修掉的東西：年表看起來是好的，只是少了幾年，
   *   而沒有任何人會發現。寧可把 total 標成 null，讓呼叫端知道自己不知道。
   */
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
    // 全站契約沒變：counts 仍是「這個人的全部」，只是現在真的是全部，
    // 而不是「前 200 筆算出來的全部」。
    counts: {
      records: summary?.records ?? rows.length,
      films: summary?.films ?? filmIds.length,
      venues: summary?.venues ?? venueIds.length,
      byYear: (summary?.by_year ?? []).map(y => ({ year: y.year, n: y.n, films: y.films })),
    },
  }
})
