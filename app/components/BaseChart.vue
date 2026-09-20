<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { BarChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts'
import {
  CalendarComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import VChart from 'vue-echarts'

const props = withDefaults(defineProps<{
  option: EChartsOption
  /** CSS 長度。給定值以 inline style 套用，繞過 cascade layer 的優先權反轉。 */
  height?: string
  label?: string
  /** 內容比容器寬時（整年出席圖固定 742px）給的固定寬度，外層自己捲。 */
  width?: string
}>(), { height: '320px', label: '圖表' })

const emit = defineEmits<{
/**
   * ECharts 的點擊事件原樣往上丟。後四個欄位**只有在某條軸設了 `triggerEvent: true` 時才有值**
   * （`componentType` 是 `'xAxis'|'yAxis'`、`targetType` 是 `'axisLabel'`、category 軸的
   * `dataIndex` 是類目索引）。沒設的軸標籤是 silent，根本不會產生事件。
   */
  /*
   * ⚠️ **不要退回成「只有熱點圖」**：`MonthlyTrend` 的月份標籤是這個功能在手機上唯一點得到的
   * 入口（線上的資料點太小），改這裡的時候那條路徑一樣要顧。
   */
  pick: [params: {
    data?: unknown
    value?: unknown
    seriesIndex?: number
    componentType?: string
    componentIndex?: number
    targetType?: string
    dataIndex?: number
  }]
}>()

/**
 * 所有圖表的外殼。直接用 vue-echarts 不裝 nuxt-echarts——後者建立在 experimental 的
 * `<NuxtIsland>` 上，且 ECharts 的 SSR 會強制固定 width/height，與響應式圖表天生衝突。
 * 色彩一律由 `~/utils/chart-theme` 提供的 hex 進來，絕不從 CSS 讀 oklch。
 */
/*
 * ① `<ClientOnly>` ＋ **固定高度的 `#fallback`**：canvas 在 Node 裡會爆，而 default slot 會從
 *    server build 被 tree-shake ⇒ 沒有 fallback 就會在 hydration 前塌成 0 高（#60／#61）。
 */
/*
 * ② 高度用 inline style 不寫在 `<style scoped>`：Tailwind 4 把 utility 放進 `@layer utilities`，
 *    而 SFC 的 scoped style 是**未分層**的（未分層 CSS 贏過所有 layer）⇒ 一條 `.chart{height:100%}`
 *    會靜靜蓋掉 `h-[400px]`，容器變 0 高、ECharts 以 0×0 初始化（#49）。
 */
/*
 * ③ `autoresize`：側邊欄收合時 window 尺寸沒變、`window.resize` 不觸發，走 ResizeObserver（#59）。
 */
/*
 * ④ 不用內建的 `'dark'` theme：我們每個顏色都在 option 裡顯式指定，而它會塞一個 `#100c2a` 的
 *    深紫底進來 ⇒ 改成 `transparent` 由卡片的 `bg-default` 透出來。深淺切換靠 `:key` 重建
 *    （`setTheme()` 不會重算 `visualMap.pieces` 與顯式的 `itemStyle.color`）。
 */
use([
  CanvasRenderer,
  BarChart,
  LineChart,
  ScatterChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  CalendarComponent,
])

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

// canvas 內部顏色是 JS 算的，CSS 的 dark class 切換管不到——換主題必須讓
// ECharts 重新吃一次 option。改 key 強制重建是最不會漏的做法。
const chartKey = computed(() => (isDark.value ? 'dark' : 'light'))
</script>

<template>
  <div :style="{ height: props.height, width: props.width }" class="w-full">
    <ClientOnly>
      <VChart
        :key="chartKey"
        :option="props.option"
        autoresize
        :aria-label="props.label"
        class="size-full"
        @click="emit('pick', $event)"
      />
      <template #fallback>
        <!-- 與圖表等高的骨架，避免 hydration 前後跳動 -->
        <div
          class="size-full animate-pulse rounded-sm bg-elevated"
          role="img"
          :aria-label="`${props.label}（載入中）`"
        />
      </template>
    </ClientOnly>
  </div>
</template>
