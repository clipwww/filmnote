<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts'
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
}>(), { height: '320px', label: '圖表' })

/**
 * 所有圖表的外殼。直接用 vue-echarts，不裝 nuxt-echarts——
 * 後者建立在 experimental 的 <NuxtIsland> 上，且 ECharts 的 SSR 會強制固定
 * width/height，與響應式圖表天生衝突。
 *
 * 這個元件負責三件呼叫端很容易忘的事：
 *
 * ① <ClientOnly> 與固定高度的 #fallback
 *    canvas 在 Node 裡會爆掉，SSR 頁面（/u/**）一定要 client-only。而
 *    <ClientOnly> 的 default slot 會從 server build 被 tree-shake，沒有
 *    #fallback 就會在 hydration 前塌成 0 高、畫面跳動（踩雷 #60/#61）。
 *
 * ② 高度用 inline style，不寫在 <style scoped>
 *    Tailwind 4 把 utility 放進 @layer utilities，而 SFC 的 scoped style
 *    經 Vite 處理後是「未分層」的——未分層 CSS 贏過所有 layer。一條
 *    .chart{height:100%} 會靜靜蓋掉 h-[400px]，容器變 0 高、ECharts 以
 *    0×0 初始化（踩雷 #49）。inline style 沒有這個問題。
 *
 * ③ autoresize
 *    側邊欄收合時 window 尺寸沒變，window.resize 不會觸發。vue-echarts 的
 *    autoresize 走 ResizeObserver（踩雷 #59）。
 *
 * 色彩一律由 ~/utils/chart-theme 提供的 hex 進來，絕不從 CSS 讀 oklch。
 */
use([
  CanvasRenderer,
  BarChart,
  LineChart,
  PieChart,
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
  <div :style="{ height: props.height }" class="w-full">
    <ClientOnly>
      <VChart
        :key="chartKey"
        :option="props.option"
        :theme="isDark ? 'dark' : undefined"
        autoresize
        :aria-label="props.label"
        class="size-full"
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
