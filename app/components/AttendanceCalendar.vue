<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { YearStats } from '~/utils/stats'

/**
 * 年度出席圖（`SCREENS.md §9` band 2）。7×53 日格。
 *
 * ── 三個會靜默壞掉的地方 ──────────────────────────────────────
 * 1. **`calendar` 只能設 `left` 與 `top`。** 同時設 `right` / `width` 會覆蓋
 *    `cellSize` 的寬度分量，方格靜默變形成 6.9×14 的長條（§5.3-3）。
 *    這是最容易踩且錯了不會報錯的雷。
 * 2. **`cellSize: 'auto'` 不是手機的解答**——寬高各自拉滿容器，375×180 下
 *    方格會變成 6.90×23.40 的長條，直接破壞方格語彙（§5.3-4）。
 *    整年固定 53 欄 × cellSize，**ECharts 自己完全不提供橫向捲動**，
 *    手機唯一乾淨解是固定像素寬放進外層 `overflow-x: auto`（§5.3-5）。
 * 3. **`visualMap.pieces` 用 `gt`/`lte` 不用 `min`/`max`**（§5.3-9）。
 *    `{min:1,max:1}` 接 `{min:2}` 會讓「剛好 2 場」的日子整格消失，而那些
 *    日子正是雙片連映——這張圖唯一想讓人看見的東西。
 */
const props = defineProps<{
  year: number
  daily: YearStats['daily']
}>()

const emit = defineEmits<{ pick: [date: string] }>()

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')
const palette = computed(() => chartPalette(isDark.value))

const CELL = 14
/** 53 欄 × 14px = 742px，加上左側的星期標籤。ECharts 不會自己捲。 */
const INNER_WIDTH = `${53 * CELL + 44}px`

const option = computed<EChartsOption>(() => {
  const p = palette.value
  return {
    ...baseChartOption(isDark.value),
    tooltip: {
      ...baseTooltip(isDark.value),
      // ECharts 的 TopLevelFormatterParams 是一個聯集，本來就得在裡面窄化；
      // 參數收 unknown 再轉，比從 echarts/types/dist/shared 撈內部型別穩。
      formatter: (params: unknown) => {
        const v = (params as { value: [string, number] }).value
        return `${v[0]}\u3000${v[1]} 場`
      },
    },
    visualMap: {
      type: 'piecewise' as const,
      show: false,
      // ★ 只作用在第 0 個 series（heatmap）。
      //   `seriesIndex` 不寫的話 visualMap 會**吃掉每一個 series**，把下面那個
      //   scatter 的 itemStyle.color 也覆寫成 att[2]——小點跟格子同色，等於不存在。
      //   實測（2019 年有兩天是雙片連映，合成三層 canvas 後數像素）：
      //     不寫 seriesIndex → 最深色 200px、小點 0px
      //     寫了            → 最深色 152px（小點在深格上挖掉 48px）+ 肉眼可見
      //   兩種寫法在畫面上都「看起來正常」，差別只有那兩天的標記在不在。
      seriesIndex: 0,
      pieces: attendancePieces(isDark.value),
    },
    calendar: {
      left: 34,
      top: 28,
      cellSize: [CELL, CELL],
      range: String(props.year),
      splitLine: { show: false },
      // 沒有資料的日子由 calendar 自己畫底色（heatmap 只補有值的格）
      itemStyle: { color: p.heat[0], borderWidth: 3, borderColor: p.sheet },
      dayLabel: {
        // 顯式寫出週首。舊專案是「因為 dayjs 的 zh-tw locale 沒定義 weekStart
        // 而退回 0」——不寫的話哪天有人改了 locale，整張圖會無聲位移。
        firstDay: WEEK_START,
        nameMap: 'ZH',
        color: p.text2,
        fontFamily: CHART_FONT,
        fontSize: 11,
      },
      monthLabel: { nameMap: 'ZH', color: p.text2, fontFamily: CHART_FONT, fontSize: 11 },
      yearLabel: { show: false },
    },
    series: [
      {
        type: 'heatmap' as const,
        coordinateSystem: 'calendar' as const,
        data: calendarSeries(props.daily),
      },
      {
        // 「兩場以上」額外疊一個紙色小點。heat-4 ↔ heat-6 只有亮 2.74:1／
        // 暗 2.53:1，低於 WCAG 1.4.11 的 3:1，不能只靠色差（§1.3 / §5.4）。
        // 點壓在最深的格子上是 17.63:1（亮）／14.09:1（暗）。
        type: 'scatter' as const,
        coordinateSystem: 'calendar' as const,
        symbolSize: 5,
        itemStyle: { color: p.sheet },
        data: doubleFeatureDays(props.daily),
        tooltip: { show: false },
        silent: true,
      },
    ],
  }
})

/** 預先捲到最右（最近一週）。§9.4：不這樣做的話手機上一打開看到的是一月。 */
const scroller = useTemplateRef<HTMLElement>('scroller')
onMounted(() => {
  nextTick(() => {
    if (scroller.value)
      scroller.value.scrollLeft = scroller.value.scrollWidth
  })
})
watch(() => props.year, () => {
  nextTick(() => {
    if (scroller.value)
      scroller.value.scrollLeft = scroller.value.scrollWidth
  })
})

function onPick(params: { value?: unknown }) {
  const v = params.value as [string, number] | undefined
  if (Array.isArray(v) && typeof v[0] === 'string')
    emit('pick', v[0])
}

const legend = computed(() => {
  const [none, one, many] = palette.value.att
  return [
    { color: none, label: '沒去' },
    { color: one, label: '1 場' },
    { color: many, label: '2 場以上' },
  ]
})
</script>

<template>
  <div>
    <div ref="scroller" class="-mx-1 overflow-x-auto px-1">
      <BaseChart
        :option="option"
        height="170px"
        :width="INNER_WIDTH"
        :label="`${year} 年的出席圖`"
        @pick="onPick"
      />
    </div>

    <!-- 圖例。色塊與格子從同一個 att 陣列取，不另外維護一份（§5.4b）。 -->
    <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
      <span v-for="l in legend" :key="l.label" class="flex items-center gap-1.5">
        <span class="size-2.5 rounded-[1px]" :style="{ backgroundColor: l.color }" />
        {{ l.label }}
      </span>
      <span class="text-dimmed">點一格看那天看了什麼</span>
    </div>
  </div>
</template>
