<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * `/u/[username]` 公開個人頁（`SCREENS §2`，SSR、`private, no-store`）。
 *
 * ── 為什麼這一頁要有圖表 ──────────────────────────────────────────────────
 * 這一頁本來只有年表、列表、花費摘要，**一張圖都沒有**，而 `/app` 有七條 band。
 * 分享是這個產品唯一的擴散機制，落差最大的就是這裡（`charts.md §5-2`）。
 *
 * ── ★ 三條這一頁特有的規矩 ────────────────────────────────────────────────
 * 1. **絕不可加 `isr` / `swr`**（踩雷 #1）。票價因觀看者而異，同一個路徑
 *    render 出不同 HTML ⇒ 作者先造訪就把含票價的 HTML 寫進 CDN。
 * 2. **圖表的資料一律走 `/api/u/{username}/stats`（匿名視角），
 *    不在前端拿紀錄列表就地算。** 列表是分頁的（一次最多 200 筆），就地算會讓
 *    超過 200 筆的人年表缺格子而且沒有任何提示。而且那支端點與列表同一條
 *    匿名路徑 ⇒ **圖與列表永遠是同一個母體**。
 * 3. **走 SSR 那條路的東西完全不碰金額。** 那支端點逐欄挑白名單，金額欄位
 *    一個都不回（匿名視角下它們一律是 0，而 0 會被讀成「這個人沒花錢」）。
 *
 *    金額**只**存在於 client 端的 `useUserSpend()`（`server: false`，帶觀看者
 *    自己的 session ⇒ RLS 依觀看者決定），有兩個呈現、**共用同一次請求**：
 *    頁首的 `UserSpendSummary`（「花了 NT$…」）與 band 堆疊最後的
 *    `SpendByYear`（「每年花費」，David 2026-09-06 裁決要做）。
 *
 *    ⚠️ 三種觀看者都必須是對的：本人看得到全部、`show_cost = true` 的路人
 *    看得到公開紀錄的票價、其他人**一列都拿不到 ⇒ 那兩塊整個不存在**
 *    （`SCREENS §12-3`：不是畫成 0、不是打馬賽克、不留佔位）。
 *    `spend_is_partial` 逐年標在數字上（「NT$3,120 以上」）＋長條的虛線開口。
 *
 * ── ★ 檢視視角與 `/app` 一致 ──────────────────────────────────────────────
 * 預設全部年度，年表兼任切換器（David 2026-09-06 裁決）。**兩頁必須一致**：
 * 同一個名字的圖在兩頁有兩種語意會讓使用者以為資料錯了（`backend.md §6e`）。
 */
const route = useRoute()
const username = computed(() => String(route.params.username))

const { data, error } = await useFetch(() => `/api/u/${username.value}`, {
  key: () => `u-${username.value}`,
})

if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusMessage ?? '載入失敗',
    fatal: true,
  })
}

const profile = computed(() => data.value?.profile)
const items = computed(() => data.value?.items ?? [])

const config = useRuntimeConfig()
const displayName = computed(() => profile.value?.displayName || profile.value?.username || '')

/* ────────────────────────── 檢視視角與統計 ────────────────────────── */

/** `null` = 全部年度（預設）。 */
const selectedYear = ref<number | null>(null)

/** 全期那一份。年表、平均線的基準、以及全期視角下的每一張圖都吃它。 */
const { data: allStats } = await useFetch(() => `/api/u/${username.value}/stats`, {
  key: () => `u-stats-${username.value}`,
})

/**
 * 指定年份那一份。全期時直接回 null 而**不發請求**——全期用的就是 `allStats`，
 * 再打一次是同一個查詢跑兩遍。
 */
const { data: yearStats } = await useAsyncData(
  () => `u-stats-${username.value}-${selectedYear.value ?? 'all'}`,
  async () => {
    if (selectedYear.value === null)
      return null
    return await $fetch(`/api/u/${username.value}/stats`, { query: { year: selectedYear.value } })
  },
  { server: false, watch: [selectedYear, username] },
)

/** 目前檢視視角的統計。全期時就是 `allStats` 本身，不是另一份。 */
const stats = computed(() => (selectedYear.value === null ? allStats.value : yearStats.value))

