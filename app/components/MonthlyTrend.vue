<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { YearStats } from '~/utils/stats'

/** 月度趨勢（`SCREENS.md §9` band 4）。12 個點，缺的月份是 0 不是斷點。 */
const props = defineProps<{ monthly: YearStats['monthly'] }>()

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
        const p0 = (params as { name: string, value: number }[])[0]
        return `${p0?.name ?? ''}\u3000${p0?.value ?? 0} 場`
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
    series: [{
      type: 'line' as const,
      data: monthlySeries(props.monthly),
      // 折線是 text0（§5.4b 對帳表）。不是琥珀——琥珀塗介面、不塗資料。
      lineStyle: { color: p.text0, width: 2 },
      itemStyle: { color: p.text0 },
      symbol: 'circle' as const,
      symbolSize: 6,
      smooth: false, // 場次是離散事件，平滑曲線會編造中間值
    }],
  }
})
</script>

<template>
  <BaseChart :option="option" height="240px" label="月度趨勢" />
</template>
