<script setup lang="ts">
/**
 * `/legal/terms` — 服務條款（`SCREENS §15.1`）。正文全部在 `legal_document`，這一頁只負責版面。
 * ⚠️ 不得要求登入、不得放在任何牆後：`supabase.redirectOptions.include` 只涵蓋 `/app` 與
 * `/admin`，`nuxt.config.ts` 的 `/legal/**` 設定也不要動。
 */
useSeoMeta({
  title: '服務條款',
  description: '影記的服務條款：我們提供什麼、你的內容歸誰、著作權保護措施與三振條款。',
  robots: 'index, follow',
})
</script>

<template>
  <LegalDocumentView kind="terms" />
</template>
