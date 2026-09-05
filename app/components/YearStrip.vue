<script setup lang="ts">
import type { YearStripRow } from '~/utils/stats'

/**
 * 年表 — 全站簽名（`SCREENS.md §2.1`）。每年一列，一列 53 格，**每格是一週**。
 *
 * ── 為什麼是週不是日 ──────────────────────────────────────────
 * 實測 169 筆分散在 12 年，日層級的填滿率約 6%——一張 7×53 的年格子有 96%
 * 是空的，看起來不是「密度」而是「荒涼」。收成週之後跳到約 22%，密集期與
 * 空窗立刻讀得出來。這是真實資料逼出來的偏離，不是懶。
 *
 * ── 為什麼不用圖表庫 ──────────────────────────────────────────
 * 純 CSS grid。舊專案用 d3 手寫 imperative DOM，在 SSR 下是負擔；而且這裡
 * 每一格都要能被鍵盤走到、被螢幕閱讀器讀到，canvas 給不了。
 *
 * ── 格子寬度是彈性的，不是規格寫的 5px／8px ────────────────────
 * §2.1 算的 371px（53 格 × 節距 7）假設整條佔滿 375px 的視窗寬。實際上它在
 * 卡片裡，還要跟左邊的年份與右邊的場次數共用一行——375px 下扣掉頁面與卡片的
 * padding 只剩約 230px 給 53 格。所以格子改成 `flex: 1` 由容器決定寬度，
 * **高度固定**。年表是密度概覽，格子是不是正方形不影響它要傳達的東西。
 */
const props = defineProps<{
  rows: YearStripRow[]
  selected: number | null
}>()

const emit = defineEmits<{ 'update:selected': [year: number] }>()

const colorMode = useColorMode()
/**
 * 三階，取值與年度出席圖同一組（`att` = heat-0/4/6）。
 * ⚠️ **圖例與格子必須從同一個陣列取。** 舊版 mockup 的 CSS 與 JS 各維護一份，
 * 圖例跟圖已經不同色了（§5.4b）。
 */
const att = computed(() => chartPalette(colorMode.value === 'dark').att)

function cellColor(n: number): string {
  const [none, one, many] = att.value
  return n === 0 ? none : n === 1 ? one : many
}

function move(delta: number) {
  const list = props.rows
  const i = list.findIndex(r => r.year === props.selected)
  const next = list[Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
  if (next)
    emit('update:selected', next.year)
}
</script>

<template>
  <div role="listbox" aria-label="年份" class="space-y-1">
    <div
      v-for="row in rows"
      :key="row.year"
      role="option"
      :tabindex="0"
      :aria-selected="row.year === selected"
      :aria-label="`${row.year} 年 ${row.records} 場`"
      class="flex items-center gap-2 border-l-2 py-1 pl-2 pr-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      :class="row.year === selected ? 'border-primary' : 'border-transparent cursor-pointer'"
      @click="emit('update:selected', row.year)"
      @keydown.enter.prevent="emit('update:selected', row.year)"
      @keydown.space.prevent="emit('update:selected', row.year)"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
    >
      <span
        class="w-10 shrink-0 text-xs tabular-nums"
        :class="row.year === selected ? 'font-semibold text-highlighted' : 'text-muted'"
      >{{ row.year }}</span>

      <!-- 53 格。格子沒有語意，資料在整列的 aria-label 上。 -->
      <span class="flex min-w-0 flex-1 gap-px" aria-hidden="true">
        <span
          v-for="(n, i) in row.weeks"
          :key="i"
          class="h-2.5 flex-1 rounded-[1px] sm:h-3"
          :style="{ backgroundColor: cellColor(n) }"
        />
      </span>

      <span class="w-8 shrink-0 text-right text-xs tabular-nums text-muted">{{ row.records }}</span>
    </div>
  </div>
</template>
