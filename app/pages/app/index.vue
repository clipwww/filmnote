<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * `/app` — 登入後看到的第一個畫面（`SCREENS.md §9`）。
 *
 * ★★ **2026-09-20 David 裁決：這一頁是海報牆，不是圖表長卷。**
 *
 *   原話：「儀表板跟個人公開頁相似度太高了／我想把儀表板呈現的內容變更做出差異／
 *   這頁先用所有看過的電影海報組成的牆面好了／依照觀看時間新->舊，
 *   重覆看的就是會有多張海報」。
 *
 *   這裡原本有八條 band，其中**七條與 `/u/[username].vue` 一字不差**
 *   （年表、出席、時段、每個月、去了哪裡、版本、國別、看了不只一次）
 *   ——那正是他說的「相似度太高」。七條全部移除，**只留「每年花費」**：
 *   它是唯一真正只屬於儀表板的一條，因為在 `/u/` 上它依觀看者而異、
 *   路人常常看不到，而本人在自己的儀表板永遠看得到全部。
 *
 *   ⚠️ **移除的是「使用」不是元件。** `YearStrip` / `AttendanceCalendar` /
 *     `HourHeatmap` / `MonthlyTrend` / `DistributionBars` / `RepeatList` /
 *     `YearScopeBar` 每一支都還被 `/u/[username].vue` 用著（實測：那一頁
 *     732–941 行）。刪元件檔會把那一頁弄壞。
 *
 *   ⚠️ **跟著七條 band 一起走的還有兩整組東西**，它們留著會變成**沒有任何
 *     入口可以到達的程式碼**，而 `lint` 與 `typecheck` 抓不到那種東西
 *     （沒人用的 computed 語法上完全合法）：
 *     ① **年份視角**（`activeYear`／`yearStats`／`yearScopedUser`／導覽列的
 *        `YearScopeBar`／換年份關抽屜的 watch）。切換器本體就是年表，
 *        年表走了就沒有入口。而「每年花費」恆為全期（`by_year` 只在
 *        `p_year = null` 有值），本來就不吃年份視角。
 *     ② **底部抽屜**（`Picked` 九種 kind／`UDrawer`／`drawerTitle`／
 *        `drawerEmptyText`／`drawerRecords`／`pickDist()`／`pickMonth()`）。
 *        九個入口全部是那七條 band 的格子。
 *
 *   ⚠️ **這一版牆上的格子不可點。** David 沒有說點下去要做什麼，不替他猜
 *     （2026-09-20 協調者裁決：下一輪再問）。要加點擊行為的人請先問他，
 *     不要因為「一格看起來就該點」而自己補一個。
 *
 * 這頁在 `nuxt.config.ts` 是 `ssr: false` 且需登入，資料一律 client 端取。
 */

useSeoMeta({ title: '我的紀錄' })

const username = useMyUsername()

/**
 * 統計只剩一份，而且**永遠是全期**（`p_year = null`）。年份視角移除之後
 * `yearStats` 那一份沒有人能到達，整支拿掉了。
 *
 * ⚠️⚠️ **這個變數叫 `allStats`，不要「順手」改名成 `stats`。**
 *   `tests/stats.test.ts` 有一條原始碼斷言擋「裸的 `stats.value?.by_year`」
 *   （RPC 在 `p_year` 不是 null 時 `by_year` 是空陣列，寫成那樣「每年花費」
 *   會無聲消失）。改名會讓這一頁當場命中那條正則而紅燈——而且那條斷言
 *   本身是對的，不要去改測試。
 */
const ALL_TIME = ref<number | null>(null)
const { stats: allStats, status: allStatus } = useYearStats(username, ALL_TIME)

const totals = computed(() => allStats.value?.totals ?? null)

/**
 * 牆上的每一格就是一筆 `viewing_record`（**不是一部片**）——重複看的片
 * 自然就有多張海報，那正是 David 要的，不要 dedupe。
 *
 * ★ 排序不用在這裡做：`useMyRecords()` 已經是
 *   `.order('watched_on', desc).order('watched_time', desc, nullsFirst:false)`
 *   （`useMyRecords.ts:67-68`），逐字就是「觀看時間新→舊」。
 *   ⚠️ 排序**沒有拿 `id` 破平手**，所以同一天同一時間的多筆順序不保證穩定。
 *     單一查詢下通常穩定，但不要在任何地方宣稱它有保證。
 *
 * ⚠️ `useMyRecords()` 是 `.limit(500)`，而它檔頭自己註明「這個上限會隨時間爆，
 *   且爆的時候是**靜默少資料**」。海報牆讓這件事變得更要緊：牆是全部紀錄的
 *   視覺呈現，少了就是少了而且看不出來。⇒ 見下方 `truncatedNote`。
 */
