<script setup lang="ts">
useHead({ titleTemplate: title => (title ? `${title} — 影記` : '影記 filmnote') })
</script>

<template>
  <!-- ★ UApp 是 Modal / Toast / Tooltip 的宿主，漏掉不會報錯只會不動（踩雷 #58） -->
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
