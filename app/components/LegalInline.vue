<script setup lang="ts">
import type { Inline } from '~/utils/legal-markdown'

/**
 * 法律文件的行內語法（文字／粗體／行內碼）。⚠️ `<code>` **不用等寬字**（DS §0 排除等寬字當
 * 資料微標籤）：條款裡的 `/legal/dmca`、`profile.username` 要讀起來像「一個名字」不是一段程式，
 * 所以只用字級與顏色跟正文區分。
 */
/*
 * ⚠️ `font-sans` **不可以拿掉**：Tailwind 的 preflight 對 `code, kbd, samp, pre` 下了
 * `font-family: var(--default-mono-font-family, …)` ⇒ 什麼都不寫的 `<code>` 一樣是等寬字
 * （實測第一版就是這樣）。要避開 prose 的毛病，得顯式蓋掉它。
 */
/*
 * ⚠️ 三個分支之間**不留空白**：whitespace 是 'condense'，元素之間含換行的空白會被吃掉，
 * 靠它做間距一定會失敗；而間距本來就已經在剖析出來的 `value` 裡了（`'請看 '`、`' 與 '`）。
 */
defineProps<{ parts: Inline[] }>()
</script>

<template>
  <!--
    eslint-disable vue/singleline-html-element-content-newline --
    三個分支必須貼在同一行：斷行之後標籤之間會多出一個含換行的空白文字節點，而「它一定會被
    摺掉」是一個**設定值**不是保證（改成 'preserve' 就會 render 成「請看  第 4 節」）。
  -->
  <template v-for="(part, i) in parts" :key="i"><strong v-if="part.type === 'strong'" class="font-semibold text-highlighted">{{ part.value }}</strong><code v-else-if="part.type === 'code'" class="font-sans text-[0.92em] text-highlighted">{{ part.value }}</code><span v-else>{{ part.value }}</span></template>
</template>
