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
  /**
   * 全期視角（`p_year = null`）才有內容，指定年份時是空陣列。
   * ⚠️ `spend_is_partial` 是**逐年**的旗標：全期把十三年混在一起的那個 true
   *    對前端沒有用（只要任何一年有未公開票價就會是 true）。
   */
  by_year?: { year: number, records: number, films: number, tickets: number, spend: number, spend_is_partial: boolean }[]
  /**
   * 156 個月的時間序列（`YYYY-MM`），全期視角才有內容。
   * 與 `monthly` 是**兩種不同的問題**：`monthly` 是十三年的同月份加總
   * （「我幾月比較常看片」），這一支是走勢（「我這些年看片量的變化」）。
   */
  monthly_series?: { month: string, records: number, tickets: number, spend: number, spend_is_partial: boolean }[]
  /**
   * 月度趨勢圖上那條虛線「歷年每月平均」。**這是 `0003` 為這件事特地做的欄位，
   * 前端一定要用它，不要自己算。**
   *
   * ⚠️ `avg_records` 的分母是 **`years_observed`（曝光數）**——從第一筆紀錄那個月
   * 到 `greatest(最後一筆, 今天)`，這個月份實際經歷過幾次。**不是年份數。**
   * 實測 David：三月 13 次、一月 12 次（2014-01 在起點之前）、十月 12 次
   * （2026-10 還沒到）。用年份數當分母的話 12 個月裡有 5 個會偏
   * （十月 2.00 → 1.85、一月 0.92 → 0.85、十二月 1.50 → 1.38）。
   *
   * ⚠️ **不受 `p_year` 影響**（來自未過濾的 `rec_all`）：指定年份時它是對照基準，
   * 全期時它與 `monthly` 同形狀而數值是平均。**一個欄位餵兩個用途，
   * 不要做成兩套計算**——兩套一定會在某次修改後給出不一致的數字，而沒有人會發現，
   * 因為沒有人會把兩頁的數字擺在一起看。（`backend.md §6e`、`verify-core` 的 H4/H6）
   */
  monthly_baseline?: {
    month: number
    /** 分母：這個月份實際經歷過幾次（**不是年份數**）。 */
    years_observed: number
    records: number
    avg_records: number
    avg_tickets: number
    avg_spend: number
    spend_is_partial: boolean
  }[]
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

/**
 * 同上，但**還沒到的月份給 null 而不是 0**（`DESIGN_SYSTEM §5.3-8`）。
 *
 * 看的是今年時，12 月的 0 跟 3 月的 0 意思完全不同：一個是「還沒發生」，
 * 一個是「那個月沒去」。畫成 0 會讓折線在年中直接墜到底，看起來像
 * 「他從七月就不看電影了」。ECharts 對 null 的處理是斷線，那正是我們要的。
 *
 * `year` 或 `today` 給 null 時退回 `monthlySeries()` 的行為（全部補 0）——
 * 全期視角本來就沒有「未來的月份」。
 */
export function monthlySeriesToDate(
  monthly: YearStats['monthly'],
  year: number | null,
  today = new Date(),
): (number | null)[] {
  const filled = monthlySeries(monthly)
  if (year === null || year !== today.getFullYear())
    return filled
  const thisMonth = today.getMonth() + 1
  return filled.map((v, i) => (i + 1 > thisMonth ? null : v))
}

/** 月度趨勢圖那條虛線要 12 個點。少一格就整條不畫，不補零。 */
export const MONTHS_PER_YEAR = 12

/**
 * 歷年每月平均——月度趨勢圖上那條虛線（視覺稿 band 4，圖例「2014–2026 每月平均」）。
 *
 * ★ **這支只做搬運，不做計算。** 數值一律來自 `user_year_stats` 的
 *   `monthly_baseline[].avg_records`，那是 `0003` 為這件事特地做的欄位。
 *
 * ── 2026-09-06 修正：這裡本來自己算，而且分母是錯的 ──────────────
 * 舊版是 `monthlyAverageSeries(monthly, by_year.length)`，也就是
 * **該月份總場次 ÷ 年份數**。`monthly_baseline` 的分母是
 * **`years_observed`（曝光數）**：從第一筆紀錄那個月到
 * `greatest(最後一筆, 今天)`，這個月份實際經歷過幾次。兩者對 David 的真實
 * 資料在 12 個月裡有 5 個不一樣（十月 2.00 vs 1.85、一月 0.92 vs 0.85、
 * 二月 0.92 vs 0.85、十一月 1.42 vs 1.31、十二月 1.50 vs 1.38），
 * 因為 2014-01 在第一筆紀錄之前、2026-10 之後的月份還沒發生。
 *
 * ⚠️ **不要因為「自己算比較直接」而把計算搬回這裡。** 一個欄位餵兩個用途
 * （指定年份時是對照基準、全期時是平均），做成兩套一定會在某次修改後不一致，
 * 而那種不一致沒有人會發現——因為沒有人會把兩頁的數字擺在一起看
 * （`backend.md §6e`）。DB 那側有 `verify-core` 的 H4/H6 守著分母；
 * **前端這一側由 `verify-all.ts` 的 `frontend/monthly-baseline` 兩條守著**
 * ——它拿真實資料跑這支函式，跟 DB 的答案逐格對帳，並且證明那組資料真的
 * 分辨得出兩種分母。
 *
 * ⚠️ 資料一律取自 `user_year_stats(username, null)`，**不要在前端拿紀錄列表
 *    就地算**：`/u/` 上別人拿得到的紀錄集合與本人不同（RLS 依觀看者而異），
 *    就地算會讓同一個人的「歷年平均」因為誰在看而不一樣。
 *
 * 拿不到這個欄位（舊的快取、RPC 還沒回來、或格數不是 12）時回 null——
 * **寧可不畫那條線，也不要畫一條除以錯的數字的線**。
 */
