<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * `/app` — 登入後看到的第一個畫面（`SCREENS.md §9`）。
 *
 * **統計是產品門面，不是設定頁裡的附屬圖表。** Letterboxd 把統計鎖在 Pro
 * 付費層，我們把它當核心免費價值——所以這一頁的門面就是統計本身。
 *
 * 版面是**垂直長卷，一個 band 一張圖，滿容器寬**，不是 2×2 的卡片牆。
 * band 的順序是規格的一部分（§9），不是隨意排列。
 *
 * ⚠️ **這一頁沒有紀錄列表**（§9）。紀錄透過 §9.2 的「點出席圖或熱點圖的一格
 * → 底部抽屜」出現；可編輯的列表在 `/app/records`（§10）。
 * 例外是資料太少的中間態，見下方 `showCharts`。
 *
 * 這頁在 `nuxt.config.ts` 是 `ssr: false` 且需登入，資料一律 client 端取。
 */

useSeoMeta({ title: '我的紀錄' })

const username = useMyUsername()

/**
 * ★ **檢視視角：全期是預設，可切換到指定年份**（David 2026-09-06 裁決）。
 *
 * `null` = 全部年度。這一行之前是
 * `selectedYear.value ?? available_years[0]`，也就是**起始就是最新年度、
 * 之後只能換成另一個具體年份**——加上 `YearStrip` 的 emit 型別是 `[year: number]`
 * （永遠 emit 不出 null），UI 上根本到不了全期視角。模板裡那些
 * `activeYear === null ? …` 的分支當時全部是跑不到的死分支，
 * 「程式看起來支援全期」是假象。兩邊都已經改掉。
 */
const activeYear = ref<number | null>(null)

/**
 * 兩份統計：
 *
 * - `allStats` —— **永遠是全期**（`p_year = null`）。年表、平均線的基準、
 *   以及全期視角下的每一張圖都吃它。
 * - `yearStats` —— 只有選了年份時才取。全期時 username 傳 null，composable 會
 *   直接回 null 而**不發請求**：不這樣做的話它的 `useAsyncData` key 會跟
 *   `allStats` 撞成同一個（兩邊的 year 都是 null ⇒ 都是 `…:all`），
 *   而 key 撞在一起的兩個 `useAsyncData` 共用同一份 state，watch 卻不同。
 */
const ALL_TIME = ref<number | null>(null)
const { stats: allStats, status: allStatus } = useYearStats(username, ALL_TIME)

const yearScopedUser = computed(() => (activeYear.value === null ? null : username.value))
const { stats: yearStats, status: yearStatus } = useYearStats(yearScopedUser, activeYear)

/** 目前檢視視角的統計。全期時就是 `allStats` 本身，不是另一份。 */
const stats = computed(() => (activeYear.value === null ? allStats.value : yearStats.value))
const status = computed(() => (activeYear.value === null ? allStatus.value : yearStatus.value))

/** 抽屜要列出票根卡，所以仍然需要原始紀錄——與 `/app/records` 共用同一份快取。 */
// `status:` 改名是必要的：這一頁的 `status` 已經被圖表那一支（`useYearStats`）用掉了。
// 抽屜要它是為了分辨「真的沒有紀錄」與「紀錄還在飛」——band 7 只要 `stats` 回來就
// 出現，而 `records` 是另一支平行的 client 端請求，先點下去會看到一句
// 「沒有可以列出的紀錄。」，正是踩雷 #169 說的「理直氣壯地說謊」。
const { records, status: recordsStatus } = useMyRecords()

const loading = computed(() => allStatus.value === 'pending' || status.value === 'pending')
const totals = computed(() => stats.value?.totals ?? null)

