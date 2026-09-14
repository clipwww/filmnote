// 相對匯入而不是 `~/utils/…`：vitest 的 `~` 別名指向 src/（管線那一側），
// 走別名的話單元測試會 resolve 不到。同層檔案用相對路徑最不會出事。
import { WEEK_START } from './chart-theme'
import { displayTitle } from './film-title'

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
  /**
   * 每一欄（星期）的總和，長度固定 7。
   *
   * ★★ **總和不進 `data`、不進 `max`。** ★★
   * 實測 David（174 筆）：單格最大 9、欄總和最大 60。兩個方向都是災難，
   * 而且兩種都零錯誤訊息：
   * - 總和當成第 8 欄餵進 `data` ⇒ `max` 從 9 變 60 ⇒ `heatPieces(60)` 第一段是
   *   `{gt:0, lte:10}`，真實的 112 格（值域 0–9）**全部塌進最淺的兩階**，整張圖變平。
   * - 總和沿用 `max=9` 的色階 ⇒ `{gt:7}` 那一段把 7 個欄總和裡的 5 個塗成最深的
   *   `heat[6]`，跟真正的尖峰（9）同色，色階的語意當場失效。
   * 所以總和只能畫在格盤**外側**（第二組 category 軸的純文字標籤），
   * 見 `app/utils/hour-heatmap-option.ts`。
   */
  colTotals: number[]
  /** 每一列（時段）的總和，長度 = `rows.length`。**不可寫死 16**，列數隨資料變。 */
  rowTotals: number[]
  /** `colTotals` 與 `rowTotals` 的共同總和。母體不含沒記時間的紀錄（見 `missing`）。 */
  total: number
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
  // ★ 總和跟 data／max 完全分開累加，理由寫在 `HourGrid.colTotals` 上方。
  const colTotals = Array.from<number>({ length: 7 }).fill(0)
  const rowTotals = Array.from<number>({ length: labels.length }).fill(0)
  let total = 0
  let max = 0
  for (let x = 0; x < 7; x++) {
    for (let y = 0; y < labels.length; y++) {
      const v = counts.get(`${x}:${y}`) ?? 0
      data.push([x, y, v])
      // `?? 0` 而不是 `!`：tsconfig 開了 noUncheckedIndexedAccess，
      // 索引存取的型別帶 undefined。兩個陣列的長度都是上面剛建好的，實際取不到 undefined。
      colTotals[x] = (colTotals[x] ?? 0) + v
      rowTotals[y] = (rowTotals[y] ?? 0) + v
      total += v
      if (v > max)
        max = v
    }
  }
  return { rows: labels, data, max, missing, colTotals, rowTotals, total }
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

/**
 * 某一筆紀錄的 `watched_on` 是不是落在某個月份（1..12）。點月度趨勢的某一點時，
 * 用它把那個月的紀錄過濾出來餵抽屜。
 *
 * ⚠️ **一律字串切片，不可以 `new Date()`。** 理由與同檔 `weekIndexInYear()`／
 * `isoDow()`／`inRepeatScope()` 寫過的完全一樣：`watched_on` 是台北牆上時間的
 * 日期，本來就沒有時區可言；`new Date('2026-03-01')` 會被當成 UTC 午夜解析再
 * 轉成本地時間，**UTC 以西的時區整個退一天** ⇒ 月初那一筆會掉到上一個月，
 * 而且不會報錯（圖上 12 筆、抽屜列 11 張，兩邊都「看起來正常」）。
 *
 * 用正則而不是裸的 `slice(5, 7)`：格式不合（空字串、`2026/03/01`、只有年月）時
 * 要回 false，不要讓 `Number('')` 的 0 或 `Number('/0')` 的 NaN 去碰運氣。
 *
 * ⚠️ 這支**只管月份，不管年份**。全期視角的「每個月」是季節性（十三年的同月份
 * 加總，見 `YearStats.monthly` 的註解），所以月份條件就是全部；指定年份時呼叫端
 * 必須**另外**加上年份條件（用 `watchedOn` 的年份前綴比對，形狀照 `inRepeatScope()`
 * 裡那個 `startsWith`）——否則切到 2019 年時，抽屜會把十三年的三月全列出來。
 *
 * 放在這裡而不是頁面的 inline computed：vitest 摸不到 SFC（`SCREENS §9.2`）。
 */
