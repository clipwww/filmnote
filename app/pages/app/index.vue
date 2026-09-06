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
const supabase = useSupabaseClient()

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
const { records } = useMyRecords()

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
  return t?.spend_is_partial
    ? `其中 ${t.spend_unknown_records} 筆沒有票價，金額不是全年總額。`
    : null
})

/* ── §9.2 點格子 → 底部片單。舊專案最有價值的互動語彙，原樣保留。 ── */
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
    return records.value.filter(r => r.watchedOn === p.date)
  // ★ 抽屜的過濾**必須跟熱點圖的 scope 一致**，否則點一格說 8 場、抽屜列出 24 張。
  //   熱點圖 2026-09-06 起跟著檢視視角走（見上方 `grid` 的註解），所以這裡也限年。
  //   全期時 activeYear 是 null，不套年份條件。
  return records.value.filter(r =>
    isoDow(r.watchedOn) === p.weekday
    && inHourRow(r.watchedTime, p.rowLabel)
    && (activeYear.value === null || String(r.watchedOn ?? '').startsWith(`${activeYear.value}-`)))
})

async function signOut() {
  await supabase.auth.signOut()
  await navigateTo('/login')
}

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
          <HourHeatmap :grid="grid" @pick="picked = { kind: 'slot', ...$event }" />

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
          <RepeatList :items="stats?.repeats ?? []" />
        </ChartBand>
      </template>
    </div>

    <!--
      §9.2：點出席圖或熱點圖的一格 → 底部抽屜列出該時段的票根卡。
      舊專案最有價值的互動語彙，原樣保留；紀錄列表退場後，這是使用者
      從 /app 看到票根卡的唯一路徑。
    -->
    <UDrawer v-model:open="drawerOpen" direction="bottom" :title="drawerTitle">
      <template #body>
        <div class="mx-auto max-w-3xl">
          <p v-if="!drawerRecords.length" class="py-6 text-center text-muted">
            這個時段沒有紀錄。
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

    <div class="mt-12 border-t border-default pt-6">
      <!-- shrink-0：375px 下沒有它，按鈕文字會被壓成「管理紀 錄」 -->
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UButton to="/app/records" variant="ghost" color="neutral" size="sm" icon="i-lucide-list" class="shrink-0">
          管理紀錄
        </UButton>
        <UButton to="/app/settings" variant="ghost" color="neutral" size="sm" icon="i-lucide-settings" class="shrink-0">
          設定
        </UButton>
        <UButton variant="ghost" color="neutral" size="sm" class="ml-auto shrink-0" @click="signOut">
          登出
        </UButton>
      </div>
      <!--
        顯示使用者名稱不是 email：這頁是自己的，但**截圖與投影分享是常態**，
        把 email 印在畫面上沒有必要。使用者名稱是 ASCII、是公開識別、
        也是他自己選的（§9c.4）。
      -->
      <p v-if="username" class="mt-3 text-xs text-muted">
        已登入：@{{ username }}
      </p>
    </div>
  </div>
</template>
