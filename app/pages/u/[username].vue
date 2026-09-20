<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'
// 型別要明寫（auto-import 只帶值）。用它而不是再抄一次三個字串字面——
// 那三個同時是 `matchesDistPick()` 的 kind，抄一份就多一處會漂移。
import type { DistKind } from '~/utils/stats'
// 顯式匯入：新加的 app/utils 檔，不依賴 auto-import 的探索時機（踩雷 #173）。
import { hourHeatmapHeight } from '~/utils/hour-heatmap-option'

/**
 * `/u/[username]` 公開個人頁（`SCREENS §2`，SSR、`private, no-store`）。
 * ⚠️ **絕不可加 `isr`／`swr`**（踩雷 #1）：票價因觀看者而異，作者先造訪就會把含票價的
 * HTML 寫進 CDN。金額只走 client 的 `useUserSpend()`，SSR 那條路一欄都不碰。
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

/** `null` = 全部年度（預設）；年表兼任切換器。 */
const selectedYear = ref<number | null>(null)

/**
 * 全期那一份（年表、平均線基準、全期視角的每一張圖都吃它）。
 * ⚠️ 圖表一律吃這支匿名視角的全量聚合，**不要拿分頁的 `items` 就地算**——
 * 超過 200 筆的人年表會缺格子而且沒有任何提示（`charts.md` 硬約束四）。
 */
const { data: allStats } = await useFetch(() => `/api/u/${username.value}/stats`, {
  key: () => `u-stats-${username.value}`,
})

/** 指定年份那一份。全期時回 null 不發請求——全期用的就是 `allStats`。 */
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
 * §4.4，不做成 stat tile。三個數字取自同一份 stats ⇒ 切年份時一起變、必然自洽。
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

/** 174 筆全部平鋪是 17,000px 的頁面，沒有人能用 ⇒ 依年份分組、漸進式載入。 */
/**
 * 兩種視角走 query string（2026-09-20）。⚠️ 開關必須是真的連結不是 ref 切換：
 * 這頁是 SSR，網址就是狀態 ⇒ 分享出去的連結要自帶視角。
 * ⚠️ 只有恰好 `'wall'` 才是牆——`?view=zzz`／空值／重複參數（會變陣列）都退回預設。
 */
const wallView = computed(() => route.query.view === 'wall')

/** 切到牆／切回圖表。`undefined` 會被 vue-router 從 query string 裡拿掉。 */
const toWall = computed(() => ({ query: { ...route.query, view: 'wall' } }))
const toCharts = computed(() => ({ query: { ...route.query, view: undefined } }))

const PAGE = 24
const shown = ref(PAGE)
watch([username, selectedYear], () => {
  shown.value = PAGE
})

/**
 * 端點一次最多 200 筆，但抽屜要列「那一格的每一筆」⇒ 第一次點圖表時先補齊。
 * 不補的話會「圖上說 9 場、抽屜列 7 張」，而 174 筆的 David 永遠碰不到（第 201 筆起才有）。
 */
const extraRecords = ref<typeof items.value>([])
const loadedAll = ref(false)

/**
 * 飛行中的那一次補齊。⚠️ **不可以寫成「進行中就早退」**：早退的呼叫者會拿只有第一頁的
 * `allRecords` 算內容 ⇒ 抽屜標題說 N 場、底下列不滿，然後無聲換成前一次的結果（#169）。
 * 所有呼叫端必須 await 同一個 promise。typecheck／lint／test 都看不到（是時序不是型別）。
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
      // ⚠️ 每一條路徑都要寫回 `extraRecords`，包括「本來就載完了」那條——漏掉的話
      //    `allRecords` 會變空陣列，抽屜與**下面整份列表一起消失**，且零錯誤訊息。
      extraRecords.value = acc
      loadedAll.value = true
    })().finally(() => {
      // 失敗也要清掉，否則下一次點擊會接到同一個已 reject 的 promise，永遠補不齊。
      inflight = null
    })
  }
  await inflight
}

/**
 * 牆視角進來時補齊 200 筆以外的紀錄。⚠️ 這段**對 174 筆的 David 不會執行**，
 * 弄壞了照樣全綠（#175）。⚠️ 用 `onMounted` 不是 `watch immediate`：後者會在
 * 伺服器上變成沒人 await 的 `$fetch`，也會踩到 #251 那條同 tick 的順序反轉。
 */
