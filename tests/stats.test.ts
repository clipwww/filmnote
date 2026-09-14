import type { YearStats } from '../app/utils/stats'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as echarts from 'echarts'
import { describe, expect, it } from 'vitest'
import { hourHeatmapHeight, hourHeatmapOption } from '../app/utils/hour-heatmap-option'
import {
  calendarSeries,
  dayTitle,
  distPickTitle,
  doubleFeatureDays,
  homeVenue,
  hourGrid,
  hourInsightText,
  hourRowTitle,
  inHourRow,
  inMonth,
  inRepeatScope,
  isoDow,
  matchesDistPick,
  matchesWeekdayPick,
  MIDNIGHT_LABEL,
  monthlyBaselineSeries,
  monthlySeries,
  monthlySeriesToDate,
  monthTitle,
  peakStandsOut,
  repeatTitle,
  slotTitle,
  spendCountsText,
  spendText,
  topWithRest,
  venueInsightText,
  WEEKDAY_LABELS,
  weekdayTitle,
  weekendEveningShare,
  weekIndexInYear,
  yearStripRows,
} from '../app/utils/stats'

describe('出席圖', () => {
  const daily: YearStats['daily'] = [
    { date: '2026-01-02', records: 1, tickets: 2 },
    { date: '2026-03-14', records: 2, tickets: 2 },
    { date: '2026-07-26', records: 1, tickets: 2 },
  ]

  it('轉成 [date, value]', () => {
    expect(calendarSeries(daily)).toEqual([
      ['2026-01-02', 1],
      ['2026-03-14', 2],
      ['2026-07-26', 1],
    ])
  })

  it('只有「兩場以上」的日子進 scatter', () => {
    // 這 4 天（實測）是雙片連映，是那張圖唯一想讓人看見的東西
    expect(doubleFeatureDays(daily)).toEqual([['2026-03-14', 2]])
  })
})

describe('時段熱點圖', () => {
  it('7 × N 全格都有值，包含 0（§5.3-6：cartesian2d 不畫空格）', () => {
    const g = hourGrid([{ weekday: 5, hour: 22, records: 8 }])
    expect(g.data.length).toBe(7 * g.rows.length)
    expect(g.data.filter(d => d[2] === 0).length).toBe(7 * g.rows.length - 1)
  })

  it('預設從 09:00 開始，午夜場在最後一列', () => {
    const g = hourGrid([{ weekday: 1, hour: 10, records: 1 }])
    expect(g.rows[0]).toBe('09:00')
    expect(g.rows.at(-1)).toBe(MIDNIGHT_LABEL)
    expect(g.rows.length).toBe(16) // 09..23 共 15 列 + 午夜場
  })

  it('00–02 時折進午夜場，不放行首', () => {
    const g = hourGrid([{ weekday: 5, hour: 0, records: 3 }])
    const last = g.rows.length - 1
    expect(g.data.find(d => d[0] === 4 && d[1] === last)?.[2]).toBe(3)
  })

  it('weekday 是 isodow：1=週一落在第 0 欄、7=週日落在第 6 欄', () => {
    // 當成 0-indexed 會讓整張圖平移一天，而且不會報錯
    const g = hourGrid([
      { weekday: 1, hour: 12, records: 1 },
      { weekday: 7, hour: 12, records: 5 },
    ])
    const y = g.rows.indexOf('12:00')
    expect(g.data.find(d => d[0] === 0 && d[1] === y)?.[2]).toBe(1)
    expect(g.data.find(d => d[0] === 6 && d[1] === y)?.[2]).toBe(5)
  })

  it('真的有清晨場時軸往前延伸，不吃掉那筆紀錄', () => {
    const g = hourGrid([{ weekday: 3, hour: 6, records: 1 }])
    expect(g.rows[0]).toBe('06:00')
    const y = g.rows.indexOf('06:00')
    expect(g.data.find(d => d[0] === 2 && d[1] === y)?.[2]).toBe(1)
  })

  it('同一格的多個小時桶會相加而不是覆蓋', () => {
    const g = hourGrid([
      { weekday: 6, hour: 0, records: 2 },
      { weekday: 6, hour: 1, records: 3 },
    ])
    const last = g.rows.length - 1
    expect(g.data.find(d => d[0] === 5 && d[1] === last)?.[2]).toBe(5)
    expect(g.max).toBe(5)
  })

  it('沒有資料時仍然回完整格盤，max 為 0', () => {
    const g = hourGrid([])
    expect(g.data.length).toBe(7 * 16)
    expect(g.max).toBe(0)
  })

  it('週五到週日晚上的佔比', () => {
    const share = weekendEveningShare([
      { weekday: 5, hour: 19, records: 5 },
      { weekday: 7, hour: 21, records: 2 },
      { weekday: 2, hour: 14, records: 3 },
    ])
    expect(share).toBe(70)
  })
})

/**
 * 形狀照 David 實測（2026-09-07，clipwww@gmail.com，174 筆）：
 * **單格最大 9、欄總和最大 60**——差 6.7 倍，這正是「總和不能當格子畫」的理由。
 * 每一格的數字是合成的（真實的逐格分布不放進 repo），但三個關鍵量是真的：
 * 欄總和 [6,5,13,13,41,60,36]、總計 174、最大單格 9。
 */
const DAVID_SHAPED: YearStats['weekday_hour'] = [
  // 週六 60：兩個 9 的尖峰 + 7 個 6
  { weekday: 6, hour: 10, records: 9 },
  { weekday: 6, hour: 14, records: 9 },
  { weekday: 6, hour: 11, records: 6 },
  { weekday: 6, hour: 13, records: 6 },
  { weekday: 6, hour: 16, records: 6 },
  { weekday: 6, hour: 19, records: 6 },
  { weekday: 6, hour: 21, records: 6 },
  { weekday: 6, hour: 22, records: 6 },
  { weekday: 6, hour: 23, records: 6 },
  // 週五 41
  { weekday: 5, hour: 17, records: 5 },
  { weekday: 5, hour: 18, records: 5 },
  { weekday: 5, hour: 19, records: 7 },
  { weekday: 5, hour: 20, records: 8 },
  { weekday: 5, hour: 21, records: 8 },
  { weekday: 5, hour: 22, records: 8 },
  // 週日 36
  { weekday: 7, hour: 12, records: 6 },
  { weekday: 7, hour: 13, records: 6 },
  { weekday: 7, hour: 14, records: 6 },
  { weekday: 7, hour: 15, records: 6 },
  { weekday: 7, hour: 16, records: 6 },
  { weekday: 7, hour: 17, records: 6 },
  // 週三 13、週四 13（**兩個一樣的欄總和是刻意的**：任何「用總和的數字反查
  // 是哪一欄」的實作都會被這一對咬到）
  { weekday: 3, hour: 19, records: 7 },
  { weekday: 3, hour: 20, records: 6 },
  { weekday: 4, hour: 19, records: 7 },
  { weekday: 4, hour: 20, records: 6 },
  // 週一 6、週二 5
  { weekday: 1, hour: 21, records: 6 },
  { weekday: 2, hour: 22, records: 5 },
]

