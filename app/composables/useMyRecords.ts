import type { Database } from '~/types/database.types'
import type { TicketCardRecord } from '~/utils/ticket'

export interface MyRecord extends TicketCardRecord {
  id: string
  watchedOn: string
  /** 分組用，等同 `watchedOn` 的前四碼。 */
  year: string
  formatCode: string | null
  /**
   * 作品的識別。多刷排行（band 7）以 `film_id` 分組，抽屜要把排行的一列
   * 對回紀錄只能靠它——片名會撞、`slug` 對未審核的 UGC 作品是 null。
   * DB 上 NOT NULL，所以這裡不宣告成可選：宣告成可選的話，map 忘了帶
   * 會 typecheck 全綠而抽屜永遠是空的。
   */
  filmId: string
  /**
   * 場所的識別。**影城分布長條**點一列時，抽屜靠它把紀錄過濾出來
   * （`matchesDistPick(r, 'venue', key)`，key 就是 `venue_id`）。
   *
   * ⚠️ 不可以改用 `venueName` 比對：`venue.name` 不保證唯一（同名分館），
   *   而且 RPC 的影城分布本來就是 `group by r.venue_id`——兩邊用不同的東西
   *   分組，長條上的筆數與抽屜列出的張數就會對不起來。
   * `viewing_record.venue_id` 在 DB 上可為 null（沒填場所），所以這裡是可為 null；
   *   `matchesDistPick()` 會把 null 對到空字串那一桶。
   */
  venueId: string | null
  /**
   * 作品的國別。**國別分布長條**點一列時的過濾依據
   * （`matchesDistPick(r, 'country', key)`）。
   *
   * ⚠️ 值直接取自 `film.country`，**沒有正規化**——必須與 RPC
   *   `coalesce(f.country, '')` 分組的那個字串一模一樣，否則對不上。
   *   null（作品沒填國別）由 `matchesDistPick()` 折進「未分類」那一桶。
   */
  country: string | null
}

/**
 * 登入者自己的全部紀錄，已整成 `TicketCard` 吃的形狀。
 *
 * `/app`（儀表板）與 `/app/records`（完整列表）共用同一份 `useAsyncData` key，
 * 兩頁之間切換不會重打一次資料庫。
 *
 * ── 為什麼是四個 query 不是一個 join ─────────────────────────
 * 票價存在獨立的 `viewing_record_cost`（RLS 只能遮列不能有條件地遮欄，
 * `show_cost` 這條規則必須靠結構強制），而海報路徑在 `film_public` view 上
 * 不在 `film` 表上。這裡刻意分開取再在前端併，不繞 PostgREST 的巢狀 select——
 * 巢狀 select 一旦跨 RLS 邊界，缺欄位時是靜默回 null 不是報錯。
 *
 * ⚠️ `limit(500)`：David 現在 174 筆。這個上限會隨時間爆，且爆的時候是靜默
 * 少資料。真正的解是分頁，但那要等 `/api/records` 支援 offset/limit。
 */