/**
 * 月度趨勢的基準線：歷年每月平均（視覺稿 band 4 的虛線）。
 *
 * ★ 一律取自 RPC 的 `monthly_baseline`，**前端不自己算**。那個欄位的分母是
 *   曝光數（該月份實際經歷過幾次），不是年份數——這裡本來自己除以
 *   `by_year.length`，12 個月裡有 5 個偏掉。見 `stats.ts` 的 `monthlyBaselineSeries()`。
 *
 * ⚠️ **全期視角下不畫這條線**（`showAverage`）。全期的實線是「十三年同月加總」
 *   （十月 24 場），虛線是同一組數字除以曝光數（2.00）——同一條 y 軸上虛線會
 *   貼著底趴平，而且它在全期**不再具有對照功能**：它就是實線本身除以一個常數。
 *   指定年份時它才回來，那才是它的用途（「整年 N 場，比歷年平均多／少」）。
 */
const monthlyBaseline = computed(() => monthlyBaselineSeries(allStats.value?.monthly_baseline))
const showAverage = computed(() => activeYear.value !== null && monthlyBaseline.value !== null)

const averageLegendLabel = computed(() => {
  const years = allStats.value?.by_year ?? []
  if (!years.length)
    return '歷年每月平均'
  const ys = years.map(y => y.year)
  return `${Math.min(...ys)}–${Math.max(...ys)} 每月平均`
})

/**
 * §9.3 的中間態：**圖表 band 在資料 ≥10 筆才出現。**
 * 不到門檻時只顯示年表與票根列表，並寫出「再記 N 場就會出現時段分析」——
 * 四張圖同時只有兩三個點，比沒有更糟。
 */
const CHART_THRESHOLD = 10

const totalRecords = computed(() => allStats.value?.totals?.records ?? 0)
const showCharts = computed(() => totalRecords.value >= CHART_THRESHOLD)

const stripRows = computed(() =>
  yearStripRows(allStats.value?.daily ?? [], allStats.value?.available_years ?? []))

/**
 * `2026 年看了 8 場、11 張票，花了 NT$2,980`（§4.4）。
 * 全期時第一段改成「總共看了」——它必須說得出自己涵蓋什麼範圍，
 * 否則同一句話在兩種視角下長得一樣而數字差十倍。
 */
const yearSegments = computed<StatSegment[]>(() => {
  const t = totals.value
  if (!t)
    return []
  const spend = t.spend > 0 ? costText(t.spend) : null
  const head: StatSegment = activeYear.value === null
    ? { value: '總共', suffix: '看了' }
    : { value: String(activeYear.value), suffix: '年看了' }
  return [
    head,
    { value: String(t.records), suffix: '場、' },
    { value: String(t.tickets), suffix: spend ? '張票，花了' : '張票' },
    ...(spend ? [{ value: spend }] : []),
  ]
})

/**
 * 時段熱點圖。**跟著檢視視角走**，跟其他 band 一樣。
 *
 * ★★ **2026-09-06：這裡原本有一個「永遠吃全部年度」的特例，是刻意拿掉的。**
 *
 * 舊註解引 `SCREENS §9c.2`：「星期 × 時段的習慣要全部看才有形狀」，所以把這張圖
 * 釘死在全部年度。那個理由在當時成立——因為當時的**預設是最新年度**，只吃 2026
 * 的 8 筆會讓 7×16 的格盤 96% 空白。
 *
 * 但 David 2026-09-06 裁決把**全期改成預設檢視視角**之後，那個理由由預設值本身
 * 滿足了，不需要再靠一條特例；而特例留著會產生一個更糟的症狀：使用者切到 2019 年
 * 時，全站就只剩這一張還在看十三年，畫面上沒有任何標記說明它跟別人不同
 * ——**那會讓人以為資料錯了**，而這正是 `backend.md §6e` 要避免的東西
 * （同一個名字的圖有兩種語意）。標題的「（全部年度）」括號也一併拿掉：
 * 全期變成預設之後那個括號不再區分任何東西。
 *
 * 單一年份樣本太小的風險改由 `INSIGHT_MIN`（20 筆）那條門檻守——它守的正是
 * 「不要從雜訊裡下『最』的斷言」，比用 scope 特例守第二次精準。
 *
 * ⚠️ **不要把這個特例加回來。** 要加回來的話，圖上必須同時出現一個看得見的
 *    標記說明它的範圍跟頁面其他部分不同，而且抽屜的過濾要跟著改（見 `drawerRecords`）。
 */