export function inMonth(watchedOn: string | null | undefined, month: number): boolean {
  const m = /^\d{4}-(\d{2})-\d{2}$/.exec(String(watchedOn ?? ''))
  return !!m && Number(m[1]) === month
}

/**
 * 點月度趨勢的某一點時的抽屜標題。
 *
 * - 全期（`year === null`）：`3 月` + 全形空白 + `12 場`
 * - 指定年份：`2019 年 3 月` + 全形空白 + `4 場`
 *
 * ★ **全期刻意不寫「全部年度」**——那一句話會擠掉標題，而範圍其實是每張票根卡
 *   自己的 `show-year` 在講（`SCREENS §9.2` 既有規矩，`repeatTitle()` 同一條）。
 *
 * ★ **一定要帶場次**（踩雷 #169，同 `repeatTitle()`／`distPickTitle()`）：
 *   那是唯一能讓「圖上那一點說 12、抽屜列 9」現形的地方。
 *
 * ⚠️ 分隔規則有兩層，不要「順手統一」：
 *   `2019 年` 與 `3 月` 之間是**半形空白**（它們是同一個日期的兩截），
 *   只有量詞（`12 場`）前面那一個是 U+3000 全形空白——那才是
 *   `slotTitle()`／`repeatTitle()` 那條規矩要的位置（`SCREENS §9.2`）。
 *   實際的字元看下面的樣板字串（註解裡不貼字面 U+3000，理由見 `repeatTitle()`）。
 */
export function monthTitle(month: number, year: number | null, records: number): string {
  return year === null
    ? `${month} 月　${records} 場`
    : `${year} 年 ${month} 月　${records} 場`
}

/* ─────────────────────────── 分布長條 ─────────────────────────── */

export interface DistItem {
  name: string
  records: number
  /**
   * 穩定識別：`venue_id` ／ format `code` ／ country 字串。
   * 聚合列（「其他 N 家」）是 `null`——它不對應任何一個真實分類。
   *
   * ⚠️ **不可以用 `name` 當識別**，三個分布各有各的理由：
   * - 影城：`name` 不保證唯一（同名分館），而且 `venue` 讀不到時是 null。
   * - 版本：畫面上的「其他」是 `code = 'other'`，那是 RPC
   *   `coalesce(r.format_code, 'other')` 聚出來的**真分類**（實測 David 有 5 筆），
   *   跟 `topWithRest()` 造出來的聚合列長得一樣但意思完全不同。
   * - 國別：畫面上的「未分類」是**空字串**（RPC 的 `coalesce(f.country, '')`），
   *   拿「未分類」這四個字去比對什麼都對不上。
   *
   * 有了它，點一列才能回頭把紀錄過濾出來（見 `matchesDistPick()`）。
   */
  key?: string | null
  /**
   * 只有「其他 N 家」那一列會有：被它收進來的長尾原件，**順序與上游一致**
   * （`user_year_stats` 的 venues 子查詢已經 `order by n desc, name`）。
   * 給「展開看完整清單」用（`DistributionBars` 靠「有沒有這一欄」決定要不要給展開鈕）。
   *
   * ⚠️ 不要在前端重排、也不要改名——上游已經排好，前端再排一次
   *   只是多一個會跟上游漂移、而且沒有人會發現的地方。
   * ⚠️ 一般列**不可以**帶 `rest: []`：那會讓每一列都長出一顆點開沒東西的鈕。
   */
  rest?: DistItem[]
}

/**
 * 長尾收成「其他 N 家」，並把被收進來的原件掛在那一列的 `rest` 上。
 *
 * 保留原始筆數而不是百分比：長條的長度由 `DistributionBars` 依第一列當基準算，
 * 先轉百分比只會多一次精度損失。（這一句原本寫「由 ECharts 依 max 算」——
 * 這張圖從來不是 ECharts，是 HTML 排版；順手更正。）
 */
