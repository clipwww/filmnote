/**
 * 圖表色票與共用 option 片段。**這裡是唯一真相，且一律是 hex。**
 * 取值來自 `docs/design/DESIGN_SYSTEM.md §1.3`（墨階）與 `§5.4b`（對帳表）。
 *
 * ── 為什麼不共用 Nuxt UI 的 --ui-color-* ──────────────────────────
 * Tailwind 4 與 Nuxt UI 的 token 全是 `oklch()`，而 ECharts 的繪圖層
 * zrender 完全看不懂。實測 zrender@6.1.0 的 `parse()`：
 *
 *   #10b981                       ✅ [16,185,129,1]
 *   rgba(16, 185, 129, 1)         ✅
 *   rgb(16,185,129)               ✅
 *   rgb(16 185 129)               ❌ undefined  ← 現代空白分隔語法也不行
 *   oklch(0.7 0.15 160)           ❌ undefined
 *   color(display-p3 0.1 0.7 0.5) ❌ undefined  ← Canvas fallback 也救不了
 *
 * `parse()` 內部只有 rgb / rgba / hsl / hsla 四個 case，而且會先
 * `replace(/ /g, '')` 再 `split(',')`。症狀極隱蔽：靜態填色看起來正常，
 * 一旦走 hover emphasis、LinearGradient、visualMap 或色彩動畫就整條變空白。
 *
 * ⇒ 傳給 ECharts 的顏色一律 hex，不要從 CSS 讀，也**不要「順手統一」進
 *   token 系統**（§5.4b 一之下的警告）。日後 CSS 要用同一組色，
 *   從這裡產生 custom property，不要反過來。
 */

/**
 * 週起始日：1 = 週一。
 *
 * ⚠️ `main.css` 也有一個 `--week-start: 1`。**兩邊都要，不是重複。**
 * design 當初把它做成 CSS 變數是預設它會被 CSS 消費，但實際的消費者是
 * ECharts——canvas 內部的值是 JS 算的，讀不到 CSS 變數，而 §5.3-1 又禁止
 * 把 CSS 變數丟給 zrender。所以圖表這一側必須有自己的常數。
 * **要改的時候兩邊一起改**，不要把其中一邊「統一」掉。
 *
 * 選週一的理由見 `DESIGN_SYSTEM §5.4`：年度出席圖與時段熱點圖必須一致，
 * 而週一起始讓「五六日」相鄰成一個看得見的區塊。
 */
export const WEEK_START = 1 as const

/**
 * 圖表用字型。
 *
 * ⚠️ 不能寫 `'inherit'`。ECharts 是把 fontFamily 串成 canvas 的
 * `ctx.font = '12px inherit'`，那不是合法的 font shorthand，整串會被丟掉，
 * 標籤退回瀏覽器預設的 10px sans-serif——而且不會有任何錯誤訊息。
 * 這裡直接複製 §2.2 的堆疊（Inter 排第一是為了 tabular-nums）。
 */
export const CHART_FONT = 'Inter, "PingFang TC", "Noto Sans CJK TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif'

export interface ChartPalette {
  /** 冊頁台紙（body）。圖表**不**畫在這上面，列在這裡只為了對帳。 */
  bg: string
  /** 票根紙（`--ui-bg`）。圖表畫在這上面，格子縫隙也用它。 */
  sheet: string
  sunken: string
  line: string
  text0: string
  text1: string
  text2: string
  text3: string
  /** 只用於「今天／本年／選取」這類 UI 狀態，**永遠不編碼資料**（§1.0）。 */
  accent: string
  /** 墨階七階，亮度單調（§1.3 已驗算）。 */
  heat: readonly [string, string, string, string, string, string, string]
  /** 出席三階。**必須恆等於 heat[0] / heat[4] / heat[6]**，見下方 assert。 */
  att: readonly [string, string, string]
}

export const CHART: { light: ChartPalette, dark: ChartPalette } = {
  light: {
    bg: '#F8EDDC',
    sheet: '#FDF9F1',
    sunken: '#EADDCA',
    line: '#C5B5A3',
    text0: '#29211A',
    text1: '#4A4036',
    text2: '#776A5D',
    text3: '#948777',
    accent: '#866500',
    heat: ['#EADDCA', '#CEC4B7', '#B1A392', '#91816F', '#685946', '#413525', '#1A1209'],
    att: ['#EADDCA', '#685946', '#1A1209'],
  },
  dark: {
    bg: '#1D1610',
    sheet: '#29211A',
    sunken: '#3D332C',
    line: '#4A4036',
    text0: '#F8EDDC',
    text1: '#DACCB9',
    text2: '#948777',
    text3: '#776A5D',
    accent: '#C9A62B',
    heat: ['#392F24', '#4C3E30', '#685949', '#857565', '#A59788', '#CEC4B9', '#F6F1EB'],
    att: ['#392F24', '#A59788', '#F6F1EB'],
  },
}

