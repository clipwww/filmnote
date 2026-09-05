<script setup lang="ts">
const user = useSupabaseUser()
</script>

<template>
  <div class="min-h-dvh flex flex-col bg-default text-default">
    <header class="border-b border-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
        <NuxtLink to="/" class="text-lg font-semibold tracking-wide">
          影記
        </NuxtLink>
        <nav class="flex items-center gap-2 text-sm">
          <UButton v-if="user" to="/app" variant="ghost" size="sm">
            我的紀錄
          </UButton>
          <UButton v-else to="/login" variant="soft" size="sm">
            登入
          </UButton>
        </nav>
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>

    <!-- 顯名標示是授權的生效要件，不是禮貌（政府資料開放授權條款第 1 版） -->
    <footer class="border-t border-default mt-12">
      <div class="mx-auto max-w-5xl px-4 py-8 text-xs leading-relaxed text-muted space-y-2">
        <p>
          本站部分資料採用文化部影視及流行音樂產業局「電影片分級及相關資訊」與「全國電影院資料」開放資料，依政府資料開放授權條款第 1 版提供。
        </p>
        <p>This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
      </div>
    </footer>
  </div>
</template>