export function topWithRest(items: DistItem[], limit: number, restLabel: (n: number) => string): DistItem[] {
  // `<= limit`：本來就放得下，一列都不用收。
  // `=== limit + 1`：只多一筆。聚成「其他 1 家」會得到一顆點開只有一列的展開鈕
  //   ——那比直接多畫一列還糟。而且這不是假想的邊界：實測 David 全期的國別與
  //   版本**正好都是 5**（= 呼叫端傳的 limit），只要多一個沒看過的國別或版本
  //   就會踩到，距離只有一筆紀錄。
  if (items.length <= limit + 1)
    return [...items]
  // ★ `slice()` 是淺拷貝，每一件（head 與 tail 裡的都是）**原樣帶著自己的 `key`**
  //   走進回傳值。不要在這裡重建物件——重建一次就會漏掉 `key`，而漏掉的症狀是
  //   「長條畫得出來、點下去抽屜永遠是空的」，typecheck 與既有測試都不會紅
  //   （`key` 是可選欄位）。
  const head = items.slice(0, limit)
  const tail = items.slice(limit)
  head.push({
    name: restLabel(tail.length),
    // ★ `records` 是加總、`rest` 是原件，**兩者必須永遠對得起來**。
    //   那也是最容易抓到「slice 切錯」的斷言（見 tests/stats.test.ts）。
    records: tail.reduce((n, i) => n + i.records, 0),
    // ★ 聚合列沒有自己的識別：它不是一個分類，是好幾個分類的和。
    //   給 null 而不是隨便湊一個字串——湊出來的值會被 `matchesDistPick()`
    //   拿去比對，然後對上零筆紀錄。這一列的展開靠 `rest`，不靠 `key`。
    key: null,
    rest: tail,
  })
  return head
}

/** 三個分布長條各自的識別空間。**三個的 coalesce 規則都不一樣**，見下面那支。 */
export type DistKind = 'venue' | 'format' | 'country'

/**
 * 某一筆紀錄要不要算進「點某一條分布長條」開出來的抽屜。
 *
 * ⚠️ **三種 kind 的預設值必須跟 `user_year_stats`（`0003`）的 group by 一模一樣**，
 * 否則圖上的數字與抽屜列出的張數會對不起來，而兩邊都「看起來正常」：
 *
 * - `format`：RPC 是 `coalesce(r.format_code, 'other')`，也就是
 *   **`format_code` 為 null 的紀錄與 `format_code = 'other'` 的紀錄被歸進同一桶**
 *   （畫面標籤就叫「其他」）。這裡少了 `?? 'other'` 的話，那些 null 會在圖上
 *   算進「其他」、在抽屜裡一筆都列不出來。
 *   ★ 這**不是**假想的邊界：實測 David 的版本分布是
 *   digital 129 / 4dx 30 / imax 9 / **other 5** / dolby 1，那 5 筆真的走這條。
 * - `country`：RPC 是 `coalesce(f.country, '')`，空字串就是畫面上的「未分類」
 *   （film 讀不到——別人的私密 UGC 作品——也落在這一桶）。
 * - `venue`：RPC 直接 group by `r.venue_id`，沒有場所的紀錄是 null；
 *   這裡用 `?? ''` 對應，呼叫端把那一列的 key 也寫成 `venue_id ?? ''` 就對得上。
 *
 * 之所以是一支匯出的純函式而不是寫在 `.vue` 的 inline computed 裡（`SCREENS §9.2`）：
 * **vitest 摸不到 SFC**。寫在 computed 裡的話上面那三條 coalesce 一條都沒有東西守，
 * 而它們壞掉的樣子全都是「抽屜開得起來但少列了幾張」——沒有錯誤訊息。
 */
export function matchesDistPick(
  r: { venueId?: string | null, formatCode?: string | null, country?: string | null },
  kind: DistKind,
  key: string,
): boolean {
  if (kind === 'venue')
    return (r.venueId ?? '') === key
  if (kind === 'format')
    return (r.formatCode ?? 'other') === key
  return (r.country ?? '') === key
}

/**
 * 點一條分布長條時的抽屜標題：`林口威秀影城` + 全形空白 + `120 場`。
 *
 * ★ **一定要帶場次**，理由與 `repeatTitle()` 完全相同（踩雷 #169）：那是唯一能讓
 *   「長條說 120、抽屜列 96」被肉眼看見的地方。數字刻意取自**長條上那個數字**
 *   （圖的宣稱），不是抽屜實際列出幾張——用同一個來源就永遠看不出不一致。
 *
 * ⚠️ 分隔符是 U+3000（全形空白），跟 `slotTitle()` / `repeatTitle()` 同一條規矩
 *   （`SCREENS §9.2`）。這一段註解刻意不貼字面的 U+3000——oxlint 的
 *   `no-irregular-whitespace` 擋註解、不擋樣板字串（見 `repeatTitle()` 上方的說明）。
 */