export function chartPalette(dark: boolean): ChartPalette {
  return dark ? CHART.dark : CHART.light
}

/**
 * `att` 必須恆等於 `heat[0] / heat[4] / heat[6]`（§5.4b）。
 * 圖例的色塊與圖上的格子若由兩份常數各自維護遲早會分岔——舊版 mockup 的
 * CSS `--att-1` 是 heat-2、JS 是 heat-4，圖例跟圖已經不同色了。
 * 這條 assert 在 `tests/chart-theme.test.ts` 有測試守著。
 */
export function attMatchesHeat(p: ChartPalette): boolean {
  return p.att[0] === p.heat[0] && p.att[1] === p.heat[4] && p.att[2] === p.heat[6]
}

/** visualMap 的 piece。**一律用 gt/lte，不要用 min/max**，理由見下。 */
export interface HeatPiece {
  value?: number
  gt?: number
  lte?: number
  color: string
}

/**
 * 出席圖的三階（§5.4）。
 *
 * ⚠️ **用 `gt`/`lte` 不用 `min`/`max`（§5.3-9）。**
 * `{ min: 1, max: 1 }` 接 `{ min: 2 }` 會讓「剛好 2 場」的格子**靜默不畫**，
 * 露出紙色看起來像渲染破洞——ECharts 把 pieces 當連續區間處理，`(1, 2)`
 * 這一段沒有 piece 認領，邊界值就掉進縫裡。而那些「剛好 2 場」的日子正是
 * 雙片連映，是這張圖唯一想讓人看見的東西。console 零錯誤。
 *
 * 只有三階，因為資料只支援三階（161 天 1 場、4 天 2 場、0 天 ≥3 場）。
 * 不要為了「以後可能會有」預留永遠不會被畫出來的色階。
 */
export function attendancePieces(dark: boolean): HeatPiece[] {
  const { att } = chartPalette(dark)
  return [
    { value: 0, color: att[0] },
    { gt: 0, lte: 1, color: att[1] },
    { gt: 1, color: att[2] },
  ]
}

/**
 * 時段熱點圖的分段：0 用 `heat[0]`，(0, max] 均分成數段直到 `heat[6]`。
 *
 * 兩個刻意的設計：
 * - **每一階至少跨一個整數**（`steps = min(6, max)`），否則值域只有 3 的時候
 *   會產生 `(0.5, 1]` 這種永遠沒有整數落進去的空 piece。
 * - **最後一段是開放上界**（只有 `gt` 沒有 `lte`），這樣即使 max 因為快取
 *   而過期，超出的值仍然畫得出來，不會變成破洞。
 */
export function heatPieces(dark: boolean, max: number): HeatPiece[] {
  const { heat } = chartPalette(dark)
  const top = Math.max(1, Math.floor(max))
  const steps = Math.min(6, top)
  const pieces: HeatPiece[] = [{ value: 0, color: heat[0] }]
  for (let i = 1; i <= steps; i++) {
    const lo = Math.floor((top * (i - 1)) / steps)
    const color = heat[Math.round((i * 6) / steps)]!
    if (i === steps)
      pieces.push({ gt: lo, color })
    else
      pieces.push({ gt: lo, lte: Math.floor((top * i) / steps), color })
  }
  return pieces
}

/**
 * tooltip 的外觀。**每一項都必須顯式覆寫**（§5.4b 三之 3）：
 * ECharts 的預設 `textStyle.color` 是 `#333`、tooltip 預設底是 `#fff`，
 * 暗色模式下會直接漏出純白。陰影也要關掉（§3：陰影預設 none）。
 */
export function baseTooltip(dark: boolean) {
  const p = chartPalette(dark)
  return {
    backgroundColor: p.sheet,
    borderColor: p.line,
    borderWidth: 1,
    padding: [6, 10] as [number, number],
    textStyle: { color: p.text0, fontFamily: CHART_FONT, fontSize: 13 },
    extraCssText: 'box-shadow:none;border-radius:2px;',
  }
}

/** 每個 option 都要疊上的共用外觀。 */
export function baseChartOption(dark: boolean) {
  const p = chartPalette(dark)
  return {
    backgroundColor: 'transparent',
    textStyle: { color: p.text1, fontFamily: CHART_FONT },
    tooltip: baseTooltip(dark),
    animation: false, // §6：除了存檔那一刻，全站沒有進場動畫
  }
}

export function axisStyle(dark: boolean) {
  const p = chartPalette(dark)
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: p.text2, fontFamily: CHART_FONT, fontSize: 12 },
    splitLine: { show: false },
    splitArea: { show: false },
  }
}
