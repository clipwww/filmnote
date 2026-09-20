// ⚠️ **值匯入一律寫相對路徑，不要靠 auto-import**：vitest 的 `~` 指向 `src/` 不是 `app/`，
// 而 auto-import 在 vitest 裡根本不存在。照抄 SFC 裡裸用 `chartPalette` 的寫法，
// `pnpm dev` 與型別檢查都綠，但 `pnpm test` 會是執行期 ReferenceError。
import type { EChartsOption } from 'echarts'
import type { HourGrid } from './stats'
import { axisStyle, baseChartOption, baseTooltip, chartPalette, heatPieces } from './chart-theme'
import { WEEKDAY_LABELS } from './stats'

/**
 * 時段熱點圖的 ECharts option（`SCREENS §9.1` band 3）。抽成**純函式**的唯一理由：
 * 「兩條總和軸真的存在而且跟格盤對齊」只有能離開瀏覽器 render 一次才驗得到
 * （`tests/stats.test.ts` 用 `ssr: true` + svg renderer 下斷言，純 node）。
 */
/*
 * 用新檔而不是把既有匯出搬過來：踩雷 #173——搬動匯出讓 dev server 的模組圖沒更新，
 * 四個檢查全綠而 `/u/` 一條 band 都畫不出來。
 */
/*
 * 四條硬限制：① 每條軸都必須 `type:'category'` 且 `boundaryGap: true`（違反會在 dev build
 * 直接 throw）；② heatmap 完全不畫空格，7×N 全格要明確餵 0；③ pieces 用 `gt`/`lte`（§5.3-9）；
 * ④ **總和只能畫在格盤外側的軸標籤上不能是格子**（單格最大 9 vs 欄總和最大 60）。
 */

/** 每列的節距（px）。 */
const ROW_PITCH = 22

/**
 * 圖表高度。**`+60` 不是 `+40`**（上 24 給星期軸、下 26 給星期總和軸）。⚠️ 忘記改的症狀
 * **不是「底部那列被切掉」**：SSR 實測 height=392 時底部總和照樣畫在 y=374 一個字都沒少，
 * 真正的症狀是每一列悄悄從 22.5px 矮成 21.375px——看不見。寫成「檢查沒被切掉」的驗收會綠。
 */
export function hourHeatmapHeight(grid: HourGrid): string {
  return `${grid.rows.length * ROW_PITCH + 60}px`
}

/**
 * `grid.right` 要 36 不是 10：量出來的——12px 的**三位數**總和在 311px 寬的 canvas 上，
 * right=30 時右緣只剩 1.6px，right=36 時 ≈304.6/311。⚠️ David 現在最大只有 60（兩位數），
 * 改回 30 在他的帳號上看起來完全正常——**這個溢出只有重度使用者會遇到**。
 */
const GRID_INSET = { left: 52, right: 36, top: 24, bottom: 26 }

