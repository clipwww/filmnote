<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { YearStats } from '~/utils/stats'

/**
 * 月度趨勢（`SCREENS.md §9` band 4）。12 個點。
 *
 * ── 兩條線 ────────────────────────────────────────────────────
 * 實線＝選定年份的每月場次；**虛線＝歷年每月平均**（視覺稿的圖例寫
 * 「2014–2026 每月平均」）。虛線的意義是「這個月對我來說算多還是算少」，
 * 沒有它的話單一年度的高低點讀不出是季節性還是偶然。
 *
 * ⚠️ 平均線的資料**必須**來自 `user_year_stats(username, null)`，
 *    不可以在前端拿紀錄列表就地算——`/u/` 上別人拿得到的紀錄集合與本人不同
 *    （RLS 依觀看者而異），就地算會讓同一個人的歷年平均因為誰在看而不一樣。
 *    算法在 `monthlyAverageSeries()`，年份數不明時它回 null，這裡就不畫那條線。
 *
 * ── 還沒到的月份是斷點，不是 0 ────────────────────────────────
 * 看今年時，12 月的 0 跟 3 月的 0 意思完全不同。畫成 0 會讓折線在年中
 * 墜到底，讀起來像「他七月就不看電影了」（`DESIGN_SYSTEM §5.3-8`）。
 */
const props = withDefaults(defineProps<{
  monthly: YearStats['monthly']
  /** 歷年每月平均的 12 個值。null／未給就不畫虛線。 */
  average?: number[] | null
  /** 選定的年份；等於今年時，尚未到來的月份畫成斷點。null = 全期。 */
  year?: number | null
}>(), { average: null, year: null })

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

const option = computed<EChartsOption>(() => {
  const p = chartPalette(isDark.value)
  const ax = axisStyle(isDark.value)
  return {
    ...baseChartOption(isDark.value),
    tooltip: {
      ...baseTooltip(isDark.value),
      trigger: 'axis' as const,
      // 見 AttendanceCalendar 的同一條註解。trigger:'axis' 給的是陣列。
      formatter: (params: unknown) => {
        const rows = params as { name: string, value: number | null, seriesName: string }[]
        if (!rows?.length)
          return ''
        // 兩條線都要出現在 tooltip 裡，否則「比平均多」這件事只能靠目測
        const lines = rows
          .filter(r => r.value !== null && r.value !== undefined)
          .map(r => `${r.seriesName}\u3000${r.value} 場`)
        return [rows[0]?.name ?? '', ...lines].join('<br>')
      },
    },
    grid: { left: 34, right: 12, top: 12, bottom: 28 },
    xAxis: { type: 'category' as const, data: MONTHS, boundaryGap: false, ...ax },
    yAxis: {
      type: 'value' as const,
      minInterval: 1, // 場次是整數，不要出現 0.5 場
      ...ax,
      splitLine: { show: true, lineStyle: { color: p.sunken } },
    },
    series: [
      // 平均線先畫 ⇒ 疊在實線下面。它是基準不是主角。
      ...(props.average
        ? [{
            name: '歷年每月平均',
            type: 'line' as const,
            data: props.average,
            lineStyle: { color: p.heat[2], width: 1, type: 'dashed' as const },
            itemStyle: { color: p.heat[2] },
            symbol: 'none' as const,
            smooth: false,
            silent: true, // 基準線不接點擊：那一點不對應任何一筆紀錄
            z: 1,
          }]
        : []),
      {
        name: props.year === null ? '全部年度' : `${props.year} 年`,
        type: 'line' as const,
        data: monthlySeriesToDate(props.monthly, props.year),
        // 折線是 text0（§5.4b 對帳表）。不是琥珀——琥珀塗介面、不塗資料。
        lineStyle: { color: p.text0, width: 2 },
        itemStyle: { color: p.text0 },
        symbol: 'circle' as const,
        symbolSize: 6,
        smooth: false, // 場次是離散事件，平滑曲線會編造中間值
        z: 2,
      },
    ],
  }
})
</script>

<template>
  <BaseChart :option="option" height="240px" label="月度趨勢" />
</template>
