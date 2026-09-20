<script setup lang="ts">
/**
 * 海報牆——**一筆觀影紀錄一格**（不是一部片一格）。
 *
 * David 2026-09-20：「所有看過的電影海報組成的牆面，依照觀看時間新->舊，
 * 重覆看的就是會有多張海報」。重看的片自然就有多張海報，**不要 dedupe**。
 *
 * ★★ 這支被 `/app`（本人的儀表板）與 `/u/[username]`（公開分享頁）**兩頁共用**。
 *   抽出來的理由不是「少寫幾行」，是這個 repo 反覆記過的那個錯：同一面牆在兩頁
 *   各留一份，漂移之後沒有人會發現——沒有人會把兩頁的同一個東西擺在一起看
 *   （`backend.md §6e`）。
 *
 * ── 這支**不決定**的事 ────────────────────────────────────────────
 * · **排序**：呼叫端給什麼順序就畫什麼順序。兩頁的資料來源不同
 *   （`/app` 是 `useMyRecords()` 直查、`/u/` 是 `/api/u/…` 的 payload），
 *   排序各自在那一層做完。
 * · **母體**：`/app` 是本人的全部紀錄、`/u/` 只有**公開**紀錄。這支不知道差別，
 *   也不該知道——它只負責「把你給我的每一筆畫成一格」。
 * · **措辭**：三段文字全部走 slot。`/app` 是本人視角（「你的紀錄」），
 *   `/u/` 是匿名視角（「公開的紀錄」）——兩頁的句子**刻意不同，不要互抄**。
 *
 * ── SSR ────────────────────────────────────────────────────────
 * ⚠️ `/u/` 是 SSR ⇒ 這支**不可以碰 `localStorage`／`window`／`document`**，
 *   也不要有「掛載後才對」的狀態。`loading` 由呼叫端決定，元件自己不猜
 *   （兩頁的「還在飛」語意不同：`/app` 是 client-only 的 `useAsyncData` 狀態，
 *   `/u/` 在伺服器那一次根本沒有載入中這回事）。
 */

const props = defineProps<{
  /**
   * 要畫的紀錄，**已經照呼叫端要的順序排好**。
   * `film` 的四個欄位直接餵給 `FilmPoster`，四個都可為 null——
   * 沒有海報時它會畫文字卡，那是正當狀態不是缺陷（見下方 §0 的註解）。
   */
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
   * **權威總數**，來自與 `records` **不同的一條路**
   * （`/app`：RPC `user_year_stats` 的 `totals.records`；`/u/`：端點的 `page.total`）。
   *
   * ★★ 這個 prop 存在的唯一理由是**讓「牆被截斷」這件事看得見**。
   *   兩頁的紀錄來源都有上限（`useMyRecords()` 是 `.limit(500)`、
   *   `/api/u/…` 一次最多 200），而**爆掉的時候是靜默少資料**——牆是全部紀錄的
   *   視覺呈現，少了就是少了而且看不出來。
   *   ⚠️ 判準刻意是「兩條路的數字對帳」而不是跟某個常數比：把那兩個上限改成
   *     800／500，這支不用動也還是對的。**不要在這裡寫死任何上限。**
   */
  total: number
  /** 紀錄還在飛。`true` 時畫骨架，而且**截斷提示絕對不出現**（理由見 `truncated`）。 */
  loading?: boolean
}>()

/**
 * 牆的格線。**真牆與載入骨架共用同一個字串**，免得兩邊漂移之後骨架的欄數
 * 跟真牆對不起來（那會讓每次載入都跳一次版）。
 *
 * ── ⚠️ 2026-09-20：「把牆加寬」提過，被 David 否決 ────────────────
 * 當天他先說「好呀」，我據此把容器放寬到 `max-w-6xl`、欄數改成
 * `3/4/5/6/7`（1280 下每張 153px）。**同日他改變主意：「我改變主意了
 * 海報牆不要加寬」** ⇒ 整組回退。
 * **記在這裡而不是靜靜抹掉**，因為「加寬」是從一個真的理由推出來的
 * （海報太小看不出是哪一部片），下一個人會從同樣的理由重新推導出同一個
 * 已經被否決的結論。要重提請先問 David。
 *
 * 目前這一組是 **David 已經目視確認過的那一組**（他看過 `/app` 之後說
 * 「效果很棒／我確認 ok」），所以不要在沒有人要求的情況下動它。
 *
 * 幾何（算出來的，不是量的）。**兩個呼叫端的容器都必須是 `mx-auto max-w-4xl px-4`**
 * （`/app` 與 `/u/[username]`，2026-09-20 實測兩頁都是）——其中一頁改了寬度，
 * 下面這張表就對那一頁說謊。gap 8px：
 *   375  → 內容 343，3 欄 = 109px
 *   640  → 608，4 欄 = 146px
 *   768  → 736，6 欄 = 109px
 *   896+ → 864（4xl 封頂），8 欄 = 101px
 * ★ 每一格都遠小於 `FilmPoster` 送的 TMDB `w185`（185px），所以不會把來源放大。
 *
 * ⚠️ 欄數還是可以動，但**格子變窄時先撐不住的是無海報的文字卡不是海報**
 *   （海報只是變小）。改欄數的人請先造一筆無海報的紀錄，在 375px 下看過它再送出。
 */
