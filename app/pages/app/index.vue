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
const user = useSupabaseUser()
const supabase = useSupabaseClient()

useSeoMeta({ title: '我的紀錄' })

const username = useMyUsername()

/** 年表要跨年度，所以額外取一份 p_year = null 的（RPC 的 year 傳 null 涵蓋全部）。 */
const allYear = ref<number | null>(null)
const { stats: allStats, status: allStatus } = useYearStats(username, allYear)

const selectedYear = ref<number | null>(null)
const activeYear = computed(() => selectedYear.value ?? allStats.value?.available_years?.[0] ?? null)
const { stats, status } = useYearStats(username, activeYear)

/** 抽屜要列出票根卡，所以仍然需要原始紀錄——與 `/app/records` 共用同一份快取。 */
const { records } = useMyRecords()

const loading = computed(() => allStatus.value === 'pending' || status.value === 'pending')
const totals = computed(() => stats.value?.totals ?? null)

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

/** `2026 年看了 8 場、11 張票，花了 NT$3,130`（§4.4） */
const yearSegments = computed<StatSegment[]>(() => {
  const t = totals.value
  if (!t || activeYear.value === null)
    return []
  const spend = t.spend > 0 ? costText(t.spend) : null
  return [
    { value: String(activeYear.value), suffix: '年看了' },
    { value: String(t.records), suffix: '場、' },
    { value: String(t.tickets), suffix: spend ? '張票，花了' : '張票' },
    ...(spend ? [{ value: spend }] : []),
  ]
})

const grid = computed(() =>
  hourGrid(stats.value?.weekday_hour ?? [], totals.value?.records_without_time ?? 0))

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

const home = computed(() => homeVenue(stats.value?.venues ?? []))
const venueInsight = computed(() =>
  home.value ? `你的主場是 ${home.value.name}，${home.value.share}% 的場次在這裡。` : null)

/**
 * 熱點圖的圖說。
 *
 * §9 的樣板寫「你 71% 的場次在週五到週日的晚上」，但那是 David 全部資料的形狀；
 * 逐年來看不一定成立——2019 年實際只有 20%，那句話就只是一個數字不是洞察。
 * 所以週末佔比過半才講它，否則改講真正的尖峰時段（那句永遠有內容）。
 */
const hourInsight = computed(() => {
  const rows = stats.value?.weekday_hour ?? []
  const share = weekendEveningShare(rows)
  if (share >= 50)
    return `你 ${share}% 的場次在週五到週日的晚上。`
  const peak = peakSlot(rows)
  if (!peak)
    return null
  const hour = MIDNIGHT_HOURS.includes(peak.hour)
    ? MIDNIGHT_LABEL
    : `${String(peak.hour).padStart(2, '0')}:00`
  return `你最常在週${WEEKDAY_LABELS[peak.weekday - 1]} ${hour} 進場，共 ${peak.records} 場。`
})
const hourNote = computed(() => {
  const n = totals.value?.records_without_time ?? 0
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
  // 熱點圖畫的是選定年份，抽屜也必須限定同一年，否則會列出別年的同時段
  const y = String(activeYear.value ?? '')
  return records.value.filter(r =>
    r.year === y && isoDow(r.watchedOn) === p.weekday && inHourRow(r.watchedTime, p.rowLabel))
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
      <!-- ── band 1：年表。兼任年份選擇器——你在選之前就看得到那年有多少東西。 ── -->
      <ChartBand title="年表">
        <YearStrip
          :rows="stripRows"
          :selected="activeYear"
          @update:selected="selectedYear = $event"
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
            <li v-for="r in records" :key="r.id">
              <TicketCard :record="r" />
            </li>
          </ul>
        </ChartBand>
      </template>

      <template v-else>
        <!-- ── band 2：年度出席圖 ── -->
        <ChartBand title="出席" :note="spendNote" table-summary="看每一天的數字">
          <template #caption>
            <StatLine class="mt-1" :segments="yearSegments" />
          </template>

          <AttendanceCalendar
            :year="activeYear ?? 0"
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

        <!-- ── band 3：時段熱點圖 ── -->
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

        <!-- ── band 4：月度趨勢 ── -->
        <ChartBand title="每個月" table-summary="看每個月的數字">
          <MonthlyTrend :monthly="stats?.monthly ?? []" />
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

        <!-- ── band 7：多刷排行 ── -->
        <ChartBand
          v-if="(stats?.repeats?.length ?? 0) > 0"
          title="看了不只一次"
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
          <ul v-else class="space-y-2 pb-4">
            <li v-for="r in drawerRecords" :key="r.id">
              <TicketCard :record="r" />
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
      <p v-if="user?.email" class="mt-3 text-xs text-dimmed">
        已登入：{{ user.email }}
      </p>
    </div>
  </div>
</template>
