<script setup lang="ts">
// ★ 具名匯出是底線 `zh_tw` 不是 `zh-tw`（踩雷 #62）。
// 沒設 locale 的話 Nuxt UI 內建字串全是英文，而且是「藏在元件裡」的那種：
// USelectMenu 開啟後的搜尋框 placeholder、UModal 的關閉鈕 aria-label、
// UPagination、UCalendar 的上一月／下一月——都不會出現在我們自己的 template 裡，
// 掃 grep 掃不到，只有真的把元件打開才看得到。
import { zh_tw } from '@nuxt/ui/locale'

useHead({ titleTemplate: title => (title ? `${title} — 影記` : '影記 filmnote') })
</script>

<template>
  <!-- ★ UApp 是 Modal / Toast / Tooltip 的宿主，漏掉不會報錯只會不動（踩雷 #58） -->
  <UApp :locale="zh_tw">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