const grid = computed(() =>
  hourGrid(stats.value?.weekday_hour ?? [], stats.value?.totals?.records_without_time ?? 0))

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

/** 圖說裡指稱目前檢視範圍的那個詞。全期時不能寫成「null 年」。 */
const scopeLabel = computed(() => (activeYear.value === null ? '全部年度' : `${activeYear.value} 年`))

/**
 * ⚠️ 圖說的組法在 `utils/stats.ts`，**`/u/` 用的是同一支**。
 * 兩頁各留一份一定會漂移，而漂移之後沒有人會發現——沒有人會把兩頁的
 * 同一張圖擺在一起看。
 */
const venueInsight = computed(() =>
  venueInsightText(stats.value?.venues ?? [], totals.value?.records ?? 0, scopeLabel.value))

/** 熱點圖的圖說。組法與 `/u/` 共用（見 `venueInsight` 上方的註解）。 */
const hourInsight = computed(() =>
  hourInsightText(stats.value?.weekday_hour ?? [], scopeLabel.value))

const hourNote = computed(() => {
  const n = stats.value?.totals?.records_without_time ?? 0
  return n > 0 ? `${n} 筆沒有記時間，沒有進這張圖。` : null
})
const spendNote = computed(() => {
  const t = totals.value
  // ⚠️ 這一句以前寫「金額不是**全年**總額」。全期是預設視角、涵蓋十三年，
  //    「全年」在那裡是錯的（而且它同時要服務「2019 年」那個視角）。
  //    改成不帶範圍的說法，讓範圍由上一行 StatLine 自己說（「總共看了」／「2019 年看了」）。
  return t?.spend_is_partial
    ? `其中 ${t.spend_unknown_records} 筆沒有票價，金額不是全部的花費。`
    : null
})

/**
 * ── band 8：每年花費 ──（David 2026-09-07 需求 6／7）
 *
 * ★★ **資料走 `allStats.by_year`，不要引入 `useUserSpend()`。**
 *   那支是為 `/u/` 造的，解決的是「票價因觀看者而異、而且 `/u/` 是 SSR
 *   ⇒ 金額不能進 `__NUXT_DATA__`」。`/app` 兩個前提都不成立
 *  （`nuxt.config` 對 `/app/**` 是 `ssr: false`、觀看者永遠是本人）。
 *   搬過來只會多發一次一模一樣的 RPC，而且製造**同一頁上兩個金額來源**
 *   ——那正是 `useUserSpend()` 檔頭在防的東西：頁首那句「花了 NT$57,873」
 *   跟這條 band 一定會在某次修改後不一致，而沒有人會把同一頁的兩個地方擺在一起看。
 *
 * ⚠️ **一定要用 `allStats`，不是 `stats`。** RPC 在 `p_year` 不是 null 時
 *   `by_year` 是**空陣列**（`case when p_year is not null then '[]'::jsonb`）。
 *   寫成 `stats.value?.by_year` 的話，使用者一切到 2019 這條 band 就無聲消失，
 *   而畫面看起來完全正常。`tests/stats.test.ts` 有一條原始碼斷言守這件事。
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
 */
const hasSpend = computed(() => (allStats.value?.totals?.spend_known_records ?? 0) > 0)

/**
 * 圖說。★ 這條 band **恆為全期**（`by_year` 只有 `p_year = null` 才有值），
 * 所以指定年份時必須明說它跟頁面其他 band 的範圍不同——`SCREENS §9` 第 3 條。
 * ⚠️ 兩頁共用的是**最後那一句的字面**（`/u/` 的前半段還要分本人／路人，
 * 見那一頁的 `spendInsight`）。要改那句話的時候兩邊一起改，不要只改一邊。
 */
