/**
 * 圖表色票。**這裡是唯一真相，且一律是 hex。**
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
 * 一旦走 hover emphasis、LinearGradient、visualMap 或色彩動畫就整條變空白——
 * 而貢獻圖與時段熱力圖**必用** visualMap，正是死亡點。
 *
 * ⇒ 傳給 ECharts 的顏色一律 hex（或舊式逗號分隔的 rgba），不要從 CSS 讀。
 *
 * ── 為什麼色票定義在 TS 而不是 CSS ────────────────────────────────
 * 若定義在 `@theme static` 再用 getComputedStyle 讀回來，就得賭 Tailwind
 * 不會把 hex 正規化成 oklch——賭錯的症狀正是上面那個「靜態正常、hover 變白」。
 * 定義在 TS 則 ECharts 拿到的必然是 hex，沒有中間層可以改寫它。
 * 日後設計需要在 CSS 用同一組色，從這裡產生 custom property，不要反過來。
 */

/** 類別色：影城分布、國別分布、版本分布等離散維度。 */
export const CHART_SERIES = [
  '#10b981', // emerald
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#ec4899', // pink
  '#84cc16', // lime
] as const

/** 連續色階：貢獻圖與時段熱力圖的 visualMap。由淺到深。 */
export const CHART_SCALE_LIGHT = ['#ecfdf5', '#a7f3d0', '#34d399', '#059669', '#065f46'] as const
export const CHART_SCALE_DARK = ['#022c22', '#065f46', '#059669', '#34d399', '#6ee7b7'] as const

interface ChartTokens {
  text: string
  textMuted: string
  axis: string
  split: string
  tooltipBg: string
  tooltipText: string
  scale: readonly string[]
}

const LIGHT: ChartTokens = {
  text: '#18181b',
  textMuted: '#71717a',
  axis: '#d4d4d8',
  split: '#f4f4f5',
  tooltipBg: '#ffffff',
  tooltipText: '#18181b',
  scale: CHART_SCALE_LIGHT,
}

const DARK: ChartTokens = {
  text: '#fafafa',
  textMuted: '#a1a1aa',
  axis: '#3f3f46',
  split: '#27272a',
  tooltipBg: '#18181b',
  tooltipText: '#fafafa',
  scale: CHART_SCALE_DARK,
}

export function chartTokens(dark: boolean): ChartTokens {
  return dark ? DARK : LIGHT
}

/**
 * 套用在每個 option 上的共用外觀。
 * canvas 內部的顏色是 JS 算出來的，CSS 的 dark mode 切換管不到它——
 * 主題變了必須重新 setOption，呼叫端以 key 或 watch 觸發。
 */
export function baseChartOption(dark: boolean) {
  const t = chartTokens(dark)
  return {
    color: [...CHART_SERIES],
    textStyle: { color: t.text, fontFamily: 'inherit' },
    tooltip: {
      backgroundColor: t.tooltipBg,
      borderColor: t.axis,
      textStyle: { color: t.tooltipText },
    },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
  }
}

export function axisStyle(dark: boolean) {
  const t = chartTokens(dark)
  return {
    axisLine: { lineStyle: { color: t.axis } },
    axisLabel: { color: t.textMuted },
    splitLine: { lineStyle: { color: t.split } },
  }
}
