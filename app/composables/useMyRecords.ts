import type { Database } from '~/types/database.types'
import type { TicketCardRecord } from '~/utils/ticket'

export interface MyRecord extends TicketCardRecord {
  id: string
  watchedOn: string
  /** 分組用，等同 `watchedOn` 的前四碼。 */
  year: string
  formatCode: string | null
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
      supabase.from('film').select('id,slug,title_zh,title_original').in('id', filmIds),
      // 海報只在 view 上。自己的私密 UGC 作品不會出現在這裡，那時就沒有海報欄——
      // 正是 §4.3 要的行為，不必補 fallback。
      supabase.from('film_public').select('id,tmdb_poster_path').in('id', filmIds),
      supabase.from('venue').select('id,name').in('id', venueIds),
      supabase.from('viewing_record_cost').select('record_id,amount').in('record_id', rows.map(r => r.id)),
    ])
    const fm = new Map((films.data ?? []).map(f => [f.id, f]))
    const pm = new Map((posters.data ?? []).map(f => [f.id, f.tmdb_poster_path]))
    const vm = new Map((venues.data ?? []).map(v => [v.id, v.name]))
    const cm = new Map((costs.data ?? []).map(c => [c.record_id, c.amount]))

    return rows.map(r => ({
      id: r.id,
      watchedOn: r.watched_on,
      year: String(r.watched_on).slice(0, 4),
      watchedTime: r.watched_time,
      venueName: vm.get(r.venue_id) ?? null,
      hallLabel: r.hall_label,
      formatCode: r.format_code,
      ticketCount: r.ticket_count,
      cost: cm.get(r.id) ?? null,
      memo: r.memo,
      isPrivate: r.visibility === 'private',
      film: {
        slug: fm.get(r.film_id)?.slug ?? null,
        titleZh: fm.get(r.film_id)?.title_zh ?? null,
        titleOriginal: fm.get(r.film_id)?.title_original ?? null,
        tmdbPosterPath: pm.get(r.film_id) ?? null,
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
