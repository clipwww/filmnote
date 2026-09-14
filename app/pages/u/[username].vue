<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'
// `DistKind` 是**型別**，Nuxt 的 auto-import 只帶值不帶型別 ⇒ 一定要明寫。
// 用它而不是在這裡再抄一次 `'venue' | 'format' | 'country'`：那三個字串同時是
// `matchesDistPick()` 的 kind，抄一份就多一個會跟 `utils/stats.ts` 漂移的地方。
import type { DistKind } from '~/utils/stats'
// 顯式匯入：新加的 app/utils 檔，不依賴 auto-import 的探索時機（踩雷 #173）。
import { hourHeatmapHeight } from '~/utils/hour-heatmap-option'

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

/**
 * 飛行中的那一次補齊。**不是 `ref`**：沒有任何畫面依賴它，它只是讓第二個
 * 呼叫者接到同一個 promise 的把手。
 *
 * ⚠️ **這裡曾經是 `if (loadedAll || loadingAll) return`——「進行中就早退」是個 bug。**
 *   2026-09-14 把入口從 2 個（熱點圖、多刷）擴到 15 個（12 個月份標籤 ＋ 三條
 *   分布長條的每一列）之後，這條時序競態變得很容易踩到：
 *   點第一列 → 開始抓、畫面完全沒有回饋、抽屜還沒開；在那個空窗裡點第二列 →
 *   `ensureAllRecords()` **立刻回傳** ⇒ `picked = B` 拿只有第一頁的 `allRecords`
 *   算內容 ⇒ 抽屜標題說 B 有 N 場、底下卻列不滿 N 張（踩雷 #169 的那種說謊抽屜）；
 *   等資料到了內容自己補上，接著第一次那個 `await` 才跑完、抽屜**無聲換成 A**。
 *   ⇒ 所有呼叫端必須 await **同一個** promise，不可以早退。
 *   typecheck／lint／test 都看不到這件事（是時序，不是型別）。
 */
let inflight: Promise<void> | null = null

watch(username, () => {
  extraRecords.value = []
  loadedAll.value = false
})