describe('時段熱點圖的軸外總和', () => {
  it('欄／列總和的長度與三方相等', () => {
    const g = hourGrid(DAVID_SHAPED)
    expect(g.colTotals.length).toBe(7)
    expect(g.rowTotals.length).toBe(g.rows.length) // ★ 不可寫死 16
    expect(g.colTotals).toEqual([6, 5, 13, 13, 41, 60, 36])
    expect(g.total).toBe(174)
    expect(g.colTotals.reduce((a, b) => a + b, 0)).toBe(g.total)
    expect(g.rowTotals.reduce((a, b) => a + b, 0)).toBe(g.total)
  })

  /**
   * ★★ 這兩條是這一項唯一真正的護欄：**總和不進 `data`、不進 `max`。**
   *
   * 既有的 `data.length === 7 * rows.length` 只擋得住「多一欄」，擋不住
   * 「多一列」也擋不住「把總和寫進既有格子」。這裡改成對每一筆 data 的座標
   * 與值域下斷言，兩個方向都會紅：
   * - 塞成第 8 欄 ⇒ `d[0] < 7` 假；塞成第 17 列 ⇒ `d[1] < rows.length` 假。
   * - 總和沿用同一個色階（`max` 被總和撐大）⇒ 第二條的 60 ≠ 9。
   */
  it('★ 總和不在 data 的座標範圍內', () => {
    const g = hourGrid(DAVID_SHAPED)
    expect(g.data.every(d => d[0] >= 0 && d[0] < 7)).toBe(true)
    expect(g.data.every(d => d[1] >= 0 && d[1] < g.rows.length)).toBe(true)
    expect(g.data.length).toBe(7 * g.rows.length)
  })

  it('★ max 是最大的「格」不是最大的「總和」——9 不是 60', () => {
    const g = hourGrid(DAVID_SHAPED)
    expect(g.max).toBe(9)
    expect(Math.max(...g.data.map(d => d[2]))).toBe(g.max)
    // 前提檢查：兩者若一樣大，上面那條就分辨不出任何東西
    expect(Math.max(...g.colTotals)).toBeGreaterThan(g.max)
  })

  it('列總和跟著 rows.length 走——真的有清晨場時是 19 列不是 16', () => {
    const g = hourGrid([...DAVID_SHAPED, { weekday: 3, hour: 6, records: 2 }])
    expect(g.rows[0]).toBe('06:00')
    expect(g.rows.length).toBe(19) // 06..23 共 18 列 + 午夜場
    expect(g.rowTotals.length).toBe(g.rows.length)
    expect(g.rowTotals[0]).toBe(2)
    expect(g.total).toBe(176)
    // ★ 三方相等在**這個列數**也要成立。只驗長度不夠：實測過一個「初始化長度對、
    //   但累加時有 y < 16 的守衛」的變異——長度那條照樣綠，只有這一條會紅。
    expect(g.rowTotals.reduce((a, b) => a + b, 0)).toBe(g.total)
    expect(g.colTotals.reduce((a, b) => a + b, 0)).toBe(g.total)
  })

  /**
   * 列總和與 `inHourRow()` 之間的一致性——**今天靠一個巧合對齊**。
   * `hourGrid()` 的 rowIndex 對放不進軸的小時會折進午夜場，而 `inHourRow()`
   * 的午夜場只認 00/01/02。兩者一致是因為 startHour 一定往前延伸涵蓋 03–08。
   * 這一條把「圖上那一列的總和」與「抽屜會列出幾張」綁在一起。
   */
  it('每一列的總和 = 用 inHourRow 過濾同一批紀錄的張數', () => {
    const raw = [
      { watchedTime: '09:30' },
      { watchedTime: '10:05' },
      { watchedTime: '10:59' },
      { watchedTime: '00:10' },
      { watchedTime: '01:45' },
      { watchedTime: '02:00' },
      { watchedTime: '23:15' },
    ]
    const g = hourGrid(raw.map(r => ({
      weekday: 3,
      hour: Number(r.watchedTime.slice(0, 2)),
      records: 1,
    })))
    for (const [y, label] of g.rows.entries())
      expect([label, g.rowTotals[y]]).toEqual([label, raw.filter(r => inHourRow(r.watchedTime, label)).length])
    expect(g.rowTotals[g.rows.length - 1]).toBe(3) // 午夜場那三筆
  })

  it('抽屜標題用全形空白，不用中點', () => {
    expect(weekdayTitle(6)).toBe('週六　全部時段')
    expect(hourRowTitle('21:00')).toBe('21:00　全部星期')
    expect(hourRowTitle(MIDNIGHT_LABEL)).toBe('午夜場　全部星期')
    expect(weekdayTitle(6)).not.toContain('・')
    expect(hourRowTitle('21:00')).not.toContain('・')
  })

  /**
   * ★ 星期總和的抽屜**必須排除沒記時間的紀錄**。
   *
   * 熱點圖的母體是 RPC 的 `weekday_hour`，那支 SQL 帶
   * `where watched_time is not null`；頁面手上的 `records` 是全部。
   * David 的 `records_without_time` 是 0，**真實資料上點一百次也不會現形**——
   * 只有這條合成資料抓得到。把 `!!r.watchedTime` 拿掉，下面會從 1 變 2。
   */
  it('★ matchesWeekdayPick 排除沒記時間的紀錄', () => {
    const rows = [
      { watchedOn: '2026-09-05', watchedTime: '21:00' }, // 週六
      { watchedOn: '2026-09-05', watchedTime: null }, // 同一天，但沒記時間 ⇒ 不算
      { watchedOn: '2026-09-04', watchedTime: '21:00' }, // 週五
      { watchedOn: null, watchedTime: '21:00' },
    ]
    expect(rows.filter(r => matchesWeekdayPick(r, 6)).length).toBe(1)
    expect(rows.filter(r => matchesWeekdayPick(r, 5)).length).toBe(1)
    expect(rows.filter(r => matchesWeekdayPick(r, 1)).length).toBe(0)
  })
})

/**
 * ★ 把 option **真的 render 一次**再下斷言。
 *
 * `echarts.init(null, null, { ssr: true, renderer: 'svg' })` 在純 node 裡就跑得起來
 * ——不開瀏覽器、不佔 port、不需要 node-canvas。這是唯一能在 `pnpm test` 裡證明
 * 「兩條總和軸真的存在且對齊」的方法。
 *
 * 對 option 欄位下斷言（`grid.right === 36`、`yAxis[1].inverse === true`）大半是
 * 「照抄原始碼」型的變更偵測器：改了數字就紅，但它答不出「36 夠不夠」「總和有沒有
 * 對齊列」。render 出來的 SVG 才答得出，而且它抓得到三件 option 斷言抓不到的事：
 * 標籤被 `interval:'auto'` 吃掉、`inverse` 反了、formatter 索引 off-by-one
 * ——後兩者都是「每個數字看起來都合理」的靜默錯誤。
 */