/** 圖說裡指稱目前檢視範圍的那個詞。全期時不能寫成「null 年」。 */
const scopeLabel = computed(() => (selectedYear.value === null ? '全部年度' : `${selectedYear.value} 年`))

useSeoMeta({
  title: () => `${displayName.value} 的觀影紀錄`,
  description: () => profile.value?.bio
    || `${displayName.value} 在影記記錄了 ${allStats.value?.totals?.records ?? 0} 次觀影。`,
  ogType: 'profile',
  ogTitle: () => `${displayName.value} 的觀影紀錄`,
  ogUrl: () => `${config.public.siteUrl}/u/${username.value}`,
})

const { formatLabel } = useScreeningFormats()

/**
 * `公開了 174 場、133 部作品，去過 14 個場所`（§4.4，不做成 stat tile）。
 *
 * 三個數字都取自**同一份 stats**，所以切換年份時會一起變、而且必然自洽。
 * 「公開了」這個動詞是刻意的：這一頁呈現的是匿名視角看得到的那一份。
 */
const countSegments = computed<StatSegment[]>(() => {
  const t = stats.value?.totals
  if (!t)
    return []
  const head: StatSegment = selectedYear.value === null
    ? { prefix: '公開了', value: String(t.records), suffix: '場、' }
    : { prefix: `${selectedYear.value} 年公開了`, value: String(t.records), suffix: '場、' }
  return [
    head,
    { value: String(t.films), suffix: '部作品，去過' },
    { value: String(stats.value?.venues?.length ?? 0), suffix: '個場所' },
  ]
})

/* ────────────────────────── 紀錄列表 ────────────────────────── */

/**
 * 174 筆全部平鋪會產生一個 17,000px 的頁面——功能對，但沒有人能用。
 * 依年份分組並漸進式載入：先給最近的一批，其餘按需展開。
 */
const PAGE = 24
const shown = ref(PAGE)
watch([username, selectedYear], () => {
  shown.value = PAGE
})

/**
 * ★ 抽屜要列出「那一格對應的每一筆」，而端點一次最多回 200 筆。
 *
 * 圖上那一格說 9 場、抽屜只列得出 7 張卡，是這一頁最容易發生又最難發現的
 * 不一致（母體 174 的 David 永遠碰不到，第 201 筆之後才會出現）。
 * 所以第一次點圖表時把剩下的頁補齊再開抽屜，**不是**讓抽屜只列已載入的那些。
 */
const extraRecords = ref<typeof items.value>([])
const loadedAll = ref(false)
const loadingAll = ref(false)

watch(username, () => {
  extraRecords.value = []
  loadedAll.value = false
})

async function ensureAllRecords() {
  if (loadedAll.value || loadingAll.value)
    return
  loadingAll.value = true
  try {
    const total = data.value?.page?.total ?? items.value.length
    const acc = [...items.value]
    // 迴圈而不是一次要 total 筆：端點的 MAX_LIMIT 是 200，要多也只會拿到 200。
    while (acc.length < total) {
      const res = await $fetch(`/api/u/${username.value}`, {
        query: { limit: 200, offset: acc.length },
      })
      if (!res.items?.length)
        break // 拿不到就停，不要無限迴圈
      acc.push(...res.items)
    }
    // ⚠️ **一定要在每一條路徑上都寫回 `extraRecords`，包括「本來就載完了」那條。**
    //    第一版在 `items.length >= total` 時直接 `loadedAll = true; return`，
    //    沒有填 `extraRecords` ⇒ `allRecords` 立刻變成空陣列 ⇒ 點一下圖表之後
    //    抽屜是空的、**下面整份紀錄列表也一起消失**。
    //    實測抓到的樣子：同一格 `/app` 列出 9 張、`/u/` 列出 0 張，
    //    而抽屜還理直氣壯地寫「這個時段沒有公開的紀錄」。零錯誤訊息。
    extraRecords.value = acc
    loadedAll.value = true
  }
  finally {
    loadingAll.value = false
  }
}

/**
 * 目前手上的全部紀錄。
 * `loadedAll` 之前用的是 `extraRecords` 是否有內容以外的旗標，現在兩者一定同時成立；
 * 保險起見這裡仍然對空陣列退回 `items`——寧可少列幾筆，也不要整份列表消失。
 */
