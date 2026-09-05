<script setup lang="ts">
/**
 * ★ 全站唯一組海報 URL 的地方（docs/BUILD_PLAN.md §6.2）。
 *
 * 三條路徑，都不經過我們自己的伺服器：
 *   TMDB → 熱連結 image.tmdb.org（未重製、未散布，且避開 6 個月快取條款）
 *   UGC  → Supabase Storage 的 signed URL，由 API 端簽好帶進來
 *   都沒有 → 文字卡片
 *
 * 「都沒有」目前是**常態而非例外**：film_tmdb_snapshot 的 2,401 筆快照要等
 * Step 9 的刷新排程才會有 poster_path，在那之前每一列都走這條路。所以文字
 * 卡片的品質等同於全站的品質，不是邊角案例。
 *
 * ── variant 的存在理由 ────────────────────────────────────────
 * 48px 寬的容器放不下中文片名。先前只有單一版面（p-4 + break-all），在列表
 * 的 w-12 容器裡只剩約 16px 可用，於是每行一個字再被截斷，變成「卡哇人」
 * 這種直式擠壓——那不是「沒有海報」，那是版面錯誤。
 *
 *   monogram：小尺寸用。取片名首字當字標，配底色，不放全名
 *   card    ：大尺寸用（作品頁側欄）。放全名，line-clamp 收尾，不用 break-all
 *
 * break-all 一律不用：它會在任意字元間斷行，中文標題會被切成直條。
 */
const props = withDefaults(defineProps<{
  titleZh?: string | null
  titleOriginal?: string | null
  tmdbPosterPath?: string | null
  ugcPosterUrl?: string | null
  size?: 'w185' | 'w342' | 'w500' | 'original'
  variant?: 'monogram' | 'card'
  eager?: boolean
}>(), { size: 'w342', variant: 'card' })

const src = computed(() => {
  if (props.tmdbPosterPath)
    return `https://image.tmdb.org/t/p/${props.size}${props.tmdbPosterPath}`
  return props.ugcPosterUrl || null
})

const label = computed(() => props.titleZh || props.titleOriginal || '未命名作品')

/**
 * 字標取片名第一個「有意義」的字。
 * 片名常以《「【（ 開頭（《Thunderbolt Fantasy》、劇場版「暗殺教室」），
 * 直接取 [0] 會得到一個引號，資訊量為零。
 */
const monogram = computed(() => {
  const cleaned = label.value.replace(/^[《〈「『【（([\s"']+/u, '')
  return [...(cleaned || label.value)][0] ?? '?'
})

/** 由片名決定底色，讓相鄰的列不會糊成一片同色。刻意用 hex，與圖表色票同源。 */
const tint = computed(() => {
  const palette = ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#14b8a6', '#ec4899']
  let h = 0
  for (const ch of label.value) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return palette[h % palette.length]!
})
</script>

<template>
  <div class="relative aspect-[2/3] overflow-hidden rounded-[3px] bg-elevated">
    <img
      v-if="src"
      :src="src"
      :alt="`${label} 海報`"
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      class="size-full object-cover"
    >

    <!-- 小尺寸：字標。不試圖塞下整個片名。 -->
    <div
      v-else-if="variant === 'monogram'"
      class="flex size-full items-center justify-center"
      :style="{ backgroundColor: `${tint}1a`, color: tint }"
      :title="label"
      role="img"
      :aria-label="`${label}（無海報）`"
    >
      <span class="text-xl font-semibold leading-none select-none">{{ monogram }}</span>
    </div>

    <!-- 大尺寸：放得下全名。line-clamp 收尾，不用 break-all。 -->
    <div
      v-else
      class="flex size-full flex-col items-center justify-center gap-2 px-3 py-4 text-center"
      :style="{ backgroundColor: `${tint}14` }"
      role="img"
      :aria-label="`${label}（無海報）`"
    >
      <span
        class="text-sm font-medium leading-snug line-clamp-5 break-words"
        :style="{ color: tint }"
      >{{ label }}</span>
    </div>
  </div>
</template>