describe('時段熱點圖的 option（SSR SVG render）', () => {
  /** 375px 裝置扣掉頁面 px-4 與 ChartBand px-4 後，canvas 實際可用寬。 */
  const CANVAS_W = 311
  const GRID_RIGHT = 36
  /** 12px sans 的數字前進寬約 0.6em。用來估三位數總和的右緣，見下面那條測試。 */
  const DIGIT_ADVANCE = 7.2

  interface SvgText { x: number, y: number, anchor: string, text: string }

  function renderTexts(grid: ReturnType<typeof hourGrid>): { texts: SvgText[], paths: number } {
    const chart = echarts.init(null, null, {
      renderer: 'svg',
      ssr: true,
      width: CANVAS_W,
      height: Number.parseInt(hourHeatmapHeight(grid), 10),
    })
    chart.setOption(hourHeatmapOption(grid, false))
    const svg = chart.renderToSVGString()
    chart.dispose()

    const texts: SvgText[] = []
    const re = /<text\b([^>]*)>([^<]*)<\/text>/g
    let m = re.exec(svg)
    while (m) {
      const attrs = m[1] ?? ''
      const t = /transform="translate\(([-\d.]+) ([-\d.]+)\)"/.exec(attrs)
      texts.push({
        x: Number(t?.[1] ?? Number.NaN),
        y: Number(t?.[2] ?? Number.NaN),
        anchor: /text-anchor="(\w+)"/.exec(attrs)?.[1] ?? '',
        text: m[2] ?? '',
      })
      m = re.exec(svg)
    }
    return { texts, paths: (svg.match(/<path/g) ?? []).length }
  }

  /** 左側時段標籤（`text-anchor="end"`），由上到下。 */
  const leftLabels = (t: SvgText[]) => t.filter(v => v.anchor === 'end').sort((a, b) => a.y - b.y)
  /** 右側時段總和（`text-anchor="start"`），由上到下。 */
  const rightTotals = (t: SvgText[]) => t.filter(v => v.anchor === 'start').sort((a, b) => a.y - b.y)
  /** 上／下兩排（`text-anchor="middle"`）：y 小的是星期、y 大的是星期總和。 */
  const midRow = (t: SvgText[], bottom: boolean) => {
    const mid = t.filter(v => v.anchor === 'middle')
    const split = (Math.min(...mid.map(v => v.y)) + Math.max(...mid.map(v => v.y))) / 2
    return mid.filter(v => (bottom ? v.y > split : v.y < split)).sort((a, b) => a.x - b.x)
  }

  it('四條軸的標籤一個都不少（`interval: 0`；掉一個看起來就是「0 場」）', () => {
    const g = hourGrid(DAVID_SHAPED)
    const { texts, paths } = renderTexts(g)
    // 16 列標籤 + 16 列總和 + 7 星期 + 7 欄總和
    expect(texts.length).toBe(g.rows.length * 2 + 14)
    // 而且**沒有多畫任何格子**——總和是文字不是 heatmap 的 item。
    // （axisLine / axisTick 在 axisStyle 裡都是 show:false，所以 path 只剩格子。）
    expect(paths).toBe(7 * g.rows.length)
  })

  it('★ 右側總和與左側時段標籤逐列對齊（inverse + formatter 索引的真證據）', () => {
    const g = hourGrid(DAVID_SHAPED)
    const { texts } = renderTexts(g)
    const left = leftLabels(texts)
    const right = rightTotals(texts)

    // 左邊那一排就是 rows 本身，由上到下（inverse:true ⇒ 09:00 在上、午夜場在下）
    expect(left.map(v => v.text)).toEqual(g.rows)
    // 右邊那一排必須是 rowTotals 的同一個順序
    expect(right.map(v => v.text)).toEqual(g.rowTotals.map(String))
    // ★ 而且逐列同高。少了 inverse ⇒ 右邊整組上下顛倒，y 對不上；
    //   formatter 索引差 1 ⇒ 上面那條先紅。
    expect(right.map(v => v.y)).toEqual(left.map(v => v.y))
  })

  it('★ 底部總和與上方星期標籤逐欄對齊', () => {
    const g = hourGrid(DAVID_SHAPED)
    const { texts } = renderTexts(g)
    const top = midRow(texts, false)
    const bottom = midRow(texts, true)

    expect(top.map(v => v.text)).toEqual([...WEEKDAY_LABELS])
    expect(bottom.map(v => v.text)).toEqual(['6', '5', '13', '13', '41', '60', '36'])
    expect(bottom.map(v => v.x)).toEqual(top.map(v => v.x))
    // 底部那一排真的在格盤下面，不是疊在星期標籤上
    expect(Math.min(...bottom.map(v => v.y))).toBeGreaterThan(Math.max(...top.map(v => v.y)))
  })

  it('★ grid.right 留得下三位數總和（375px 的 311px canvas）', () => {
    // 右側是**列**總和，所以要把某一列推到三位數：七天各 20 場 ⇒ 20:00 那列 152
    const heavy = hourGrid([
      ...DAVID_SHAPED,
      ...Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, hour: 20, records: 20 })),
    ])
    const { texts } = renderTexts(heavy)
    const right = rightTotals(texts)
    const widest = Math.max(...right.map(v => v.text.length))
    expect(widest).toBeGreaterThanOrEqual(3) // 前提：真的量到三位數

    // 右側總和是 text-anchor="start"，起點 = 寬 − grid.right + axisLabel 預設 margin(8)
    const originX = right[0]?.x ?? Number.NaN
    expect(originX).toBe(CANVAS_W - GRID_RIGHT + 8)
    // ⚠️ 字寬是估的（12px sans 的數字約 0.6em），不是瀏覽器像素量測。
    //    這一條守的是「右緣留白必須放得下三位數」——把 grid.right 改回 10 會立刻紅。
    expect(originX + widest * DIGIT_ADVANCE).toBeLessThanOrEqual(CANVAS_W)
  })

  interface AxisShape { triggerEvent?: boolean, tooltip?: { show?: boolean } }
  const shape = () => hourHeatmapOption(hourGrid(DAVID_SHAPED), false) as unknown as {
    xAxis: AxisShape[]
    yAxis: AxisShape[]
    visualMap: { seriesIndex?: number }
  }

  it('★ triggerEvent 的軸一定同時關掉 axis tooltip（否則滑過標籤會冒泡泡）', () => {
    const o = shape()
    // `setTooltipConfig()` 對每一個軸標籤無條件塞 tooltipConfig，標籤一旦因為
    // triggerEvent 變成 non-silent，滑過去就會冒出一個只寫著「六」或「60」的泡泡。
    // 這是 SVG 看不出來的迴歸，只能在 option 這一層擋。
    for (const a of [...o.xAxis, ...o.yAxis]) {
      if (a.triggerEvent)
        expect(a.tooltip?.show).toBe(false)
    }
    // 只有第二組軸可觸發；原本的星期／時段標籤維持 silent（沒有 triggerEvent 就是 silent）
    expect([o.xAxis[0]?.triggerEvent, o.yAxis[0]?.triggerEvent]).toEqual([undefined, undefined])
    expect([o.xAxis[1]?.triggerEvent, o.yAxis[1]?.triggerEvent]).toEqual([true, true])
  })

  it('visualMap 有 seriesIndex（踩雷 #86 的預防針）', () => {
    expect(shape().visualMap.seriesIndex).toBe(0)
  })

  it('高度公式：16 列是 412px（`/u/` 的骨架綁同一支，不要手抄）', () => {
    expect(hourHeatmapHeight(hourGrid(DAVID_SHAPED))).toBe('412px')
    expect(hourHeatmapHeight(hourGrid([{ weekday: 3, hour: 6, records: 1 }]))).toBe('478px')
  })
})

describe('月度趨勢', () => {
  it('12 個月補滿，缺的月份是 0 不是缺點', () => {
    const s = monthlySeries([{ month: 3, records: 4, tickets: 5, spend: 0, spend_is_partial: false }])
    expect(s.length).toBe(12)
    expect(s[2]).toBe(4)
    expect(s[0]).toBe(0)
  })

  /**
   * ★ 這一組 2026-09-06 整個換掉了。
   *
   * 舊的那條叫「歷年每月平均＝該月份的全期總場次 ÷ 年份數」，而且把
   * `avg![9]` 釘成 **1.85**（24 ÷ 13）。**那是把錯的答案釘住的假綠燈**：
   * 分母不是年份數，是 `years_observed`（曝光數）——那個月份實際經歷過幾次。
   * DB 早就在 `monthly_baseline` 裡給了正確答案（十月 **2.00**，因為 2026-10
   * 還沒發生 ⇒ 曝光 12 次不是 13 次），前端卻自己算了一套，而這條測試
   * 保護的正是那一套。
   *
   * 現在的形狀：**前端只搬運，不計算**，所以測試也不再重算一次公式
   * （重算就是實作的複本，實作改錯它會跟著改錯）。它守的是搬運的正確性
   * ——月份對得上、格數是 12、缺格不畫。分母對不對由
   * `verify-all.ts` 的 `frontend/monthly-baseline` 拿真實資料跟 DB 對帳。
   */
  const REAL_BASELINE = [
    // user_year_stats('clipwww', null) → monthly_baseline 實測 2026-09-06
    { month: 1, years_observed: 12, records: 11, avg_records: 0.92 },
    { month: 2, years_observed: 12, records: 11, avg_records: 0.92 },
    { month: 3, years_observed: 13, records: 18, avg_records: 1.38 },
    { month: 4, years_observed: 13, records: 12, avg_records: 0.92 },
    { month: 5, years_observed: 13, records: 11, avg_records: 0.85 },
    { month: 6, years_observed: 13, records: 10, avg_records: 0.77 },
    { month: 7, years_observed: 13, records: 13, avg_records: 1.00 },
    { month: 8, years_observed: 13, records: 14, avg_records: 1.08 },
    { month: 9, years_observed: 13, records: 15, avg_records: 1.15 },
    { month: 10, years_observed: 12, records: 24, avg_records: 2.00 },
    { month: 11, years_observed: 12, records: 17, avg_records: 1.42 },
    { month: 12, years_observed: 12, records: 18, avg_records: 1.50 },
  ].map(b => ({ ...b, avg_tickets: 0, avg_spend: 0, spend_is_partial: false }))

  it('平均線的數值原封不動來自 monthly_baseline.avg_records', () => {
    const avg = monthlyBaselineSeries(REAL_BASELINE)
    expect(avg).toEqual([0.92, 0.92, 1.38, 0.92, 0.85, 0.77, 1.00, 1.08, 1.15, 2.00, 1.42, 1.50])
  })

  it('★ 分母是曝光數不是年份數——十月是 2.00 不是 1.85', () => {
    // 這一條是拿來**分辨兩種分母**的，不是重算公式。
    // 十月：24 場、曝光 12 次（2026-10 還沒到）⇒ 2.00；除以年份數 13 會得到 1.85。
    // 一月：11 場、曝光 12 次（2014-01 在第一筆紀錄之前）⇒ 0.92；除以 13 會得到 0.85。
    const avg = monthlyBaselineSeries(REAL_BASELINE)!
    expect(avg[9]).toBe(2.00)
    expect(avg[9]).not.toBe(1.85)
    expect(avg[0]).toBe(0.92)
    expect(avg[0]).not.toBe(0.85)
    // 曝光數確實不是全部相同——否則這組資料分辨不出兩種分母，這條測試會變成空轉
    expect(new Set(REAL_BASELINE.map(b => b.years_observed)).size).toBeGreaterThan(1)
  })

  it('月份順序由 month 欄位決定，不是陣列順序', () => {
    // RPC 有 `order by e.m`，但契約是欄位不是順序。倒著餵應該得到一樣的結果。
    const shuffled = [...REAL_BASELINE].reverse()
    expect(monthlyBaselineSeries(shuffled)).toEqual(monthlyBaselineSeries(REAL_BASELINE))
  })

  it('缺任何一格就整條不畫——不補 0（那會讓那個月看起來像平均從沒去過）', () => {
    expect(monthlyBaselineSeries(undefined)).toBeNull()
    expect(monthlyBaselineSeries([])).toBeNull()
    expect(monthlyBaselineSeries(REAL_BASELINE.filter(b => b.month !== 7))).toBeNull()
  })

  it('看今年時，還沒到的月份是斷點不是 0', () => {
    const monthly = [{ month: 1, records: 3, tickets: 3, spend: 0, spend_is_partial: false }]
    const today = new Date('2026-03-15T00:00:00Z')
    const s = monthlySeriesToDate(monthly, 2026, today)
    expect(s[0]).toBe(3)
    expect(s[1]).toBe(0) // 二月過了但沒去 ⇒ 真的是 0
    expect(s[2]).toBe(0) // 三月進行中
    expect(s[3]).toBeNull() // 四月還沒到 ⇒ 斷點，不是 0
    expect(s[11]).toBeNull()
    // 看往年時整年都過完了，12 個月都是數字
    expect(monthlySeriesToDate(monthly, 2025, today).every(v => v !== null)).toBe(true)
    // 全期視角沒有「未來的月份」
    expect(monthlySeriesToDate(monthly, null, today).every(v => v !== null)).toBe(true)
  })
})