onMounted(() => {
  if (wallView.value)
    ensureAllRecords()
})
watch(wallView, (on) => {
  if (on)
    ensureAllRecords()
})

/** 目前手上的全部紀錄。對空陣列退回 `items`——寧可少列幾筆，也不要整份列表消失。 */
const allRecords = computed(() =>
  (loadedAll.value && extraRecords.value.length ? extraRecords.value : items.value))

/**
 * API 的形狀 → `TicketCard` 的形狀。`cost` 恆為 null：公開頁完全不給金額
 * （聚合是推論通道不是安全邊界，見 `/api/u/[username]` 檔頭），金額由 client 另外取。
 */
const cards = computed(() => allRecords.value.map(r => ({
  id: r.id ?? '',
  // 多刷抽屜靠它把排行的一列對回紀錄。`?? null` 是保險：比不中總比爆掉好。
  filmId: r.film?.id ?? null,
  year: String(r.watchedOn ?? '').slice(0, 4) || '未知',
  watchedOn: r.watchedOn,
  watchedTime: r.watchedTime,
  venueName: r.venue?.name ?? null,
  /*
   * ⚠️ 下面三欄是分布長條抽屜唯一的過濾依據，**漏一欄不會 typecheck 紅**（inline literal）：
   * 症狀是「長條說 120 場、抽屜列不出東西」，四關全綠、console 零錯誤（#169 同族）。
   * `formatCode` 是識別、`formatLabel` 給人看，兩個都要（RPC 以 code 分組）。
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
    /*
     * 2026-09-20 補：端點早就回 `ugc_poster_url`、`TicketCard` 也讀它，這裡沒接
     * ⇒ 只有 UGC 海報的片 `/app` 是海報、`/u/` 是文字卡（`backend.md §6e`）。
     * ⚠️ 修了但**驗不到**：實測 `ugc_poster_url` 非 null 的筆數是 0（#175 的形狀）。
     */
    ugcPosterUrl: r.film?.ugc_poster_url ?? null,
  },
})))

/**
 * 牆的權威總數（端點的 `page.total`），與 `cards` 是兩條獨立的路讓元件對帳出「被截斷」。
 * ⚠️ 盲點：端點取不到 summary 時 `total` 是 `null`，這裡退回 `cards.length` ⇒ 不宣稱截斷。
 * 方向對（不知道就別亂講），代價是「total 未知＋真的超過 200 筆」會靜默少畫。已回報。
 */
const wallTotal = computed(() => data.value?.page?.total ?? cards.value.length)

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
 * 年表（`SCREENS §2.1`）。公開頁一定要有——OG 分享圖就是以它為英雄，圖上有點進來沒有。
 * ⚠️ 取自 `stats.daily`（全量聚合）不是 `items`（分頁）：超過 200 筆會缺格子且無提示。
 */
const stripRows = computed(() => yearStripRows(
  allStats.value?.daily ?? [],
  allStats.value?.availableYears ?? [],
))

/**
 * ⚠️ 與頁首那句「花了 NT$…」共用同一個 `useUserSpend()`（同 key ⇒ 同一次請求、同一份答案）。
 * 兩份查詢遲早會對「看不看得到」給出不同答案，而沒有人會把同頁兩處擺在一起看。
 * ⚠️ 只在 client（`server: false`）：伺服器端算出的金額會進 `__NUXT_DATA__` ⇒ band 要包 ClientOnly。
 */
const { spend } = useUserSpend(computed(() => profile.value?.username ?? null))

/**
 * ⚠️ 這條 band 恆為全期（`by_year` 只在 `p_year is null` 有值），選了 2019 之後它仍是十三年
 * 而其他 band 都變 2019 ⇒ `SCREENS §9` 第 3 條要求畫面上說出來，否則會被讀成「資料錯了」。
 * ⚠️ 措辭與 `/app` 的 `spendInsight` 相關但**字面已不同**，要改請兩邊一起看過。
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
 * 圖說的組法在 `utils/stats.ts`，不要在這裡就地組字（vitest 摸不到 SFC）。
 * ⚠️ 2026-09-20 起 `/app` 已經沒有這些 band，所以「兩頁共用」那句話不再成立。
 */
