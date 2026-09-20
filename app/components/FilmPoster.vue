<script setup lang="ts">
/**
 * ★ 全站唯一組海報 URL 的地方（`BUILD_PLAN §6.2`）。三條路徑都不經過我們自己的伺服器：
 * TMDB 熱連結 `image.tmdb.org`（未重製、未散布，且避開 6 個月快取條款）、
 * UGC 的 signed URL（由 API 端簽好帶進來）、都沒有則是文字卡片。
 */
/*
 * ── variant ──
 * 48px 寬的容器放不下中文片名：先前單一版面（`p-4` + `break-all`）在 `w-12` 容器裡只剩約
 * 16px 可用，每行一個字再被截斷 ⇒「卡哇人」那種直式擠壓，那不是「沒有海報」是版面錯誤。
 * `monogram` 取首字當字標（小尺寸）、`card` 放全名 + line-clamp（大尺寸）。break-all 一律不用。
 */
/*
 * ── 底色只有一個，不做雜湊配色（§4.3）──
 * 原本由片名雜湊出六種色，砍掉的理由：① 違反 §0「資料是墨不是彩虹」，而且它連資料都不是
 * （顏色不編碼任何東西，只是看起來有在分類）；② 它要解的問題已經消失（Step 9 之後
 * 2,452/2,669 有海報 = 91.9%，無海報磚變成散落的少數）；③ 磚之間本來就有邊框與 gap。
 */
/*
 * ⚠️ **次要文字必須用 `text-toned` 不能用 `text-muted`**：磚底比卡片底深一階，`text-muted`
 * 在上面只有亮 3.92／暗 3.51（不及格），`text-toned` 是 5.57／6.15。
 * ⚠️ **無海報磚是永久狀態不是過渡**：那 268 部沒有 tmdb_id 的作品不會自己變出海報。
 * §0 的驗收標準原封不動，而這條在 8% 的時候比在 100% 的時候更難達到（旁邊就擺著真海報）。
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