const { records, status: recordsStatus } = useMyRecords()

/**
 * ⚠️⚠️ **`username.value === null` 一定要算進載入中，這不是保險是修一個真的會發生的謊。**
 *
 * 時序（從程式碼推的，瀏覽器實測見回報）：`useMyUsername()` 是**另一支**要跑網路的
 * `useAsyncData`，而 `useYearStats` 的 handler 第一行是 `if (!username.value) return null`
 * ——它**同步就回來了**，於是 `allStatus` 立刻變 `success`、`stats` 是 null、
 * `totalRecords` 是 0 ⇒ **空狀態「還沒有東西可以看。記下第一場」會先渲染一次**，
 * 幾百 ms 後 username 到了、watch 重取，牆才長出來。
 * 對一個有 174 筆的人說「還沒有東西可以看」，正是踩雷 #169 那種理直氣壯的謊。
 * `allStatus === 'idle'` 那個窄窗守不到這一段——它在 `success` 上。
 *
 * ⚠️ **這是舊頁就有的行為，不是海報牆造成的**（舊頁同一套 `allStats`／`totalRecords`），
 *   但空狀態這一輪本來就在改，順手修掉。
 * ⚠️ **代價要說出來**：username **永遠**回不來的帳號（沒有 profile 列、或那支請求失敗）
 *   會看到骨架屏不停。那比「說謊」好但仍然是沉默的空白。真正的解是讓
 *   `useMyUsername()` 也吐一個 `status`，分得出「還沒到」與「就是沒有」——
 *   那要動 `app/composables/**`（共用層），已回報給協調者，不在這一輪自己動。
 */
const loading = computed(() =>
  username.value === null || allStatus.value === 'pending' || allStatus.value === 'idle')

/**
 * 紀錄還在飛。**`idle` 也要算**：`useMyRecords` 是 `server: false`，
 * client 端掛載到請求真的發出去之間有一段 `idle`，那時把牆畫成空的一樣是說謊。
 */
const recordsLoading = computed(() => recordsStatus.value === 'pending' || recordsStatus.value === 'idle')

/**
 * **RPC 算的權威總數**（`user_year_stats`，不受 500 上限影響）。
 * 空狀態的閘門與下方的截斷判準都吃它。
 */
const totalRecords = computed(() => allStats.value?.totals?.records ?? 0)

/**
 * `總共看了 174 場、190 張票，花了 NT$57,873`（§4.4）。
 *
 * 年份視角移除之後這一句**恆為全期**，所以第一段固定是「總共」——
 * 它仍然必須說得出自己涵蓋什麼範圍，不能只剩一個裸數字。
 */
const yearSegments = computed<StatSegment[]>(() => {
  const t = totals.value
  if (!t)
    return []
  const spend = t.spend > 0 ? costText(t.spend) : null
  return [
    { value: '總共', suffix: '看了' },
    { value: String(t.records), suffix: '場、' },
    { value: String(t.tickets), suffix: spend ? '張票，花了' : '張票' },
    ...(spend ? [{ value: spend }] : []),
  ]
})

const spendNote = computed(() => {
  const t = totals.value
  return t?.spend_is_partial
    ? `其中 ${t.spend_unknown_records} 筆沒有票價，金額不是全部的花費。`
    : null
})

/*
 * ⚠️ 「牆被截斷了要看得見」那一段判準**搬進 `PosterWall.vue` 了**，因為它是
 *   兩頁共用的規則（`/app` 受 `useMyRecords()` 的 `.limit(500)` 限制、
 *   `/u/` 受端點一次 200 筆限制，形狀一模一樣）。這一頁只負責把兩條路的數字
 *   交出去：`records`（實際拿到幾筆）與 `totalRecords`（RPC 算的權威總數）。
 *   ⚠️ **不要在這個檔案裡寫死 500**——判準是兩條路對帳，不是跟常數比。
 */

