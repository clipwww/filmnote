// 相對匯入而不是 `~/utils/…`：vitest 的 `~` 別名指向 src/（管線那一側），
// 走別名的話單元測試會 resolve 不到。同層檔案用相對路徑最不會出事。
import { WEEK_START } from './chart-theme'

/**
 * `user_year_stats` RPC 的回傳形狀，以及把它轉成各張圖要的資料。
 *
 * 轉換全部放在這裡而不是散在元件裡，因為每一條都有一個「照直覺寫會錯、
 * 而且不會報錯」的地方，值得被測試蓋住。
 */

export interface YearTotals {
  records: number
  films: number
  tickets: number
  spend: number
  spend_currency: string
  /** 呼叫者看不到全部票價時為 true。**不能把部分金額顯示成全部。 */
  spend_is_partial: boolean
  spend_known_records: number
  spend_unknown_records: number
  /** 沒有 watched_time 的舊資料，進不了時段熱點圖。 */
  records_without_time: number
}

export interface YearStats {
  username: string
  year: number | null
  is_own: boolean
  available_years: number[]
  totals: YearTotals
  daily: { date: string, records: number, tickets: number }[]
  /** ⚠️ `weekday` 是 **isodow**：1=週一 … 7=週日。不是 `dow` 的 0=週日。 */
  weekday_hour: { weekday: number, hour: number, records: number }[]
  monthly: { month: number, records: number, tickets: number, spend: number, spend_is_partial: boolean }[]
  venues: { venue_id: string | null, name: string | null, city: string | null, kind: string | null, records: number }[]
  countries: { country: string, records: number }[]
  formats: { code: string, label: string, records: number }[]
  repeats: { film_id: string, title_zh: string | null, slug: string | null, poster_path: string | null, records: number }[]
}

/* ────────────────────────── 出席圖（calendar heatmap） ───────────────────── */

/**
 * `{date, records, tickets}` → ECharts calendar 要的 `[date, value]`。
 *
 * backend 刻意給具名欄位而不是直接給 ECharts 的格式（不想把圖表函式庫的
 * 資料形狀綁進 API 契約），所以這一層是必要的，不是多餘的搬運。
 */
export function calendarSeries(daily: YearStats['daily']): [string, number][] {
  return daily.map(d => [d.date, d.records])
}

/**
 * 「當天看了兩場以上」的日子。
 *
 * 這些日子要在 calendar 上**另外疊一個 scatter 畫小點**，不能只靠色差——
 * `heat-4 ↔ heat-6` 只有亮 2.74:1／暗 2.53:1，低於 WCAG 1.4.11 的 3:1（§1.3）。
 * 而這些日子正是雙片連映，是整張圖唯一想讓人看見的東西。
 */
export function doubleFeatureDays(daily: YearStats['daily']): [string, number][] {
  return daily.filter(d => d.records > 1).map(d => [d.date, d.records])
}

/* ────────────────────── 時段熱點圖（cartesian2d heatmap） ────────────────── */

/** isodow 1..7 → 中文單字。**週一起始**（§5.4），所以第一欄是「一」。 */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 週末三格用較重的字重讓它們讀成一組（§5.4「代價，寫清楚」的緩解）。 */
export const WEEKEND_ISODOW = new Set([5, 6, 7])

export const MIDNIGHT_LABEL = '午夜場'
/** 折進「午夜場」那一桶的小時。 */
export const MIDNIGHT_HOURS = [0, 1, 2]
/** 預設起點：實測 David 的場次只落在 9–23 時，畫滿 24 列會有 1/3 永遠空白。 */
export const DEFAULT_START_HOUR = 9

export interface HourGrid {
  /** 由上到下的列標籤，最後一列是「午夜場」。 */
  rows: string[]
  /** ECharts heatmap 的 `[x, y, value]`；**7×rows 全格都有，包含 0**。 */
  data: [number, number, number][]
  max: number
  /** 有幾筆紀錄因為沒有時間而進不了這張圖。 */
  missing: number
}

/**
 * 把 `weekday_hour` 攤成完整的 7 × N 格盤。
 *
 * 三個一定要做對的地方：
 *
 * 1. **全格都要餵值，包含 0**（§5.3-6）。`cartesian2d` 的 heatmap 完全不畫
 *    空格（實測 3 筆資料的 7×6 格盤只產生 5 個 path），漏掉的格子會露出
 *    卡片底色，看起來像破洞而不是「從未」。
 * 2. **`weekday` 是 isodow（1=週一…7=週日）**，不是 `dow`。當成 0-indexed
 *    會讓整張圖平移一天**而且不會報錯**。
 * 3. **00:00–02:00 折到最後標「午夜場」**（§9.1）。週五深夜的午夜場在心理上
 *    屬於「週五晚上」，放在行首會把一次連續的外出經驗切成兩天。
 *
 * 軸的起點預設 09:00，但若真的有 03–08 時的紀錄就往前延伸——
 * 規格的 09:00 是從 David 的資料推出來的預設，不是可以吃掉別人資料的硬界線。
 */
