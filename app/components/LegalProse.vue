<script setup lang="ts">
import type { Block } from '~/utils/legal-markdown'

/**
 * 法律文件正文（`SCREENS §15.1`）。不用 Nuxt UI 的 prose 樣式：§15.1 明文禁止——那一套是為
 * 技術文件調的，字級與行高跟本站的紙不同調，而且會把 `<code>` 渲染成等寬字（DS §0 排除）。
 */
/*
 * 行長是 `34em` 不是 `34ch`：DS §2.4 寫「中文內文 `max-width: 34ch`（≈560px）」，兩個數字對
 * 不起來而對得起來的是後面那一個。`ch` 是當前字型「0」的推進寬度（Inter ≈ 0.6em、蘋方 0.5em）
 * ⇒ `34ch` 實測落在 272–330px、一行 17–20 個漢字，不是 ≈560px。漢字是 1em 全形 ⇒ 34em = 544px。
 * ⚠️ 這是**對帳結果不是自由發揮**：要改回 `ch` 之前先量一次一行有幾個字。
 */
/*
 * 只有文字區塊受行長限制：一個被壓在 544px 裡的三欄表會逐格換行、讀不出對照關係
 * ⇒ 表格改為在自己的 `overflow-x-auto` 容器內捲動（DS §10：頁面 body 永遠不橫向捲動）。
 */
defineProps<{ blocks: Block[] }>()
</script>

<template>
  <div class="text-default">
    <template v-for="(block, i) in blocks" :key="i">
      <!--
        錨點在標題上，`scroll-mt` 讓 `#s4` 跳過去時標題不會貼在視窗最上緣。
        ⚠️ 這些 id 是對外承諾（`SCREENS §15.1`），不要為了樣式改動它們。
      -->
      <h2
        v-if="block.type === 'heading' && block.level === 2"
        :id="block.id"
        class="scroll-mt-20 text-xl/[1.4] font-semibold text-highlighted first:mt-0 mt-10"
      >
        {{ block.display }}
      </h2>
      <h3
        v-else-if="block.type === 'heading'"
        :id="block.id"
        class="scroll-mt-20 text-[17px]/[1.5] font-semibold text-highlighted first:mt-0 mt-7"
      >
        {{ block.display }}
      </h3>

      <p v-else-if="block.type === 'paragraph'" class="legal-measure mt-3.5">
        <LegalInline :parts="block.inlines" />
      </p>

      <!-- 引言：條款正文自己的注記（草案標示、警語）。用側邊線而不是底色，
           §0 的收藏冊調性裡整塊上色會讀成「另一個元件」。 -->
      <blockquote
        v-else-if="block.type === 'quote'"
        class="legal-measure mt-4 border-s-2 border-accented ps-3.5 text-toned"
      >
        <p v-for="(para, j) in block.paragraphs" :key="j" :class="j ? 'mt-2.5' : ''">
          <LegalInline :parts="para" />
        </p>
      </blockquote>

      <component
        :is="block.ordered ? 'ol' : 'ul'"
        v-else-if="block.type === 'list'"
        class="legal-measure mt-3.5 ps-5 space-y-1.5"
        :class="block.ordered ? 'list-decimal' : 'list-disc'"
      >
        <li v-for="(item, j) in block.items" :key="j" class="ps-1">
          <LegalInline :parts="item" />
        </li>
      </component>

      <div v-else-if="block.type === 'table'" class="mt-4 overflow-x-auto">
        <table class="w-full min-w-md border-collapse text-[13px]/[1.6]">
          <thead>
            <tr>
              <th
                v-for="(cell, j) in block.head"
                :key="j"
                scope="col"
                class="border-b border-default px-2.5 py-1.5 text-start font-semibold text-muted"
              >
                <LegalInline :parts="cell.inlines" />
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, j) in block.rows" :key="j">
              <td
                v-for="(cell, k) in row"
                :key="k"
                class="border-b border-default px-2.5 py-1.5 align-top"
              >
                <LegalInline :parts="cell.inlines" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 見 script 的「行長」段：34 個漢字＝34em，不是 34ch。 */
.legal-measure {
  max-width: 34em;
}
</style>
