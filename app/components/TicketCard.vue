<script setup lang="ts">
import type { TicketCardRecord } from '~/utils/ticket'

/**
 * ★ 全站的主要物件（`DESIGN_SYSTEM §0`／`§4.3`）。`/u/`、`/app/records`、`/app`、
 * `/film/` 的「誰看過」、匯入預覽共用同一張卡。
 */
/*
 * 為什麼是票根不是海報：Letterboxd 每部片都有海報，我們有 10%（268/2669）永遠沒有；
 * 而我們比它多的（官方核准片名、影城、廳別、版本、票價、場次時間）正好是一張台灣票根
 * 上印的東西。⇒ **沒有海報時海報欄不存在**，卡片自然變寬，不留灰色佔位不畫破圖圖示。
 * 驗收標準是「無海報的卡片要好到使用者不會希望它變成海報」。
 */
/*
 * 左邊窄帶是日期，取的是票根撕線的**結構**——不畫齒孔、不畫虛線，材質不取。
 * 尚未落地：`§4.3` 的網格模式（要做時是加一個 `variant="grid"` 不是另開元件）、
 * 原文片名的專屬字型堆疊（`§2.3`）。色票一律只用語意類別，換 token 時這個檔不必動。
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

/**
 * meta 是**兩段不是一行**（§4.3）。第一段是影城（含廳別），永遠不被切開；
 * 第二段是版本／時間／張數／票價。桌機兩段並在同一行，375px 自然落成兩行——
 * **那個斷點是刻意的，不是碰巧的**。
 */
const venueMeta = computed(() => venueSegment(props.record))
const detailMeta = computed(() => detailSegment(props.record))

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
    <!--
      日期帶**染琥珀**（§4.3）不是中性面：琥珀承載表面，票根的撕線位置整條變成重點色，
      卡片一眼就讀成票根而不是列表列。對比已驗——日期數字 14.03:1／14.08:1、
      星期 4.65:1／4.65:1。`tabular-nums` 讓多張卡的數字對得齊（由 Inter 供應）。
    -->
    <div
      v-if="band"
      class="-my-3 -ms-3 w-13 shrink-0 self-stretch bg-amber-50 py-3 text-center leading-tight tabular-nums sm:-ms-4 dark:bg-amber-950"
    >
      <div v-if="showYear" class="text-[11px] text-muted">
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
      <!--
        場次時間。它同時從 meta 的第二段拿掉了（見 `utils/ticket.ts` 的 `detailSegment`），
        兩邊都印就是同一個值出現兩次。帶寬從 44px 放到 52px：`16:00` 在 11px 的 Inter tabular
        實量約 30px，44px 扣掉左右內距會擠。
      -->
      <div v-if="shortTime(record.watchedTime)" class="text-[11px] text-muted">
        {{ shortTime(record.watchedTime) }}
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

      <!--
        兩段各自一次插值，段與段之間靠 flex 的 gap 分隔——**不要**靠文字裡的空白，那會被
        whitespace 'condense' 吃掉、render 成 `威秀影城數位`。影城那段 `whitespace-nowrap`，
        寧可整段換行也不要斷在名稱中間。
      -->
      <p
        v-if="venueMeta || detailMeta"
        class="mt-1 flex flex-wrap gap-x-2 text-[13px] leading-normal text-muted tabular-nums"
      >
        <!--
          用 `truncate` 不是只有 nowrap：§4.3 算的 277px 是「沒有海報也沒有操作鈕」的乾淨卡片，
          而 `/app/records` 的卡多了兩顆鈕，375px 下內容欄只剩約 197px，純 nowrap 會讓影城名
          直接畫到海報上面去（實測 218px 的字塞進 133px 的欄）。省略號讀起來是「名字更長」，
          跟斷在名稱中間變成另一個地名不一樣。
        -->
        <span v-if="venueMeta" class="max-w-full truncate">{{ venueMeta }}</span>
        <span v-if="detailMeta">{{ detailMeta }}</span>
      </p>

      <p
        v-if="record.memo"
        class="mt-1.5 border-l-2 border-default pl-2 text-sm leading-relaxed whitespace-pre-line"
      >
        {{ record.memo }}
      </p>
    </div>

    <!--
      海報是選配的鑲嵌。沒有就整欄不存在，卡片自然變寬。
      `<640px` 直接不顯示（`SCREENS.md §2.3`）——票根卡本來就完整，而 375px 下
      那 56px 是影城全名需要的空間。
    -->
    <div v-if="hasPoster" class="hidden w-14 shrink-0 sm:block">
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
