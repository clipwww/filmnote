<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'
// `DistKind` 是**型別**，Nuxt 的 auto-import 只帶值不帶型別 ⇒ 一定要明寫。
// 用它而不是在這裡再抄一次 `'venue' | 'format' | 'country'`：那三個字串同時是
// `matchesDistPick()` 的 kind，抄一份就多一個會跟 `utils/stats.ts` 漂移的地方。
// （`/u/[username].vue` 也是這樣寫的——兩頁的 `Picked` 必須是同一個形狀。）
import type { DistKind } from '~/utils/stats'

/**
 * `/app` — 登入後看到的第一個畫面（`SCREENS.md §9`）。
 *
 * **統計是產品門面，不是設定頁裡的附屬圖表。** Letterboxd 把統計鎖在 Pro
 * 付費層，我們把它當核心免費價值——所以這一頁的門面就是統計本身。
 *
 * 版面是**垂直長卷，一個 band 一張圖，滿容器寬**，不是 2×2 的卡片牆。
 * band 的順序是規格的一部分（§9），不是隨意排列。
 *
 * ⚠️ **這一頁沒有紀錄列表**（§9）。紀錄透過 §9.2 的「點圖表的一格 → 底部抽屜」
 * 出現；可編輯的列表在 `/app/records`（§10）。例外是資料太少的中間態，
 * 見下方 `showCharts`。
 * （2026-09-14 起「一格」不只出席圖與熱點圖：月度趨勢的每個月、以及三條分布
 * 長條的每一列也都開同一個抽屜。九種 kind 見下方的 `Picked`。）
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

/**
 * 三條分布長條的資料。
 *
 * ★ **每一件都要填 `key`**（2026-09-14，David 第 4／5 點：每一列都要點得開抽屜）。
 *   `key` 是**識別**不是顯示文字，三條的識別空間各不相同，規則寫在
 *   `utils/stats.ts` 的 `matchesDistPick()`——這裡的三行必須跟那支逐條對稱：
 *   · 影城 `venue_id ?? ''`：`?? ''` 對上 `(r.venueId ?? '') === key`。
 *     在 `/app` 這個 `?? ''` 其實是 no-op（`viewing_record.venue_id` 在 DB 上
 *     NOT NULL），仍然寫出來是為了**跟 `matchesDistPick()` 與 `/u/` 對稱**
 *     ——三處只要有一處寫法不同，下一個人就得三邊都讀完才敢改。
 *   · 版本 `f.code`：RPC 已經 `coalesce(r.format_code,'other')`，所以畫面上那個
 *     「其他」的 code 就是 `'other'`——**它是一個真分類**，不是 `topWithRest()`
 *     聚出來的長尾（實測 David 有 5 筆走這條）。
 *   · 國別 `c.country`：**空字串**就是畫面上的「未分類」（`coalesce(f.country,'')`）。
 *     顯示文字用 `||` 換成「未分類」，`key` 一定要留原始的空字串——拿四個中文字
 *     去比對會對上零筆。
 *
 * ⚠️ 這三行與 `/u/[username].vue` 的同名 computed **逐字相同**（那邊的 `venues`
 *   來自 `/api/u/…/stats`、這邊來自 RPC，但兩支的欄位名一樣）。要改請兩邊一起改：
 *   同一個名字的圖在兩頁有兩種語意會讓使用者以為資料錯了（`backend.md §6e`）。
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
    // band 4 月度趨勢的一個月（1..12）。`records` 是**圖上那個點的數字**，同上。
    // ⚠️ 這個 kind 的語意隨檢視視角而變：全期是「跨年度的同一個月」，
    //    指定年份是「那一年的那個月」。過濾與標題都要照著分（見下方）。
    | { kind: 'month', month: number, records: number }
    // band 5／6 三條分布長條的一列。`kind` 直接就是 `matchesDistPick()` 的
    // `DistKind`，不另外翻譯一層。`key` 是穩定識別、`name` 是畫面上那行字，
    // 兩者刻意分開（見 `venueItems`）。`records` 同樣是**長條上那個數字**。
    | { kind: DistKind, key: string, name: string, records: number }

// ⚠️ 這個 union 與 `/u/[username].vue` 的 `Picked` **形狀必須一致**（兩頁擺的是
//    同一組 band）。兩頁不同的只有「怎麼開」與「空了說什麼話」，見下方。

const picked = ref<Picked | null>(null)

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
 * ★ **`/u/` 那一頁的同名函式是 `async` 的，這裡不是**——這是兩頁唯一的行為差異，
 *   而且是有理由的：`/u/` 的紀錄列表是分頁的（一次最多 200 筆），所以它必須先
 *   `await ensureAllRecords()`；`/app` 的 `useMyRecords()` 是**一次取回**（沒有第二頁
 *   可以補），所以這裡沒有東西可以等。
 *   ⚠️ 「一次取回」**不等於「全部」**：`useMyRecords.ts:69` 是 `.limit(500)`，
 *   而同檔 :51 的既有 ⚠️ 已經記著「這個上限會隨時間爆，且爆的時候是**靜默少資料**」。
 *   ⇒ 超過 500 筆的使用者，這一頁的分布長條與月份抽屜會少列（踩雷 #169 的同一族，
 *   長條說 120、抽屜列 96）。**這一頁對那條不免疫**，只是解法是分頁不是 await。
 *   「紀錄還沒到」在這一頁由抽屜裡的 `recordsLoading` 骨架處理（見模板），
 *   不是靠等待——那一段本來就在，出席圖與熱點圖走的也是同一條。
 */