const spendInsight = computed(() => activeYear.value === null
  ? '你自己記下的票價，逐年合計。'
  : '你自己記下的票價，逐年合計。這一條不隨上方的年份切換。')

/* ── §9.2 點格子 → 底部片單。舊專案最有價值的互動語彙，原樣保留。 ── */
type Picked
  = | { kind: 'day', date: string }
    | { kind: 'slot', weekday: number, rowLabel: string }
    // 熱點圖格盤外側的兩條總和軌道（`HourHeatmap` 的第二組軸標籤）。
    | { kind: 'weekday', weekday: number }
    | { kind: 'hour', rowLabel: string }
    // band 7 多刷排行的一列。`records` 是**排行上那個數字**，帶進標題是刻意的
    // ——跟抽屜實際列出幾張擺在一起才看得出不一致（踩雷 #169）。
    | { kind: 'film', filmId: string, titleZh: string | null, records: number }

const picked = ref<Picked | null>(null)
const drawerOpen = computed({
  get: () => picked.value !== null,
  set: (v: boolean) => {
    if (!v)
      picked.value = null
  },
})
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
  // 多刷：標題帶次數與（指定年份時的）年份，理由見 `utils/stats.ts` 的 `repeatTitle`。
  if (p.kind === 'film')
    return repeatTitle(p.titleZh, activeYear.value, p.records)
  return slotTitle(p.weekday, p.rowLabel)
})

/** 抽屜空了的時候那句話。五種 kind 讀起來各不相同，不能共用「這個時段」。 */
const drawerEmptyText = computed(() => {
  switch (picked.value?.kind) {
    // day（出席圖點一天）維持原文案，不在這一項的範圍內
    case 'weekday': return '這一天沒有紀錄。'
    case 'hour': return '這個時段沒有紀錄。'
    // 「這個時段」對一部片是錯的。而且這一句在多刷上**幾乎不該出現**：
    // 排行上那一列說 N 次就該列得出 N 張，看到它就是有東西壞了。
    case 'film': return '沒有可以列出的紀錄。'
    default: return '這個時段沒有紀錄。'
  }
})

const drawerRecords = computed(() => {
  const p = picked.value
  if (!p)
    return []
  if (p.kind === 'day')
    return records.value.filter(r => r.watchedOn === p.date)
  // ★ 多刷：`activeYear` 一定要傳進去。band 7 吃的 `stats` 就是這個 scope
  //   （`activeYear === null ? allStats : yearStats`），少了它會變成
  //   「排行說 3 次、抽屜列 4 張」——而排行那個數字自己是對的，圖看起來沒問題。
  if (p.kind === 'film')
    return records.value.filter(r => inRepeatScope(r, p.filmId, activeYear.value))
  // ★ 抽屜的過濾**必須跟熱點圖的 scope 一致**，否則點一格說 8 場、抽屜列出 24 張。
  //   熱點圖 2026-09-06 起跟著檢視視角走（見上方 `grid` 的註解），所以這裡也限年。
  //   全期時 activeYear 是 null，不套年份條件。
  const inScope = (r: { watchedOn?: string | null }) =>
    activeYear.value === null || String(r.watchedOn ?? '').startsWith(`${activeYear.value}-`)
  // ★ 星期總和：**過濾述詞在 utils/stats.ts**，因為它有一條真實資料測不出來的條件
  //   （熱點圖的母體不含沒記時間的紀錄，而 David 的 records_without_time 是 0）。
  //   寫在這裡的 inline computed 裡 vitest 摸不到，就沒有東西守得住它。
  if (p.kind === 'weekday')
    return records.value.filter(r => matchesWeekdayPick(r, p.weekday) && inScope(r))
  // 時段總和：`inHourRow(null, …) === false`，對沒記時間的紀錄天然免疫。
  if (p.kind === 'hour')
    return records.value.filter(r => inHourRow(r.watchedTime, p.rowLabel) && inScope(r))
  return records.value.filter(r =>
    isoDow(r.watchedOn) === p.weekday
    && inHourRow(r.watchedTime, p.rowLabel)
    && inScope(r))
})

