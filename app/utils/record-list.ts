import type { Ref } from 'vue'
// ⚠️ 明寫 import 不靠 auto-import：這支要在 vitest 裡跑（那裡沒有 Nuxt）。
import { computed, ref, watch } from 'vue'

/**
 * `/app/records` 表格的篩選、搜尋與頁碼分頁的**狀態**。抽成獨立模組的唯一理由是**測得到**：
 * 只活在 SFC 的 computed／watch 裡時，typecheck／lint／test／build 四關全綠也看不見它們
 * （純 client 行為，#332）。介面是「改輸入 → 看頁碼／選項」，下面的純函式都是內部細節。
 */

/**
 * 篩選要用到的欄位，不必整個 `MyRecord`（測試才不用造一整筆）。
 * ⚠️ 不 import `MyRecord`：那支檔用 `~/` 與 Nuxt auto-import，tests/ 的 tsc 會連帶去檢查它。
 */
export interface ListableRecord {
  /** 等同 `watchedOn` 的前四碼。 */
  year: string
  film?: { titleZh?: string | null, titleOriginal?: string | null } | null
  venueName?: string | null
  hallLabel?: string | null
  formatLabel?: string | null
  memo?: string | null
  cost?: number | null
}

/**
 * 四個自由文字欄的子字串比對：作品名（中文與原文）／影城／影廳／備註。
 * ⚠️ **逐欄比對，不是把欄位串起來比一次**：串起來會讓「影城結尾＋備註開頭」這種跨欄的巧合
 * 算成命中。**不含日期字串**（David 2026-09-25 裁決）⇒ 打 `2024` 只比得到片名裡的 2024。
 */
function matchesQuery(record: ListableRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q)
    return true
  // 兩邊都 toLowerCase 是為了 `titleOriginal`（拉丁字）；中日文的 toLowerCase 是 no-op。
  return [
    record.film?.titleZh,
    record.film?.titleOriginal,
    record.venueName,
    record.hallLabel,
    record.memo,
  ].some(v => !!v && v.toLowerCase().includes(q))
}

/** 第 `page` 頁（1 起算）的那一批。驗它**不可以只驗長度**（#234）：要驗切到的是哪一段。 */
function pageSlice<T>(rows: T[], page: number, perPage: number): T[] {
  const start = (Math.max(1, page) - 1) * perPage
  return rows.slice(start, start + perPage)
}

/**
 * 換年份時，影城／版本還在新年份的選項裡就留著，不在了才歸回 `all`。
 * 留著一個當年沒有的影城，表會是空的而且看不出原因；全部清掉則會把使用者剛設好的篩選丟掉。
 */
function keepIfOffered(value: string, options: { value: string }[], all: string): string {
  return options.some(o => o.value === value) ? value : all
}

export const RECORD_LIST_ALL = '__all__'
/** 一頁的筆數。預設「所有年份」之後全集是 174 筆（實測）⇒ 不分頁會是很長的一張表。 */
export const RECORD_LIST_PER_PAGE = 24

/**
 * `records` 是 `useMyRecords()` 的那個 ref（已按 `watched_on` 新到舊排序）。
 * 回傳的五個輸入 ref 直接給 `v-model`；`page` 也是（`UPagination` 的 `v-model:page`）。
 */