const venueInsight = computed(() => venueInsightText(
  (stats.value?.venues ?? []).map(v => ({ venue_id: null, name: v.name, city: null, kind: null, records: v.records })),
  stats.value?.totals?.records ?? 0,
  scopeLabel.value,
))

/**
 * ⚠️ `key` 是**識別**不是顯示文字，要跟 `matchesDistPick()` 逐條對稱：影城 `venue_id ?? ''`；
 * 版本 `f.code`（RPC 已 coalesce 成 `'other'`，**那是真分類**，實測 5 筆）；
 * 國別**空字串**就是畫面上的「未分類」——拿四個中文字去比對會對上零筆。
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
    // `records` 是**排行上那個數字**，帶進標題才看得出跟抽屜列出幾張不一致（#169）。
    | { kind: 'film', filmId: string, titleZh: string | null, records: number }
    // ⚠️ 語意隨視角而變：全期是「跨年度的同一個月」、指定年份是「那一年的那個月」，
    //    過濾與標題都要照著分。
    | { kind: 'month', month: number, records: number }
    // `key` 是穩定識別、`name` 是畫面上那行字，刻意分開（見 `venueItems`）。
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
 * ⚠️ `key === null`（`topWithRest()` 的聚合列）要擋掉：漏進來的話
 * `matchesDistPick(r, kind, '')` 會去列「沒有場所」那一桶，而標題寫著「其他 10 家」的加總。
 * ★ 判斷用 `=== null` 不是 falsy——**空字串是正當的 key**（國別「未分類」、場所不明）。
 */
function pickDist(kind: DistKind, e: { key: string | null, name: string, records: number }) {
  if (e.key === null)
    return
  return pick({ kind, key: e.key, name: e.name, records: e.records })
}

/**
 * `records` 取自 `stats.monthly`（圖的來源）不是過濾完的長度——同一個來源就永遠看不出
 * 不一致（#169）。找不到就是 0，`monthTitle()` 會印「0 場」⇒ 抽屜說得出自己為什麼是空的。
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
  if (p.kind === 'film')
    return repeatTitle(p.titleZh, selectedYear.value, p.records)
  // ⚠️ 標題組字一律在 `utils/stats.ts`，不要寫成這裡的樣板（`SCREENS §9.2`）——
  //    vitest 摸不到 SFC，全形空白／「N 場」／全期不寫「全部年度」就沒東西守。
  if (p.kind === 'month')
    return monthTitle(p.month, selectedYear.value, p.records)
  if (p.kind === 'slot')
    return slotTitle(p.weekday, p.rowLabel)
  // 三條長條共用同一個標題形狀，它們在畫面上是同一種東西。
  if (p.kind === 'venue' || p.kind === 'format' || p.kind === 'country')
    return distPickTitle(p.name, p.records)
  /*
   * ⚠️ 到不了，但兩件事不可以「順手簡化」：① 分布那一支不可改回 fallthrough——第十種
   *    kind 忘了接會靜靜掉進去、帶著不存在的 `p.key` 組標題；② `slot` 也不可以——分布成員的
   *    kind 是 `DistKind`（聯集），discriminant narrowing 減不掉它，`p.weekday` 會紅。
   */
  return ''
})

/**
 * 九種 kind 讀起來各不相同，不能共用「這個時段」——它對場所／月份／版本／國別都是錯的。
 * ⚠️ 這一頁是匿名視角，每一句都要有「公開的」三個字（空抽屜的真正原因通常是紀錄私密）。
 * `/app` 是本人視角、措辭刻意不同，**兩頁不要互抄**。
 */
