<script setup lang="ts">
/**
 * `/legal/privacy` — 隱私權政策（`SCREENS §15.1`）。
 * 正文在 `legal_document`（`kind='privacy'`）。
 */
useSeoMeta({
  title: '隱私權政策',
  description: '影記蒐集什麼、不蒐集什麼、這些資料誰看得到、存多久，以及你的權利。',
  robots: 'index, follow',
})
</script>

<template>
  <LegalDocumentView kind="privacy" />
</template>
