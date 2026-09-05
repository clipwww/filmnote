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
 */
export default defineEventHandler(async (event) => {
  const username = getRouterParam(event, 'username')
  if (!username)
    throw createError({ statusCode: 400, statusMessage: '缺少 username' })

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
  const { data: records } = await db
    .from('viewing_record_public')
    .select('id,film_id,venue_id,watched_on,watched_time,ticket_count,hall_label,format_code,memo')
    .eq('user_id', userId)
    .order('watched_on', { ascending: false })
    .order('watched_time', { ascending: false, nullsFirst: false })
    .limit(200)

  const rows = records ?? []

  // 片名與場所另外撈，避免 embed 在 view 上的關聯推導問題
  const filmIds = [...new Set(rows.map(r => r.film_id).filter((v): v is string => !!v))]
  const venueIds = [...new Set(rows.map(r => r.venue_id).filter((v): v is string => !!v))]

  const [{ data: films }, { data: venues }] = await Promise.all([
    filmIds.length
      ? db.from('film_public').select('id,slug,title_zh,title_original,tmdb_poster_path').in('id', filmIds)
      : Promise.resolve({ data: [] as never[] }),
    venueIds.length
      ? db.from('venue').select('id,name,kind,city').in('id', venueIds)
      : Promise.resolve({ data: [] as never[] }),
  ])

  const filmById = new Map((films ?? []).map(f => [f.id, f]))
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

  // 只有筆數，沒有金額
  const byYear = new Map<number, number>()
  for (const r of rows) {
    if (!r.watched_on)
      continue
    const y = Number(r.watched_on.slice(0, 4))
    byYear.set(y, (byYear.get(y) ?? 0) + 1)
  }

  return {
    profile: {
      username: profile.username,
      displayName: profile.display_name,
      avatarUrl: profile.avatar_url,
      bio: profile.bio,
      showCost: profile.show_cost,
    },
    items,
    counts: {
      records: rows.length,
      films: filmIds.length,
      venues: venueIds.length,
      byYear: [...byYear.entries()].sort((a, b) => b[0] - a[0]).map(([year, n]) => ({ year, n })),
    },
  }
})