describe('分布', () => {
  const venues = [
    { venue_id: 'a', name: '林口威秀', city: null, kind: null, records: 115 },
    { venue_id: 'b', name: '信義威秀', city: null, kind: null, records: 14 },
    { venue_id: 'c', name: '京站威秀', city: null, kind: null, records: 10 },
    { venue_id: 'd', name: 'X', city: null, kind: null, records: 5 },
    { venue_id: 'e', name: 'Y', city: null, kind: null, records: 3 },
  ]

  it('長尾收成「其他 N 家」並保留筆數總和，而且把原件帶著走', () => {
    const out = topWithRest(venues.map(v => ({ name: v.name!, records: v.records })), 3, n => `其他 ${n} 家`)
    expect(out.length).toBe(4)
    expect(out[3]).toEqual({
      name: '其他 2 家',
      records: 8,
      // ★ 聚合列的 key 是 **null**（它不是一個分類，是好幾個分類的和）。
      //   `toEqual` 會忽略 undefined 但不會忽略 null ⇒ 這一行是必要的，
      //   而且它同時釘住「不可以給聚合列湊一個假的 key」。
      key: null,
      // ★ 順序必須與上游一致（`user_year_stats` 已經 `order by n desc, name`），
      //   前端不得重排。
      rest: [{ name: 'X', records: 5 }, { name: 'Y', records: 3 }],
    })
  })

  it('★ 加總與原件必須永遠對得起來——這一條抓的是 slice 切錯／順序被重排', () => {
    // ⚠️ 這一條刻意造 9 筆（limit + 4）。實測 David 的真資料在「版本」與「國別」
    //   兩個分布上任何視角都 ≤5 筆 ⇒ 那兩條路徑上線時**沒有被真實資料走過**。
    //   不要為了「跟其他條一致」把筆數降到 ≤ limit + 1，那會退回早退路徑，
    //   等於什麼都沒測。
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `V${i}`, records: 9 - i }))
    const out = topWithRest(many, 5, n => `其他 ${n} 家`)
    expect(out.length).toBe(6)
    const restRow = out[5]!
    expect(restRow.name).toBe('其他 4 家')
    expect(restRow.rest).toHaveLength(4)
    // 加總 == 原件相加
    expect(restRow.rest!.reduce((n, r) => n + r.records, 0)).toBe(restRow.records)
    // 頭尾接回去要一字不差等於原本的全部：一筆都不能少、順序不能變
    expect([...out.slice(0, 5), ...restRow.rest!]).toEqual(many)
    // head 那五列一列都不該帶 rest（否則每一列都會長出一顆點開沒東西的鈕）
    expect(out.slice(0, 5).some(r => 'rest' in r)).toBe(false)
  })

  /**
   * ★ `key` 必須原樣穿過去——**head 與 rest 兩邊都要**。
   *
   * 這一條守的是「點一列 → 抽屜列出那一列的紀錄」整條路的入口。弄壞它的方法是
   * 在 `topWithRest()` 裡重建物件（`items.map(i => ({ name: i.name, records: i.records }))`）：
   * 長條照樣畫得出來、筆數照樣對，**只有點下去的抽屜永遠是空的**——
   * `key` 是可選欄位，typecheck 不會紅，上面每一條既有測試也不會紅。
   *
   * ⚠️ 刻意造 9 筆（limit + 4）。≤ limit + 1 會走早退路徑（`return [...items]`），
   *   那條路徑連 slice 都沒有，等於什麼都沒測（同上面那條的理由）。
   */
  it('★ topWithRest 原樣帶過 key：head 保留、rest 保留、聚合列是 null', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `V${i}`,
      records: 9 - i,
      key: `venue-${i}`,
    }))
    const out = topWithRest(many, 5, n => `其他 ${n} 家`)

    // head：五列各自帶回自己的 key
    expect(out.slice(0, 5).map(r => r.key)).toEqual(['venue-0', 'venue-1', 'venue-2', 'venue-3', 'venue-4'])
    // 聚合列：null，不是 undefined、也不是隨手湊的字串
    const restRow = out[5]!
    expect(restRow.key).toBeNull()
    // rest：被收進長尾的那四件也要帶著自己的 key（展開後那幾列一樣要能點）
    expect(restRow.rest!.map(r => r.key)).toEqual(['venue-5', 'venue-6', 'venue-7', 'venue-8'])
  })

  it('★ 早退路徑（≤ limit + 1）也要保留 key', () => {
    // 實測 David 的國別與版本正好都是 5 ⇒ **真實資料上走的就是這條路徑**，
    // 上面那條 9 筆的測試在真資料上一次都不會被走到。
    const five = Array.from({ length: 5 }, (_, i) => ({ name: `C${i}`, records: 5 - i, key: `c${i}` }))
    expect(topWithRest(five, 5, n => `其他 ${n} 國`).map(r => r.key)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
  })

  it('★ 只多一筆時直接併進 head，不生「其他 1 家」那顆點開只有一列的鈕', () => {
    // 實測 David 全期的國別與版本**正好都是 5**（= 呼叫端的 limit），
    // 只要多一個沒看過的國別就會走到這裡。這不是假想的邊界。
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `C${i}`, records: 6 - i }))
    const out = topWithRest(six, 5, n => `其他 ${n} 國`)
    expect(out).toEqual(six)
    expect(out.some(r => r.name.startsWith('其他'))).toBe(false)
    expect(out.some(r => 'rest' in r)).toBe(false)
  })

  it('不足 limit 時原樣回傳，不加一條空的「其他 0 家」，也不掛空的 rest', () => {
    // ⚠️ 這一條**刻意**走 `items.length <= limit + 1` 的早退路徑。
    //   不要為了「統一」把測資加到 6 筆——那會讓它跟上面那條重複，
    //   而早退路徑就沒有人守了。
    const items = [{ name: 'A', records: 1 }]
    const out = topWithRest(items, 3, n => `其他 ${n} 家`)
    expect(out).toEqual(items)
    // `toEqual` 會忽略 undefined，但 `rest: []` 會被它抓到；寫明白比較不會被改掉
    expect('rest' in out[0]!).toBe(false)
  })

  it('主場與佔比', () => {
    expect(homeVenue(venues)).toEqual({ name: '林口威秀', share: 78 })
  })

  it('沒有場所資料時回 null，不要印出「你的主場是 null」', () => {
    expect(homeVenue([])).toBeNull()
  })
})

/**
 * 分布長條（去了哪裡／看的是什麼／哪一國）點一列 → 抽屜（David 這一輪的第 4、5 點）。
 *
 * ⚠️ 同「多刷排行 → 抽屜」：這裡守得到的只有純函式。`@pick` 有沒有接上、
 * 呼叫端有沒有把 `venue_id ?? ''` 寫進 key、`cards` 有沒有帶 `venueId`／`country`
 * ——這個 repo 沒有元件測試基礎設施，那幾件事只能靠瀏覽器手動驗。
 */
