<script setup lang="ts">
/**
 * ★ 全站唯一組海報 URL 的地方（docs/BUILD_PLAN.md §6.2）。
 *
 * 三條路徑，都不經過我們自己的伺服器：
 *   TMDB → 熱連結 image.tmdb.org（未重製、未散布，且避開 6 個月快取條款）
 *   UGC  → Supabase Storage 的 signed URL，由 API 端簽好帶進來
 *   都沒有 → 片名文字卡片
 *
 * 「都沒有」不只發生在 UGC 作品：`film_public` view 會用 `expires_at > now()`
 * 把逾期的 TMDB 欄位變成 NULL，所以快取過期的作品會自動退回文字卡片，
 * 而不是繼續供應逾期內容。**絕不要自建海報代理**——那等同轉存。
 */
const props = withDefaults(defineProps<{
  titleZh?: string | null
  titleOriginal?: string | null
  tmdbPosterPath?: string | null
  ugcPosterUrl?: string | null
  size?: 'w185' | 'w342' | 'w500' | 'original'
  eager?: boolean
}>(), { size: 'w342' })

const src = computed(() => {
  if (props.tmdbPosterPath)
    return `https://image.tmdb.org/t/p/${props.size}${props.tmdbPosterPath}`
  return props.ugcPosterUrl || null
})

const label = computed(() => props.titleZh || props.titleOriginal || '未命名作品')
</script>

<template>
  <div class="relative aspect-[2/3] overflow-hidden rounded-lg bg-elevated">
    <img
      v-if="src"
      :src="src"
      :alt="`${label} 海報`"
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      class="size-full object-cover"
    >
    <!-- 文字卡片：缺海報不影響核心功能（SPEC 海報與圖片節） -->
    <div
      v-else
      class="flex size-full items-center justify-center p-4 text-center"
    >
      <span class="text-sm font-medium text-muted leading-relaxed break-all">{{ label }}</span>
    </div>
  </div>
</template>