/**
 * ── 每年花費 ──（David 2026-09-07 需求 6／7；2026-09-20 起是這一頁唯一的 band）
 *
 * ★★ **資料走 `allStats.by_year`，不要引入 `useUserSpend()`。**
 *   那支是為 `/u/` 造的，解決的是「票價因觀看者而異、而且 `/u/` 是 SSR
 *   ⇒ 金額不能進 `__NUXT_DATA__`」。`/app` 兩個前提都不成立
 *  （`nuxt.config` 對 `/app/**` 是 `ssr: false`、觀看者永遠是本人）。
 *   搬過來只會多發一次一模一樣的 RPC，而且製造**同一頁上兩個金額來源**
 *   ——頁首那句「花了 NT$57,873」跟這條 band 一定會在某次修改後不一致。
 */
const spendRows = computed(() =>
  (allStats.value?.by_year ?? [])
    // ⚠️ `Number()` 不是裝飾：`spend` 在 DB 是 `numeric(12,2)`，而 `SpendByYear`
    //    的 `width()` 用 `spend === 0` 嚴格比較決定「免費那一列的條寬是 0」。
    //    要是 JSON 那層送成字串 `'0.00'`，那一列會靜默長出一小段條而字寫著「免費」。
    .map(y => ({
      year: y.year,
      spend: Number(y.spend ?? 0),
      records: y.records,
      tickets: y.tickets,
      isPartial: !!y.spend_is_partial,
    }))
    .sort((a, b) => b.year - a.year))

const spendCurrency = computed(() => allStats.value?.totals?.spend_currency ?? 'TWD')

/**
 * ★ 判準是「**讀得到幾列票價**」（`SCREENS §2.0b` 第 1 條），不是「總額大於零」
 *   ——後者會把「全部都是兌換票（NT$0）」誤判成沒東西可看。
 *   在 `/app` 這條的意思不是隱私（本人看得到自己全部），而是 §9.3 的「不畫空圖」：
 *   一筆票價都沒記過的帳號每一年都會是「NT$0 以上」，那比沒有這條 band 更糟。
 *
 * ⚠️ 2026-09-20：`showCharts`（<10 筆不畫圖）那道閘門整個拿掉了——三張海報
 *   完全讀得懂，不像兩三個點的圖。**但這一道閘門留著**：它守的是
 *   「讀不讀得到票價」，跟筆數是兩件事，不要一起收掉。
 */
const hasSpend = computed(() => (allStats.value?.totals?.spend_known_records ?? 0) > 0)

/**
 * ⚠️ 兩頁共用的是**這一句的字面**（`/u/` 的 `spendInsight` 還要分本人／路人）。
 * 要改這句話的時候兩邊一起改，不要只改一邊。
 * （原本還有一句「這一條不隨上方的年份切換。」——年份切換器已經不存在了，
 *   那句話在這一頁沒有回答任何問題。）
 */
const spendInsight = '你自己記下的票價，逐年合計。'

/**
 * 空狀態的淡化示意圖。
 *
 * ★★ **2026-09-20：這裡示意的是「牆」，不是出席圖。** 原本是 7×26 的出席格
 *   ＋一句「這裡會長成你的出席圖」——出席圖已經從這一頁搬走了，那句話與那張
 *   示意圖會對 0 筆的新使用者**承諾一個他永遠不會拿到的東西**。
 *   改成 2:3 的海報方塊。
 *
 * ★ 刻意用固定的偽亂數而不是 `Math.random`，免得每次 render 長不一樣
 *   （這頁雖然沒有 SSR，「示意圖會閃」一樣是缺陷）。
 *
 * ★ 示意圖用固定 6 欄、12 格（不吃 `WALL_GRID`），因為它要的是**兩列就收掉**：
 *   吃 `WALL_GRID` 的話 375px 下 3 欄 12 格會變成 4 列 650px 高的「提示」。
 *   它示意的是形狀（一格一張海報、排成格線），不是逐格對齊的版面稿。
 */