describe('分布長條 → 抽屜', () => {
  it('影城：以 venue_id 比對，沒有場所的紀錄對上空字串那一列', () => {
    const rows = [
      { venueId: 'v-linkou' },
      { venueId: 'v-linkou' },
      { venueId: 'v-xinyi' },
      { venueId: null }, // 沒填場所 ⇒ RPC 那邊 group by 出來就是 null 那一桶
    ]
    expect(rows.filter(r => matchesDistPick(r, 'venue', 'v-linkou'))).toHaveLength(2)
    expect(rows.filter(r => matchesDistPick(r, 'venue', 'v-xinyi'))).toHaveLength(1)
    // 呼叫端把 `venue_id ?? ''` 當 key，這裡就對得上；不可以拿場所**名稱**比對
    expect(rows.filter(r => matchesDistPick(r, 'venue', ''))).toHaveLength(1)
  })

  /**
   * ★★ 這一條是這一項真正會壞的地方。
   *
   * RPC（`0003` 第 207 行）是 `coalesce(r.format_code, 'other')`：
   * **`format_code` 為 null 的紀錄與 `format_code = 'other'` 的紀錄是同一桶**，
   * 畫面上那一列就叫「其他」。少了 `?? 'other'`，那些 null 會在長條上被算進
   * 「其他 5 場」、在抽屜裡一筆都列不出來——而且沒有任何錯誤訊息。
   *
   * 實測 David：digital 129 / 4dx 30 / imax 9 / **other 5** / dolby 1。
   * 那 5 筆是真的，所以這條路徑**上線後第一天就會被走到**。
   */
  it('★ 版本：formatCode 為 null 的紀錄要對上 key「other」（RPC 的 coalesce）', () => {
    const rows = [
      { formatCode: 'digital' },
      { formatCode: '4dx' },
      { formatCode: null }, // ← 沒有這一條就測不到 coalesce
      { formatCode: 'other' }, // ← 真的存在的分類，與上面那筆同桶
      { formatCode: null },
    ]
    expect(rows.filter(r => matchesDistPick(r, 'format', 'other'))).toHaveLength(3)
    expect(rows.filter(r => matchesDistPick(r, 'format', 'digital'))).toHaveLength(1)
    // 「其他」是畫面上的**標籤**，不是識別。拿標籤來比對會列出零筆。
    expect(rows.filter(r => matchesDistPick(r, 'format', '其他'))).toHaveLength(0)
    // null 那一筆單獨拿出來看
    expect(matchesDistPick({ formatCode: null }, 'format', 'other')).toBe(true)
  })

  /**
   * ★ 國別的「未分類」是 **空字串**，不是 null 也不是那四個字。
   * RPC 是 `coalesce(f.country, '')`（film 讀不到——別人的私密 UGC 作品——也落在這一桶）。
   * 實測 David：日本 102 / 美國 67 / 台灣 3 / 韓國 1 / 俄羅斯 1，沒有聚合列。
   */
  it('★ 國別：country 為 null 的紀錄要對上 key 空字串（畫面上的「未分類」）', () => {
    const rows = [
      { country: '日本' },
      { country: '日本' },
      { country: '美國' },
      { country: null }, // ← 這一條就是會壞的那一筆
      { country: '' }, // film 讀得到但欄位是空的，與上面同桶
    ]
    expect(rows.filter(r => matchesDistPick(r, 'country', '日本'))).toHaveLength(2)
    expect(rows.filter(r => matchesDistPick(r, 'country', ''))).toHaveLength(2)
    expect(matchesDistPick({ country: null }, 'country', '')).toBe(true)
    // 拿畫面上的字去比對什麼都對不上
    expect(rows.filter(r => matchesDistPick(r, 'country', '未分類'))).toHaveLength(0)
  })

  it('三種 kind 各看各的欄位，不會互相汙染', () => {
    // 同一筆紀錄三個欄位都有值：拿 venue 的 key 去問 format 必須是 false。
    const r = { venueId: 'v1', formatCode: 'imax', country: '日本' }
    expect(matchesDistPick(r, 'venue', 'v1')).toBe(true)
    expect(matchesDistPick(r, 'format', 'v1')).toBe(false)
    expect(matchesDistPick(r, 'country', 'v1')).toBe(false)
    expect(matchesDistPick(r, 'format', 'imax')).toBe(true)
    expect(matchesDistPick(r, 'venue', 'imax')).toBe(false)
    expect(matchesDistPick(r, 'country', '日本')).toBe(true)
    // 欄位整個缺席（`/u/` 的 cards 忘了帶）⇒ 走各自的預設桶，不是「全部都算」
    expect(matchesDistPick({}, 'venue', 'v1')).toBe(false)
    expect(matchesDistPick({}, 'format', 'other')).toBe(true)
    expect(matchesDistPick({}, 'country', '')).toBe(true)
  })

  it('抽屜標題帶場次，分隔是 U+3000（踩雷 #169：空抽屜會理直氣壯地說謊）', () => {
    expect(distPickTitle('林口威秀影城', 120)).toBe('林口威秀影城　120 場')
    expect(distPickTitle('其他', 5)).toBe('其他　5 場')
    expect(distPickTitle('未分類', 1)).toBe('未分類　1 場')
    expect(distPickTitle('日本', 102)).toContain('　')
    expect(distPickTitle('日本', 102)).not.toContain('・')
  })
})

/**
 * 月度趨勢點一個月 → 抽屜（David 這一輪的第 5 點）。
 */
describe('月度趨勢 → 抽屜', () => {
  it('inMonth：解析 YYYY-MM-DD 的月份兩碼', () => {
    expect(inMonth('2026-03-14', 3)).toBe(true)
    expect(inMonth('2026-03-01', 3)).toBe(true)
    expect(inMonth('2026-03-31', 3)).toBe(true)
    expect(inMonth('2026-04-01', 3)).toBe(false)
    expect(inMonth('2026-12-31', 12)).toBe(true)
    expect(inMonth('2026-01-01', 1)).toBe(true)
  })

  it('★ 跨年的同一個月都算進來——全期的「每個月」是季節性不是某一年', () => {
    // `YearStats.monthly` 是十三年的同月份加總（RPC 的 `group by extract(month …)`），
    // 所以抽屜也必須把十三年的三月全列出來，否則圖上說 18 場、抽屜只列 2 張。
    const rows = ['2014-03-08', '2019-03-02', '2026-03-14', '2026-04-01']
    expect(rows.filter(d => inMonth(d, 3))).toHaveLength(3)
  })

  it('★ 不經過 Date：UTC 以西的時區不可以讓月初那一筆掉到上個月', () => {
    // `new Date('2026-03-01')` 在紐約會變成 2026-02-28 ⇒ 三月少一筆，而且不報錯。
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(inMonth('2026-03-01', 3)).toBe(true)
      expect(inMonth('2026-03-01', 2)).toBe(false)
      expect(inMonth('2026-01-01', 1)).toBe(true)
      expect(inMonth('2026-12-31', 12)).toBe(true)
    }
    finally {
      process.env.TZ = tz
    }
  })

  it('null／空字串／格式不合一律 false，不靠 Number(\'\') 的 0 碰運氣', () => {
    expect(inMonth(null, 3)).toBe(false)
    expect(inMonth(undefined, 3)).toBe(false)
    expect(inMonth('', 3)).toBe(false)
    expect(inMonth('', 0)).toBe(false) // Number('') === 0，裸 slice 會在這裡出事
    expect(inMonth('2026/03/14', 3)).toBe(false)
    expect(inMonth('2026-03', 3)).toBe(false)
    expect(inMonth('2026-3-14', 3)).toBe(false)
    expect(inMonth('not-a-date', 3)).toBe(false)
  })

  it('★ 全期的標題不寫「全部年度」——範圍由票根卡自己的 show-year 講（§9.2）', () => {
    expect(monthTitle(3, null, 12)).toBe('3 月　12 場')
    expect(monthTitle(12, null, 1)).toBe('12 月　1 場')
    expect(monthTitle(3, null, 12)).not.toContain('全部年度')
  })

  it('指定年份時標題一定要帶年（同一個「3 月」在兩種視角下差十倍）', () => {
    expect(monthTitle(3, 2019, 4)).toBe('2019 年 3 月　4 場')
    expect(monthTitle(1, 2014, 1)).toBe('2014 年 1 月　1 場')
  })

  it('分隔：量詞前面是 U+3000，「年」與「月」之間是半形空白', () => {
    // 完整字串比對已經釘死格式；這條是補刀，說清楚被釘死的是哪一個字元。
    // ⚠️ 不要「順手統一」成「年」後面也放全形空白——年月是同一個日期的兩截。
    //    （這一行不貼字面的 U+3000：oxlint 的 no-irregular-whitespace 擋註解、
    //     不擋樣板字串，見 stats.ts 的 repeatTitle() 上方。）
    expect(monthTitle(3, null, 12)).toBe('3 月　12 場')
    expect(monthTitle(3, 2019, 4)).toBe('2019 年 3 月　4 場')
    expect(monthTitle(3, 2019, 4)).not.toContain('年　')
    expect(monthTitle(3, null, 12)).not.toContain('・')
  })
})