const drawerEmptyText = computed(() => {
  switch (picked.value?.kind) {
    // day（出席圖點一天）維持原文案，不在這一項的範圍內
    case 'weekday': return '這一天沒有公開的紀錄。'
    case 'hour': return '這個時段沒有公開的紀錄。'
    // 多刷上幾乎不該出現：排行說 N 次就該列得出 N 張，看到它就是壞了。
    case 'film': return '沒有公開的紀錄可以列出。'
    // 這四種**會**正常出現（0 場或還沒到來的月份都點得下去）⇒ 寫成讀得通的話不是錯誤訊息。
    case 'month': return '這個月沒有公開的紀錄。'
    case 'venue': return '這個場所沒有公開的紀錄。'
    case 'format': return '這個版本沒有公開的紀錄。'
    // 用「國別」不用「國家」：「未分類」那一列（空字串桶）不是一個國家。
    case 'country': return '這個國別沒有公開的紀錄。'
    default: return '這個時段沒有公開的紀錄。'
  }
})

/**
 * 換年份就關抽屜：`picked` 把「圖上那個數字」烤進標題，而 `drawerRecords` 隨
 * `selectedYear` 重算 ⇒ 抽屜開著時換年份會變成「標題 10 次、內容 1 張」。
 * 兩個切年份的入口都寫 `selectedYear = $event`，所以都走這一條，不必各自補。
 */
watch(selectedYear, () => {
  picked.value = null
})

