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
 *   monogram：小尺寸用。取片名首字當字標，不放全名
 *   card    ：大尺寸用（作品頁側欄）。放全名，line-clamp 收尾，不用 break-all
 *
 * break-all 一律不用：它會在任意字元間斷行，中文標題會被切成直條。
 *
 * ── 底色只有一個，不做雜湊配色（§4.3）────────────────────────
 * 原本是由片名雜湊出六種色（emerald / blue / violet / pink…），砍掉的理由有三：
 *
 * 1. **它違反 §0「資料是墨，不是彩虹」，而且它連資料都不是。** 顏色是從片名
 *    雜湊出來的，不編碼任何東西——只是「看起來有在分類」。全站唯一允許的
 *    彩色是琥珀，而琥珀只塗介面不塗資料（§1.0）。
 * 2. **它當初要解的問題已經消失。** 雜湊配色是為了讓一整面文字磚不糊成一片；
 *    Step 9 之後 2,452 / 2,669 部有海報（91.9%），無海報磚變成散落在真海報
 *    之間的少數，不再是一整面牆。
 * 3. 磚與磚之間本來就有邊框與 gap，不需要靠底色分。
 *
 * ⚠️ **次要文字必須用 `text-toned` 不能用 `text-muted`。** 磚底（`bg-elevated`）
 * 比卡片底深一階，`text-muted` 在上面只有亮 3.92 / 暗 3.51，不及格；
 * `text-toned` 是亮 5.57 / 暗 6.15。整條文字階要跟著往上推一階。
 *
 * ⚠️ **無海報磚是永久狀態不是過渡。** 那 268 部沒有 tmdb_id 的作品不會自己
 * 變出海報。§0 的驗收標準原封不動：**無海報的卡片要好到使用者不會希望它
 * 變成海報**——這條在 8% 的時候比在 100% 的時候更難達到，因為它旁邊就擺著
 * 真海報可以比。
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
      class="flex size-full items-center justify-center bg-elevated"
      :title="label"
      role="img"
      :aria-label="`${label}（無海報）`"
    >
      <span class="text-xl font-semibold leading-none text-highlighted select-none">{{ monogram }}</span>
    </div>

    <!-- 大尺寸：放得下全名。line-clamp 收尾，不用 break-all。 -->
    <div
      v-else
      class="flex size-full flex-col items-center justify-center gap-2 bg-elevated px-3 py-4 text-center"
      role="img"
      :aria-label="`${label}（無海報）`"
    >
      <span class="text-sm font-medium leading-snug text-highlighted line-clamp-5 break-words">{{ label }}</span>
    </div>
  </div>
</template>