/**
 * 紀錄還在飛。**`idle` 也要算**：`useMyRecords` 是 `server: false`，
 * client 端掛載到請求真的發出去之間有一段 `idle`，那時說「沒有紀錄」一樣是說謊。
 */
const recordsLoading = computed(() => recordsStatus.value === 'pending' || recordsStatus.value === 'idle')

/**
 * 換年份就把抽屜關掉。
 *
 * 多刷的標題把「排行上那個數字」烤進了 `picked`，而 `drawerRecords` 是隨
 * `activeYear` 重算的 computed——年份在抽屜開著時變動，會出現「標題 10 次、
 * 內容 1 張」。UDrawer 是 modal、年表在遮罩底下，所以實務上大概點不到；
 * 但這是一行就能根絕的說謊管道，不留。
 */
watch(activeYear, () => {
  picked.value = null
})

/**
 * 空狀態的淡化示意圖：一年份的出席格。刻意用固定的偽亂數而不是 Math.random，
 * 免得每次 render 長不一樣（這頁雖然沒有 SSR，但「示意圖會閃」一樣是缺陷）。
 */
const demoCells = Array.from({ length: 7 * 26 }, (_, i) => {
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
  <!--
    max-w-4xl 不是 3xl：整年出席圖是 53 欄 × 14px = 742px + 星期標籤，
    在 3xl（768px）扣掉頁面與卡片的 padding 之後只剩約 700px，
    圖會被切掉左邊那一欄星期標籤——而那一欄正好是預先捲到最右之後被藏掉的部分。
  -->
  <div class="mx-auto max-w-4xl px-4 py-8">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        我的紀錄
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一場
      </UButton>
    </div>

    <!-- §9.4：載入態是 720–780px 寬的實體區塊不是轉圈，否則圖表出現時整頁往下推（CLS）。 -->
    <div v-if="loading" class="mt-8 space-y-4">
      <USkeleton class="h-[140px] w-full rounded-sm" />
      <USkeleton class="h-[240px] w-full rounded-sm" />
      <USkeleton class="h-[420px] w-full rounded-sm" />
    </div>

    <!--
      §9.3 全新帳號：四張圖同時空是這頁最尷尬的狀態，所以**不畫空圖**。
      一個明確的下一步動作，加一張淡化的示意圖說明「這裡會長出什麼」。
      David 有 174 筆永遠看不到這個狀態，但新使用者第一眼就是它。
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
          記下幾場之後，這裡會長成你的出席圖：
        </p>
        <div
          class="mt-3 grid grid-flow-col grid-rows-7 gap-[3px] overflow-hidden opacity-30"
          aria-hidden="true"
        >
          <span
            v-for="(c, i) in demoCells"
            :key="i"
            class="size-2.5 rounded-[2px] bg-inverted"
            :style="{ opacity: c > 0.72 ? c : 0.08 }"
          />
        </div>
      </div>
    </section>

    <div v-else class="mt-8 space-y-4">
      <!--
        ★ 這一句本來是「出席」band 的 caption。全期視角下那條 band 整條不出現
          （見下方），而它是全頁的標題數字——跟著一起消失的話，全期視角就沒有
          任何一個地方說得出「總共幾場」。所以提到頁面層級，由它自己說明
          目前的檢視範圍（「總共看了 174 場」／「2026 年看了 8 場」）。
      -->
      <div>
        <StatLine :segments="yearSegments" />
        <p v-if="spendNote" class="mt-1 text-sm text-muted">
          {{ spendNote }}
        </p>
      </div>

      <!-- ── band 1：年表。兼任檢視視角選擇器——你在選之前就看得到那年有多少東西。 ── -->
      <ChartBand title="年表">
        <YearStrip
          :rows="stripRows"
          :selected="activeYear"
          @update:selected="activeYear = $event"
        />
      </ChartBand>

      <!--
        §9.3 的中間態：資料還不夠時只顯示年表與票根列表，圖表 band 不出現。
        兩三個點的圖比沒有圖更糟。
      -->
      <template v-if="!showCharts">
        <ChartBand
          title="紀錄"
          :insight="`再記 ${CHART_THRESHOLD - totalRecords} 場就會出現時段分析。`"
        >
          <ul class="space-y-2">
            <!-- 同抽屜：這份列表是全部紀錄、沒有年份分組，年份必須自己帶 -->
            <li v-for="r in records" :key="r.id">
              <TicketCard :record="r" show-year />
            </li>
          </ul>
        </ChartBand>
      </template>

      <template v-else>
        <!--
          ── band 2：年度出席圖 ──
          ★ **全期視角下整條不出現**（David 2026-09-06 裁決：「全部顯示視角下
            無法呈現的（像是逐日貢獻圖）就隱藏」）。7×53 的格盤綁死在一個日曆年上
            （`calendar.range` 只吃得下一個年份），全期沒有這個座標軸。
          ⚠️ 「隱藏」不是「畫成空的」也不是「畫成 0 年」——這裡本來寫
            `:year="activeYear ?? 0"`，真的進到全期會去畫一張「0 年」的日曆。
        -->
        <ChartBand v-if="activeYear !== null" title="出席" table-summary="看每一天的數字">
          <AttendanceCalendar
            :year="activeYear"
            :daily="stats?.daily ?? []"
            @pick="picked = { kind: 'day', date: $event }"
          />

          <template #table>
            <table class="w-full text-sm tabular-nums">
              <thead class="text-muted">
                <tr>
                  <th class="py-1 pr-4 text-left font-normal">
                    日期
                  </th><th class="py-1 pr-4 text-left font-normal">
                    場次
                  </th><th class="py-1 text-left font-normal">
                    張數
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="d in stats?.daily ?? []" :key="d.date" class="border-t border-default">
                  <td class="py-1 pr-4">
                    {{ d.date }}
                  </td>
                  <td class="py-1 pr-4">
                    {{ d.records }}
                  </td>
                  <td class="py-1">
                    {{ d.tickets }}
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </ChartBand>

        <!--
          ── band 3：時段熱點圖 ──
          ★ 標題本來是「時段（全部年度）」。**那個括號 2026-09-06 刻意拿掉了**，
            連同「這張圖永遠吃全部年度」的特例一起——理由寫在上方 `grid` 的註解裡。
            全期變成預設檢視視角之後，那個括號不再區分任何東西。
        -->
        <ChartBand title="時段" :insight="hourInsight" :note="hourNote" table-summary="看每一格的數字">
          <!-- kind 由 HourHeatmap 決定（格子／星期總和／時段總和三種），這裡不要再包一層 -->
          <HourHeatmap :grid="grid" @pick="picked = $event" />

          <template #table>
            <table class="w-full text-sm tabular-nums">
              <thead class="text-muted">
                <tr>
                  <th class="py-1 pr-3 text-left font-normal">
                    時段
                  </th>
                  <th v-for="w in WEEKDAY_LABELS" :key="w" class="py-1 pr-3 text-left font-normal">
                    {{ w }}
                  </th>
                  <!--
                    §5.4b 三之 1 的對帳方法是「把資料表跟圖並排逐格比」。圖上多了
                    兩條總和軌道，資料表就得有同樣的兩條，否則新加的東西沒有對帳基準。
                  -->
                  <th class="py-1 pr-3 text-left font-normal">
                    合計
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(label, y) in grid.rows" :key="label" class="border-t border-default">
                  <td class="py-1 pr-3 text-muted">
                    {{ label }}
                  </td>
                  <td v-for="x in 7" :key="x" class="py-1 pr-3">
                    {{ grid.data.find(d => d[0] === x - 1 && d[1] === y)?.[2] ?? 0 }}
                  </td>
                  <td class="py-1 pr-3 font-medium">
                    {{ grid.rowTotals[y] ?? 0 }}
                  </td>
                </tr>
                <tr class="border-t-2 border-default">
                  <td class="py-1 pr-3 text-muted">
                    合計
                  </td>
                  <td v-for="(n, x) in grid.colTotals" :key="x" class="py-1 pr-3 font-medium">
                    {{ n }}
                  </td>
                  <td class="py-1 pr-3 font-medium">
                    {{ grid.total }}
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </ChartBand>

        <!--
          ── band 4：月度趨勢 ──
          全期時這是**季節性**（12 個月份桶、跨年度加總），不是 156 個月的時間序列
          ——走勢已經由年表在說（`backend.md §6e`）。所以圖說要講清楚在看什麼。
        -->
        <ChartBand
          title="每個月"
          :insight="activeYear === null
            ? '十三年來每個月份的加總——看得出哪幾個月是你的旺季。'
            : null"
          table-summary="看每個月的數字"
        >
          <MonthlyTrend
            :monthly="stats?.monthly ?? []"
            :average="showAverage ? monthlyBaseline : null"
            :year="activeYear"
          />
          <!-- 圖例自己用 HTML 畫（見 frontend 交接 §3：canvas 的圖例拿不到鍵盤與螢幕閱讀器） -->
          <p class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span class="inline-flex items-center gap-1.5">
              <ChartLegendSwatch kind="ink" />
              {{ activeYear === null ? '全部年度加總' : `${activeYear} 年` }}
            </span>
            <!--
              ★ 全期時沒有這條虛線，圖例也不能留著（留著就是圖例指向一條不存在的線）。
                理由見 script 裡的 `showAverage`：全期時虛線就是實線除以曝光數，
                同一條 y 軸上會貼著底趴平，而且它不再具有對照功能。
            -->
            <span v-if="showAverage" class="inline-flex items-center gap-1.5">
              <ChartLegendSwatch kind="baseline" />
              {{ averageLegendLabel }}
            </span>
          </p>
          <template #table>
            <table class="w-full text-sm tabular-nums">
              <thead class="text-muted">
                <tr>
                  <th class="py-1 pr-4 text-left font-normal">
                    月
                  </th><th class="py-1 pr-4 text-left font-normal">
                    場次
                  </th><th class="py-1 text-left font-normal">
                    張數
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in stats?.monthly ?? []" :key="m.month" class="border-t border-default">
                  <td class="py-1 pr-4">
                    {{ m.month }} 月
                  </td>
                  <td class="py-1 pr-4">
                    {{ m.records }}
                  </td>
                  <td class="py-1">
                    {{ m.tickets }}
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </ChartBand>

        <!-- ── band 5：影城分布 ── -->
        <ChartBand title="去了哪裡" :insight="venueInsight">
          <DistributionBars :items="venueItems" unit=" 場" />
        </ChartBand>

        <!-- ── band 6：版本與國別 ── -->
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

        <!--
          ── band 7：多刷排行 ──
          ⚠️ `repeats` 吃的是目前檢視視角的紀錄，所以「多刷」的語意會跟著變：
             指定年份時是「那一年內看過兩次以上」，全期時是「這些年來看過兩次以上」
             （實測 David 全期 19 部）。數字沒錯，但不講清楚會被讀成前者，
             所以圖說明講範圍。
        -->
        <ChartBand
          v-if="(stats?.repeats?.length ?? 0) > 0"
          title="看了不只一次"
          :insight="activeYear === null
            ? '這些年來看過兩次以上的作品。'
            : `${activeYear} 年內看過兩次以上的作品。`"
        >
          <RepeatList
            :items="stats?.repeats ?? []"
            @pick="picked = { kind: 'film', ...$event }"
          />
        </ChartBand>
      </template>

      <!--
        ── band 8：每年花費 ──（David 2026-09-07 需求 6）
        ★ **放在 `showCharts` 的 `v-else` 外面**，跟 `/u/` 一樣：一份最多十三列的
          長條清單在資料很少時仍然讀得懂，不像 7×53 的出席圖。
        ★ **恆為全期**（`by_year` 只在 `p_year = null` 有值），所以圖說要說出這件事。
        ★ 排在最後跟 `/u/` 一致（那邊排最後是因為它可能整條不存在，晚出現時
          不會把正在讀的東西往下推）。`SCREENS §9`：band 的順序是規格的一部分。
        ★ **不需要 `<ClientOnly>`**：`/app` 在 `nuxt.config` 是 `ssr: false`，整頁本來
          就是 client-only。`/u/` 那邊包 ClientOnly 是因為那頁是 SSR、金額不能進
          `__NUXT_DATA__`——不要照抄過來（無害但會讓下一棒以為 `/app` 有 SSR 外洩風險）。
        ★ 不加 `#table`：這條 band 的數字本來就是 HTML 文字，螢幕閱讀器讀得到；
          `ChartBand` 的 `#table` 是給 canvas（ECharts）補的。
        ★ `:privacy-note="false"`：「只有你看得到這些數字。」是為 `/u/` 寫的，
          `/app` 整頁私密，那句在這裡沒有回答任何問題。
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
      §9.2：點出席圖或熱點圖的一格 → 底部抽屜列出該時段的票根卡。
      舊專案最有價值的互動語彙，原樣保留；紀錄列表退場後，這是使用者
      從 /app 看到票根卡的唯一路徑。
    -->
    <UDrawer v-model:open="drawerOpen" direction="bottom" :title="drawerTitle">
      <template #body>
        <div class="mx-auto max-w-3xl">
          <!--
            ★ 紀錄還在飛的時候**不能說「沒有紀錄」**。
              band 7 只要 `stats` 回來就出現，而 `records` 是另一支平行的請求；
              先點下去會看到一句理直氣壯的謊話（踩雷 #169）。骨架屏是既有缺陷的
              順手修，出席圖與時段圖的抽屜也一起受惠。
          -->
          <div v-if="recordsLoading" class="space-y-2 py-2 pb-4">
            <USkeleton v-for="i in 3" :key="i" class="h-20 w-full rounded-sm" />
          </div>
          <p v-else-if="!drawerRecords.length" class="py-6 text-center text-muted">
            {{ drawerEmptyText }}
          </p>
          <!--
            show-year 是必要的：抽屜的內容跨年份聚合，而標題不一定帶年——
            出席圖點一格是「2024/03/15 (週五)」有年，時段圖點一格是
            「週三 14:00~15:00」，那一格的紀錄可能散在 2014–2026。
            日期帶預設不顯示年份（依年份分組的列表由上下文提供），
            抽屜打破了那個前提。
          -->
          <ul v-else class="space-y-2 pb-4">
            <li v-for="r in drawerRecords" :key="r.id">
              <TicketCard :record="r" show-year />
            </li>
          </ul>
        </div>
      </template>
    </UDrawer>

    <!--
      2026-09-07 David 裁決：這裡原本有一列重複的操作入口與帳號指示，整塊移除。
      那三個入口與使用者名稱都在右上的帳號選單裡（`app/components/AppNav.vue`），
      AppNav 上線之後這一列就是同一件事做兩次。

      頁尾的顯名段與法遵連結不在這裡，是 layout 的 `AttributionFooter`（掛在
      `app/layouts/default.vue`）。那是授權生效要件（DS §9：顯名未盡視為自始
      未取得授權），跟這次移除的東西無關，也不要挪到這一頁來。

      ⚠️ 不要把「這個位置是空的」讀成「這個位置不能放東西」——BUILD_PLAN §6.1①
      的一次性條款同意（寫入 `legal_acceptance`）到現在都還沒有實作，它的落點
      就是這一頁。
    -->
  </div>
</template>