const drawerRecords = computed(() => {
  const p = picked.value
  if (!p)
    return []
  /**
   * ⚠️ 每一種會隨 scope 變的 kind 都要套它，否則點一格說 8 場、抽屜列 24 張
   * （圖吃 `stats`＝那一年，抽屜吃 `cards`＝全部年度）。
   */
  const inScope = (r: { year?: string }) =>
    selectedYear.value === null || r.year === String(selectedYear.value)
  if (p.kind === 'day')
    return cards.value.filter(r => r.watchedOn === p.date)
  /*
   * 全期視角下「每個月」是跨年度的同一個月（`inScope` 恆真，圖上那個點本身就是加總）。
   * ⚠️ `inMonth()` 只管月份不管年份 ⇒ 年份一定要靠 `inScope` 另外加，
   *    少了它，切到 2019 年點三月會列出十三年份的三月。
   */
  if (p.kind === 'month')
    return cards.value.filter(r => inMonth(r.watchedOn, p.month) && inScope(r))
  // ⚠️ 過濾 `cards` 不是 `visible`（= `filtered.slice(0, shown)`）——用 `visible` 的話
  //    抽屜會被下方列表的分頁狀態悄悄截斷（按幾次「再顯示 24 筆」就多列幾張）。
  if (p.kind === 'film')
    return cards.value.filter(r => inRepeatScope(r, p.filmId, selectedYear.value))
  // ⚠️ 述詞在 `utils/stats.ts`：它含一條「熱點圖母體不含沒記時間的紀錄」的條件，
  //    真實資料永遠測不出來（records_without_time = 0），寫成 inline 就沒東西守得住。
  if (p.kind === 'weekday')
    return cards.value.filter(r => matchesWeekdayPick(r, p.weekday) && inScope(r))
  // 時段總和：`inHourRow(null, …) === false`，對沒記時間的紀錄天然免疫。
  if (p.kind === 'hour')
    return cards.value.filter(r => inHourRow(r.watchedTime, p.rowLabel) && inScope(r))
  // 九種 kind 全部明寫，末尾那一行只負責接「忘了接的第十種」（理由見末尾）。
  if (p.kind === 'slot') {
    return cards.value.filter(r =>
      isoDow(r.watchedOn ?? '') === p.weekday
      && inHourRow(r.watchedTime, p.rowLabel)
      && inScope(r))
  }
  /*
   * ⚠️ 述詞在 `utils/stats.ts` 的 `matchesDistPick()`，不要寫在這裡：它含三條
   * 「照直覺寫會錯而且不報錯」的 coalesce（format→'other'、country→''、venue→''），
   * 必須跟 RPC 的 group by 逐字一致，而寫成 inline 的話 vitest 摸不到（`SCREENS §9.2`）。
   */
  if (p.kind === 'venue' || p.kind === 'format' || p.kind === 'country')
    return cards.value.filter(r => matchesDistPick(r, p.kind, p.key) && inScope(r))
  // ⚠️ 到不了。分布那一支不可當 fallthrough——忘了接第十種的代價要是「抽屜是空的」，
  //    不是「抽屜理直氣壯地列錯東西」（#169）。同 `drawerTitle` 末尾。
  return []
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <!--
      ⚠️ 根必須是**單一元素**且不可帶 `v-if`：falsy 的 v-if 根會 render 成註解節點，
         換頁淡入對它是 no-op；而 `<template>` 的直接子註解**自己就是一個根節點**。
         四關全綠也看不到（只有瀏覽器真的換頁才報 E4004）⇒ `tests/page-root.test.ts` 靜態守。
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

      <!-- §4.4：不做成 stat tile（那是 §0 要避開的儀表板長相），排成一行有量詞的句子。 -->
      <!--
        ⚠️ 用 `UButton :to`（⇒ 真的 `<a>`）不是 `@click` 切 ref：網址就是狀態，
           而這頁是 SSR ⇒ 分享出去的連結要自帶視角。
           兩態各自說**按下去會看到什麼**，不說「目前在哪」（只有一個按鈕時後者讀起來是反的）。
      -->
      <div class="mt-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <StatLine v-if="stats" :segments="countSegments" />
        <UButton
          :to="wallView ? toCharts : toWall"
          variant="soft"
          color="neutral"
          size="sm"
          :icon="wallView ? 'i-lucide-bar-chart-3' : 'i-lucide-layout-grid'"
        >
          {{ wallView ? '看圖表與紀錄' : '看海報牆' }}
        </UButton>
      </div>

      <!--
        與 `/app` 同一支元件（各留一份會漂移，`backend.md §6e`）。吃 `cards` 不是 `filtered`——
        牆恆為全期。`:total` 與 `:records` 是兩條獨立的路讓元件對帳出「被截斷」。
        ⚠️ 不給 `:loading`（SSR 沒有載入中）；措辭走 slot，匿名視角要講「公開的」。
      -->
      <PosterWall
        v-if="wallView"
        class="mt-8"
        :records="cards"
        :total="wallTotal"
      >
        <template #caption>
          依觀看時間排列，新的在前。同一部片看過幾次，牆上就有幾張——只包含公開的紀錄。
        </template>
        <template #empty>
          還沒有公開的觀影紀錄。
        </template>
        <!-- slot 參數改名：這頁自己有 `shown`（列表分頁計數），同名會 shadow（`vue/no-template-shadow`）。 -->
        <template #truncated="{ shown: wallShown, total: wallTotalN }">
          這面牆只顯示了 {{ wallShown }} 筆，公開的紀錄共 {{ wallTotalN }} 筆。
        </template>
      </PosterWall>

      <template v-else>
        <!-- ⚠️ 票價只在 client 補：SSR 的 HTML 與 `__NUXT_DATA__` 裡永遠不能有金額。 -->
        <ClientOnly>
          <UserSpendSummary :username="profile.username" />
          <template #fallback>
            <!-- 只佔位不畫框：畫一個框再換成沒有框的內容會像「載入完就壞掉」 -->
            <div class="mt-6 h-14" />
          </template>
        </ClientOnly>

        <div class="mt-8 space-y-4">
          <!--
            ⚠️ 這一層 `<div>` **有功能不是裝飾**：`YearScopeBar` 留了 1px sentinel、它的
               `ClientOnly` 掛載前還多印一個空 `<span>`，而 `space-y-4` 是每個非最後子節點各
               吃 16px ⇒ 不包的話掛載前 49px、掛載後 33px（**hydration 當下跳 16px**）。不要拆。
          -->
          <div v-if="stripRows.length">
            <ChartBand title="年表">
              <YearStrip :rows="stripRows" :selected="selectedYear" @update:selected="selectedYear = $event" />
            </ChartBand>
            <!--
              Teleport 到 `#header-year-scope`，留在這裡的只有 sentinel ⇒ **位置必須就在年表正後方**。
              ⚠️ 年份來源是 `stripRows` 不是 `availableYears`（前者多了「daily 有但清單還沒更新」的
                 年份）——兩個入口的年份集合必須逐個相同，否則年表上有 2026、導覽列選單裡沒有。
            -->
            <YearScopeBar
              :years="stripRows.map(r => r.year)"
              :selected="selectedYear"
              @update:selected="selectedYear = $event"
            />
          </div>

          <template v-if="showCharts">
            <!--
              ⚠️ ECharts 一律包 `<ClientOnly>` ＋ `#fallback` 給固定高度骨架（#60／#61）：
                 SSR 下 canvas 在 Node 畫不出來，沒骨架會 CLS。骨架比的是**整個元件**的高度
                 不是 canvas——只對到 canvas 會差 24px（月度趨勢真的這樣壞過）。
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
                  ⚠️ 一定要走 `pick()`（它先 `await ensureAllRecords()`）：直接指派的話抽屜是空的、
                     下面整份列表一起消失，而四關全綠（#169）。kind 由 HourHeatmap 決定，不要再包一層。
                -->
                <HourHeatmap :grid="grid" @pick="pick($event)" />
                <template #fallback>
                  <!--
                    骨架高度綁 `hourHeatmapHeight()`（與圖表同一支）；硬寫字面值的話公式一改就靜靜 CLS。
                    ⚠️ 那支**只算 canvas 不含元件自己那句提示** ⇒ 下面的 `&nbsp;` 不是裝飾，
                       它鏡射那一行的 24px。用它不抄文字：抄文字多一個會漂移的地方。
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
                  ⚠️ 走 `pickMonth()`：它先 `await ensureAllRecords()`（#169），並把「圖上那個月幾場」
                     烤進標題。`MonthlyTrend` 只 emit 月份，範圍（全期／某一年）由這一頁決定。
                -->
                <MonthlyTrend
                  :monthly="(stats?.monthly ?? []).map(m => ({ ...m, spend: 0, spend_is_partial: false }))"
                  :average="showAverage ? monthlyBaseline : null"
                  :year="selectedYear"
                  @pick="pickMonth($event)"
                />
                <template #fallback>
                  <!--
                    ⚠️ 骨架要涵蓋兩塊：240px 的圖 ＋ 元件自己那句提示（`&nbsp;` 鏡射它的 24px）。
                       只對到 240 的話 hydration 當下底下整批 band 會往下跳 24px。
                    ⚠️ 240 是**抄來的字面值**——那支沒有共用高度函式，它改高度這裡要一起改，不會有東西變紅。
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
              影城分布：台灣在地的差異化資訊，分享頁上最值得看的一條。`kind` 由呼叫端指定——
              同一個 `DistributionBars` 服務三條長條，它自己不知道畫的是場所、版本還是國別。
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
                ⚠️ 一定要走 `pick()`（先 `await ensureAllRecords()`，#169）。直接指派在 174 筆上看起來
                   完全正常，>200 筆的人抽屜會短於排行上的數字，而四關全綠、console 零錯誤。
              -->
              <RepeatList
                :items="stats?.repeats ?? []"
                @pick="pick({ kind: 'film', ...$event })"
              />
            </ChartBand>
          </template>

          <!--
            ⚠️ 三種觀看者都必須對：本人看全部、`show_cost` 的路人看公開票價、其他人**一列都
               拿不到 ⇒ 整條不存在**（`SCREENS §12-3`：畫 0 或馬賽克都能用總額÷場次反推）。
            ⚠️ 排最後且刻意不給 `#fallback`：先撐開再塌掉的空白等於公告「這裡本來有東西」。
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
          點圖表的一格 → 底部抽屜列出那一格的票根卡（§9.2）。九種 kind 的標題由 `drawerTitle`
          分派到 `utils/stats.ts`，空狀態由 `drawerEmptyText` 分派。
        -->
        <UDrawer v-model:open="drawerOpen" direction="bottom" :title="drawerTitle">
          <template #body>
            <div class="mx-auto max-w-3xl">
              <p v-if="!drawerRecords.length" class="py-6 text-center text-muted">
                {{ drawerEmptyText }}
              </p>
              <!--
                `show-year` 是必要的：抽屜內容跨年份聚合而標題不一定帶年（時段圖點一格
                「週三 14:00」的紀錄可能散在 2014–2026）。
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
    </template>
  </div>
</template>