function pickDist(kind: DistKind, e: { key: string | null, name: string, records: number }) {
  if (e.key === null)
    return
  picked.value = { kind, key: e.key, name: e.name, records: e.records }
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
  picked.value = { kind: 'month', month, records: n }
}
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
  // ⚠️ 標題的組字一律在 `utils/stats.ts`，**不寫成這裡的字串樣板**（`SCREENS §9.2`）：
  //   vitest 摸不到 SFC，寫在這裡的話全形空白、「N 場」、以及全期刻意不寫
  //   「全部年度」那條規矩就一條都沒有東西守。`monthTitle()` 自己處理
  //   全期／指定年份兩種形狀，所以這裡把 `activeYear` 原樣交出去就好。
  if (p.kind === 'month')
    return monthTitle(p.month, activeYear.value, p.records)
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
 * ⚠️ 這一頁是**本人視角**（整頁私密、觀看者永遠是自己），所以講的是
 *   「沒有紀錄」。`/u/` 是匿名視角的公開頁，那邊每一句都是「沒有**公開的**紀錄」
 *   ——因為在那裡空抽屜的真正原因通常是「那些紀錄是私密的」，那句話回答的是
 *   一個這一頁不存在的問題。**兩頁的措辭刻意不同，不要互抄。**
 */
const drawerEmptyText = computed(() => {
  switch (picked.value?.kind) {
    // day（出席圖點一天）維持原文案，不在這一項的範圍內
    case 'weekday': return '這一天沒有紀錄。'
    case 'hour': return '這個時段沒有紀錄。'
    // 「這個時段」對一部片是錯的。而且這一句在多刷上**幾乎不該出現**：
    // 排行上那一列說 N 次就該列得出 N 張，看到它就是有東西壞了。
    case 'film': return '沒有可以列出的紀錄。'
    // 以下四種是 2026-09-14 新增的。它們**會**正常出現（0 場的月份、還沒到來的
    // 月份都點得下去，見 `pickMonth()`），所以要寫成一句讀得通的話而不是錯誤訊息。
    case 'month': return '這個月沒有紀錄。'
    case 'venue': return '這個場所沒有紀錄。'
    case 'format': return '這個版本沒有紀錄。'
    // 「這個國家」對「未分類」那一列是錯的（`country` 是空字串那一桶），
    // 所以用「國別」——跟長條上方那個標題同一個詞。
    case 'country': return '這個國別沒有紀錄。'
    default: return '這個時段沒有紀錄。'
  }
})