export function monthlyBaselineSeries(
  // 只讀 `month` 與 `avg_records` 兩個欄位，所以收結構型別而不是
  // `YearStats['monthly_baseline']`——`/u/` 的端點只轉發這兩欄（金額一律不出門），
  // 綁死完整型別會逼那支端點把 `avg_spend` 也帶出來。
  baseline: { month: number, avg_records: number }[] | null | undefined,
): number[] | null {
  if (!baseline?.length)
    return null
  const by = new Map(baseline.map(b => [b.month, b.avg_records]))
  const out: number[] = []
  for (let m = 1; m <= MONTHS_PER_YEAR; m++) {
    const v = by.get(m)
    // 缺任何一格就整條不畫。補 0 會讓那個月看起來像「平均從沒去過」。
    if (typeof v !== 'number' || !Number.isFinite(v))
      return null
    out.push(v)
  }
  return out
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

/* ─────────────────────── 圖說（`/app` 與 `/u/` 共用） ─────────────────────── */

/**
 * ★ 樣本數不足時**不要下「最」的斷言**（`SCREENS §9c.3`）。
 *
 * 「你最常在週六 10:00 進場，共 2 場」——2 場、樣本 8 筆。那是從雜訊長出來的
 * 斷言，比不給洞察更糟，因為它看起來像一個發現。
 * **0 筆不畫圖、1–19 筆畫圖但不給斷言、20 筆以上才有洞察。**
 */
export const INSIGHT_MIN = 20

/**
 * 時段熱點圖的圖說。
 *
 * ⚠️ **這一段刻意放在 `utils` 而不是各自寫在兩個頁面裡。** `/app` 與 `/u/` 畫的是
 * 同一張圖，圖說各留一份的話**一定會漂移**——而漂移之後沒有人會發現，
 * 因為沒有人會把兩頁的同一張圖擺在一起看（`backend.md §6e` 對
 * 「一個欄位餵兩個用途」講的是同一件事）。
 *
 * `scopeLabel` 是「全部年度」或「2019 年」：**每一句圖說都要說得出自己涵蓋
 * 什麼範圍**，否則同一句話在兩種檢視視角下長得一樣而數字差十倍。
 */
export function hourInsightText(rows: YearStats['weekday_hour'], scopeLabel: string): string | null {
  const n = rows.reduce((sum, r) => sum + r.records, 0)
  if (!n)
    return null
  if (n < INSIGHT_MIN) {
    const slots = new Set(rows.map(r => `${r.weekday}:${r.hour}`)).size
    return `${scopeLabel}的 ${n} 場分佈在 ${slots} 個時段。`
  }
  const share = weekendEveningShare(rows)
  if (share >= 50)
    return `你 ${share}% 的場次在週五到週日的晚上。`
  const peak = peakSlot(rows)
  if (!peak)
    return null
  const hour = MIDNIGHT_HOURS.includes(peak.hour)
    ? MIDNIGHT_LABEL
    : `${String(peak.hour).padStart(2, '0')}:00`
  return `你最常在週${WEEKDAY_LABELS[peak.weekday - 1]} ${hour} 進場，共 ${peak.records} 場。`
}

/** 影城分布的圖說。同上，兩頁共用。 */
export function venueInsightText(
  venues: YearStats['venues'],
  totalRecords: number,
  scopeLabel: string,
): string | null {
  const top = homeVenue(venues)
  if (!totalRecords || !top)
    return null
  // 樣本不足就只敘述，不說「你的主場」——8 場裡的 6 場不構成「主場」
  if (totalRecords < INSIGHT_MIN)
    return `${scopeLabel}的 ${totalRecords} 場分佈在 ${venues.length} 個場所。`
  return `你的主場是 ${top.name}，${top.share}% 的場次在這裡。`
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

/* ─────────────────────────── 金額的呈現 ─────────────────────────── */

/**
 * 金額的顯示字串。
 *
 * ⚠️ **涵蓋不完整時要在數字上看得出來**，不能只靠底下一行小字——
 * 使用者看到一張「每年花費」而不知道那是部分資料，比沒有這張圖更糟：
 * 那會讓他以為朋友一年只花了那麼多。「以上」是一個中文裡不需要圖例的記號，
 * 而且**它跟著數字走**：使用者只截到一列的圖時，那個但書仍然在。
 *
 * ── ★ NT$0 不等於隱藏（`SCREENS §12.1`）────────────────────────────────────
 * 實測 David：**2015 年 2 場、票價都記了、合計 NT$0**（兌換票／免費場）。
 * 那是一個真實而且有意思的事實，不是「沒有資料」。第一版把
 * 「金額為 0」當成「沒東西可看」整列過濾掉，2015 就這樣從圖上消失了
 * ——年表上有那一年、花費圖上沒有，而畫面看起來完全正常。
 *
 * ⇒ `amount === 0` 且**涵蓋完整**時顯示「免費」，跟票根卡同一個字
 *   （`costText(0)` 也是「免費」）。
 *
 * ⚠️ `amount === 0` 但**涵蓋不完整**時仍然是「NT$0 以上」，那才精確：
 *    「看得到的部分加起來是 0，實際只會更多」。不要把它也寫成「免費」
 *    ——那會把「沒公開」講成「沒花錢」，正好是這張圖最不能犯的錯。
 */
export function spendText(amount: number, currency: string, partial: boolean): string {
  if (amount === 0 && !partial)
    return '免費'
  const base = currency === 'TWD'
    ? `NT$${Number(amount).toLocaleString('zh-Hant-TW')}`
    : `${currency} ${Number(amount).toLocaleString('zh-Hant-TW')}`
  return partial ? `${base} 以上` : base
}