export function hourHeatmapOption(grid: HourGrid, dark: boolean): EChartsOption {
  const p = chartPalette(dark)
  const ax = axisStyle(dark)

  /**
   * 兩條總和軸共用的設定。`triggerEvent` **只加在這兩條新軸上**，原本的標籤維持 silent
   * ——要的是總和可點，不是把原本的標籤變成按鈕；少兩條軸就少一半的迴歸面。
   */
  /*
   * ⚠️ `tooltip: { show: false }` **是 `triggerEvent` 的必要配套不是美化**：`setTooltipConfig()`
   * 對每個軸標籤**無條件**塞 tooltipConfig，標籤因 triggerEvent 變 non-silent 後滑過去就冒出一個
   * 只寫「六」或「60」的泡泡（全域 formatter 幫不上忙，echarts 明文不把它給 component tooltip）。
   * 而 `isLabelSilent` 只看 `triggerEvent || tooltip.show` ⇒ `show:false` 不會把標籤變回 silent。
   */
  const totalsAxis = {
    type: 'category' as const,
    boundaryGap: true, // ★ 違反會 throw
    triggerEvent: true,
    tooltip: { show: false }, // ★ 見上面，不能拿掉
    ...ax,
  }

  /**
   * 總和標籤共用的字樣。`color` 沿用 `p.text2`（亮 4.99:1／暗 4.51:1）。⚠️ **不要為了「讓總和
   * 退後」改用 `p.text3`**：亮 3.34:1／暗 3.02:1，兩個都低於 4.5:1。總和與資料的區隔靠**位置**
   * （格盤外的獨立軌道），不靠降低對比。字級也維持 12px。
   */
  /*
   * ⚠️ `interval: 0`：category 軸的預設是 `'auto'`，**會在標籤要撞在一起時靜靜丟掉幾個**。
   * 現在 16 列 SSR render 過確認全在，但列數會隨資料變（真有 03:00 就是 22 列，那個尺寸從沒
   * render 過）。**掉一個總和的症狀是「那一格看起來是 0 場」，零錯誤訊息。**
   */
  const totalsLabel = { ...ax.axisLabel, interval: 0 }

  /**
   * ⚠️ formatter 的第二個參數：category 軸走的是
   * `labelFormatter(rawValue, tick.value - axis.scale.getExtent()[0])`，這裡剛好等於類目索引
   * **因為 ordinal 的 `getExtent()[0]` 是 0**。誰在這條軸上加 `min`/`max`/dataZoom，每一個總和
   * 會整體平移一個常數，而畫面上每個數字看起來都還是合理的。（它對 `interval` 隱藏標籤免疫。）
   */
  const colTotalAt = (_value: string, i: number) => String(grid.colTotals[i] ?? 0)
  const rowTotalAt = (_value: string, i: number) => String(grid.rowTotals[i] ?? 0)

  return {
    ...baseChartOption(dark),
    tooltip: {
      ...baseTooltip(dark),
      // 見 AttendanceCalendar 的同一條註解。
      formatter: (params: unknown) => {
        const d = (params as { data?: unknown }).data
        // 軸標籤的 tooltip 已經由 `totalsAxis.tooltip.show = false` 擋掉，理論上進不來；
        // 留著是因為解構 undefined 是 TypeError 直接拋，代價比一行 guard 高。
        if (!Array.isArray(d))
          return ''
        const [x, y, v] = d as [number, number, number]
        // 分隔用「量詞 + 全形空白」不用中點（全域約束 6）；沿用搬過來的 \u3000 跳脫寫法。
        return `週${WEEKDAY_LABELS[x]}\u3000${grid.rows[y]}\u3000${v} 場`
      },
    },
    grid: { ...GRID_INSET },
    xAxis: [
      {
        type: 'category' as const,
        data: [...WEEKDAY_LABELS],
        boundaryGap: true, // ★ 違反會 throw
        position: 'top' as const, // §9.1 的樣板把星期放在最上面一列
        ...ax,
      },
      // 底部：每個星期的總和。
      {
        ...totalsAxis,
        data: [...WEEKDAY_LABELS],
        position: 'bottom' as const,
        axisLabel: { ...totalsLabel, formatter: colTotalAt },
      },
    ],
    yAxis: [
      {
        type: 'category' as const,
        data: grid.rows,
        boundaryGap: true, // ★ 同上
        inverse: true, // 09:00 在上、午夜場在下
        ...ax,
      },
      // 右側：每個時段的總和。
      // ⚠️ `inverse: true` **漏掉不會報錯**，症狀只是 16 個總和上下顛倒，
      //    而每一個看起來都是合理的數字。測試用 SVG 的 y 座標把它釘住。
      {
        ...totalsAxis,
        data: grid.rows,
        inverse: true,
        position: 'right' as const,
        axisLabel: { ...totalsLabel, formatter: rowTotalAt },
      },
    ],
    visualMap: {
      type: 'piecewise' as const,
      // seriesIndex 不寫的話 visualMap 會吃掉**每一個** series（踩雷 #86）。
      // 現在只有一個 series 所以看不出來，但總和是「多加一個 series」最容易被
      // 想到的做法，這條預防針留著。
      seriesIndex: 0,
      show: false,
      pieces: heatPieces(dark, grid.max),
    },
    series: [{
      type: 'heatmap' as const,
      data: grid.data,
      itemStyle: { borderWidth: 2, borderColor: p.sheet },
      // hover 不換色（§6：沒有每張卡片的 hover transition），只留 tooltip
      emphasis: { disabled: true },
    }],
  }
}
