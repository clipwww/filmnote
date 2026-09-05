<script setup lang="ts">
// ★ 這裡刻意不設 title：app.vue 的 titleTemplate 是
//   title => title ? `${title} — 影記` : '影記 filmnote'
//   首頁若再給一個含站名的 title，就會變成「影記 filmnote — 影記」。
//   不設值時 template 會走 fallback，得到乾淨的「影記 filmnote」。
useSeoMeta({
  description: '台灣在地的觀影紀錄工具：記得住台灣的片名、你在哪看的、以及你花了多少。',
})
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-16">
    <h1 class="text-3xl font-bold tracking-tight">
      影記 filmnote
    </h1>
    <p class="mt-4 text-lg text-muted">
      台灣在地的觀影紀錄工具。記下每一次進電影院的經驗，回顧自己的觀影軌跡。
    </p>
    <ul class="mt-8 space-y-2 text-muted">
      <li>· 以文化部影視局官方核准片名為準，不再被 TMDB 的中文標題搞混。</li>
      <li>· 內建全台 107 家電影院、932 個影廳的官方主檔。</li>
      <li>· 票價、票數、影廳、版本都記得住，並產生年度消費統計。</li>
    </ul>
    <UButton to="/login" size="lg" class="mt-8">
      用 Google 登入開始記錄
    </UButton>
  </div>
</template>