const demoCells = Array.from({ length: 12 }, (_, i) => {
  // 線性的 (i * k) % n 會在格線上排成明顯的斜紋，看起來像壞掉的圖不像資料。
  // 這裡用 murmur 的收尾混合把相鄰的 i 打散。
  let h = Math.imul(i + 1, 0x9E3779B1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85EBCA6B)
  h ^= h >>> 13
  return (h >>> 0) % 1000 / 1000
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8">
    <!--
      ⚠️ **頁面的說明註解只能放在這個根 `<div>` 的裡面。**
         `<template>` 的直接子註解自己就是一個根節點 ⇒ 頁面變成 Fragment ⇒
         換頁淡入整個不生效，而 `typecheck`／`lint`／`test`／`build` 四個全綠、
         SSR 產物也乾淨，只有 dev 會印一行 `[NUXT_E4004]`（踩雷 4ee9277）。

      ⚠️ **`max-w-4xl` 的「值」沒換，但「理由」2026-09-20 換過了，兩件事要分開讀。**
         · 舊理由：「整年出席圖 53 欄 × 14px = 742px，3xl 放不下」。
           出席圖那一天隨七條 band 一起搬走了 ⇒ **這個理由確實已經失效**。
         · 現在的理由：**必須跟 `/u/[username]` 一樣**。那一頁的海報牆是**同一支
           元件**（`PosterWall.vue`），而它檔頭那張「每個斷點每張海報多寬」的
           算式是以 `max-w-4xl` 的可用寬度算出來的——兩頁其中一頁改了寬度，
           那張表就對另一頁說謊。
           ⚠️ **不要寫成「跟站上其他頁對齊」**：站上根本沒有單一寬度
           （2026-09-20 實測：`max-w-xl` 到 `max-w-6xl` 都有，
             `/app/records` 就是 `max-w-6xl`）。同為 4xl 的是
             `/u/[username]`、`search.vue`、`app/films/new.vue`。
         ⇒ 「舊理由失效」**不等於**「可以放寬」。同一天真的試過放寬到 `max-w-6xl`
           （為了讓海報大一點），**David 否決：「我改變主意了 海報牆不要加寬」**，
           已整組回退。經過記在 `PosterWall.vue` 的 `WALL_GRID` 檔頭，
           要重提請先問他。
    -->
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        我的紀錄
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一場
      </UButton>
    </div>

    <!--
      §9.4：載入態是實體區塊不是轉圈，否則內容出現時整頁往下推（CLS）。

      ★ 骨架**走的是真牆同一支元件**（`loading` 開著、不給任何 slot）而不是在這裡
        再排一次格線。牆的欄數以後改在 `PosterWall.vue` 一個地方改就好——
        骨架與真牆的欄數對不起來會讓每次載入都跳一次版，而那種漂移沒有東西守得住。
    -->
    <div v-if="loading" class="mt-8 space-y-8">
      <USkeleton class="h-7 w-2/3 rounded-sm" />
      <PosterWall :records="[]" :total="0" loading />
    </div>

    <!--
      §9.3 全新帳號：一個明確的下一步動作，加一張淡化的示意圖說明
      「這裡會長出什麼」。David 有 174 筆永遠看不到這個狀態，
      但新使用者第一眼就是它。
      ⚠️ 示意圖與那句話 2026-09-20 從「出席圖」改成「海報牆」——
         這一頁已經沒有出席圖了，承諾它就是說謊。
    -->
    <section v-else-if="!totalRecords" class="mt-10">
      <p class="text-lg">
        還沒有東西可以看。
      </p>
      <p class="mt-1 text-muted">
        記下第一場，這裡就會開始長出來。
      </p>
      <UButton to="/app/records/new" size="lg" class="mt-6">
        記下你的第一場
      </UButton>

      <div class="mt-10 rounded-sm border border-default bg-default p-4">
        <p class="text-sm text-muted">
          記下幾場之後，這裡會長成一面你自己的海報牆：
        </p>
        <div class="mt-3 grid grid-cols-6 gap-2 opacity-30" aria-hidden="true">
          <span
            v-for="(c, i) in demoCells"
            :key="i"
            class="aspect-[2/3] rounded-[3px] bg-inverted"
            :style="{ opacity: 0.35 + c * 0.65 }"
          />
        </div>
      </div>
    </section>

    <div v-else class="mt-8 space-y-8">
      <div>
        <StatLine :segments="yearSegments" />
        <p v-if="spendNote" class="mt-1 text-sm text-muted">
          {{ spendNote }}
        </p>
      </div>

      <!--
        ── 海報牆 ──（David 2026-09-20）
        「所有看過的電影海報組成的牆面，依照觀看時間新->舊，
          重覆看的就是會有多張海報」。

        ★ 牆本體在 `app/components/PosterWall.vue`，`/u/[username]` 用的是同一支
          ——同一面牆在兩頁各留一份會漂移，而漂移之後沒有人會發現（`backend.md §6e`）。
        ★ `:total` 給的是 **RPC 算的權威總數**，跟 `:records`（useMyRecords 實際
          拿回幾筆，上限 500）是**兩條獨立的路**。元件靠這兩個數字對帳，
          牆被截斷時才說得出來。
        ★ 三段文字走 slot 而不是寫在元件裡：這一頁是**本人視角**（整頁私密、
          觀看者永遠是自己）所以講「你的紀錄」；`/u/` 是匿名視角的公開頁，
          每一句都要講「公開的紀錄」。**兩頁的措辭刻意不同，不要互抄。**
      -->
      <PosterWall :records="records" :total="totalRecords" :loading="recordsLoading">
        <template #caption>
          依觀看時間排列，新的在前。同一部片看過幾次，牆上就有幾張。
        </template>
        <template #empty>
          讀不到你的紀錄。重新整理看看。
        </template>
        <template #truncated="{ shown, total }">
          這面牆只放得下最近 {{ shown }} 筆，你總共有 {{ total }} 筆。
        </template>
      </PosterWall>

      <!--
        ── 每年花費 ──（David 2026-09-07 需求 6）
        ★ 2026-09-20 起這是這一頁**唯一**的 band：其餘七條與 `/u/` 一字不差，
          那正是 David 說的「相似度太高」。這一條留下來是因為它在 `/u/` 上
          依觀看者而異、路人常常看不到，只有本人的儀表板永遠看得到全部。
        ★ **恆為全期**（`by_year` 只在 `p_year = null` 有值）。年份視角已經移除，
          所以不再需要「這一條不隨上方的年份切換」那句但書。
        ★ **不需要 `<ClientOnly>`**：`/app` 在 `nuxt.config` 是 `ssr: false`，整頁本來
          就是 client-only。`/u/` 那邊包 ClientOnly 是因為那頁是 SSR、金額不能進
          `__NUXT_DATA__`——不要照抄過來（無害但會讓下一棒以為 `/app` 有 SSR 外洩風險）。
        ★ 不加 `#table`：這條 band 的數字本來就是 HTML 文字，螢幕閱讀器讀得到；
          `ChartBand` 的 `#table` 是給 canvas（ECharts）補的。
        ★ `:privacy-note="false"`：「只有你看得到這些數字。」是為 `/u/` 寫的，
          `/app` 整頁私密，那句在這裡沒有回答任何問題。
        ⚠️ `tests/stats.test.ts` 有一條斷言要求 `v-if="hasSpend"` 就寫在
          `<ChartBand` 與 `title="每年花費"` 之間——不要把閘門搬到外層的 wrapper。
      -->
      <ChartBand v-if="hasSpend" title="每年花費" :insight="spendInsight">
        <SpendByYear
          :by-year="spendRows"
          :currency="spendCurrency"
          is-own
          :privacy-note="false"
        />
      </ChartBand>
    </div>

    <!--
      2026-09-07 David 裁決：這裡原本有一列重複的操作入口與帳號指示，整塊移除。
      那三個入口與使用者名稱都在右上的帳號選單裡（`app/components/AppNav.vue`）。

      頁尾的顯名段與法遵連結不在這裡，是 layout 的 `AttributionFooter`（掛在
      `app/layouts/default.vue`）。那是授權生效要件（DS §9：顯名未盡視為自始
      未取得授權），跟這次移除的東西無關，也不要挪到這一頁來。

      ⚠️ 不要把「這個位置是空的」讀成「這個位置不能放東西」——BUILD_PLAN §6.1①
      的一次性條款同意（寫入 `legal_acceptance`）到現在都還沒有實作，它的落點
      就是這一頁。
    -->
  </div>
</template>