const drawerRecords = computed(() => {
  const p = picked.value
  if (!p)
    return []
  /**
   * 目前的檢視視角。**每一種 scope 會變的 kind 都要套它**，否則點一格說 8 場、
   * 抽屜列出 24 張（圖吃的是 `stats`＝那一年，抽屜吃的是 `records`＝全部年度）。
   * 熱點圖 2026-09-06 起跟著檢視視角走（見上方 `grid` 的註解），所以它也限年。
   * 全期時 `activeYear` 是 null ⇒ 不加年份條件。
   *
   * ⚠️ 這一段 2026-09-14 從 `weekday` 分支前面**往上搬**，因為新加的
   *   `month` 與三條分布長條也要用它。搬動沒有改變任何既有分支的行為。
   */
  const inScope = (r: { watchedOn?: string | null }) =>
    activeYear.value === null || String(r.watchedOn ?? '').startsWith(`${activeYear.value}-`)
  if (p.kind === 'day')
    return records.value.filter(r => r.watchedOn === p.date)
  /*
   * ★ 「每個月」在**全期視角下是跨年度的同一個月**（十三年的三月全算進來），
   *   那時 `inScope` 恆為真——這是對的，圖上那個點本身就是加總
   *   （band 4 的圖說寫的就是「十三年來每個月份的加總」）。
   *   指定年份時 `inScope` 才把它收斂成「那一年的三月」。
   * ⚠️ `inMonth()` **只管月份不管年份**（見 `utils/stats.ts`），所以年份一定要
   *   靠 `inScope` 另外加。少了它，切到 2019 年點三月會列出十三年份的三月。
   */
  if (p.kind === 'month')
    return records.value.filter(r => inMonth(r.watchedOn, p.month) && inScope(r))
  // ★ 多刷：`activeYear` 一定要傳進去。band 7 吃的 `stats` 就是這個 scope
  //   （`activeYear === null ? allStats : yearStats`），少了它會變成
  //   「排行說 3 次、抽屜列 4 張」——而排行那個數字自己是對的，圖看起來沒問題。
  if (p.kind === 'film')
    return records.value.filter(r => inRepeatScope(r, p.filmId, activeYear.value))
  // ★ 星期總和：**過濾述詞在 utils/stats.ts**，因為它有一條真實資料測不出來的條件
  //   （熱點圖的母體不含沒記時間的紀錄，而 David 的 records_without_time 是 0）。
  //   寫在這裡的 inline computed 裡 vitest 摸不到，就沒有東西守得住它。
  if (p.kind === 'weekday')
    return records.value.filter(r => matchesWeekdayPick(r, p.weekday) && inScope(r))
  // 時段總和：`inHourRow(null, …) === false`，對沒記時間的紀錄天然免疫。
  if (p.kind === 'hour')
    return records.value.filter(r => inHourRow(r.watchedTime, p.rowLabel) && inScope(r))
  // 格盤裡的一格。⚠️ 這一支 2026-09-14 從 fallthrough 改成明寫的 `if`：
  //   九種 kind 現在**全部**明寫，末尾那一行只負責接「忘了接的第十種」，
  //   理由見這個 computed 末尾那段。
  if (p.kind === 'slot') {
    return records.value.filter(r =>
      isoDow(r.watchedOn) === p.weekday
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
    return records.value.filter(r => matchesDistPick(r, p.kind, p.key) && inScope(r))
  // ⚠️ 到不了（九種 kind 已經窮盡）。留著、而且分布那一支**不可以**當 fallthrough，
  //   理由與 `drawerTitle` 末尾那段完全相同：忘了接第十種 kind 的代價要是
  //   「抽屜是空的」，不是「抽屜理直氣壯地列錯東西」（踩雷 #169 的精神）。
  return []
})

/**
 * 紀錄還在飛。**`idle` 也要算**：`useMyRecords` 是 `server: false`，
 * client 端掛載到請求真的發出去之間有一段 `idle`，那時說「沒有紀錄」一樣是說謊。
 */
const recordsLoading = computed(() => recordsStatus.value === 'pending' || recordsStatus.value === 'idle')

/**
 * 換年份就把抽屜關掉。
 *
 * `picked` 把「圖上那個數字」烤進了標題，而 `drawerRecords` 是隨 `activeYear`
 * 重算的 computed——年份在抽屜開著時變動，會出現「標題 10 次、內容 1 張」。
 *
 * ⚠️ 2026-09-14：會烤數字進標題的 kind 從一種（`film`）變成**五種**
 *   （`film`／`month`／`venue`／`format`／`country`），所以這一條的價值變高了；
 *   同一天也多了**第二個切年份的入口**（`YearScopeBar`，teleport 進導覽列）。
 *   那個入口同樣到不了：導覽列是 `z-30`，`UDrawer` 的遮罩是 50 ⇒ 抽屜開著時
 *   它也在遮罩底下（跟年表一樣）。這條 watch 仍然是「理論上的洞」，
 *   但它一行就能根絕，不留。
 *   ★ 兩個入口寫的都是 `activeYear = $event`，所以**兩個都走這一條 watch**，
 *     不需要各自再補一次關抽屜的邏輯。`/u/` 那一頁有一條逐字對應的 watch。
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
  <div class="mx-auto max-w-4xl px-4 py-8">
    <!--
      max-w-4xl 不是 3xl：整年出席圖是 53 欄 × 14px = 742px + 星期標籤，
      在 3xl（768px）扣掉頁面與卡片的 padding 之後只剩約 700px，
      圖會被切掉左邊那一欄星期標籤——而那一欄正好是預先捲到最右之後被藏掉的部分。
    -->
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

      <!--
        ── band 1：年表。兼任檢視視角選擇器——你在選之前就看得到那年有多少東西。 ──

        ⚠️ 這一層 `<div>` 是 2026-09-14 加的，**它有功能、不是排版裝飾**：
           `YearScopeBar` 會在原地留下一個 1px 的 sentinel（觀測點）。而外面那個
           `space-y-4` 在 Tailwind 4.3 編譯出來的是
           `:where(& > :not(:last-child)) { margin-block-end: 16px }`——**每一個
           非最後的子節點各吃一份 16px**。sentinel 直接放進去就是多一個子節點、
           多一份 16px：年表與 band 2 之間會從 16px 變成 33px（16＋1＋16）。
           包一層之後 `space-y-4` 只看得到這個 wrapper，版面差異只剩那 1px。
           ⇒ 不要為了「少一層 div」把它拆掉。`/u/[username].vue` 是同一個寫法，
             但那一頁是 SSR、帳更難看一點（多一個掛載前的節點，見那邊的註解）。
      -->
      <div>
        <ChartBand title="年表">
          <YearStrip
            :rows="stripRows"
            :selected="activeYear"
            @update:selected="activeYear = $event"
          />
        </ChartBand>
        <!--
          ── 導覽列上的年份切換器（2026-09-14 David 第 2 點）──
          它自己 Teleport 到 `#header-year-scope`（`layouts/default.vue`），
          留在這裡的只有觀測用的 sentinel ⇒ **位置必須就是年表的正後方**：
          切換器要在「年表捲出畫面」的那一刻才出現，年表還看得到時不需要它。

          ★ 年份來源是 `stripRows`，**不是 `allStats.available_years`**（刻意偏離）。
            `stripRows = yearStripRows(daily, available_years)`，也就是
            available_years **聯集**「daily 裡出現過但清單還沒更新的年份」
            （見 `utils/stats.ts` 那一行註解）。年表自己畫的就是 `stripRows`
            ——兩個切換器是同一件事的兩個入口，**提供的年份集合必須逐個相同**，
            否則會出現「年表上有 2026、導覽列的選單裡沒有」。
            順序也因此對齊（`yearStripRows()` 已經新到舊排好；
            `YearScopeBar` 內部仍會自己排一次，不互相假設）。

          ★ `@update:selected` 寫成跟年表**一模一樣的一行**：兩個入口共用
            `activeYear`，也就共用了上面那條「換年份關抽屜」的 watch。
        -->
        <YearScopeBar
          :years="stripRows.map(r => r.year)"
          :selected="activeYear"
          @update:selected="activeYear = $event"
        />
      </div>

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
          <!--
            ★ `MonthlyTrend` 只 emit 月份（1..12），範圍（全期／某一年）由這一頁
              決定——它才知道 `activeYear`。`pickMonth()` 順便把「圖上那個月幾場」
              查出來烤進標題（踩雷 #169）。
          -->
          <MonthlyTrend
            :monthly="stats?.monthly ?? []"
            :average="showAverage ? monthlyBaseline : null"
            :year="activeYear"
            @pick="pickMonth($event)"
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

        <!--
          ── band 5：影城分布 ──
          ★ 每一列都點得開抽屜（2026-09-14 David 第 4／5 點）。`kind` 由呼叫端
            指定：同一個 `DistributionBars` 服務三條長條，它自己不知道
            自己畫的是場所、版本還是國別。
        -->
        <ChartBand title="去了哪裡" :insight="venueInsight">
          <DistributionBars :items="venueItems" unit=" 場" @pick="pickDist('venue', $event)" />
        </ChartBand>

        <!-- ── band 6：版本與國別 ── -->
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
      §9.2：點圖表的一格 → 底部抽屜列出對應的票根卡。
      舊專案最有價值的互動語彙，原樣保留；紀錄列表退場後，這是使用者
      從 /app 看到票根卡的唯一路徑。

      ⚠️ 2026-09-14 起「一格」不只是出席圖與熱點圖了：band 4 的每個月、
         band 5／6 三條分布長條的每一列（含展開出來的長尾）都走同一個抽屜。
         標題由 `drawerTitle` 分派到 `utils/stats.ts` 的各支組字函式，
         空狀態由 `drawerEmptyText` 分派——**九種 kind 各有各的說法**。
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
