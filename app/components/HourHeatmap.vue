<script setup lang="ts">
import type { HourGrid } from '~/utils/stats'
// 顯式匯入而不是靠 auto-import：這是一個**新加的** app/utils 檔，而踩雷 #173 的
// 形狀正是「模組圖沒更新 ⇒ 頁面整個畫不出來，而 typecheck / lint / test 四個全綠」。
// 寫死這一行就完全不依賴 auto-import 的探索時機。
import { hourHeatmapHeight, hourHeatmapOption } from '~/utils/hour-heatmap-option'

/**
 * 時段熱點圖（`SCREENS.md §9` band 3）。**直式：星期 7 欄 × 時段列**——方向沿用舊專案，
 * 7 欄天生塞得進 375px、永遠不需要橫向捲動，這是舊碼裡最有價值的判斷（§5.5）。
 */
/*
 * option 的建構搬到 `~/utils/hour-heatmap-option.ts`（那三條硬限制的註解也在那裡）。唯一的
 * 理由是可測：「兩條總和軸真的存在而且跟格盤對齊」只有能離開瀏覽器 render 一次才驗得到，
 * 而 SFC 進不了 vitest。
 */
/*
 * 三種可點的東西：112 個格子（含值為 0 的）→ `slot`、底部每個星期的總和 → `weekday`、
 * 右側每個時段的總和 → `hour`。原本的星期／時段標籤**維持 silent**，它們不是按鈕。
 */
const props = defineProps<{ grid: HourGrid }>()

/**
 * ⚠️ **這是 breaking change。** 舊的形狀是 `{ weekday, rowLabel }`，呼叫端寫
 * `@pick="picked = { kind: 'slot', ...$event }"`。現在 kind 由這裡決定，
 * 兩頁都必須改成直接吃 `$event`。
 */
const emit = defineEmits<{
  pick: [pick:
    | { kind: 'slot', weekday: number, rowLabel: string }
    | { kind: 'weekday', weekday: number }
    | { kind: 'hour', rowLabel: string }]
}>()

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

/**
 * 高度公式在 option 檔裡（`rows.length * 22 + 60`）。列數會隨資料變（真有清晨場
 * 時軸會往前延伸），所以 `/u/` 的 `<ClientOnly> #fallback` 骨架也綁同一支函式，
 * 不要再手抄一次數字。
 */
const height = computed(() => hourHeatmapHeight(props.grid))

const option = computed(() => hourHeatmapOption(props.grid, isDark.value))

/**
 * ECharts 的 click，三種來源：**格子**的 `params.data` 是 `[x, y, value]`；**軸標籤**的
 * `params.data` 是 undefined，改帶 `targetType: 'axisLabel'` 與 `componentType` ＋
 * `componentIndex`。只有設了 `triggerEvent` 的軸會送，而我們只在第二條（總和）軸上設。
 */
/*
 * ⚠️ **不要改用 `params.value` 反查是哪一欄**：兩條 x 軸的原始類目一模一樣（都是「一…日」），
 * 而總和的數字會重複——David 的欄總和裡週三與週四都是 13。用 `dataIndex`（類目索引）。
 */
function onPick(params: {
  data?: unknown
  targetType?: string
  componentType?: string
  dataIndex?: number
}) {
  if (params.targetType === 'axisLabel' && typeof params.dataIndex === 'number') {
    if (params.componentType === 'xAxis') {
      emit('pick', { kind: 'weekday', weekday: params.dataIndex + 1 }) // 欄索引 0..6 → isodow 1..7
      return
    }
    if (params.componentType === 'yAxis') {
      const rowLabel = props.grid.rows[params.dataIndex]
      if (rowLabel)
        emit('pick', { kind: 'hour', rowLabel })
      return
    }
    return
  }
  const d = params.data as [number, number, number] | undefined
  if (!Array.isArray(d))
    return
  const rowLabel = props.grid.rows[d[1]]
  if (rowLabel)
    emit('pick', { kind: 'slot', weekday: d[0] + 1, rowLabel }) // 欄索引 0..6 → isodow 1..7
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
      點一格看那個時段看了什麼；外側的總和也可以點
    </p>
  </div>
</template>
