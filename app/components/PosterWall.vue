<script setup lang="ts">
/**
 * 海報牆——**一筆觀影紀錄一格**（不是一部片一格），所以重看的片會有多張海報。
 * `/app` 與 `/u/[username]` 共用這一支；兩頁各留一份會漂移（`backend.md §6e`）。
 * 排序、母體、措辭都由呼叫端決定，這支只負責把給它的每一筆畫成一格。
 */

const props = defineProps<{
  /** 已照呼叫端要的順序排好。`film` 四個欄位直接餵 `FilmPoster`。 */
  records: readonly {
    id: string
    film?: {
      titleZh?: string | null
      titleOriginal?: string | null
      tmdbPosterPath?: string | null
      ugcPosterUrl?: string | null
    } | null
  }[]
  /**
   * 權威總數，來自**與 `records` 不同的一條路**（`/app` 是 RPC、`/u/` 是 `page.total`）。
   * 存在的唯一理由是讓「牆被截斷」看得見：兩邊的來源都有上限（500／200）而爆掉時
   * 是靜默少資料。⚠️ 判準是兩條路對帳，**不要在這裡寫死任何上限**。
   */
  total: number
  /** 還在飛。由呼叫端決定——`/u/` 是 SSR，那裡沒有「載入中」這回事。 */
  loading?: boolean
}>()

/**
 * 真牆與骨架共用，不然欄數漂移會讓每次載入都跳版。容器 `max-w-4xl px-4` ＋ gap 8px ⇒
 * 375:3欄109px／640:4欄146px／768:6欄109px／896+:8欄101px，都小於 `w185` 不放大來源。
 * ⚠️ 2026-09-20 加寬到 6xl 被否決；欄數變窄先撐不住的是無海報文字卡，改前看 375px。
 */
const WALL_GRID = 'grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8'

/**
 * ⚠️ `records.length === 0` **不是截斷是壞掉**，那一種由 `#empty` 負責。
 * 這兩段是兄弟節點不是 v-if 鏈 ⇒ 少了這一半，空陣列時會同時印出「讀不到…」與
 * 「只放得下 0 筆，總共 174 筆」。typecheck／lint／test／死碼 grep 全部抓不到。
 */
const truncated = computed(() =>
  !props.loading && props.records.length > 0 && props.records.length < props.total)
</script>

<template>
  <section>
    <!-- 說牆自己說不出來的兩件事：排序，以及為什麼同一張海報會出現兩次。 -->
    <p v-if="$slots.caption" class="text-sm text-muted">
      <slot name="caption" />
    </p>

    <!-- ⚠️ 還在飛時不能把牆畫成空的：`total` 來自另一支請求，它先到（踩雷 #169）。 -->
    <div v-if="loading" :class="WALL_GRID" class="mt-3">
      <USkeleton v-for="i in 24" :key="i" class="aspect-[2/3] w-full rounded-[3px]" />
    </div>

    <!-- 上游說有紀錄卻拿到空陣列＝壞掉，不是空狀態。說出來，不要留一面沉默的空牆。 -->
    <p v-else-if="!records.length" class="mt-3 text-muted">
      <slot name="empty">
        讀不到紀錄。重新整理看看。
      </slot>
    </p>

    <ul v-else :class="WALL_GRID" class="mt-3">
      <!--
        ⚠️ `:key` 必須是**紀錄**的 id：重看的片共用 filmId，拿它當 key 會把多張海報收成
           一張，格數就不等於紀錄數，而畫面看起來完全正常。
      -->
      <!--
        ⚠️ 無海報走 `card` 不是 `monogram`（最窄一格 109px，`monogram` 為 48px 寫的）。
           目前 0 筆樣本（174/174 有海報）⇒ 沒被目視過，但別改成灰底或濾掉，
           它隨時會回來，`DESIGN_SYSTEM §0` 照樣成立。
      -->
      <!-- ⚠️ `w185` 熱連結 image.tmdb.org，不建 proxy 不轉存——TMDB 合規要求非效能選擇。 -->
      <li v-for="r in records" :key="r.id">
        <FilmPoster
          :title-zh="r.film?.titleZh"
          :title-original="r.film?.titleOriginal"
          :tmdb-poster-path="r.film?.tmdbPosterPath"
          :ugc-poster-url="r.film?.ugcPosterUrl"
          size="w185"
        />
      </li>
    </ul>

    <!-- 被上游的筆數上限截斷了要看得見。判準見 script 的 `truncated`。 -->
    <p v-if="truncated" class="mt-4 text-sm text-muted">
      <slot name="truncated" :shown="records.length" :total="total">
        這面牆只顯示了 {{ records.length }} 筆，總共有 {{ total }} 筆。
      </slot>
    </p>
  </section>
</template>
