<script setup lang="ts">
import type { TicketCardRecord } from '~/utils/ticket'

/**
 * ★ 全站的主要物件（`DESIGN_SYSTEM §0` / `§4.3`）。
 * `/u/{username}`、`/app/records`、`/app`、`/film/{slug}` 的「誰看過」、
 * 匯入預覽共用同一張卡。
 *
 * ── 為什麼是票根不是海報 ──────────────────────────────────────
 * Letterboxd 是海報導向的，因為它每部片都有海報；我們有 10%（268/2669）
 * 永遠沒有。而我們比它多的東西——官方核准片名、影城、廳別、版本、票價、
 * 場次時間——正好是一張台灣電影票根上印的東西。
 *
 * 所以**沒有海報時，海報欄不存在**，卡片自然變寬。不留灰色佔位、不畫破圖
 * 圖示。驗收標準是「無海報的卡片要好到使用者不會希望它變成海報」。
 *
 * ── 版面 ──────────────────────────────────────────────────────
 * ```
 * ┌────┬──────────────────────────────────────────┬──────┐
 * │ 7  │ 劇場版 吉伊卡哇 人魚島的秘密              │      │
 * │ 26 │ ちいかわ                  ← 原文，小一級  │ 海報 │
 * │ 六 │ 林口威秀 (7廳) 2D 16:00 2張 NT$520        │ 選配 │
 * └────┴──────────────────────────────────────────┴──────┘
 * ```
 * 左邊窄帶是日期，取的是票根撕線的**結構**——不畫齒孔、不畫虛線，材質不取。
 *
 * ── 尚未落地的東西 ────────────────────────────────────────────
 * 1. **色票**：design session 正在把調性改成「更重的溫暖收藏感」，`§1.6` 的
 *    token 會整組換。這裡一律只用 Nuxt UI 的語意類別（`text-muted` /
 *    `border-default` / `bg-default`），換 token 時這個檔不必動。
 * 2. **`§4.3` 的網格模式**（同一份資料轉 2:3 直式）尚未實作：目前四個呼叫端
 *    都是列表。要做時是加一個 `variant="grid"`，不是另開一個元件。
 * 3. 原文片名的專屬字型堆疊（`§2.3` 的 `.title-original`）等 design 的 CSS。
 */
const props = withDefaults(defineProps<{
  record: TicketCardRecord
  /** 日期帶要不要多一行年份。依年份分組的列表用不到，`/film/[slug]` 的「誰看過」要。 */
  showYear?: boolean
  /** 片名要不要連到作品頁。匯入預覽那種「還沒存進去」的情境設 false。 */
  linkFilm?: boolean
}>(), { showYear: false, linkFilm: true })

defineSlots<{
  /** 卡片最右側的操作區（編輯／刪除）。只有 `/app` 的列表會用。 */
  actions?: () => unknown
}>()

const band = computed(() => dateBand(props.record.watchedOn))

const titleZh = computed(() => displayTitle(props.record.film?.titleZh))
const titleOriginal = computed(() => displayTitle(props.record.film?.titleOriginal))
/** 中文片名缺席時原文遞補當主標，避免主標留白、副標卻有字。 */
const title = computed(() => titleZh.value || titleOriginal.value)
/** 副標只在它跟主標不同時才出現，否則同一個字會印兩次。 */
const subtitle = computed(() => (titleOriginal.value && titleOriginal.value !== title.value ? titleOriginal.value : ''))

const meta = computed(() => ticketMetaLine(props.record))

/**
 * 有沒有海報**在這裡決定**，不丟給 FilmPoster 的 fallback——
 * §4.3 要的是「海報欄不存在」，不是「海報欄放一張文字卡」。
 */
const hasPoster = computed(() => !!(props.record.film?.tmdbPosterPath || props.record.film?.ugcPosterUrl))

const filmHref = computed(() =>
  props.linkFilm && props.record.film?.slug ? `/film/${props.record.film.slug}` : null)
</script>

<template>
  <article class="flex items-start gap-3 rounded-sm border border-default bg-default px-3 py-3 sm:gap-4 sm:px-4">
    <!-- 日期帶。tabular-nums 讓多張卡的數字對得齊（Inter 供應，見 §2.2）。 -->
    <div
      v-if="band"
      class="w-9 shrink-0 self-stretch border-r border-default pr-3 text-center leading-tight tabular-nums"
    >
      <div v-if="showYear" class="text-[11px] text-dimmed">
        {{ band.year }}
      </div>
      <div class="text-[11px] text-muted">
        {{ band.month }}
      </div>
      <div class="text-lg font-semibold text-highlighted">
        {{ band.day }}
      </div>
      <div class="text-[11px] text-muted">
        {{ band.weekday }}
      </div>
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <NuxtLink
          v-if="filmHref"
          :to="filmHref"
          class="text-base font-medium leading-snug text-highlighted line-clamp-2 hover:underline underline-offset-4"
        >
          {{ title || '（作品不明）' }}
        </NuxtLink>
        <span v-else class="text-base font-medium leading-snug line-clamp-2" :class="title ? 'text-highlighted' : 'text-muted'">
          {{ title || '（作品待審核）' }}
        </span>
        <UBadge v-if="record.isPrivate" variant="soft" color="neutral" size="sm">
          私密
        </UBadge>
      </div>

      <!-- 原文片名：小一級、淡一階。實測 12.9% 的原文片名有中文字型畫不出來的
           字（諺文、日本新字體、泰文…），把它做成刻意的層級差而不是破面。 -->
      <p v-if="subtitle" class="mt-0.5 text-[13px] leading-normal text-muted line-clamp-1">
        {{ subtitle }}
      </p>

      <!-- meta 行一次插值。切成多個元素靠空白分隔會被 Vue 的 whitespace
           'condense' 吃掉，render 成 `2D16:00`（見 utils/ticket.ts 檔頭）。 -->
      <p v-if="meta" class="mt-1 text-[13px] leading-normal text-muted tabular-nums">
        {{ meta }}
      </p>

      <p
        v-if="record.memo"
        class="mt-1.5 border-l-2 border-default pl-2 text-sm leading-relaxed whitespace-pre-line"
      >
        {{ record.memo }}
      </p>
    </div>

    <!-- 海報是選配的鑲嵌。沒有就整欄不存在，卡片自然變寬。 -->
    <div v-if="hasPoster" class="w-14 shrink-0">
      <FilmPoster
        :title-zh="record.film?.titleZh"
        :title-original="record.film?.titleOriginal"
        :tmdb-poster-path="record.film?.tmdbPosterPath"
        :ugc-poster-url="record.film?.ugcPosterUrl"
        variant="monogram"
        size="w185"
      />
    </div>

    <div v-if="$slots.actions" class="flex shrink-0 gap-1">
      <slot name="actions" />
    </div>
  </article>
</template>