const allRecords = computed(() =>
  (loadedAll.value && extraRecords.value.length ? extraRecords.value : items.value))

/**
 * API 的形狀 → `TicketCard` 的形狀。
 *
 * `cost` 恆為 null：公開頁**完全不給金額**（見 `/api/u/[username]` 檔頭——
 * 聚合是推論通道，不是安全邊界）。金額由 `UserSpendSummary` 帶著觀看者
 * 自己的 session 在 client 端另外取。
 */
const cards = computed(() => allRecords.value.map(r => ({
  id: r.id ?? '',
  year: String(r.watchedOn ?? '').slice(0, 4) || '未知',
  watchedOn: r.watchedOn,
  watchedTime: r.watchedTime,
  venueName: r.venue?.name ?? null,
  hallLabel: r.hallLabel,
  formatLabel: formatLabel(r.formatCode),
  ticketCount: r.ticketCount,
  cost: null,
  memo: r.memo,
  film: {
    slug: r.film?.slug ?? null,
    titleZh: r.film?.title_zh ?? null,
    titleOriginal: r.film?.title_original ?? null,
    tmdbPosterPath: r.film?.tmdb_poster_path ?? null,
  },
})))

const filtered = computed(() =>
  selectedYear.value === null
    ? cards.value
    : cards.value.filter(c => c.year === String(selectedYear.value)))

const visible = computed(() => filtered.value.slice(0, shown.value))
const hasMore = computed(() => filtered.value.length > shown.value)
/** 依年份分組，讓長列表有可掃描的錨點。 */
const grouped = computed(() => groupByYear(visible.value))

/* ────────────────────────── 圖表 ────────────────────────── */

/**
 * 年表（`SCREENS §2.1`）。**公開頁一定要有它**——OG 分享圖的個人頁版面就是
 * 以年表為英雄，分享圖上有、點進來卻沒有是不一致的。
 *
 * ⚠️ 資料取自 `stats.daily`（全量聚合），**不是** `items`（分頁的列表）。
 *    這裡本來是拿 `items` 就地算的，超過 200 筆的使用者年表會缺格子
 *    而且沒有任何提示（`charts.md` 硬約束四）。
 */
const stripRows = computed(() => yearStripRows(
  allStats.value?.daily ?? [],
  allStats.value?.availableYears ?? [],
))

/**
 * 金額（David 2026-09-06 裁決：`/u/` 要做金額相關的圖表）。
 *
 * ⚠️ **與頁首那句「花了 NT$…」共用同一個 `useUserSpend()`**——同一個 key ⇒
 *    同一次請求、同一份答案。兩份查詢一定會在某次修改後對「看不看得到」
 *    「是不是全部」給出不同答案，而沒有人會把同一頁的兩個地方擺在一起看。
 *
 * ⚠️ 這份資料**只在 client 端存在**（`server: false`）：票價因觀看者而異，
 *    任何在伺服器端算出來的金額都會被序列化進 `__NUXT_DATA__` 一起送出。
 *    所以下面那條 band 一定要包在 `<ClientOnly>` 裡。
 */
const { spend } = useUserSpend(computed(() => profile.value?.username ?? null))

/** §9.3 的中間態：資料太少時不畫圖，兩三個點的圖比沒有圖更糟。 */
const CHART_THRESHOLD = 10
const showCharts = computed(() => (allStats.value?.totals?.records ?? 0) >= CHART_THRESHOLD)

const grid = computed(() =>
  hourGrid(stats.value?.weekdayHour ?? [], stats.value?.totals?.recordsWithoutTime ?? 0))

const hourInsight = computed(() => hourInsightText(stats.value?.weekdayHour ?? [], scopeLabel.value))
const hourNote = computed(() => {
  const n = stats.value?.totals?.recordsWithoutTime ?? 0
  return n > 0 ? `${n} 筆沒有記時間，沒有進這張圖。` : null
})

/**
 * ⚠️ 圖說的組法在 `utils/stats.ts`，**`/app` 用的是同一支**。
 * 兩頁各留一份一定會漂移，而漂移之後沒有人會發現。
 */
