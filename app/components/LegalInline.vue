<script setup lang="ts">
import type { Inline } from '~/utils/legal-markdown'

/**
 * 法律文件的行內語法。三種：文字、粗體、行內碼。
 *
 * ⚠️ `<code>` **不用等寬字**（DS §0 明確排除等寬字當資料微標籤，
 * `SCREENS §15.1` 又特別點名 Nuxt UI 的 prose 預設會把它渲染成等寬）。
 * 這裡只用字級與顏色跟正文區分——條款裡的 `/legal/dmca`、`profile.username`
 * 要讀起來像「一個名字」，不是像一段程式。
 *
 * ⚠️ `font-sans` **不可以拿掉**。Tailwind 的 preflight 對 `code, kbd, samp, pre`
 * 下了 `font-family: var(--default-mono-font-family, …)`，所以什麼都不寫的
 * `<code>` 一樣是等寬字——實測第一版就是這樣，畫面上 `docs/SPEC.md` 與
 * `profile.username` 全部變成等寬。要避開 prose 的那個毛病，得顯式蓋掉它。
 *
 * ⚠️ 三個分支之間**不留空白**：Vue 的 whitespace 是 'condense'，
 * 元素之間含換行的空白會被吃掉，靠它做間距一定會失敗；而間距本來就已經
 * 在剖析出來的 `value` 裡了（`'請看 '`、`' 與 '`）。
 */
defineProps<{ parts: Inline[] }>()
</script>

<template>
  <!--
    eslint-disable vue/singleline-html-element-content-newline --
    三個分支必須貼在同一行。斷行之後 `</strong>` 與 `<code v-else-if>` 之間會多出
    一個含換行的空白文字節點，那正是 Vue 的 whitespace 'condense' 在處理的東西，
    而「它一定會被摺掉」是一個**設定值**不是保證（改成 'preserve' 就會 render 成
    「請看  第 4 節」）。行內語法的間距已經在剖析出來的 value 裡，不需要靠標籤縫隙。
  -->
  <template v-for="(part, i) in parts" :key="i"><strong v-if="part.type === 'strong'" class="font-semibold text-highlighted">{{ part.value }}</strong><code v-else-if="part.type === 'code'" class="font-sans text-[0.92em] text-highlighted">{{ part.value }}</code><span v-else>{{ part.value }}</span></template>
</template>