async function ensureAllRecords() {
  if (loadedAll.value)
    return
  if (!inflight) {
    inflight = (async () => {
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
    })().finally(() => {
      // 失敗時也要清掉，否則這一頁**永遠**補不齊了（下一次點擊會接到同一個
      // 已 reject 的 promise）。清掉之後下一次點擊就是一次乾淨的重試。
      inflight = null
    })
  }
  await inflight
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
  // ★ 多刷排行的抽屜要靠它把排行的一列對回紀錄（band 7 以 `film_id` 分組）。
  //   `film.id` 確實在 payload 裡：端點的 select 是
  //   `film_public.select('id,slug,…')`，`filmById` 用 `{ ...f, ugc_poster_url }` 展開。
  //   `?? null` 是保險——匿名讀得到的紀錄依 `record_read` policy 必然讀得到 film，
  //   null 只會讓它比不中而不是爆掉。
  filmId: r.film?.id ?? null,
  year: String(r.watchedOn ?? '').slice(0, 4) || '未知',
  watchedOn: r.watchedOn,
  watchedTime: r.watchedTime,
  venueName: r.venue?.name ?? null,
  /*
   * ★ 下面三欄是**三條分布長條的抽屜**唯一的過濾依據——`matchesDistPick()` 收的
   *   就是 `{ venueId, formatCode, country }` 這個扁平形狀（不是 `film` 物件裡的）。
   *
   * ⚠️ **漏掉任何一欄都不會 typecheck 紅。** `cards` 是沒有型別標註的 inline
   *   literal，而 `matchesDistPick()` 那三個欄位在型別上全是可選的 ⇒ 漏一欄的
   *   症狀是「長條點得下去、標題寫著 120 場、抽屜一張都列不出來」，
   *   lint／typecheck／test 全綠、console 零錯誤（踩雷 #169 同一族）。
   *
   * ⚠️ `formatLabel`（上一行）是**給人看的**（「數位」「IMAX」），
   *   `formatCode` 是**識別**（`digital`／`imax`／`other`）。兩個都要：
   *   RPC 的版本分布是 `group by coalesce(r.format_code,'other')`，用 label 比對
   *   只要哪天改了一個字就整條對不上。
   *
   * ⚠️ `venueId` 取自 `r.venue?.id`（端點回的是整個 venue 物件）而不是原始的
   *   `venue_id`——這一頁的 payload 沒有後者。長條那側是 RPC 的
   *   `group by r.venue_id`（原始值），這一側要先查得到 `venue` 那一列。
   *   ★ **在今天的 schema 下這兩者不可能分歧**（2026-09-14 查證，不要重新猜）：
   *     `viewing_record.venue_id` 是 `not null references public.venue on delete restrict`
   *     （`0001_init.sql:466`）⇒ 場所刪不掉、也不會是 null；`venue_read` 是
   *     `using (true)`（`0001_init.sql:806`）⇒ 匿名讀得到的紀錄，它的場所一定查得到。
   *     所以這裡**不需要**改端點去多回一個 `venue_id`。
   *   ⇒ 哪天 venue 改成可軟刪、開始跟著 `merged_into_venue_id` 轉址、或 `venue_read`
   *     被收緊，這一條就會變成「長條 12 場、抽屜 9 張」——那時候才回頭看這裡。
   */
  venueId: r.venue?.id ?? null,
  formatCode: r.formatCode ?? null,
  country: r.film?.country ?? null,
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

/**
 * 「每年花費」那條 band 的圖說。
 *
 * ★ **這條 band 恆為全期，不跟著上方的年份切換。** `useUserSpend()` 打的是
 *   `user_year_stats(username, null)`，而 RPC 的 `by_year` 只有 `p_year is null`
 *   時才有內容 ⇒ 選了 2019 之後這條仍然是十三年的清單，而頁面上其他 band
 *   全都變成 2019。
 *
 * ⚠️ 這件事以前**完全沒有寫在畫面上**：本人視角只有一句「只有你看得到這一段。」，
 *   路人視角是 `null`。`SCREENS §9` 第 3 條要求每一句圖說都說得出自己涵蓋什麼
 *   範圍——同一張圖跟旁邊的圖範圍不同而畫面上沒有任何記號，最容易被讀成
 *   「資料錯了」。所以選了年份時兩種觀看者都要看到那一句。
 *   `/app` 的 band 8 共用**最後那一句的字面**（前半段那邊不必分本人／路人，
 *   因為觀看者永遠是本人）。要改那句話的時候兩邊一起改。
 */
const spendInsight = computed(() => {
  const scope = selectedYear.value === null ? '' : '這一條不隨上方的年份切換。'
  if (spend.value?.isOwn)
    return `你自己記下的票價。只有你看得到這一段。${scope}`
  return scope ? `公開紀錄的票價，逐年合計。${scope}` : null
})

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

/**
 * 三條分布長條的資料。
 *
 * ★ **每一件都要填 `key`**（2026-09-14，David 第 4／5 點：每一列都要點得開抽屜）。
 *   `key` 是**識別**不是顯示文字，三條的識別空間各不相同，規則寫在
 *   `utils/stats.ts` 的 `matchesDistPick()`——這裡的三行必須跟那支逐條對稱：
 *   · 影城 `venue_id ?? ''`：`?? ''` 對上 `(r.venueId ?? '') === key`。
 *   · 版本 `f.code`：RPC 已經 `coalesce(r.format_code,'other')`，所以畫面上那個
 *     「其他」的 code 就是 `'other'`——**它是一個真分類**，不是 `topWithRest()`
 *     聚出來的長尾（實測 David 有 5 筆走這條）。
 *   · 國別 `c.country`：**空字串**就是畫面上的「未分類」（`coalesce(f.country,'')`）。
 *     顯示文字用 `||` 換成「未分類」，`key` 一定要留原始的空字串——拿四個中文字
 *     去比對會對上零筆。
 *
 * ⚠️ 顯示文字（`name`）與識別（`key`）**不可以合併成一欄**。三條長條的 `name`
 *   都不保證唯一（同名分館）、都可能被改字，而 `key` 是要拿去跟紀錄比對的。
 */
const venueItems = computed(() =>
  topWithRest(
    (stats.value?.venues ?? []).map(v => ({ key: v.venue_id ?? '', name: v.name ?? '（場所不明）', records: v.records })),
    5,
    n => `其他 ${n} 家`,
  ))
const formatItems = computed(() =>
  topWithRest(
    (stats.value?.formats ?? []).map(f => ({ key: f.code, name: f.label, records: f.records })),
    5,
    n => `其他 ${n} 種`,
  ))
const countryItems = computed(() =>
  topWithRest(
    (stats.value?.countries ?? []).map(c => ({ key: c.country, name: c.country || '未分類', records: c.records })),
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
    // 熱點圖格盤外側的兩條總和軌道（`HourHeatmap` 的第二組軸標籤）。
    | { kind: 'weekday', weekday: number }
    | { kind: 'hour', rowLabel: string }
    // band 7 多刷排行的一列。`records` 是**排行上那個數字**，帶進標題是刻意的
    // ——跟抽屜實際列出幾張擺在一起才看得出不一致（踩雷 #169）。
    | { kind: 'film', filmId: string, titleZh: string | null, records: number }
    // 月度趨勢的一個月（1..12）。`records` 是**圖上那個點的數字**，同上。
    // ⚠️ 這個 kind 的語意隨檢視視角而變：全期是「跨年度的同一個月」，
    //    指定年份是「那一年的那個月」。過濾與標題都要照著分（見下方）。
    | { kind: 'month', month: number, records: number }
    // 三條分布長條的一列（去了哪裡／版本／國別）。`kind` 直接就是
    // `matchesDistPick()` 的 `DistKind`，不另外翻譯一層。
    // `key` 是穩定識別、`name` 是畫面上那行字，兩者刻意分開（見 `venueItems`）。
    // `records` 同樣是**長條上那個數字**（踩雷 #169）。
    | { kind: DistKind, key: string, name: string, records: number }

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

/**
 * 分布長條的一列 → 抽屜（2026-09-14，David 第 4／5 點）。
 *
 * ⚠️ `key` 為 null 的只有 `topWithRest()` 造出來的聚合列（「其他 N 家」），而那一列
 *   在 `DistributionBars` 裡是展開／收合鈕、**不會 emit pick**。這裡仍然擋一次：
 *   型別上 `key` 是 `string | null`，真的漏一個進來的話
 *   `matchesDistPick(r, kind, '')` 會去列「沒有場所」那一桶的紀錄，而標題寫著
 *   「其他 10 家」那一列的加總——那是一個會說謊的抽屜，寧可什麼都不做。
 *   ★ 判斷一定是 `=== null` 不是 falsy：**空字串是正當的 key**
 *     （國別的「未分類」、影城的「（場所不明）」都是 `''`）。
 *
 * ★ 走 `pick()` 不是 `picked = …`：`pick()` 會先 `await ensureAllRecords()`
 *   補齊 200 筆以外的紀錄（踩雷 #169）。這是 `/u/` 跟 `/app` 唯一的行為差異，
 *   理由是這一頁的紀錄列表是分頁的（`/app` 的 `useMyRecords()` 是**一次取回**，
 *   上限 500，見 `useMyRecords.ts:51` 的既有 ⚠️——不是「全部」，只是沒有第二頁
 *   可以補，所以那一頁沒有這個 await）。
 */
function pickDist(kind: DistKind, e: { key: string | null, name: string, records: number }) {
  if (e.key === null)
    return
  return pick({ kind, key: e.key, name: e.name, records: e.records })
}

/**
 * 月度趨勢的一個月 → 抽屜（2026-09-14，David 第 5 點）。
 *
 * ★ `records` 取自 **`stats.monthly`（圖的資料來源）**，不是抽屜過濾完的長度：
 *   用同一個來源就永遠看不出不一致（踩雷 #169，同 `repeatTitle()`／`distPickTitle()`）。
 *   找不到就是 0——還沒到來的月份 RPC 不回那一列，而 `MonthlyTrend` 的軸標籤
 *   照樣點得到（那是刻意的，見該檔註解）。`monthTitle()` 會把「0 場」印在標題上，
 *   所以開出來是一個**說得出自己為什麼是空的**抽屜，不是沉默的空白。
 */
function pickMonth(month: number) {
  const n = (stats.value?.monthly ?? []).find(m => m.month === month)?.records ?? 0
  return pick({ kind: 'month', month, records: n })
}

const drawerTitle = computed(() => {
  const p = picked.value
  if (!p)
    return ''
  if (p.kind === 'day')
    return dayTitle(p.date)
  if (p.kind === 'weekday')
    return weekdayTitle(p.weekday)
  if (p.kind === 'hour')
    return hourRowTitle(p.rowLabel)
  // 多刷：標題帶次數與（指定年份時的）年份，與 `/app` 用的是同一支。
  if (p.kind === 'film')
    return repeatTitle(p.titleZh, selectedYear.value, p.records)
  // ⚠️ 標題的組字一律在 `utils/stats.ts`，**不寫成這裡的字串樣板**（`SCREENS §9.2`）：
  //   vitest 摸不到 SFC，寫在這裡的話全形空白、「N 場」、以及全期刻意不寫
  //   「全部年度」那條規矩就一條都沒有東西守。`monthTitle()` 自己處理
  //   全期／指定年份兩種形狀，所以這裡把 `selectedYear` 原樣交出去就好。
  if (p.kind === 'month')
    return monthTitle(p.month, selectedYear.value, p.records)
  if (p.kind === 'slot')
    return slotTitle(p.weekday, p.rowLabel)
  // 三條分布長條共用同一個標題形狀（`distPickTitle()`：名稱後面接場次，
  // 分隔字元刻意不在註解裡貼，見那支函式）——它們在畫面上是同一種東西。
  if (p.kind === 'venue' || p.kind === 'format' || p.kind === 'country')
    return distPickTitle(p.name, p.records)
  /*
   * ⚠️ **九種 kind 全部明寫，所以這一行到不了——但兩件事都不可以「順手簡化」：**
   *   ① 不可以把分布那一支改回 fallthrough（拿掉它的 `if`）。那樣第十種 kind
   *      忘了接的時候會**靜靜地掉進分布**，帶著一個根本不存在的 `p.key` 去組標題
   *      與過濾。現在的行為是標題空白、抽屜列不出東西——看得見，而且不說謊。
   *   ② 也不可以把 `slot` 改回 fallthrough。`Picked` 裡分布那一個成員的 kind 是
   *      `DistKind`（三個字面的**聯集**）而不是單一字面，TypeScript 的
   *      discriminant narrowing **減不掉這種成員** ⇒ 落到後面的 `p` 會是
   *      「slot ∪ 分布」而 `p.weekday` 當場紅掉（實測 `nuxt typecheck`：
   *      `Property 'weekday' does not exist on type '… | { kind: DistKind; … }'`）。
   *      這一行本身不碰 `p` 的任何欄位，所以它照樣通得過。
   *   `drawerRecords` 末尾是逐字相同的處理，兩處要一起看。
   */
  return ''
})

/**
 * 抽屜空了的時候那句話。**九種 kind 讀起來各不相同，不能共用「這個時段」**
 * ——它對一個場所、一個月份、一種版本、一個國別都是錯的。
 *
 * ⚠️ 這一頁是**匿名視角的公開頁**，所以每一句都是「沒有**公開的**紀錄」：
 *   觀看者看到空抽屜時，真正的原因通常不是「這個人沒看過」而是
 *   「那些紀錄是私密的」。`/app` 是本人視角，那邊措辭刻意不同（沒有「公開的」
 *   三個字），兩頁**不要互抄**。
 */
const drawerEmptyText = computed(() => {
  switch (picked.value?.kind) {
    // day（出席圖點一天）維持原文案，不在這一項的範圍內
    case 'weekday': return '這一天沒有公開的紀錄。'
    case 'hour': return '這個時段沒有公開的紀錄。'
    // 「這個時段」對一部片是錯的。這一句在多刷上**幾乎不該出現**：
    // 排行說 N 次就該列得出 N 張，看到它就是有東西壞了。
    case 'film': return '沒有公開的紀錄可以列出。'
    // 以下四種是 2026-09-14 新增的。它們**會**正常出現（0 場的月份、還沒到來的
    // 月份都點得下去，見 `pickMonth()`），所以要寫成一句讀得通的話而不是錯誤訊息。
    case 'month': return '這個月沒有公開的紀錄。'
    case 'venue': return '這個場所沒有公開的紀錄。'
    case 'format': return '這個版本沒有公開的紀錄。'
    // 「這個國家」對「未分類」那一列是錯的（`country` 是空字串那一桶），
    // 所以用「國別」——跟長條上方那個標題同一個詞。
    case 'country': return '這個國別沒有公開的紀錄。'
    default: return '這個時段沒有公開的紀錄。'
  }
})

/**
 * 換年份就把抽屜關掉。
 *
 * `picked` 把「圖上那個數字」烤進了標題，而 `drawerRecords` 是隨 `selectedYear`
 * 重算的 computed——年份在抽屜開著時變動，會出現「標題 10 次、內容 1 張」。
 *
 * ⚠️ 2026-09-14：會烤數字進標題的 kind 從一種（`film`）變成**五種**
 *   （`film`／`month`／`venue`／`format`／`country`），所以這一條的價值變高了；
 *   同一天也多了**第二個切年份的入口**（`YearScopeBar`，teleport 進導覽列）。
 *   那個入口同樣到不了：導覽列是 `z-30`，`UDrawer` 的遮罩是 50 ⇒ 抽屜開著時
 *   它也在遮罩底下（跟年表一樣）。這條 watch 仍然是「理論上的洞」，
 *   但它一行就能根絕，不留。
 *   ★ 兩個入口寫的都是 `selectedYear = $event`，所以**兩個都走這一條 watch**，
 *     不需要各自再補一次關抽屜的邏輯。
 */
watch(selectedYear, () => {
  picked.value = null
})

const drawerRecords = computed(() => {
  const p = picked.value
  if (!p)
    return []
  /**
   * 目前的檢視視角。**每一種 scope 會變的 kind 都要套它**，否則點一格說 8 場、
   * 抽屜列出 24 張（圖吃的是 `stats`＝那一年，抽屜吃的是 `cards`＝全部年度）。
   * 全期時 `selectedYear` 是 null ⇒ 不加年份條件。
   *
   * ⚠️ 這一段 2026-09-14 從 `weekday` 分支前面**往上搬**，因為新加的
   *   `month` 與三條分布長條也要用它。搬動沒有改變任何既有分支的行為。
   */
  const inScope = (r: { year?: string }) =>
    selectedYear.value === null || r.year === String(selectedYear.value)
  if (p.kind === 'day')
    return cards.value.filter(r => r.watchedOn === p.date)
  /*
   * ★ 「每個月」在**全期視角下是跨年度的同一個月**（十三年的三月全算進來），
   *   那時 `inScope` 恆為真——這是對的，圖上那個點本身就是加總。
   *   指定年份時 `inScope` 才把它收斂成「那一年的三月」。
   * ⚠️ `inMonth()` **只管月份不管年份**（見 `utils/stats.ts`），所以年份一定要
   *   靠 `inScope` 另外加。少了它，切到 2019 年點三月會列出十三年份的三月。
   */
  if (p.kind === 'month')
    return cards.value.filter(r => inMonth(r.watchedOn, p.month) && inScope(r))
  // ★ 多刷：過濾的是 `cards` **不是 `filtered`、更不是 `visible`**。
  //   `visible = filtered.slice(0, shown)`（預設 24）——用它的話抽屜會被下方列表的
  //   分頁狀態悄悄截斷，而且是「使用者按過幾次『再顯示 24 筆』就多列幾張」。
  // ★ `selectedYear` 一定要傳進去：band 7 吃的 `stats` 就是這個 scope。
  if (p.kind === 'film')
    return cards.value.filter(r => inRepeatScope(r, p.filmId, selectedYear.value))
  // `watchedOn` 在 API 的型別上可以是 null；`isoDow('')` 回 null ⇒ 那一筆自然
  // 不會等於任何 weekday，跟它本來就進不了熱點圖是一致的。
  // （`inScope` 的定義 2026-09-14 搬到這個 computed 的開頭，見那裡的註解。）
  // ★ 星期總和的過濾述詞在 utils/stats.ts——它含一條「熱點圖的母體不含沒記時間的
  //   紀錄」的條件，真實資料上永遠測不出來（records_without_time = 0），
  //   寫成 inline computed 就沒有任何測試守得住。與 `/app` 用的是同一支。
  if (p.kind === 'weekday')
    return cards.value.filter(r => matchesWeekdayPick(r, p.weekday) && inScope(r))
  // 時段總和：`inHourRow(null, …) === false`，對沒記時間的紀錄天然免疫。
  if (p.kind === 'hour')
    return cards.value.filter(r => inHourRow(r.watchedTime, p.rowLabel) && inScope(r))
  // 格盤裡的一格。⚠️ 這一支 2026-09-14 從 fallthrough 改成明寫的 `if`：
  //   九種 kind 現在**全部**明寫，末尾那一行只負責接「忘了接的第十種」，
  //   理由見這個 computed 末尾那段。
  if (p.kind === 'slot') {
    return cards.value.filter(r =>
      isoDow(r.watchedOn ?? '') === p.weekday
      && inHourRow(r.watchedTime, p.rowLabel)
      && inScope(r))
  }
  /*
   * ★ 三條分布長條：述詞在 `utils/stats.ts` 的 `matchesDistPick()`，不寫在這裡。
   *   它含三條「照直覺寫會錯而且不會報錯」的 coalesce（format 的 null→'other'、
   *   country 的 null→''、venue 的 null→''），必須跟 RPC 的 group by 逐字一致，
   *   而寫成 inline computed 的話 vitest 摸不到（`SCREENS §9.2`）。
   * ★ `p.kind` 直接就是 `DistKind`，這也是 `Picked` 那一個成員不把三種 kind
   *   拆成三個的原因。
   */
  if (p.kind === 'venue' || p.kind === 'format' || p.kind === 'country')
    return cards.value.filter(r => matchesDistPick(r, p.kind, p.key) && inScope(r))
  // ⚠️ 到不了（九種 kind 已經窮盡）。留著、而且分布那一支**不可以**當 fallthrough，
  //   理由與 `drawerTitle` 末尾那段完全相同：忘了接第十種 kind 的代價要是
  //   「抽屜是空的」，不是「抽屜理直氣壯地列錯東西」（踩雷 #169 的精神）。
  return []
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <!--
      ★ 根節點**不能**是 `v-if`（2026-09-14，配合 `app.pageTransition` 的換頁淡入）。

      <Transition> 的 hooks 掛在這個元件 render 出來的**根 vnode** 上。原本的根是
      `<div v-if="profile" …>`，`profile` 為 falsy 時它 render 成**註解節點**——註解
      沒有樣式，fade 對它是 no-op ⇒ 那一次換頁直接硬切。

      ⚠️ 而且**不會有任何警告**：Vue 的 `isElementRoot()` 明文放行註解節點
         （註解＝「可能只是 v-if 分支切換」）。會噴 `renders non-element root node`
         的是 Fragment 根（多根 template，或根是 `<slot />`）。
         ⇒ 這個 bug 屬於「壞掉但 console 全綠」那一類，**不能用「看 console 有沒有噴」
         來驗收**，只能靠「根永遠是單一元素」這條規則。同一個修法見
         `app/pages/film/[slug].vue` 與 `app/components/LegalDocumentView.vue`。

      ⇒ 外層 `<div>` 永遠存在（class 一個字都沒動），`v-if` 移到內層的 `<template>`。
        用 `<template>` 而不是再包一層 `<div>`：它不產生任何 DOM 節點，
        所以這次改動的 DOM 與視覺差異是**零**。

      ⚠️ 副作用只有一個且無害：`profile` 為 falsy 時外層 div 會留下一個空的 `py-10`
        盒子（以前是什麼都不 render）。它沒有底色也沒有框，看不見；而且這條路徑
        到不了——上面的 `error` 分支是 `fatal: true`，直接進錯誤頁。

      ★★ **這段註解為什麼在 div 裡面而不是在它上面**（2026-09-14，David 實跑抓到）：
        `<template>` 的直接子註解**自己就是一個根節點**——加上下面那個 div 就是兩個，
        頁面變成 Fragment 根。第一版把這段寫在 div 上方，於是換頁時真的噴了
          [NUXT_E4004] … does not have a single root node and will cause errors
          when navigating between routes.
        而且淡入對 Fragment 根整個不生效——**修根節點的那次改動自己造出了同一個病**。
        ⇒ 註解只能放在根元素**裡面**。同一個病在 `app/pages/app/index.vue`、
          `app/pages/app/records/index.vue`（那兩處是既有的）、
          `app/pages/film/[slug].vue` 都已一併修掉。
        ⇒ 也順帶更正上面那條「不會有任何警告」——**只有 Vue 自己不講**。Nuxt 會講，
          但它查的是 **render 出來的東西**不是模板形狀：
          `route-provider.js` 在 `dev && client` 時看 `vnode.el.nodeName`，
          落在 `#comment` / `#text` 就報 E4004 ⇒ **多根與 falsy 的 v-if 根都會被抓到**。
          代價是它只在**瀏覽器裡真的換一次頁**時才出現：SSR、typecheck、lint、test、
          build 一個都看不到它。所以 `tests/page-root.test.ts` 用靜態解析補這一段。
    -->
    <template v-if="profile">
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
        <!--
          ── 年表。全站簽名，同時是檢視視角選擇器。 ──

          ⚠️ 這一層 `<div>` 是 2026-09-14 加的，**它有功能、不是排版裝飾**：
             `YearScopeBar` 會在原地留下一個 1px 的 sentinel（觀測點），而且它的
             `<ClientOnly>` 在掛載前還會多印一個空的 `<span>`（Nuxt 的 `ClientOnly`
             沒有 fallback slot 時印的就是 `fallbackTag` 的預設值）。而外面那個
             `space-y-4` 在 Tailwind 4.3 編譯出來的是
             `:where(& > :not(:last-child)) { margin-block-end: 16px }`——**每一個
             非最後的子節點各吃一份 16px**。兩個節點直接放進去，年表與下一條 band
             之間掛載前是 49px（16＋1＋16＋0＋16）、掛載後那個 `<span>` 被換成不佔位的
             Teleport 而變 33px ⇒ **hydration 當下還會跳 16px**。
             包一層之後 `space-y-4` 只看得到這個 wrapper，版面差異只剩那 1px。
             ⇒ 不要為了「少一層 div」把它拆掉。`/app/index.vue` 是同一個寫法，
               **那一頁一樣要包**：`ClientOnly` 的 `mounted` 一律從 `false` 起、
               `onMounted` 才翻真（`nuxt/dist/app/components/client-only.js`，
               沒有「非 hydration 就短路」那種分支）⇒ `ssr: false` 的 `/app`
               第一個 render pass 同樣會印出那個 `<span>`，只是它只活一個 pass。

          `v-if` 從 `ChartBand` 移到 wrapper 上：沒有年份可選時兩個都不該存在
          （`YearScopeBar` 自己也擋 `years.length`，這裡是同一件事的外層）。
        -->
        <div v-if="stripRows.length">
          <ChartBand title="年表">
            <YearStrip :rows="stripRows" :selected="selectedYear" @update:selected="selectedYear = $event" />
          </ChartBand>
          <!--
            ── 導覽列上的年份切換器（2026-09-14 David 第 2 點）──
            它自己 Teleport 到 `#header-year-scope`（`layouts/default.vue`），
            留在這裡的只有觀測用的 sentinel ⇒ **位置必須就是年表的正後方**：
            切換器要在「年表捲出畫面」的那一刻才出現，年表還看得到時不需要它。

            ★ 年份來源是 `stripRows`，**不是 `allStats.availableYears`**（刻意偏離）。
              `stripRows = yearStripRows(daily, availableYears)`，也就是
              availableYears **聯集**「daily 裡出現過但清單還沒更新的年份」
              （見 `utils/stats.ts` 那一行註解）。年表自己畫的就是 `stripRows`
              ——兩個切換器是同一件事的兩個入口，**提供的年份集合必須逐個相同**，
              否則會出現「年表上有 2026、導覽列的選單裡沒有」。
              順序也因此對齊（`yearStripRows()` 已經新到舊排好；
              `YearScopeBar` 內部仍會自己排一次，不互相假設）。

            ★ `@update:selected` 寫成跟年表**一模一樣的一行**：兩個入口共用
              `selectedYear`，也就共用了下面那條「換年份關抽屜」的 watch。
          -->
          <YearScopeBar
            :years="stripRows.map(r => r.year)"
            :selected="selectedYear"
            @update:selected="selectedYear = $event"
          />
        </div>

        <template v-if="showCharts">
          <!--
            ⚠️ 三張 ECharts 一律包 `<ClientOnly>`，而且 `#fallback` 要給**固定高度**
               的實體骨架（踩雷 #60／#61）：這一頁是 SSR，canvas 在 Node 裡畫不出來；
               而 default slot 會從 server build 被 tree-shake，沒有骨架的話圖表出現時
               會把整頁往下推（CLS）。
            ⚠️ **骨架要比的是整個元件的高度，不是 canvas 的高度。** 三支都是
               「圖 ＋ 底下一行圖例／提示」的結構，只對到 canvas 那一段就會差
               24px（2026-09-14 月度趨勢真的這樣壞過一次，見該處骨架的註解）。
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
              <!--
                ★ 一定要走 `pick()` 不是 `picked = $event`：`pick()` 會先
                `await ensureAllRecords()` 補資料（踩雷 #169）。少了它抽屜開起來是空的，
                而且下面整份列表會一起消失——typecheck / lint / test 全綠。
                kind 由 HourHeatmap 決定（格子／星期總和／時段總和），這裡不要再包一層。
              -->
              <HourHeatmap :grid="grid" @pick="pick($event)" />
              <template #fallback>
                <!--
                  骨架高度綁 `hourHeatmapHeight()`，跟圖表本身是同一支函式。
                  以前這裡是硬寫的 `h-[392px]`，跟 HourHeatmap 的高度公式沒有任何連結，
                  公式一改就靜靜 CLS 20px（沒有任何測試守得住一個 Tailwind 字面值）。

                  ⚠️ **`hourHeatmapHeight()` 只算 canvas，不含 `HourHeatmap` 自己那句
                     提示 `<p class="mt-2 text-xs">`**（2026-09-14 查證；那個 `<p>` 是
                     既有的，這個缺口在這一輪之前就在）。所以下面那一行 `&nbsp;`
                     **不是裝飾**——它把提示那一行的盒子照原樣鏡射一份
                     （`mt-2` 8px ＋ `text-xs` 行高 16px ＝ 24px），少了它 hydration
                     當下底下整批 band 會往下跳 24px。
                  ⚠️ 用 `&nbsp;` 而**不是**重抄那句提示文字：決定高度的是行高與字級，
                     文案改了這裡不必跟著改；抄一份文字反而會多一個會漂移的地方。
                -->
                <div>
                  <USkeleton class="max-w-[420px] rounded-sm" :style="{ height: hourHeatmapHeight(grid) }" />
                  <p class="mt-2 text-xs" aria-hidden="true">
                    &nbsp;
                  </p>
                </div>
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
              <!--
                ★ 一定要走 `pickMonth()` 不是 `picked = …`：它會先
                  `await ensureAllRecords()`（踩雷 #169），而且順便把「圖上那個月
                  幾場」查出來烤進標題。`MonthlyTrend` 只 emit 月份（1..12），
                  範圍（全期／某一年）由這一頁決定——它才知道 `selectedYear`。
              -->
              <MonthlyTrend
                :monthly="(stats?.monthly ?? []).map(m => ({ ...m, spend: 0, spend_is_partial: false }))"
                :average="showAverage ? monthlyBaseline : null"
                :year="selectedYear"
                @pick="pickMonth($event)"
              />
              <template #fallback>
                <!--
                  ⚠️ 骨架要涵蓋 `MonthlyTrend` 的**兩塊**：240px 的圖（該元件傳給
                     `BaseChart` 的 `height`）＋ 它自己那句「點月份或線上的點」提示
                     `<p class="mt-2 text-xs">`。那句提示是 2026-09-14 才加的，
                     骨架一度還停在 240px ⇒ 這一頁是 SSR，hydration 當下底下整批
                     band 會往下跳 24px（`mt-2` 8 ＋ `text-xs` 行高 16）。
                     下面的 `&nbsp;` 就是那一行的鏡射（同熱點圖，理由見上一條）。
                  ⚠️ 240 仍然是**抄來的字面值**——`MonthlyTrend` 沒有像熱點圖那樣的
                     共用高度函式，那支改高度這裡要一起改，而且不會有東西變紅。
                -->
                <div>
                  <USkeleton class="h-[240px] w-full rounded-sm" />
                  <p class="mt-2 text-xs" aria-hidden="true">
                    &nbsp;
                  </p>
                </div>
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

          <!--
            ── 影城分布。台灣在地的差異化資訊，分享頁上最值得看的一條。 ──
            ★ 每一列都點得開抽屜（2026-09-14 David 第 4／5 點）。`kind` 由呼叫端
              指定：同一個 `DistributionBars` 服務三條長條，它自己不知道
              自己畫的是場所、版本還是國別。
          -->
          <ChartBand title="去了哪裡" :insight="venueInsight">
            <DistributionBars :items="venueItems" unit=" 場" @pick="pickDist('venue', $event)" />
          </ChartBand>

          <!-- ── 版本與國別 ── -->
          <ChartBand title="看的是什麼">
            <div class="grid gap-8 sm:grid-cols-2">
              <div>
                <h3 class="mb-3 text-sm font-medium text-muted">
                  版本
                </h3>
                <DistributionBars :items="formatItems" unit=" 場" @pick="pickDist('format', $event)" />
              </div>
              <div>
                <h3 class="mb-3 text-sm font-medium text-muted">
                  國別
                </h3>
                <DistributionBars :items="countryItems" unit=" 場" @pick="pickDist('country', $event)" />
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
            <!--
              ★ **一定要走 `pick()` 不是 `picked = …`**：`pick()` 會先
                `await ensureAllRecords()` 把 200 筆以外的紀錄補齊（踩雷 #169）。
                直接指派在 David 的 174 筆上看起來完全正常，>200 筆的人抽屜會短於
                排行上的數字，typecheck／lint／test 全綠、console 零錯誤。
            -->
            <RepeatList
              :items="stats?.repeats ?? []"
              @pick="pick({ kind: 'film', ...$event })"
            />
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
            :insight="spendInsight"
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

        ⚠️ 2026-09-14 起「一格」不只是出席圖與熱點圖了：月度趨勢的每個月、
           以及三條分布長條的每一列（含展開出來的長尾）都走同一個抽屜。
           標題由 `drawerTitle` 分派到 `utils/stats.ts` 的各支組字函式，
           空狀態由 `drawerEmptyText` 分派——**九種 kind 各有各的說法**。
      -->
      <UDrawer v-model:open="drawerOpen" direction="bottom" :title="drawerTitle">
        <template #body>
          <div class="mx-auto max-w-3xl">
            <p v-if="!drawerRecords.length" class="py-6 text-center text-muted">
              {{ drawerEmptyText }}
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
    </template>
  </div>
</template>