const WALL_GRID = 'grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8'

/**
 * 牆被截斷了嗎？
 *
 * ★ `loading` 要擋在最前面：紀錄那一支請求還沒到的時候 `records.length` 是 0
 *   而 `total` 已經是真數字，不擋的話每次載入都會閃一句「只放得下 0 筆」。
 * ★★ `records.length === 0` **不是截斷，是壞掉**——那一種由 `#empty` 那一段負責。
 *   這兩段是**兄弟節點不是 v-if 鏈**，各自的條件必須自己把對方排除掉：
 *   少了這一半，紀錄回空陣列時畫面會同時出現「讀不到…」與「只放得下最近 0 筆，
 *   總共有 174 筆」——後面那句是胡說。
 *   ⚠️ typecheck／lint／test 與死碼 grep **全部抓不到這件事**，只有把請求弄壞
 *     才看得見（2026-09-20 實測，`/app` 那一版就犯過）。
 */
const truncated = computed(() =>
  !props.loading && props.records.length > 0 && props.records.length < props.total)
</script>

<template>
  <section>
    <!--
      ★ 這一句在說兩件牆自己說不出來的事：**排序**，以及**為什麼同一張海報會出現
        兩次**。少了第二句，重複看過的片在牆上看起來就像 bug。
        措辭由呼叫端給——兩頁的視角不同（本人／匿名）。
    -->
    <p v-if="$slots.caption" class="text-sm text-muted">
      <slot name="caption" />
    </p>

    <!--
      ★ 紀錄還在飛的時候**不能把牆畫成空的**（踩雷 #169）：`total` 來自另一支
        請求，它先到的時候頁面已經寫著「總共看了 174 場」而牆是空的。
    -->
    <div v-if="loading" :class="WALL_GRID" class="mt-3">
      <USkeleton v-for="i in 24" :key="i" class="aspect-[2/3] w-full rounded-[3px]" />
    </div>

    <!--
      ⚠️ 上游說有紀錄、這裡卻拿到空陣列：那是壞掉，不是空狀態。
         說出來，不要留一面沉默的空牆。
    -->
    <p v-else-if="!records.length" class="mt-3 text-muted">
      <slot name="empty">
        讀不到紀錄。重新整理看看。
      </slot>
    </p>

    <ul v-else :class="WALL_GRID" class="mt-3">
      <!--
        ★★ `:key` 一定是**紀錄**的 id，不是 `filmId`：重複看過的片會共用同一個
          filmId，拿它當 key 會讓 Vue 把多張海報收成一張——牆上的格數就不等於
          紀錄數了，而畫面看起來完全正常。

        ★ `variant` 用預設的 `card`（放得下全名）不是 `monogram`。理由是尺寸：
          `monogram` 是為 48px 的容器寫的（`FilmPoster` 檔頭），而這裡最窄的一格是
          375px 下的 109px、桌機 101px，兩倍有餘。
          ⚠️ 「109px 放得下中文片名」是推的不是量的——實際換行結果要在瀏覽器上
             看過才算數。`card` 用 `line-clamp-5` 收尾、不用 `break-all`，
             所以最壞情況是截斷不是直條擠壓。

        ⚠️⚠️ **無海報那條路目前在 David 的資料上一個樣本都沒有**（2026-09-20
          修掉兩個 TMDB 配對錯誤之後 174／174 都有海報，UGC 0 筆），所以它是
          **沒有被目視驗證過的**。但它隨時會回來（新的 UGC 作品、配不到 TMDB 的片），
          而 `DESIGN_SYSTEM §0`「無海報的卡片要好到使用者不會希望它變成海報」
          對它照樣成立。**不要**因為現在看不到就改成灰色佔位圖、把它濾掉、
          或把 `card` 換成 `monogram`——那三件事都是在賭一個你看不到的畫面。

        ★ `size="w185"`：牆上一格最大 146px（sm 斷點），w185 綽綽有餘，而一頁要載
          一兩百張。跟 `search.vue` 的格狀清單同一個選擇。海報一律熱連結
          `image.tmdb.org`（`FilmPoster` 已經做對了）——**不建 proxy、不轉存**，
          那是 TMDB 的合規要求不是效能選擇。
      -->
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

    <!-- 牆被上游的筆數上限截斷了要看得見。判準見 script 的 `truncated`。 -->
    <p v-if="truncated" class="mt-4 text-sm text-muted">
      <slot name="truncated" :shown="records.length" :total="total">
        這面牆只顯示了 {{ records.length }} 筆，總共有 {{ total }} 筆。
      </slot>
    </p>
  </section>
</template>
