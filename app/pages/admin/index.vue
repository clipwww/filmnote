<script setup lang="ts">
/**
 * `/admin` 本身不是一個畫面，只是三個佇列的入口。
 *
 * 直接轉向到作品審核——那是三個裡面唯一每次打開都可能有東西的佇列。
 * `replace: true` 讓上一頁回得去，不會卡在轉向迴圈裡。
 */
definePageMeta({
  middleware: () => navigateTo('/admin/films', { replace: true }),
})
</script>

<template>
  <div />
</template>