describe('年表 YearStrip', () => {
  it('2026-01-01（週四）落在第 0 週，1/5（週一）進第 1 週', () => {
    // 週一起始（WEEK_START=1）
    expect(weekIndexInYear('2026-01-01')).toEqual({ year: 2026, week: 0 })
    expect(weekIndexInYear('2026-01-04')).toEqual({ year: 2026, week: 0 })
    expect(weekIndexInYear('2026-01-05')).toEqual({ year: 2026, week: 1 })
  })

  it('永遠落在 0..52，不會溢位到第 54 格', () => {
    for (const y of [2020, 2021, 2024, 2028, 2032]) {
      for (const d of ['01-01', '12-31']) {
        const w = weekIndexInYear(`${y}-${d}`)!
        expect(w.week).toBeGreaterThanOrEqual(0)
        expect(w.week).toBeLessThan(53)
      }
    }
  })

  it('年初的日子留在自己的年份，不會被算進前一年（不是 ISO 週號）', () => {
    // 2027-01-01 是週五，ISO 會把它算成 2026 年第 53 週
    expect(weekIndexInYear('2027-01-01')?.year).toBe(2027)
  })

  it('列依年份新到舊，每列 53 格', () => {
    const rows = yearStripRows(
      [
        { date: '2026-07-26', records: 1, tickets: 2 },
        { date: '2026-07-28', records: 2, tickets: 2 },
        { date: '2025-03-01', records: 1, tickets: 1 },
      ],
      [2026, 2025, 2024],
    )
    expect(rows.map(r => r.year)).toEqual([2026, 2025, 2024])
    expect(rows[0]!.weeks.length).toBe(53)
    expect(rows[0]!.records).toBe(3)
    expect(rows[2]!.records).toBe(0) // 有列出來但整年空的年份
  })

  it('同一週的多天會相加（週的填滿率才會比日高）', () => {
    const rows = yearStripRows(
      [
        { date: '2026-07-27', records: 1, tickets: 1 }, // 週一
        { date: '2026-07-30', records: 1, tickets: 1 }, // 同一週的週四
      ],
      [2026],
    )
    expect(Math.max(...rows[0]!.weeks)).toBe(2)
    expect(rows[0]!.weeks.filter(n => n > 0).length).toBe(1)
  })
})

describe('點格子 → 底部片單', () => {
  it('isoDow：1=週一、7=週日，且不受時區影響', () => {
    expect(isoDow('2026-07-26')).toBe(7) // 週日
    expect(isoDow('2026-07-27')).toBe(1) // 週一
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(isoDow('2026-07-26')).toBe(7)
    }
    finally {
      process.env.TZ = tz
    }
  })

  it('inHourRow：午夜場那一列吃 00/01/02 時', () => {
    expect(inHourRow('00:30', MIDNIGHT_LABEL)).toBe(true)
    expect(inHourRow('02:00', MIDNIGHT_LABEL)).toBe(true)
    expect(inHourRow('03:00', MIDNIGHT_LABEL)).toBe(false)
    expect(inHourRow('21:30:00', '21:00')).toBe(true)
    expect(inHourRow('21:30:00', '22:00')).toBe(false)
    expect(inHourRow(null, '21:00')).toBe(false)
  })

  it('標題格式沿用舊專案', () => {
    expect(dayTitle('2026-07-26')).toBe('2026/07/26（週日）')
    expect(slotTitle(5, '21:00')).toBe('週五　21:00')
  })
})

/**
 * 多刷排行（band 7）點一列 → 抽屜。
 *
 * ⚠️ **這裡守得到的只有這兩支純函式。** 這個 repo 沒有 `@vue/test-utils`、
 * 沒有 happy-dom（查過 package.json），所以 `.vue` 裡的接線——`@pick` 有沒有走
 * `/u/` 的 `pick()`、`activeYear` 有沒有真的傳進來、過濾的是 `cards` 還是 `visible`、
 * `show-year` 有沒有傳——**一條自動檢查都沒有**。那幾件事只能靠瀏覽器手動驗。
 */
describe('多刷排行 → 抽屜', () => {
  it('標題帶次數（那是唯一能讓「排行說 10、抽屜列 7」現形的地方）', () => {
    // 《》被 displayTitle 剝掉，跟排行列上的片名長得一樣
    expect(repeatTitle('《少女與戰車 最終章》 第４話', null, 4)).toBe('少女與戰車 最終章 第４話　4 次')
    expect(repeatTitle('少女與戰車 劇場版', null, 10)).toBe('少女與戰車 劇場版　10 次')
  })

  it('指定年份時標題一定要帶年（語意在全期與單年是兩件事）', () => {
    expect(repeatTitle('《少女與戰車 最終章》 第４話', 2024, 3)).toBe('少女與戰車 最終章 第４話　2024 年　3 次')
    expect(repeatTitle('天氣之子', 2020, 2)).toBe('天氣之子　2020 年　2 次')
  })

  it('分隔符是 U+3000 不是半形空白', () => {
    // 完整字串比對已經釘死格式；這條是補刀，說清楚被釘死的是哪一個字元。
    expect(repeatTitle('X', null, 2)).toBe('X　2 次')
    expect(repeatTitle('X', 2020, 2)).toBe('X　2020 年　2 次')
  })

  it('片名缺席時不留白', () => {
    expect(repeatTitle(null, null, 2)).toBe('（作品不明）　2 次')
    expect(repeatTitle('', 2019, 3)).toBe('（作品不明）　2019 年　3 次')
  })

  /**
   * 真實資料的形狀：《少女與戰車 最終章》第４話全期 4 筆，其中 2024 年 3 筆、
   * 2023-11-04 那一筆是差額（`pnpm db:sql` 逐年 group 量過）。
   * 刻意**不要**讓測試資料全部同年——那樣把年份條件拿掉照樣綠（踩雷 #175）。
   */
  const ep4 = 'f-ep4'
  const other = 'f-other'
  const rows = [
    { filmId: ep4, watchedOn: '2024-05-11' },
    { filmId: ep4, watchedOn: '2024-06-01' },
    { filmId: ep4, watchedOn: '2024-06-08' },
    { filmId: ep4, watchedOn: '2023-11-04' }, // ← 唯一的差額
    { filmId: other, watchedOn: '2024-05-11' },
    { filmId: null, watchedOn: '2024-05-11' }, // film 讀不到的紀錄
  ]

  it('指定年份時只列那一年（scope 跟排行一致）', () => {
    expect(rows.filter(r => inRepeatScope(r, ep4, 2024))).toHaveLength(3)
    // 2023 那一筆單獨拿出來看：同一部片，但不在 scope 內
    expect(inRepeatScope({ filmId: ep4, watchedOn: '2023-11-04' }, ep4, 2024)).toBe(false)
  })

  it('全期（year=null）不套年份條件', () => {
    expect(rows.filter(r => inRepeatScope(r, ep4, null))).toHaveLength(4)
  })

  it('只用 film_id 對，不同片與讀不到 film 的一律排除', () => {
    expect(inRepeatScope({ filmId: other, watchedOn: '2024-05-11' }, ep4, 2024)).toBe(false)
    expect(inRepeatScope({ filmId: other, watchedOn: '2024-05-11' }, ep4, null)).toBe(false)
    // ★ `/u/` 的 cards 忘了帶 filmId 就是這個形狀：抽屜永遠空，標題還寫著「N 次」
    expect(inRepeatScope({ filmId: null, watchedOn: '2024-05-11' }, ep4, null)).toBe(false)
  })

  it('年份用字串前綴比，不經過 Date（時區會讓它退一天且不報錯）', () => {
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      // 台北時間 2024-01-01 的紀錄，在紐約解析會變成 2023-12-31
      expect(inRepeatScope({ filmId: ep4, watchedOn: '2024-01-01' }, ep4, 2024)).toBe(true)
      expect(inRepeatScope({ filmId: ep4, watchedOn: '2024-12-31' }, ep4, 2024)).toBe(true)
    }
    finally {
      process.env.TZ = tz
    }
  })
})