export function useMyRecords() {
  const supabase = useSupabaseClient<Database>()
  const user = useSupabaseUser()
  const { formatLabel } = useScreeningFormats()

  const { data, status, refresh } = useAsyncData('my-records', async () => {
    if (!user.value?.sub)
      return []

    const { data: rows, error } = await supabase
      .from('viewing_record')
      .select('id,watched_on,watched_time,visibility,memo,hall_label,format_code,ticket_count,film_id,venue_id')
      .eq('user_id', user.value.sub)
      .order('watched_on', { ascending: false })
      .order('watched_time', { ascending: false, nullsFirst: false })
      .limit(500)
    if (error)
      throw error

    const filmIds = [...new Set(rows.map(r => r.film_id))]
    const venueIds = [...new Set(rows.map(r => r.venue_id))]
    const [films, posters, venues, costs] = await Promise.all([
      // ★ `country` 必須從 `film` 表拿，**不是 `film_public`**（下面那支）。
      //   `film_public` 的 where 是 `visibility='public' and moderation_state='visible'`
      //   ⇒ **自己新增的私密 UGC 作品（visibility='private'）不在裡面**。
      //   從那支拿的話那些紀錄的 country 會是 null，於是它們在國別分布上
      //   全部掉進「未分類」——而長條的筆數來自 RPC（`left join public.film`），
      //   兩邊母體不同，抽屜就會少列。這裡本來就已經在讀 `film` 表了。
      supabase.from('film').select('id,slug,title_zh,title_original,country,ugc_poster_path,visibility,review_state').in('id', filmIds),
      // 海報只在 view 上。自己的私密 UGC 作品不會出現在這裡，那時就沒有海報欄——
      // 正是 §4.3 要的行為，不必補 fallback。
      supabase.from('film_public').select('id,tmdb_poster_path').in('id', filmIds),
      supabase.from('venue').select('id,name').in('id', venueIds),
      supabase.from('viewing_record_cost').select('record_id,amount').in('record_id', rows.map(r => r.id)),
    ])
    const fm = new Map((films.data ?? []).map(f => [f.id, f]))
    const pm = new Map((posters.data ?? []).map(f => [f.id, f.tmdb_poster_path]))

    /**
     * UGC 海報存在 private bucket，`ugc_poster_path` 是**路徑不是 URL**，
     * 直接塞進 `<img src>` 只會得到 400。要能顯示必須換成 signed URL。
     * 批次簽一次（`createSignedUrls`），不要一部片一個往返。
     * 沒有 UGC 海報時整段跳過——絕大多數紀錄走的是 TMDB 熱連結。
     */
    const ugcPaths = (films.data ?? [])
      .map(f => f.ugc_poster_path)
      .filter((p): p is string => !!p)
    const um = new Map<string, string>()
    if (ugcPaths.length) {
      const { data: signed } = await supabase.storage
        .from('ugc-poster')
        .createSignedUrls(ugcPaths, 60 * 60)
      for (const s of signed ?? []) {
        if (s.path && s.signedUrl)
          um.set(s.path, s.signedUrl)
      }
    }
    const vm = new Map((venues.data ?? []).map(v => [v.id, v.name]))
    const cm = new Map((costs.data ?? []).map(c => [c.record_id, c.amount]))

    return rows.map(r => ({
      id: r.id,
      filmId: r.film_id,
      watchedOn: r.watched_on,
      year: String(r.watched_on).slice(0, 4),
      watchedTime: r.watched_time,
      venueName: vm.get(r.venue_id) ?? null,
      // ★ 名稱給人看、id 給分布長條的抽屜過濾用（見 `MyRecord.venueId`）。
      //   兩個都要，不可以只留一個。
      venueId: r.venue_id,
      // ★ 國別分布長條的抽屜過濾用（見 `MyRecord.country`）。
      //   放在這一層而不是 `film` 物件裡：`matchesDistPick()` 收的是扁平的
      //   `{ venueId, formatCode, country }`，三個述詞用同一個形狀最不會出錯。
      country: fm.get(r.film_id)?.country ?? null,
      hallLabel: r.hall_label,
      formatCode: r.format_code,
      ticketCount: r.ticket_count,
      cost: cm.get(r.id) ?? null,
      memo: r.memo,
      isPrivate: r.visibility === 'private',
      film: {
        /**
         * ⚠️ 只有**公開且已審核**的作品才給連結。
         *
         * 使用者自己新增的 UGC 作品在 insert 當下就有 slug（資料庫的觸發器產的），
         * 但 `/film/[slug]` 走 `/api/film/[slug]`，那支明確用匿名 client
         * （為了讓 ISR 快取安全），所以私密作品對**作者自己也是 404**。
         * 不擋的話畫面上會出現一個看起來正常、點下去卻是錯誤頁的連結——
         * 而且 Nuxt 會在 hover 之前就去 prefetch 它的 payload，於是每一張這種卡
         * 都在 console 留一個 404。實測就是這樣發現的。
         */
        slug: (() => {
          const f = fm.get(r.film_id)
          return f?.visibility === 'public' && f?.review_state === 'approved' ? f.slug ?? null : null
        })(),
        titleZh: fm.get(r.film_id)?.title_zh ?? null,
        titleOriginal: fm.get(r.film_id)?.title_original ?? null,
        tmdbPosterPath: pm.get(r.film_id) ?? null,
        ugcPosterUrl: (() => {
          const path = fm.get(r.film_id)?.ugc_poster_path
          return path ? um.get(path) ?? null : null
        })(),
      },
    }))
  }, { server: false, watch: [user] })

  /**
   * 版本名在 computed 裡才貼上：`screening_format` 是另一支 useAsyncData，
   * 可能比紀錄晚到。先 map 好會讓晚到的那份永遠貼不上去。
   */
  const records = computed<MyRecord[]>(() =>
    (data.value ?? []).map(r => ({ ...r, formatLabel: formatLabel(r.formatCode) })))

  return { records, status, refresh }
}

/** 依年份分組（資料已按日期新到舊排序，所以年份也是新到舊）。 */
export function groupByYear<T extends { year: string }>(rows: T[]): { year: string, rows: T[] }[] {
  const groups: { year: string, rows: T[] }[] = []
  for (const r of rows) {
    const last = groups.at(-1)
    if (last?.year === r.year)
      last.rows.push(r)
    else groups.push({ year: r.year, rows: [r] })
  }
  return groups
}

/**
 * 一年的量詞句所需的數字（`DESIGN_SYSTEM §4.4`）。
 *
 * `tickets`：`ticket_count` 沒填時當 1 張——「看了一場但沒說幾張票」的
 * 合理讀法是一張，當 0 會讓總票數比場次還少，那是明顯錯的。
 * `spendIsPartial`：有紀錄沒有票價時為 true。金額不能假裝是全年總額。
 */
export function yearTotals(rows: MyRecord[]) {
  let tickets = 0
  let spend = 0
  let missingCost = 0
  for (const r of rows) {
    tickets += r.ticketCount ?? 1
    if (r.cost === null || r.cost === undefined)
      missingCost++
    else spend += Number(r.cost)
  }
  return { records: rows.length, tickets, spend, missingCost, spendIsPartial: missingCost > 0 }
}
