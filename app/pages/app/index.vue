<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * `/app` — 登入後的第一個畫面（`SCREENS.md §9`），`ssr: false` 且需登入。
 * 2026-09-20 改成海報牆：原本八條 band 有七條與 `/u/[username]` 一字不差，全部移除，
 * 只留「每年花費」。⚠️ 移除的是**使用**不是元件——那七支 `/u/` 還用著，刪檔會弄壞那頁。
 */

useSeoMeta({ title: '我的紀錄' })

const username = useMyUsername()

/**
 * 全期統計（`p_year = null`）。⚠️ **不要改名成 `stats`**：`tests/stats.test.ts` 有一條斷言
 * 擋「裸的 `stats.value?.by_year`」——RPC 在 `p_year` 非 null 時 `by_year` 是 `[]`，
 * 寫成那樣「每年花費」會無聲消失。改名會當場命中那條正則。
 */
const ALL_TIME = ref<number | null>(null)
const { stats: allStats, status: allStatus } = useYearStats(username, ALL_TIME)

const totals = computed(() => allStats.value?.totals ?? null)

/**
 * 一格 = 一筆 `viewing_record`（不是一部片），重看的片自然多張海報，不要 dedupe。
 * 排序已在 `useMyRecords()`（watched_on／watched_time desc）⚠️ **沒有 `id` 破平手**，
 * 不要宣稱穩定。⚠️ 它是 `.limit(500)` 且爆掉時靜默少資料 ⇒ 交給 `PosterWall` 對帳。
 */
const { records, status: recordsStatus } = useMyRecords()

/**
 * ⚠️ `username === null` 要算載入中：`useYearStats` 的 handler 第一行 `if (!username) return null`
 * 同步回來 ⇒ status 立刻 `success` ⇒ 空狀態會先對 174 筆的人閃一次（#169）；`idle` 守不到。
 * ⚠️ 代價：username 永遠回不來的帳號骨架不停。真正的解是 `useMyUsername()` 也吐 status。
 */
const loading = computed(() =>
  username.value === null || allStatus.value === 'pending' || allStatus.value === 'idle')

/** ⚠️ `idle` 也要算：`server: false` 在掛載到發請求之間有一段 idle，那時畫成空的是說謊。 */
const recordsLoading = computed(() => recordsStatus.value === 'pending' || recordsStatus.value === 'idle')

/** RPC 算的權威總數，不受 `useMyRecords` 的 500 上限影響。空狀態閘門與截斷對帳都吃它。 */
const totalRecords = computed(() => allStats.value?.totals?.records ?? 0)

/** 恆為全期，所以第一段固定「總共」——它必須說得出自己涵蓋什麼範圍（§4.4）。 */
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

/* 截斷判準在 `PosterWall.vue`（兩頁共用）。⚠️ 不要在這裡寫死 500——判準是兩條路對帳。 */

/**
 * ⚠️ 不要改用 `useUserSpend()`：那支是為 `/u/` 的 SSR ＋觀看者差異造的，搬來只會多發一次
 * 同樣的 RPC，並製造同一頁兩個金額來源（頁首那句與這條 band 遲早不一致）。
 */
const spendRows = computed(() =>
  (allStats.value?.by_year ?? [])
    // ⚠️ `spend` 在 DB 是 `numeric(12,2)`；JSON 送成 `'0.00'` 時 `SpendByYear` 的
    //    `width()` 用 `spend === 0` 比較，會讓「免費」那一列長出一小段條。
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
 * 判準是「讀得到幾列票價」不是「總額大於零」（`SCREENS §2.0b`）——後者會把全是
 * 兌換票（NT$0）誤判成沒東西可看。⚠️ `showCharts`（<10 筆）2026-09-20 拿掉了，
 * **這道閘門留著**：它守票價不守筆數，不要一起收。
 */
const hasSpend = computed(() => (allStats.value?.totals?.spend_known_records ?? 0) > 0)

/** ⚠️ 這句的字面與 `/u/` 的 `spendInsight` 共用，要改兩邊一起改。 */
const spendInsight = '你自己記下的票價，逐年合計。'

/**
 * 空狀態的示意圖：示意的是**牆**不是出席圖（出席圖已搬走，承諾它就是說謊）。
 * 固定偽亂數不用 `Math.random`，免得每次 render 長不一樣。
 * 固定 6 欄 12 格、不吃 `WALL_GRID`：吃了的話 375px 會變成 4 列 650px 高的「提示」。
 */
const demoCells = Array.from({ length: 12 }, (_, i) => {
  // 線性的 (i*k)%n 會排成斜紋像壞掉的圖；用 murmur 的收尾混合把相鄰的 i 打散。
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
      ⚠️ 頁面註解只能放在根 `<div>` 裡面：`<template>` 的直接子註解自己就是一個根節點
         ⇒ 頁面變 Fragment ⇒ 換頁淡入失效，而四關全綠、只有 dev 印 `[NUXT_E4004]`（4ee9277）。
      ⚠️ `max-w-4xl` 必須與 `/u/[username]` 一致——`PosterWall` 的幾何表以它算的（見該檔）。
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
      骨架走真牆同一支元件，欄數才不會漂移（漂移會讓每次載入都跳版）。
    -->
    <div v-if="loading" class="mt-8 space-y-8">
      <USkeleton class="h-7 w-2/3 rounded-sm" />
      <PosterWall :records="[]" :total="0" loading />
    </div>

    <!--
      §9.3 全新帳號：一個明確的下一步 ＋ 一張示意圖說明「這裡會長出什麼」。
      ⚠️ 示意的是海報牆不是出席圖——這一頁已經沒有出席圖了。
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
        牆本體在 `PosterWall.vue`，`/u/[username]` 同一支（各留一份會漂移，`backend.md §6e`）。
        `:total` 是 RPC 權威總數、`:records` 上限 500，兩條獨立的路讓元件對帳出「被截斷」。
        ⚠️ 措辭走 slot（本人視角 vs `/u/` 匿名視角，不要互抄）；格子不可點（2026-09-20 決定）。
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
        2026-09-20 起這是唯一的 band（其餘七條與 `/u/` 一字不差），恆為全期。
        `:privacy-note="false"` 與不包 `<ClientOnly>` 都因為整頁私密且 `ssr: false`。
        ⚠️ `v-if="hasSpend"` 必須就寫在 `<ChartBand` 與 title 之間，`tests/stats.test.ts` 在守。
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
      頁尾顯名與法遵連結在 layout 的 `AttributionFooter`（授權生效要件，DS §9），不要挪來這頁。
      ⚠️ 這裡是空的不代表不能放東西——`BUILD_PLAN §6.1①` 的條款同意還沒實作，落點就是這頁。
    -->
  </div>
</template>