const venueInsight = computed(() => venueInsightText(
  (stats.value?.venues ?? []).map(v => ({ venue_id: null, name: v.name, city: null, kind: null, records: v.records })),
  stats.value?.totals?.records ?? 0,
  scopeLabel.value,
))

const venueItems = computed(() =>
  topWithRest(
    (stats.value?.venues ?? []).map(v => ({ name: v.name ?? '（場所不明）', records: v.records })),
    5,
    n => `其他 ${n} 家`,
  ))
const formatItems = computed(() =>
  topWithRest((stats.value?.formats ?? []).map(f => ({ name: f.label, records: f.records })), 5, n => `其他 ${n} 種`))
const countryItems = computed(() =>
  topWithRest(
    (stats.value?.countries ?? []).map(c => ({ name: c.country || '未分類', records: c.records })),
    5,
    n => `其他 ${n} 國`,
  ))

/**
 * 月度趨勢的基準線。**一律取自 RPC 的 `monthly_baseline`，前端不自己算**
 * ——分母是曝光數不是年份數，見 `stats.ts` 的 `monthlyBaselineSeries()`。
 * 全期時不畫（那時它只是實線除以一個常數，會貼著底趴平）。
 */
const monthlyBaseline = computed(() => monthlyBaselineSeries(allStats.value?.monthlyBaseline))
const showAverage = computed(() => selectedYear.value !== null && monthlyBaseline.value !== null)

const averageLegendLabel = computed(() => {
  const years = allStats.value?.availableYears ?? []
  if (!years.length)
    return '歷年每月平均'
  return `${Math.min(...years)}–${Math.max(...years)} 每月平均`
})

/* ──────────────── 點格子 → 底部片單（§9.2，與 `/app` 同一個語彙）──────────────── */

type Picked
  = | { kind: 'day', date: string }
    | { kind: 'slot', weekday: number, rowLabel: string }

const picked = ref<Picked | null>(null)
const drawerOpen = computed({
  get: () => picked.value !== null,
  set: (v: boolean) => {
    if (!v)
      picked.value = null
  },
})

/** 點下去先把紀錄補齊再開抽屜——否則圖上說 9 場、抽屜只列得出 7 張。 */
async function pick(p: Picked) {
  await ensureAllRecords()
  picked.value = p
}

const drawerTitle = computed(() => {
  const p = picked.value
  if (!p)
    return ''
  return p.kind === 'day' ? dayTitle(p.date) : slotTitle(p.weekday, p.rowLabel)
})

const drawerRecords = computed(() => {
  const p = picked.value
  if (!p)
    return []
  if (p.kind === 'day')
    return cards.value.filter(r => r.watchedOn === p.date)
  // 抽屜的過濾必須跟熱點圖的 scope 一致，否則點一格說 8 場、抽屜列出 24 張。
  // `watchedOn` 在 API 的型別上可以是 null；`isoDow('')` 回 null ⇒ 那一筆自然
  // 不會等於任何 weekday，跟它本來就進不了熱點圖是一致的。
  return cards.value.filter(r =>
    isoDow(r.watchedOn ?? '') === p.weekday
    && inHourRow(r.watchedTime, p.rowLabel)
    && (selectedYear.value === null || r.year === String(selectedYear.value)))
})
</script>