describe('金額的呈現', () => {
  it('一般金額', () => {
    expect(spendText(2980, 'TWD', false)).toBe('NT$2,980')
  })

  it('★ 涵蓋不完整時「以上」跟著數字走，不是只靠底下一行小字', () => {
    // 使用者只截到一列的圖時，那個但書必須仍然在——
    // 看到一張「每年花費」而不知道那是部分資料，比沒有這張圖更糟。
    expect(spendText(6890, 'TWD', true)).toBe('NT$6,890 以上')
  })

  it('★ NT$0 不等於隱藏——涵蓋完整的 0 是「免費」（SCREENS §12.1）', () => {
    // 實測 David 2015 年 2 場、票價都記了、合計 NT$0（兌換票）。
    // 那是真實的事實，不是「沒有資料」。第一版把它整列過濾掉，
    // 結果年表上有那一年、花費圖上沒有，而畫面看起來完全正常。
    expect(spendText(0, 'TWD', false)).toBe('免費')
  })

  it('★ 但「0 而且涵蓋不完整」不可以寫成免費——那是把「沒公開」講成「沒花錢」', () => {
    // 這是這張圖最不能犯的錯：看得到的部分加起來是 0，實際只會更多。
    expect(spendText(0, 'TWD', true)).toBe('NT$0 以上')
    expect(spendText(0, 'TWD', true)).not.toBe('免費')
  })

  it('非 TWD 不硬套 NT$', () => {
    expect(spendText(1200, 'JPY', false)).toBe('JPY 1,200')
    expect(spendText(1200, 'JPY', true)).toBe('JPY 1,200 以上')
  })

  it('★ 場數與張數是兩個不同的數字，順序不可對調', () => {
    // 實測 David 2019 年 25 場、37 張（user_year_stats 的 by_year，2026-09-07）。
    // ⚠️ 這裡**不可以**拿 2014 年（3 場 3 張）當樣本——那一年 records === tickets，
    //    把兩個參數對調照樣綠，這條就變成空轉的（踩雷 #175）。
    expect(spendCountsText(25, 37)).toBe('25 場 / 37 張')
    expect(spendCountsText(25, 37)).not.toBe('37 場 / 25 張')
  })

  it('一場一張的年份也照印兩個數字，不合併', () => {
    // 2014 年 3 場 3 張。合併成「3 場」會讓「場」與「張」的區別在某些年份憑空消失。
    expect(spendCountsText(3, 3)).toBe('3 場 / 3 張')
  })

  it('分隔是半形空白包住的斜線，不是中點也不是全形空白', () => {
    // David 2026-09-07 逐字指定 `{金額} / {場數} 場 / {票數} 張`。
    // 中點串是 Letterboxd 的簽名，這個產品刻意不長那樣（DESIGN_SYSTEM §0）。
    expect(spendCountsText(21, 27)).toContain(' / ')
    expect(spendCountsText(21, 27)).not.toContain('・')
    expect(spendCountsText(21, 27)).not.toContain('　')
  })

  it('★ 金額那一段與場次那一段之間有分隔，整列讀得出三段', () => {
    // 這是「整列長什麼樣」在單元測試層面唯一守得到的部分：兩支函式各自的輸出，
    // 中間那個斜線由模板的純文字節點提供（見 SpendByYear.vue 的註解）。
    // 順序（金額在左）由下面「原始碼接線」那個 describe 守——沒有元件測試基礎設施。
    expect(`${spendText(7236, 'TWD', true)} / ${spendCountsText(21, 27)}`)
      .toBe('NT$7,236 以上 / 21 場 / 27 張')
    // 2015 年：0 且完整 ⇒「免費」，而場次張數照印（NT$0 不等於隱藏，SCREENS §12.1）
    expect(`${spendText(0, 'TWD', false)} / ${spendCountsText(2, 5)}`)
      .toBe('免費 / 2 場 / 5 張')
  })
})

describe('圖說：「最」要是真的', () => {
  /** David 的真實時段分布（user_year_stats 實測 2026-09-06）。 */
  function davidHours() {
    const rows: { weekday: number, hour: number, records: number }[] = []
    // 前三高：週六 14:00=9、週六 10:00=9、週五 22:00=8 —— **前兩名並列**
    rows.push({ weekday: 6, hour: 14, records: 9 })
    rows.push({ weekday: 6, hour: 10, records: 9 })
    rows.push({ weekday: 5, hour: 22, records: 8 })
    // 其餘 64 格湊到 174 場，且維持週末 78.7% 的形狀
    for (let i = 0; i < 40; i++)
      rows.push({ weekday: 5 + (i % 3), hour: 9 + (i % 12), records: 2 })
    for (let i = 0; i < 24; i++)
      rows.push({ weekday: 1 + (i % 4), hour: 9 + (i % 12), records: 2 })
    return rows
  }

  it('★ 前兩名並列時不可以講「最」——那是在並列裡任意挑一個', () => {
    // 這正是舊邏輯輸出「你最常在週六 10:00 進場，共 9 場」的那組資料。
    // 9 場不小（z 分數會過關），但「最」宣稱的是**唯一性**。
    expect(peakStandsOut([9, 9, 8, 2, 2, 2])).toBe(false)
  })

  it('明顯領先時可以講', () => {
    expect(peakStandsOut([120, 14, 10, 8, 5])).toBe(true)
  })

  it('★ 領先再多，太少場也不算習慣', () => {
    // 4 場 vs 1 場是 4 倍領先，但 4 場不是一個習慣，是巧合
    expect(peakStandsOut([4, 1, 1])).toBe(false)
    expect(peakStandsOut([5, 1, 1])).toBe(true)
  })

  it('只有一格有資料時不必比領先幅度', () => {
    expect(peakStandsOut([7, 0, 0])).toBe(true)
  })

  it('★ David 的真實分布：講週末佔比（真的），不講並列的尖峰（假的）', () => {
    const text = hourInsightText(davidHours(), '全部年度')!
    expect(text).toContain('週五到週日')
    expect(text).not.toContain('最常')
    expect(text).not.toContain('10:00')
  })

  it('★ 聚合句必須真的在講多數——39% 不可以寫成「你 39% 的場次在…」', () => {
    // 實測 David 的「週末晚上」是 39%，基準線 30%（3/7 × 8/16）⇒ 倍率 1.3。
    // 光看 lift 會放行，畫面上就出現「你 39% 的場次在週五到週日的晚上」——
    // 技術上沒說錯，但使用者讀到的是「這就是我的樣子」，而 61% 不是那樣。
    // ⚠️ 總筆數必須 >= INSIGHT_MIN(20)，否則會走「樣本不足」那條早退路徑而
    //    根本進不到聚合分支——第一版寫成 10 筆，**弄壞實作時測試照樣綠**。
    // 這組：20 場，週末晚上 8/20 = 40%、週末 40%、晚場 40% ⇒ 三個分支都該被擋。
    // 而尖峰 8 vs 6 不到 1.5 倍 ⇒ 也不准講「最」。
    const rows = [
      { weekday: 6, hour: 20, records: 8 }, // 週末晚上
      { weekday: 2, hour: 10, records: 6 }, // 平日白天
      { weekday: 3, hour: 11, records: 6 }, // 平日白天
    ]
    const text = hourInsightText(rows, '全部年度')!
    expect(text).not.toMatch(/你 \d+% 的場次/)
  })

  it('樣本不足時只敘述，不出現「最」「主場」「你的」', () => {
    const few = [{ weekday: 6, hour: 10, records: 2 }, { weekday: 3, hour: 14, records: 1 }]
    const text = hourInsightText(few, '2026 年')!
    expect(text).toContain('2026 年')
    expect(text).not.toContain('最')
  })

  it('★ 什麼都站不出來時，給一句真的敘述而不是硬講一個「最」', () => {
    // 平坦分布：40 格各 5 場，沒有尖峰也沒有週末/晚場的偏斜
    const flat = Array.from({ length: 40 }, (_, i) => ({
      weekday: (i % 7) + 1,
      hour: 9 + (i % 6), // 全部落在 09–14，晚場佔比 0 ⇒ 聚合也站不出來
      records: 5,
    }))
    const text = hourInsightText(flat, '全部年度')!
    expect(text).toContain('沒有特別集中')
    expect(text).not.toContain('最常')
  })

  it('影城：站得出來才叫「主場」，站不出來改講前三家的佔比', () => {
    const dominant = [
      { venue_id: 'a', name: '林口威秀', city: null, kind: null, records: 120 },
      { venue_id: 'b', name: '信義威秀', city: null, kind: null, records: 14 },
      { venue_id: 'c', name: '京站威秀', city: null, kind: null, records: 10 },
    ]
    expect(venueInsightText(dominant, 144, '全部年度')).toContain('主場')

    const flat = [
      { venue_id: 'a', name: 'A', city: null, kind: null, records: 30 },
      { venue_id: 'b', name: 'B', city: null, kind: null, records: 28 },
      { venue_id: 'c', name: 'C', city: null, kind: null, records: 25 },
      { venue_id: 'd', name: 'D', city: null, kind: null, records: 20 },
    ]
    const text = venueInsightText(flat, 103, '全部年度')!
    expect(text).not.toContain('主場')
    expect(text).toContain('最常去的三家')
  })
})

/**
 * ── 「每年花費」的接線（掃原始碼）────────────────────────────────────────────
 *
 * ★★ **為什麼要掃原始碼**：這個 repo 沒有元件測試基礎設施（`tests/` 全是純
 * `.ts`、`vitest.config.ts` 的 include 只有 `tests/**` 的 `.test.ts`、沒有
 * `@vue/test-utils`）。所以「整列是不是照 `{金額} / {場數} 場 / {票數} 張` 的
 * 順序排」在單元測試層面驗不到——把模板兩個 `span` 對調，`pnpm test`、
 * `typecheck`、`verify:all` 會**全部是綠的**，而畫面上金額跑到最後面。
 *
 * ★★ **為什麼在這裡而不是 `scripts/verify-all.ts`**：這幾條不需要資料庫，
 * 放在 `pnpm test` 裡每次都會跑。verify-all 那邊留的是需要真實資料的那一半
 *（`runSpendByYearChecks()`：列上印出來的張數加總 vs DB 的 `totals.tickets`）。
 *
 * ⚠️ **掃之前一定要先把註解剝掉**（踩雷 #166）。這個 repo 已經在同一個位置跌過
 * 一次：字串比對的斷言被註解餵飽，把呼叫整個刪掉照樣綠，因為註解裡剛好寫著那個
 * 函式名——而這一輪 `SpendByYear.vue` 與這個檔案的註解裡都寫了好幾次
 * `spendCountsText`。`strip()` 的形狀照抄 `scripts/verify-all.ts` 的 `stripComments()`。
 */