export function useRecordListState<T extends ListableRecord>(records: Ref<T[]>) {
  const ALL = RECORD_LIST_ALL
  const PER_PAGE = RECORD_LIST_PER_PAGE
  /** 年份跟另外三個篩選器同型，**預設就是 `ALL`**（David：「年份變成篩選選項之一，預設全部」）。 */
  const year = ref(ALL)
  const venue = ref(ALL)
  const format = ref(ALL)
  const cost = ref(ALL)
  const q = ref('')

  /**
   * 年份選項**新到舊**。`records` 已新到舊排序、`Set` 保留插入序
   * ⇒ 刻意**不走下面的 `options()`**：那一支會 `.sort()` 成升冪，年份會變成舊的在最上面。
   */
  const yearOptions = computed(() => [
    { label: `所有年份（${records.value.length}）`, value: ALL },
    ...[...new Set(records.value.map(r => r.year))].map(y => ({ label: y, value: y })),
  ])

  const byYear = computed(() =>
    year.value === ALL ? records.value : records.value.filter(r => r.year === year.value))

  /**
   * 選項只從**目前年份範圍內**的紀錄長出來：選了就 0 筆的選項比沒有選項更難用。
   * ⚠️ 預設「所有年份」時算出來的是全期的 16／7 項（實測，含「所有…」），不是當年的 4／3 項；
   * David 2026-09-25 裁決**不限制選項**。
   */
  function options(values: (string | null | undefined)[], allLabel: string) {
    const seen = [...new Set(values.map(v => v?.trim()).filter((v): v is string => !!v))].sort()
    return [{ label: allLabel, value: ALL }, ...seen.map(v => ({ label: v, value: v }))]
  }
  const venueOptions = computed(() => options(byYear.value.map(r => r.venueName), '所有影城'))
  const formatOptions = computed(() => options(byYear.value.map(r => r.formatLabel), '所有版本'))
  const costOptions = [
    { label: '票價不限', value: ALL },
    { label: '有填票價', value: 'has' },
    { label: '沒填票價', value: 'none' },
  ]

  // 換年份只重設新年份裡已經沒有的影城／版本（David 2026-09-25：不要清掉剛設好的篩選）。
  // 票價那一維跟年份無關，不動。
  watch(year, () => {
    venue.value = keepIfOffered(venue.value, venueOptions.value, ALL)
    format.value = keepIfOffered(format.value, formatOptions.value, ALL)
  })

  const filtered = computed(() => byYear.value.filter((r) => {
    if (venue.value !== ALL && r.venueName?.trim() !== venue.value)
      return false
    if (format.value !== ALL && r.formatLabel?.trim() !== format.value)
      return false
    if (cost.value === 'has' && (r.cost === null || r.cost === undefined))
      return false
    if (cost.value === 'none' && r.cost !== null && r.cost !== undefined)
      return false
    // 搜尋與三個篩選器是**疊加**不是取代。不加 debounce——174 筆逐字元重算量不出延遲。
    return matchesQuery(r, q.value)
  }))

  const hasNarrowed = computed(() =>
    year.value !== ALL || venue.value !== ALL || format.value !== ALL || cost.value !== ALL || !!q.value.trim())
  function clearFilters() {
    year.value = ALL
    venue.value = ALL
    format.value = ALL
    cost.value = ALL
    q.value = ''
  }

  /* 全集早就在客端（`useMyRecords` 一次取完），所以換頁**不重新請求**、也不動 DB。 */
  const page = ref(1)
  const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PER_PAGE)))

  /**
   * ⚠️ 監看的是**五個輸入值**，不是 `filtered`：`refresh()`（存檔、刪除之後都會呼叫）會換掉
   * `filtered` 的 identity ⇒ 監看它的話每一次存檔都把使用者踢回第 1 頁。
   */
  watch([year, venue, format, cost, q], () => {
    page.value = 1
  })

  /**
   * 刪掉最後一頁唯一那筆之後 `page` 會落在範圍外 ⇒ 表是空的而且沒有任何解釋。
   * ⚠️ 是**夾回最後一頁不是跳回第 1 頁**：跳回第 1 頁就是上面那條 watch 明文要避免的事。
   */
  watch(pageCount, (n) => {
    if (page.value > n)
      page.value = n
  })

  const visible = computed(() => pageSlice(filtered.value, page.value, PER_PAGE))

  return {
    ALL,
    PER_PAGE,
    year,
    venue,
    format,
    cost,
    q,
    yearOptions,
    venueOptions,
    formatOptions,
    costOptions,
    filtered,
    hasNarrowed,
    clearFilters,
    page,
    pageCount,
    visible,
  }
}
