<script setup lang="ts">
import type { YearStats } from '~/utils/stats'

/**
 * 多刷排行（`SCREENS.md §9` band 7、US-41）。
 *
 * ⚠️ 「多刷」的語意**跟著檢視視角變**：指定年份時是「那一年內看過兩次以上」，
 * 全期時是「這些年來看過兩次以上」。所以呼叫端的圖說要講清楚範圍，
 * 抽屜的標題與過濾也要跟著同一個 scope（`SCREENS §9c.2`）。
 */
defineProps<{ items: YearStats['repeats'] }>()

/**
 * 整列可點 → 抽屜列出那一部片在目前 scope 內的每一次觀看紀錄。
 *
 * ★ 只 emit `film_id`，**不 emit slug 或片名當識別**：多刷以 film_id 分組
 *   （`BUILD_PLAN` 附錄第 31 條），片名會撞、slug 對未審核 UGC 是 404。
 * ★ `records` 一起帶出去是給標題用的——那是**排行上的數字**，跟抽屜實際列出
 *   幾張擺在一起才看得出不一致（踩雷 #169）。
 */
const emit = defineEmits<{
  pick: [film: { filmId: string, titleZh: string | null, records: number }]
}>()
</script>

<template>
  <ul class="space-y-3">
    <li v-for="f in items" :key="f.film_id">
      <!--
        ★ **整列是一顆 button，片名不再是 NuxtLink。**
          `<a>` 巢在 `<button>` 裡是無效 HTML，而且點到片名時連結會吃掉事件、
          抽屜開不起來——使用者只會覺得「有時候點得開有時候點不開」。
          作品頁的入口在抽屜裡：每一張 TicketCard 的片名本來就連到
          `/film/{slug}`（`TicketCard.vue` 的 `linkFilm` 預設 true），
          而且那個 slug 來自**紀錄**、已經過了 public + approved 的閘門——
          排行的 `repeats[].slug` 直接來自 `left join film`，**沒有過閘門**。
        ★ 不要加 hover 位移／transition（`DESIGN_SYSTEM`：沒有每張卡片的 hover
          transition）。focus 樣式照 `YearStrip` 的 outline 寫法。
      -->
      <button
        type="button"
        class="flex w-full items-center gap-3 text-start focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
        aria-haspopup="dialog"
        @click="emit('pick', { filmId: f.film_id, titleZh: f.title_zh, records: f.records })"
      >
        <!--
          ★ `aria-hidden`：`FilmPoster` 沒有海報時是 `role="img"` + aria-label、
            有海報時 img 的 alt 是「片名 海報」。包進 button 之後那段文字會被
            吸進按鈕的可及名稱，螢幕閱讀器會唸成「XX 海報，XX，10 次」。
        -->
        <div class="w-10 shrink-0" aria-hidden="true">
          <FilmPoster
            :title-zh="f.title_zh"
            :tmdb-poster-path="f.poster_path"
            variant="monogram"
            size="w185"
          />
        </div>
        <!-- min-w-0 + truncate：375px 下最長的片名要收尾，不是撐開容器 -->
        <span class="min-w-0 flex-1 truncate text-sm hover:underline underline-offset-4">
          {{ displayTitle(f.title_zh) || '（作品不明）' }}
        </span>
        <span class="shrink-0 text-sm tabular-nums text-highlighted">{{ f.records }} 次</span>
      </button>
    </li>
  </ul>
</template>
