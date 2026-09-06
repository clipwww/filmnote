<template>
  <div class="min-h-dvh flex flex-col bg-default text-default">
    <header class="border-b border-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
        <NuxtLink to="/" class="flex items-center gap-2 text-highlighted" aria-label="影記 首頁">
          <!-- §2.6：字標是路徑不是字型。同一個元件也用在頁尾的顯名區，
               DS §9.1 的份量比值算的就是它——兩處必須是同一個東西。 -->
          <BrandWordmark :height="22" />
          <span class="text-[13px] text-muted">filmnote</span>
        </NuxtLink>
        <!--
          右上功能選單。`AppNav` 自己包 `<ClientOnly>`：選單內容取決於身分，
          而 `strip-auth-on-cacheable.ts` 讓 `/`、`/film/**`、`/venue/**`、
          `/legal/**` 的 SSR 一律看不到身分 ⇒ 不包就是必然的 hydration
          mismatch，而 Vue 只改正文字不改正屬性（踩雷 #98，實測過）。
        -->
        <AppNav />
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>

    <!-- 顯名標示是授權的生效要件，不是禮貌（政府資料開放授權條款第 1 版）。
         元件內有三條份量規則與驗收方式。 -->
    <AttributionFooter />
  </div>
</template>