export function distPickTitle(name: string, records: number): string {
  return `${name}　${records} 場`
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

/** 點星期總和（底部那一列）時的抽屜標題：`週六\u3000全部時段`。分隔符是 U+3000（全形空白）。 */
export function weekdayTitle(weekday: number): string {
  const name = WEEKDAY_LABELS[weekday - 1] ?? ''
  return `週${name}　全部時段`
}

/** 點時段總和（右側那一欄）時的抽屜標題：`21:00\u3000全部星期`。分隔符是 U+3000（全形空白）。 */
export function hourRowTitle(rowLabel: string): string {
  return `${rowLabel}　全部星期`
}

/**
 * 某一筆紀錄要不要算進「星期總和」那一條抽屜。
 *
 * ⚠️ **`!!watchedTime` 這個條件不能省，而且它在真實資料上永遠測不出來。**
 * 熱點圖的母體是 `user_year_stats` 的 `weekday_hour` 子查詢，那支 SQL 帶
 * `where watched_time is not null`；而頁面手上的 `records` 是全部。少了這個條件，
 * 抽屜列出的張數會比圖上的欄總和多——而 David（唯一有資料的帳號）的
 * `records_without_time` 是 0，點一百次也不會現形。只有合成資料的單元測試抓得到。
 *
 * （時段那一條靠 `inHourRow(null, …) === false` 天然免疫，不需要這支。）
 *
 * 之所以是一支匯出的純函式而不是寫在 `.vue` 的 inline computed 裡：
 * 寫在 computed 裡 vitest 摸不到，就沒有任何東西守得住上面那段。
 */
export function matchesWeekdayPick(
  r: { watchedOn?: string | null, watchedTime?: string | null },
  weekday: number,
): boolean {
  return !!r.watchedTime && isoDow(r.watchedOn ?? '') === weekday
}

/**
 * 多刷排行（band 7）點一列時的抽屜標題：
 * 全期「少女與戰車 劇場版 + 全形空白 + 10 次」；
 * 指定年份「少女與戰車 最終章 第４話 + 全形空白 + 2024 年 + 全形空白 + 3 次」。
 *
 * ⚠️ 這一段刻意不貼字面的 U+3000：**oxlint 的 `no-irregular-whitespace` 擋註解、
 * 不擋樣板字串**（`skipStrings` 預設開、`skipComments` 預設關）。實際的分隔符
 * 看下面的樣板字串，那裡才是字面的 U+3000。
 *
 * ★ **一定要帶次數。** 那是唯一能讓「排行說 10、抽屜列 7」被肉眼看見的地方
 *   （踩雷 #169：抽屜開得起來不等於列得出東西，空抽屜會理直氣壯地說謊）。
 *   這個數字刻意來自**排行上那個數字**（圖的宣稱），不是抽屜實際列出幾張——
 *   兩邊一致才是對的，用同一個來源就永遠看不出不一致。
 *
 * ★ **指定年份時一定要帶年。** 多刷的語意在全期與單年是兩件事
 *   （`SCREENS §9` 2026-09-06 裁決第 3 條），標題必須說得出自己涵蓋什麼範圍。
 *   全期不另外寫「全部年度」——每張票根卡自己帶 `show-year`。
 *
 * 分隔符是 U+3000（`slotTitle` 同一套寫法）。
 */
export function repeatTitle(titleZh: string | null | undefined, year: number | null, records: number): string {
  const name = displayTitle(titleZh) || '（作品不明）'
  return year === null ? `${name}　${records} 次` : `${name}　${year} 年　${records} 次`
}

/**
 * 某一筆紀錄要不要算進「多刷排行」那一條抽屜。
 *
 * ⚠️ **`filmId` 是必填而不是可選的，這是刻意的。**
 * `/app` 那邊有 `MyRecord` 介面擋著，忘了帶 `filmId` 是編譯錯誤；
 * 但 `/u/` 的 `cards` 是沒有型別標註的 inline object literal，宣告成可選的話
 * 忘了加 `filmId` 會 **typecheck 全綠、抽屜永遠是空的、標題還理直氣壯寫著「10 次」**。
 * 保護剛好只長在不會出錯的那一邊。必填才會強制兩個呼叫端都供貨。
 *
 * ⚠️ 只用 `film_id` 對，**不要用片名或 slug**（`BUILD_PLAN` 附錄第 31 條：
 * 多刷以 film_id 分組）。片名會撞（David 就有「少女與戰車最終章 第1話」與
 * 「《少女與戰車 最終章》 第3話」這種同系列近似名），slug 對未審核 UGC
 * 拿得到卻連過去 404。
 *
 * ⚠️ 年份比對用 `startsWith('2024-')` 不是 `new Date(...).getFullYear()`——
 * 同 `isoDow` 的理由：`watched_on` 是台北牆上時間的日期字串，任何 Date 解析
 * 都會在 UTC 以西的時區退一天而且不報錯。
 */
export function inRepeatScope(
  r: { filmId: string | null, watchedOn?: string | null },
  filmId: string,
  year: number | null,
): boolean {
  if (!r.filmId || r.filmId !== filmId)
    return false
  return year === null || String(r.watchedOn ?? '').startsWith(`${year}-`)
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
 * ★★ **「最」要是真的**（David 2026-09-06 裁決，收緊 `SCREENS §9c.3`）。
 *
 * `INSIGHT_MIN` 守的是**總筆數**，但那守不到真正的問題。實測 David 的時段分布：
 * 174 場、67 個有值的格子，**最高 9 場、第二高也是 9 場、第三高 8 場**
 * （週六 14:00、週六 10:00、週五 22:00）。舊邏輯照樣輸出
 * 「你最常在週六 10:00 進場，共 9 場」——那句話**不是弱，是不成立**：
 * 它在兩個並列的格子裡任意挑了一個，而使用者會把它讀成一個發現。
 *
 * ⇒ 門檻要守的是**「這個尖峰有沒有從分布裡站出來」**，不是總筆數。
 */

/** 絕對下限。低於這個數字的「最」不是習慣，是巧合。 */
export const PEAK_MIN_RECORDS = 5

/**
 * 尖峰必須明顯領先第二名。**這一條才是抓到 David 那個並列的東西**——
 * 只看「尖峰夠不夠大」（例如 z 分數）會放行 9 vs 9，因為 9 確實夠大。
 * 「最」這個字宣稱的是**唯一性**，所以判準也必須是唯一性。
 */
export const PEAK_LEAD = 1.5

/**
 * 聚合型斷言（「X% 的場次在週末」）的門檻：至少要是**平均分佈**的這麼多倍。
 *
 * 聚合橫跨很多格，所以不受單格雜訊影響——那正是尖峰站不出來時仍然講得出
 * 真話的原因。基準線是「完全平均分佈時會是多少」：週末是 3/7 ＝ 42.9%，
 * 所以 1.4 倍 ＝ 60%。實測 David 週末 **78.7%**（過關，而且是真的）。
 */
export const AGGREGATE_LIFT = 1.4

/**
 * ★ 而且它必須真的在講**多數**。
 *
 * 只看「有沒有高過平均分佈」是不夠的：實測 David 的「週末晚上」是 **39%**，
 * 基準線 30%（3/7 × 8/16），倍率 1.3 ⇒ 光看 lift 會放行，
 * 於是畫面上出現「**你 39% 的場次在週五到週日的晚上**」。
 * 那句話技術上沒說錯，但讀起來是假的——使用者讀到的是「這就是我的樣子」，
 * 而 61% 的場次不是那樣。**判準是「這句話講出去要是對的」，不是「數學上站得住」。**
 */
export const AGGREGATE_MIN_SHARE = 50

/**
 * 這一組數字裡的最大值，有沒有「站出來」到可以被稱為「最」。
 *
 * ⚠️ 兩頁（`/app` 與 `/u/`）共用這一支。各留一份判斷一定會漂移，
 *    而漂移之後沒有人會發現——沒有人會把兩頁的同一句圖說擺在一起看。
 */
export function peakStandsOut(counts: number[]): boolean {
  const sorted = [...counts].filter(n => n > 0).sort((a, b) => b - a)
  const top = sorted[0] ?? 0
  const second = sorted[1] ?? 0
  if (top < PEAK_MIN_RECORDS)
    return false
  // 第二名是 0（只有一格有資料）時不必比領先幅度，它本來就是唯一的
  return second === 0 || top >= PEAK_LEAD * second
}

/**
 * 時段熱點圖的圖說。
 *
 * 順序是**由穩健到脆弱**：先講跨很多格的聚合（不受單格雜訊影響），
 * 站不出來的尖峰**不講**，什麼都站不出來時給一句純敘述——
 * 「沒有特別集中的一格」本身就是一個發現，而且是真的。
 *
 * ⚠️ **這一段刻意放在 `utils` 而不是各自寫在兩個頁面裡。** `/app` 與 `/u/` 畫的是
 * 同一張圖，圖說各留一份的話**一定會漂移**（`backend.md §6e` 對
 * 「一個欄位餵兩個用途」講的是同一件事）。
 *
 * `scopeLabel` 是「全部年度」或「2019 年」：**每一句圖說都要說得出自己涵蓋
 * 什麼範圍**，否則同一句話在兩種檢視視角下長得一樣而數字差十倍。
 */
export function hourInsightText(rows: YearStats['weekday_hour'], scopeLabel: string): string | null {
  const n = rows.reduce((sum, r) => sum + r.records, 0)
  if (!n)
    return null

  const grid = hourGrid(rows)
  const slots = new Set(rows.map(r => `${r.weekday}:${r.hour}`)).size

  if (n < INSIGHT_MIN)
    return `${scopeLabel}的 ${n} 場分佈在 ${slots} 個時段。`

  // ── ① 穩健的聚合：橫跨很多格，單格的雜訊動不了它 ──────────────────────
  const isEvening = (h: number) => h >= 17 || MIDNIGHT_HOURS.includes(h)
  const share = (pred: (r: YearStats['weekday_hour'][number]) => boolean) =>
    Math.round((rows.filter(pred).reduce((m, r) => m + r.records, 0) / n) * 100)

  // 最具體的先試：週末的晚上。基準線是 (3/7) × (晚場列數 / 全部列數)。
  const eveningRows = grid.rows.filter(l => l === MIDNIGHT_LABEL || Number(l.slice(0, 2)) >= 17).length
  const eveningBase = eveningRows / grid.rows.length
  // ★ 直接用既有的 `weekendEveningShare()`，不要在這裡重算一份同樣的東西
  //   ——兩份一定會在某次修改後給出不一致的數字。
  const weShare = weekendEveningShare(rows)
  if (weShare >= AGGREGATE_MIN_SHARE && weShare >= Math.round((3 / 7) * eveningBase * AGGREGATE_LIFT * 100))
    return `你 ${weShare}% 的場次在週五到週日的晚上。`

  // 週末（基準線 3/7 ＝ 42.9%，門檻 60%）
  const weekendShare = share(r => WEEKEND_ISODOW.has(r.weekday))
  if (weekendShare >= AGGREGATE_MIN_SHARE && weekendShare >= Math.round((3 / 7) * AGGREGATE_LIFT * 100))
    return `你 ${weekendShare}% 的場次在週五到週日。`

  // 晚場（基準線由格盤自己算，David 約 50% ⇒ 51.7% 不過關，那本來就不是發現）
  const eveningShare = share(r => isEvening(r.hour))
  if (eveningShare >= AGGREGATE_MIN_SHARE && eveningShare >= Math.round(eveningBase * AGGREGATE_LIFT * 100))
    return `你 ${eveningShare}% 的場次在晚上。`

  // ── ② 尖峰：**只有真的站得出來才准講「最」** ──────────────────────────
  const peak = peakStandsOut(rows.map(r => r.records)) ? peakSlot(rows) : null
  if (peak) {
    const hour = MIDNIGHT_HOURS.includes(peak.hour)
      ? MIDNIGHT_LABEL
      : `${String(peak.hour).padStart(2, '0')}:00`
    return `你最常在週${WEEKDAY_LABELS[peak.weekday - 1]} ${hour} 進場，共 ${peak.records} 場。`
  }

  // ── ③ 都站不出來 ⇒ 純敘述。「沒有特別集中的一格」也是一個發現。 ────────
  return `${scopeLabel}的 ${n} 場散在 ${slots} 個時段，沒有特別集中的一格。`
}

/**
 * 影城分布的圖說。同上，兩頁共用，而且「主場」也要真的站得出來。
 *
 * 實測 David：120 / 14 / 10…，佔 69% ⇒ 站得出來，「主場」是真的。
 * 但如果最高的那家只比第二名多一點，「你的主場是 X」就是一句任意的話。
 */
export function venueInsightText(
  venues: YearStats['venues'],
  totalRecords: number,
  scopeLabel: string,
): string | null {
  if (!totalRecords || !venues.length)
    return null
  // 樣本不足就只敘述，不說「你的主場」——8 場裡的 6 場不構成「主場」
  if (totalRecords < INSIGHT_MIN)
    return `${scopeLabel}的 ${totalRecords} 場分佈在 ${venues.length} 個場所。`

  const top = homeVenue(venues)
  if (top && peakStandsOut(venues.map(v => v.records)))
    return `你的主場是 ${top.name}，${top.share}% 的場次在這裡。`

  // 站不出來就講一句**集合層級**的真話：不宣稱唯一的贏家，但仍然有資訊
  const total = venues.reduce((m, v) => m + v.records, 0)
  const topThree = [...venues].sort((a, b) => b.records - a.records).slice(0, 3)
  const shareOfThree = Math.round((topThree.reduce((m, v) => m + v.records, 0) / Math.max(1, total)) * 100)
  return `${scopeLabel}的場次分散在 ${venues.length} 個場所，最常去的三家佔 ${shareOfThree}%。`
}

/**
 * 最大值那一格。⚠️ **它只是最大值，不是「最」**——要宣稱「最」之前必須先過
 * `peakStandsOut()`（實測 David 的前兩名都是 9 場，argmax 是任意挑一個）。
 */
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

/**
 * 「每年花費」列尾的場次與張數。
 *
 * 整列的形狀是 `{金額} / {場數} 場 / {票數} 張`（David 2026-09-07 逐字指定的
 * 顯示格式），金額那一段由 `spendText()` 負責，這一支只負責後面兩段。
 *
 * ⚠️ **分隔符是斜線，不是站內慣例的全形空白。** `DESIGN_SYSTEM §0` 與
 *    `charts.md §2.2` 定的量詞串用全形空白（`slotTitle()` 的「週五\u300021:00」），
 *    這裡刻意不照那條走——David 逐字寫的是斜線，而 `UserSpendSummary` 的
 *    「只涵蓋 3 / 5 筆紀錄」已經有先例。**不要順手改成全形空白或中點**
 *    （中點串是 Letterboxd 的簽名，這個產品刻意不長那樣）。
 *
 * ⚠️ **場次與張數是兩個不同的數字**，一場可能買多張票（實測 David 2019 年
 *    25 場 37 張）。順序不可對調，而且測試的樣本必須挑 `records !== tickets`
 *    的年份——拿 2014 年（3 場 3 張）當測資的話，把兩個參數對調照樣綠
 *    （踩雷 #175：測試資料必須真的走得到要測的分支）。
 *
 * ⚠️ 兩個數字都取自 RPC 的 `by_year`（`tk = sum(coalesce(ticket_count, 1))`），
 *    跟頁首那句「總共看了 174 場、250 張票」是**同一個定義**。實測 `by_year`
 *    的加總正好等於 `totals`（174／250／57,873），不要在別的地方另算一套。
 *
 * ★ 回傳的是**一整串**（含中間那個斜線）而不是兩段：這一段整體是不換行的原子，
 *   換行機會只留在它與金額之間的那個斜線上（見 `SpendByYear.vue` 的模板）。
 *   拆成兩個 `whitespace-nowrap` 的元素反而會讓分隔空白落在 nowrap 內部而
 *   失去換行機會——nowrap 裡的空白**不產生斷行點**。
 */
export function spendCountsText(records: number, tickets: number): string {
  return `${records} 場 / ${tickets} 張`
}