const srcRoot = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
function strip(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, ' ') // template 註解
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 區塊註解（含 JSDoc）
    .replace(/^\s*\/\/.*$/gm, ' ') // 整行的行註解
}
const readCode = (p: string) => strip(readFileSync(srcRoot(p), 'utf8'))

const SPEND_COMPONENT = 'app/components/SpendByYear.vue'
const DASHBOARD = 'app/pages/app/index.vue'

describe('「每年花費」每一列的三段（原始碼接線）', () => {
  it('正向對照：路徑是活的，而且 strip() 真的剝掉了註解', () => {
    // 這一條紅了代表下面每一條都不算數：不是路徑錯，就是 strip() 把整份吃光，
    // 或是它根本沒剝到東西（那樣「找得到某個名字」就會被註解餵飽）。
    const raw = readFileSync(srcRoot(SPEND_COMPONENT), 'utf8')
    const code = readCode(SPEND_COMPONENT)
    expect(raw, '檔案不見了或路徑錯了').toContain('<template>')
    expect(code, 'strip() 把整份吃光了').toContain('<template>')
    // 兩種註解都要真的被剝掉，否則下面每一條「找得到某個名字」都會被註解餵飽。
    expect(raw, '這個檔已經沒有 template 註解 ⇒ 這個正向對照失去目標').toContain('<!--')
    expect(raw, '這個檔已經沒有 JSDoc ⇒ 這個正向對照失去目標').toContain('/**')
    expect(code, 'strip() 沒剝掉 template 註解').not.toContain('<!--')
    expect(code, 'strip() 沒剝掉區塊註解').not.toContain('/**')
  })

  it('★ 元件真的呼叫了 spendCountsText()，不是只在註解裡提到它', () => {
    // 左括號是條件的一部分：要的是**呼叫**不是提及（同 verify-all 的 monthly-baseline ③）。
    expect(readCode(SPEND_COMPONENT)).toMatch(/spendCountsText\s*\(/)
  })

  it('★ 順序是金額在左、場次張數在右', () => {
    // David 2026-09-07 逐字指定 `{金額} / {場數} 場 / {票數} 張`。
    // 註：`spendText(` 不是 `spendCountsText(` 的子字串（後者是 `…CountsText(`），
    //     所以兩個 indexOf 不會互相汙染。
    const src = readCode(SPEND_COMPONENT)
    const amount = src.indexOf('spendText(')
    const counts = src.indexOf('spendCountsText(')
    expect(amount, '找不到 spendText( ⇒ 這條已經失去目標').toBeGreaterThan(-1)
    expect(counts, '找不到 spendCountsText( ⇒ 這條已經失去目標').toBeGreaterThan(-1)
    expect(amount, '金額被排到場次張數後面了').toBeLessThan(counts)
  })

  it('★ 分隔的斜線不可以被關進 whitespace-nowrap 裡', () => {
    // nowrap 內部的空白**不產生斷行點**。把「 / 」寫進後面那個 nowrap span 裡，
    // 整個右側會變成一段不可斷的文字 ⇒ 375px 放不下時直接橫向溢出（硬約束）。
    // 正確的形狀是兩個 span 之間的純文字節點：`</span> / <span`。
    expect(readCode(SPEND_COMPONENT)).toContain('</span> / <span')
  })

  it('場數與張數不可以跟著 isPartial 變灰', () => {
    // 不完整的只有金額；把兩個完整的數字染上「不完整」的視覺訊號，是這張圖
    // 最不能犯的那類錯的鏡像。條件式只准出現在金額那一段的 :class 上。
    const src = readCode(SPEND_COMPONENT)
    const counts = src.indexOf('spendCountsText(')
    // 從 spendCountsText 那個 span 的開頭到它為止，不可以有 isPartial 的條件式。
    const spanStart = src.lastIndexOf('<span', counts)
    expect(src.slice(spanStart, counts)).not.toContain('isPartial')
  })
})

describe('儀表板的每年花費 band 吃的是全期那一份', () => {
  /** 裸的 `stats.value?.by_year`。`allStats` / `yearStats` 都是大寫 S，不會命中。 */
  const BARE_STATS_BY_YEAR = /(?:^|[^A-Za-z])stats\.value\?\.by_year/

  it('正向對照：這條正則抓得到裸的那一種，放過 allStats 那一種', () => {
    // 沒有這一條的話，下面那條「找不到」有可能只是正則壞了
    // （`verify-all.ts` 規矩③：凡是「應該看不到」的斷言都要配一組「應該看得到」）。
    expect('const rows = stats.value?.by_year ?? []').toMatch(BARE_STATS_BY_YEAR)
    expect('const rows = allStats.value?.by_year ?? []').not.toMatch(BARE_STATS_BY_YEAR)
    expect('const rows = yearStats.value?.by_year ?? []').not.toMatch(BARE_STATS_BY_YEAR)
  })

  it('★ 儀表板不可以出現裸的 stats.value?.by_year', () => {
    // RPC：`'by_year', case when p_year is not null then '[]'::jsonb else … end`
    // ⇒ 指定年份時 `by_year` 是**空陣列**。寫成 `stats.value?.by_year` 的話，
    //   使用者一切到 2019 這條 band 就無聲消失，而畫面看起來完全正常。
    //   這是這一項最容易犯、也最看不出來的錯。
    // ⚠️ 這條只擋得住這個字面形狀（`const s = stats.value` 再取 `s?.by_year`
    //    它抓不到）。真正的把關是瀏覽器上「切到某一年，band 8 仍在且仍是十三列」。
    expect(readCode(DASHBOARD)).not.toMatch(BARE_STATS_BY_YEAR)
  })

  /**
   * ⚠️ **`toContain('<SpendByYear')` 不夠。** 2026-09-08 實測弄壞法：把標籤改名成
   * `<SpendByYearX`（band 整個失效）——那一條**照樣綠**，因為舊的元件名是新名字的
   * 前綴。要一個邊界字元才守得住。整條 band 被刪掉那種弄壞法兩種寫法都抓得到，
   * 但「假檢查」的判準是**最弱的那個弄壞法**，不是最明顯的那個。
   */
  const RENDERS_SPEND = /<SpendByYear[\s/>]/

  it('正向對照：這條正則要邊界，前綴同名的假元件騙不過去', () => {
    expect('<SpendByYear :by-year="x" />').toMatch(RENDERS_SPEND)
    expect('<SpendByYear/>').toMatch(RENDERS_SPEND)
    expect('<SpendByYearX :by-year="x" />').not.toMatch(RENDERS_SPEND)
  })

  it('★ 儀表板真的 render 了 <SpendByYear（不是只在註解裡）', () => {
    expect(readCode(DASHBOARD)).toMatch(RENDERS_SPEND)
  })

  it('★ 一筆票價都沒記過就整條不出現——band 掛在 hasSpend 那個閘門上', () => {
    // David 2026-09-07 裁決：`spend_known_records = 0` 的帳號**整條 band 不出現**，
    // 不畫成 0、不留佔位。上面那條只證明 `spend_known_records` 這個字出現在檔案裡，
    // 沒有證明它真的接在 band 的 `v-if` 上——閘門被拿掉的話，那種帳號會看到
    // 十三列「NT$0 以上」，比沒有這條 band 更糟。
    const src = readCode(DASHBOARD)
    const band = src.indexOf('title="每年花費"')
    expect(band, '找不到「每年花費」那條 band ⇒ 這條已經失去目標').toBeGreaterThan(-1)
    const tag = src.lastIndexOf('<ChartBand', band)
    expect(tag, '「每年花費」不在 <ChartBand 裡了 ⇒ 這條已經失去目標').toBeGreaterThan(-1)
    expect(src.slice(tag, band)).toContain('v-if="hasSpend"')
  })

  it('★ 顯示閘門是「讀得到幾列票價」，不是「總額大於零」', () => {
    // SCREENS §2.0b 第 1 條：`spend > 0` 會把「全部都是兌換票（NT$0）」的帳號
    // 誤判成沒東西可看。判準必須是 `spend_known_records`。
    expect(readCode(DASHBOARD)).toContain('spend_known_records')
  })
})