<template>
  <div v-if="profile" class="mx-auto max-w-4xl px-4 py-10">
    <header class="flex items-center gap-4">
      <UAvatar :src="profile.avatarUrl ?? undefined" :alt="displayName" size="xl" />
      <div class="min-w-0">
        <h1 class="text-2xl font-bold tracking-tight">
          {{ displayName }}
        </h1>
        <p class="text-muted">
          @{{ profile.username }}
        </p>
      </div>
    </header>

    <p v-if="profile.bio" class="mt-4 leading-relaxed">
      {{ profile.bio }}
    </p>

    <!--
      §4.4：數字不做成 stat tile。「大數字 + 小標籤 + 一排補充數據」是儀表板的
      預設長相，也正是 §0 要避開的東西。排成一行有量詞的句子。
    -->
    <StatLine v-if="stats" class="mt-8" :segments="countSegments" />

    <!--
      票價一律在 client 端補：SSR 以匿名視角 render，作者本人的票價（以及
      show_cost 開啟後的公開票價）由瀏覽器帶著自己的 session 去取。
      這樣 SSR 產出的 HTML 與 __NUXT_DATA__ 裡永遠不會有金額。
    -->
    <ClientOnly>
      <UserSpendSummary :username="profile.username" />
      <template #fallback>
        <!-- 只佔位不畫框：畫一個框再換成沒有框的內容會像「載入完就壞掉」 -->
        <div class="mt-6 h-14" />
      </template>
    </ClientOnly>

    <div class="mt-8 space-y-4">
      <!-- ── 年表。全站簽名，同時是檢視視角選擇器。 ── -->
      <ChartBand v-if="stripRows.length" title="年表">
        <YearStrip :rows="stripRows" :selected="selectedYear" @update:selected="selectedYear = $event" />
      </ChartBand>

      <template v-if="showCharts">
        <!--
          ⚠️ 三張 ECharts 一律包 `<ClientOnly>`，而且 `#fallback` 要給**固定高度**
             的實體骨架（踩雷 #60／#61）：這一頁是 SSR，canvas 在 Node 裡畫不出來；
             而 default slot 會從 server build 被 tree-shake，沒有骨架的話圖表出現時
             會把整頁往下推（CLS）。
        -->

        <!-- ── 年度出席圖：全期下整條不出現（7×53 綁死在一個日曆年上）── -->
        <ChartBand v-if="selectedYear !== null" title="出席">
          <ClientOnly>
            <AttendanceCalendar
              :year="selectedYear"
              :daily="stats?.daily ?? []"
              @pick="pick({ kind: 'day', date: $event })"
            />
            <template #fallback>
              <USkeleton class="h-[196px] w-full rounded-sm" />
            </template>
          </ClientOnly>
        </ChartBand>

        <!-- ── 時段熱點圖 ── -->
        <ChartBand title="時段" :insight="hourInsight" :note="hourNote">
          <ClientOnly>
            <HourHeatmap :grid="grid" @pick="pick({ kind: 'slot', ...$event })" />
            <template #fallback>
              <USkeleton class="h-[392px] max-w-[420px] rounded-sm" />
            </template>
          </ClientOnly>
        </ChartBand>

        <!-- ── 月度趨勢 ── -->
        <ChartBand
          title="每個月"
          :insight="selectedYear === null
            ? '每個月份跨年度的加總——看得出哪幾個月是旺季。'
            : null"
        >
          <ClientOnly>
            <MonthlyTrend
              :monthly="(stats?.monthly ?? []).map(m => ({ ...m, spend: 0, spend_is_partial: false }))"
              :average="showAverage ? monthlyBaseline : null"
              :year="selectedYear"
            />
            <template #fallback>
              <USkeleton class="h-[240px] w-full rounded-sm" />
            </template>
          </ClientOnly>
          <!-- 圖例自己用 HTML 畫：canvas 的圖例拿不到鍵盤與螢幕閱讀器 -->
          <p class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span class="inline-flex items-center gap-1.5">
              <ChartLegendSwatch kind="ink" />
              {{ selectedYear === null ? '全部年度加總' : `${selectedYear} 年` }}
            </span>
            <span v-if="showAverage" class="inline-flex items-center gap-1.5">
              <ChartLegendSwatch kind="baseline" />
              {{ averageLegendLabel }}
            </span>
          </p>
        </ChartBand>

        <!-- ── 影城分布。台灣在地的差異化資訊，分享頁上最值得看的一條。 ── -->
        <ChartBand title="去了哪裡" :insight="venueInsight">
          <DistributionBars :items="venueItems" unit=" 場" />
        </ChartBand>

        <!-- ── 版本與國別 ── -->
        <ChartBand title="看的是什麼">
          <div class="grid gap-8 sm:grid-cols-2">
            <div>
              <h3 class="mb-3 text-sm font-medium text-muted">
                版本
              </h3>
              <DistributionBars :items="formatItems" unit=" 場" />
            </div>
            <div>
              <h3 class="mb-3 text-sm font-medium text-muted">
                國別
              </h3>
              <DistributionBars :items="countryItems" unit=" 場" />
            </div>
          </div>
        </ChartBand>

        <!-- ── 多刷排行。語意隨檢視視角而變，所以圖說要講清楚範圍。 ── -->
        <ChartBand
          v-if="(stats?.repeats?.length ?? 0) > 0"
          title="看了不只一次"
          :insight="selectedYear === null
            ? '這些年來看過兩次以上的作品。'
            : `${selectedYear} 年內看過兩次以上的作品。`"
        >
          <RepeatList :items="stats?.repeats ?? []" />
        </ChartBand>
      </template>

      <!--
        ── 每年花費 ──（David 2026-09-06 裁決）
        ★ 這條 band **對三種觀看者長得不一樣，而三種都必須是對的**：
          本人看得到全部；`show_cost = true` 的路人看得到公開紀錄的票價；
          其他人**一列都拿不到 ⇒ 整條 band 不存在**（`SCREENS §12-3`：
          不是畫成 0、不是打馬賽克——否則 `總花費 ÷ 場次` 就能反推個別票價）。
          判斷不在這裡做，由 RLS 做（`useUserSpend()` 的 `canSeeMoney`
          數的是讀得到幾列票價）。

        ★ **放在 band 堆疊的最後，而且刻意不給 `#fallback` 佔位。**
          它是 client-only 而且可能根本不出現：給固定高度的骨架的話，
          「拿不到金額」的觀看者會看到一塊先撐開再塌掉的空白——那不但是
          版面跳動，還等於公告「這裡本來有東西」。排在最後 ⇒ 它晚出現時
          只會往下推紀錄列表（那時還在視窗外），不會推到正在讀的東西。
      -->
      <ClientOnly>
        <ChartBand
          v-if="spend?.canSeeMoney"
          title="每年花費"
          :insight="spend.isOwn
            ? '你自己記下的票價。只有你看得到這一段。'
            : null"
        >
          <SpendByYear :by-year="spend.byYear" :currency="spend.currency" :is-own="spend.isOwn" />
        </ChartBand>
      </ClientOnly>
    </div>

    <section class="mt-10">
      <h2 class="text-lg font-semibold">
        觀影紀錄<span v-if="selectedYear" class="ms-2 text-sm font-normal text-muted">{{ selectedYear }} 年</span>
      </h2>
      <p v-if="!items.length" class="mt-2 text-muted">
        還沒有公開的觀影紀錄。
      </p>
      <template v-else>
        <div v-for="g in grouped" :key="g.year" class="mt-6">
          <h3 class="text-sm font-semibold text-muted tabular-nums">
            {{ g.year }} 年
          </h3>
          <ul class="mt-2 space-y-2">
            <li v-for="r in g.rows" :key="r.id">
              <TicketCard :record="r" />
            </li>
          </ul>
        </div>

        <div v-if="hasMore" class="mt-6 flex justify-center">
          <UButton variant="soft" color="neutral" @click="shown += PAGE">
            再顯示 {{ Math.min(PAGE, filtered.length - shown) }} 筆（共 {{ filtered.length }} 筆）
          </UButton>
        </div>
      </template>
    </section>

    <!--
      點圖表的一格 → 底部抽屜列出那一格的票根卡（§9.2，與 `/app` 同一個語彙）。
    -->
    <UDrawer v-model:open="drawerOpen" direction="bottom" :title="drawerTitle">
      <template #body>
        <div class="mx-auto max-w-3xl">
          <p v-if="!drawerRecords.length" class="py-6 text-center text-muted">
            這個時段沒有公開的紀錄。
          </p>
          <!--
            ★ `show-year` 是必要的：抽屜的內容跨年份聚合，而標題不一定帶年——
            出席圖點一格是「2024/03/15（週五）」有年，時段圖點一格是
            「週三 14:00」，那一格的紀錄可能散在 2014–2026。
            日期帶預設不顯示年份（依年份分組的列表由上下文提供），抽屜打破了那個前提。
          -->
          <ul v-else class="space-y-2 pb-4">
            <li v-for="r in drawerRecords" :key="r.id">
              <TicketCard :record="r" show-year />
            </li>
          </ul>
        </div>
      </template>
    </UDrawer>
  </div>
</template>
