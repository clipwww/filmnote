<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { HourGrid } from '~/utils/stats'

/**
 * 時段熱點圖（`SCREENS.md §9` band 3）。**直式：星期 7 欄 × 時段列。**
 *
 * 方向沿用舊專案——7 欄天生塞得進 375px，永遠不需要橫向捲動。這是舊碼裡
 * 最有價值的判斷（§5.5）。
 *
 * ── 三條硬限制 ────────────────────────────────────────────────
 * 1. **兩軸都必須 `type:'category'` 且 `boundaryGap: true`**，違反會在
 *    dev build 直接 throw。時段軸必須是字串桶，不能用 value 軸做連續小時。
 *    `visualMap` 是必需元件（可 `show:false`）（§5.3-7）。
 * 2. **`cartesian2d` heatmap 完全不畫空格**（實測 3 筆資料的 7×6 格盤只產生
 *    5 個 path）。7×N 全格必須明確餵 `value: 0`，否則「從未」的格子直接消失、
 *    露出卡片底色，看起來像破洞（§5.3-6）。補格在 `hourGrid()`，有測試守著。
 * 3. **`visualMap.pieces` 用 `gt`/`lte` 不用 `min`/`max`**（§5.3-9）。
 *    邊界值會掉進兩個 piece 之間的縫裡，靜默不畫，console 零錯誤——
 *    design 是逐像素掃 112 格對帳資料表才抓到的。
 */
const props = defineProps<{ grid: HourGrid }>()

const emit = defineEmits<{ pick: [cell: { weekday: number, rowLabel: string }] }>()

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

/** 16 列 × 22px + 軸標籤。列數會隨資料變（真有清晨場時軸會往前延伸）。 */
const height = computed(() => `${props.grid.rows.length * 22 + 40}px`)

const option = computed<EChartsOption>(() => {
  const p = chartPalette(isDark.value)
  const ax = axisStyle(isDark.value)
  return {
    ...baseChartOption(isDark.value),
    tooltip: {
      ...baseTooltip(isDark.value),
      // 見 AttendanceCalendar 的同一條註解。
      formatter: (params: unknown) => {
        const [x, y, v] = (params as { data: [number, number, number] }).data
        return `週${WEEKDAY_LABELS[x]}\u3000${props.grid.rows[y]}\u3000${v} 場`
      },
    },
    grid: { left: 52, right: 10, top: 24, bottom: 8 },
    xAxis: {
      type: 'category' as const,
      data: [...WEEKDAY_LABELS],
      boundaryGap: true, // ★ 違反會 throw
      position: 'top' as const, // §9.1 的樣板把星期放在最上面一列
      ...ax,
    },
    yAxis: {
      type: 'category' as const,
      data: props.grid.rows,
      boundaryGap: true, // ★ 同上
      inverse: true, // 09:00 在上、午夜場在下
      ...ax,
    },
    visualMap: {
      type: 'piecewise' as const,
      show: false,
      pieces: heatPieces(isDark.value, props.grid.max),
    },
    series: [{
      type: 'heatmap' as const,
      data: props.grid.data,
      itemStyle: { borderWidth: 2, borderColor: p.sheet },
      // hover 不換色（§6：沒有每張卡片的 hover transition），只留 tooltip
      emphasis: { disabled: true },
    }],
  }
})

function onPick(params: { data?: unknown }) {
  const d = params.data as [number, number, number] | undefined
  if (!Array.isArray(d))
    return
  const rowLabel = props.grid.rows[d[1]]
  if (rowLabel)
    emit('pick', { weekday: d[0] + 1, rowLabel }) // 欄索引 0..6 → isodow 1..7
}
</script>

<template>
  <div>
    <!--
      限寬：桌機的 band 有 830px，7 欄攤開會讓每一格變成 110×22 的長條，
      方格語彙整個消失。舊專案的節距是 15px 方塊（§5.5），在 375px 上天生成立，
      桌機這裡把寬度收回來讓格子接近那個比例，而不是把圖拉滿。
    -->
    <div class="max-w-[420px]">
      <BaseChart :option="option" :height="height" label="星期與時段的熱點圖" @pick="onPick" />
    </div>
    <p class="mt-2 text-xs text-muted">
      點一格看那個時段看了什麼
    </p>
  </div>
</template>
