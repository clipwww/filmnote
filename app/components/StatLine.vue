<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * 數字排成一行有量詞的句子（`DESIGN_SYSTEM §4.2`／`§4.4`），例如
 * 「2026 年看了 24 場、41 張票，花了 NT$9,860」。不是 stat tile：「大數字 + 小標籤 + 一排
 * 補充數據 + 漸層」是儀表板的預設長相，正是 §0 要避開的。**圖是主角，數字是圖說。**
 */
/*
 * ⚠️ 兩個會靜默把畫面弄壞的排版陷阱：① **不要在 segment 之間手打空格做中英間距**（§2.5），
 * 用 `text-autospace: normal`——§2.5 說「初始值就是 normal」**實測不成立**，Chrome 152 的
 * computed value 是 `no-autospace`，必須顯式寫（實測同一串字 231.1px → 239.1px）。
 */
/*
 * ② **template 裡元素之間不能有換行**：whitespace 預設 'condense' 會把含換行的空白整個移除，
 * 但若哪天改成 'preserve'，多打的換行又會變成真的空白。兩邊都不賭——整串寫在同一行。
 */
defineProps<{ segments: StatSegment[] }>()
</script>

<template>
  <!-- eslint-disable-next-line vue/singleline-html-element-content-newline -- 見上方第 2 點：這一串刻意不換行 -->
  <p class="text-base leading-relaxed text-muted"><template v-for="(s, i) in segments" :key="i"><span v-if="s.prefix">{{ s.prefix }}</span><span class="text-2xl font-semibold text-highlighted tabular-nums">{{ s.value }}</span><span v-if="s.suffix">{{ s.suffix }}</span></template></p>
</template>