export function hourGrid(rows: YearStats['weekday_hour'], missing = 0): HourGrid {
  const early = rows
    .map(r => r.hour)
    .filter(h => h >= 3 && h < DEFAULT_START_HOUR)
  const startHour = early.length ? Math.min(DEFAULT_START_HOUR, ...early) : DEFAULT_START_HOUR

  const hourRows: number[] = []
  for (let h = startHour; h <= 23; h++)
    hourRows.push(h)

  const labels = hourRows.map(h => `${String(h).padStart(2, '0')}:00`)
  labels.push(MIDNIGHT_LABEL)

  const rowIndex = (hour: number) => {
    if (MIDNIGHT_HOURS.includes(hour))
      return labels.length - 1
    const i = hourRows.indexOf(hour)
    // 理論上進不來（startHour 已經往前延伸過），但真的進來時寧可折進午夜場
    // 也不要靜默丟掉一筆紀錄。
    return i >= 0 ? i : labels.length - 1
  }

  const counts = new Map<string, number>()
  for (const r of rows) {
    const y = rowIndex(r.hour)
    const x = r.weekday - 1 // isodow 1..7 → 欄索引 0..6
    const key = `${x}:${y}`
    counts.set(key, (counts.get(key) ?? 0) + r.records)
  }

  const data: [number, number, number][] = []
  let max = 0
  for (let x = 0; x < 7; x++) {
    for (let y = 0; y < labels.length; y++) {
      const v = counts.get(`${x}:${y}`) ?? 0
      data.push([x, y, v])
      if (v > max)
        max = v
    }
  }
  return { rows: labels, data, max, missing }
}

/** 「你 71% 的場次在週五到週日的晚上」——熱點圖上方那句話。 */
export function weekendEveningShare(rows: YearStats['weekday_hour']): number {
  const total = rows.reduce((n, r) => n + r.records, 0)
  if (!total)
    return 0
  const hit = rows
    .filter(r => WEEKEND_ISODOW.has(r.weekday) && (r.hour >= 17 || MIDNIGHT_HOURS.includes(r.hour)))
    .reduce((n, r) => n + r.records, 0)
  return Math.round((hit / total) * 100)
}

/* ─────────────────────────── 月度趨勢 ─────────────────────────── */

/** 12 個月補滿；沒有紀錄的月份是 0 而不是缺一個點。 */
export function monthlySeries(monthly: YearStats['monthly']): number[] {
  const by = new Map(monthly.map(m => [m.month, m.records]))
  return Array.from({ length: 12 }, (_, i) => by.get(i + 1) ?? 0)
}

/* ─────────────────────────── 分布長條 ─────────────────────────── */

export interface DistItem { name: string, records: number }

/**
 * 長尾收成「其他 N 家」。
 *
 * 保留原始筆數而不是百分比：長條圖的長度由 ECharts 依 max 算，
 * 先轉百分比只會多一次精度損失。
 */
export function topWithRest(items: DistItem[], limit: number, restLabel: (n: number) => string): DistItem[] {
  if (items.length <= limit)
    return [...items]
  const head = items.slice(0, limit)
  const tail = items.slice(limit)
  head.push({
    name: restLabel(tail.length),
    records: tail.reduce((n, i) => n + i.records, 0),
  })
  return head
}

/** 「你的主場是 林口威秀，68% 的場次在這裡。」 */
export function homeVenue(venues: YearStats['venues']): { name: string, share: number } | null {
  const total = venues.reduce((n, v) => n + v.records, 0)
  const top = venues[0]
  if (!top || !total || !top.name)
    return null
  return { name: top.name, share: Math.round((top.records / total) * 100) }
}

/* ───────────────────────── 年表 YearStrip ───────────────────────── */

/** 一列 53 格，每格是一週（不是一天）。 */
export const WEEKS_PER_ROW = 53

/**
 * 一個日期落在該年的第幾週（0 起算，週一為週首）。
 *
 * ⚠️ 全程用 `Date.UTC` 算。`new Date('2026-07-26')` 會把字串當 UTC 午夜解析後
 * 轉成**本地**時間，UTC 以西的時區全都退一天——`watched_on` 是台北牆上時間的
 * 日期，本來就沒有時區可言。
 *
 * 為什麼不是 ISO 8601 週號：ISO 的第 1 週是「包含 1/4 的那一週」，年初幾天會
 * 被算進**前一年**的第 52/53 週。年表是「每年一列」，跨年的格子沒有地方放，
 * 所以這裡用的是「該年第一天所在的那一週為第 0 週」——每一天都留在自己的年份裡。
 */
export function weekIndexInYear(date: string): { year: number, week: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m)
    return null
  const year = Number(m[1])
  const dayOfYear = Math.round(
    (Date.UTC(year, Number(m[2]) - 1, Number(m[3])) - Date.UTC(year, 0, 1)) / 86400000,
  )
  // 1/1 落在它那一週的第幾天（以 WEEK_START 為週首）
  const offset = (new Date(Date.UTC(year, 0, 1)).getUTCDay() - WEEK_START + 7) % 7
  // 閏年 + 1/1 剛好是週首前一天時會算出 53，夾回最後一格而不是溢位。
  return { year, week: Math.min(WEEKS_PER_ROW - 1, Math.floor((dayOfYear + offset) / 7)) }
}

export interface YearStripRow {
  year: number
  /** 53 格，每格是那一週的場次數。 */
  weeks: number[]
  records: number
}

/**
 * 全部年度的 `daily` → 年表的列。
 *
 * **收成「週」而不是「日」是資料逼出來的**：169 筆分散在 12 年，日層級的填滿率
 * 約 6%——7×53 的年格子有 96% 是空的，看起來不是密度是荒涼。收成週之後跳到
 * 約 22%，密集期與空窗立刻讀得出來（`SCREENS.md §2.1`）。
 */
export function yearStripRows(
  daily: YearStats['daily'],
  years: number[],
): YearStripRow[] {
  // 手寫迴圈而不是 Array.from：eslint 的 --fix 會把 `Array.from({length}, () => 0)`
  // 改寫成 `Array.from({length}).fill(0)`，那個形式的推論型別是 unknown[]。
  function blank(): number[] {
    const a: number[] = []
    for (let i = 0; i < WEEKS_PER_ROW; i++)
      a.push(0)
    return a
  }

  const rows = new Map<number, YearStripRow>()
  for (const y of years)
    rows.set(y, { year: y, weeks: blank(), records: 0 })

  for (const d of daily) {
    const w = weekIndexInYear(d.date)
    if (!w)
      continue
    // available_years 理論上涵蓋全部，但資料比清單新的時候寧可多長一列
    const row = rows.get(w.year) ?? { year: w.year, weeks: blank(), records: 0 }
    rows.set(w.year, row)
    row.weeks[w.week] = (row.weeks[w.week] ?? 0) + d.records
    row.records += d.records
  }

  return [...rows.values()].sort((a, b) => b.year - a.year)
}

/* ─────────────────── 點格子 → 底部片單（§9.2） ─────────────────── */

/**
 * `YYYY-MM-DD` → isodow（1=週一 … 7=週日）。
 *
 * ⚠️ 全程 UTC。`new Date('2026-07-26').getDay()` 在 UTC 以西的時區退一天，
 * 而且不會報錯——熱點圖的欄位跟抽屜的內容會對不起來，但兩邊都「看起來正常」。
 */
export function isoDow(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m)
    return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  return ((d + 6) % 7) + 1 // 0=週日 → 7
}

/** 某個 `HH:mm[:ss]` 是否落在熱點圖的那一列。 */
export function inHourRow(time: string | null | undefined, rowLabel: string): boolean {
  if (!time)
    return false
  const h = Number(time.slice(0, 2))
  if (Number.isNaN(h))
    return false
  if (rowLabel === MIDNIGHT_LABEL)
    return MIDNIGHT_HOURS.includes(h)
  return h === Number(rowLabel.slice(0, 2))
}

/** `2026-07-26` → `2026/07/26（週日）`。標題格式沿用舊專案（§5.5）。 */
export function dayTitle(date: string): string {
  const dow = isoDow(date)
  const name = dow ? WEEKDAY_LABELS[dow - 1] : ''
  return `${date.replace(/-/g, '/')}${name ? `（週${name}）` : ''}`
}

/** `週五` + 全形空格 + `21:00` 之類的標題（分隔符是 U+3000，見下面的樣板字串）。 */
export function slotTitle(weekday: number, rowLabel: string): string {
  const name = WEEKDAY_LABELS[weekday - 1] ?? ''
  return `週${name}　${rowLabel}`
}

/** 最常進場的那一格。`weekendEveningShare` 在週末佔比不高時沒有洞察力，改講這個。 */
export function peakSlot(rows: YearStats['weekday_hour']): { weekday: number, hour: number, records: number } | null {
  let best: { weekday: number, hour: number, records: number } | null = null
  for (const r of rows) {
    if (!best || r.records > best.records)
      best = { weekday: r.weekday, hour: r.hour, records: r.records }
  }
  return best
}
