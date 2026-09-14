<script setup lang="ts">
import type { EChartsOption } from 'echarts'
import type { YearStats } from '~/utils/stats'

/**
 * 月度趨勢（`SCREENS.md §9` band 4）。12 個點。
 *
 * ── 兩條線 ────────────────────────────────────────────────────
 * 實線＝選定年份的每月場次；**虛線＝歷年每月平均**（視覺稿的圖例寫
 * 「2014–2026 每月平均」）。虛線的意義是「這個月對我來說算多還是算少」，
 * 沒有它的話單一年度的高低點讀不出是季節性還是偶然。
 *
 * ⚠️ 平均線的資料**必須**來自 `user_year_stats(username, null)`，
 *    不可以在前端拿紀錄列表就地算——`/u/` 上別人拿得到的紀錄集合與本人不同
 *    （RLS 依觀看者而異），就地算會讓同一個人的歷年平均因為誰在看而不一樣。
 *    算法在 `monthlyAverageSeries()`，年份數不明時它回 null，這裡就不畫那條線。
 *
 * ── 還沒到的月份是斷點，不是 0 ────────────────────────────────
 * 看今年時，12 月的 0 跟 3 月的 0 意思完全不同。畫成 0 會讓折線在年中
 * 墜到底，讀起來像「他七月就不看電影了」（`DESIGN_SYSTEM §5.3-8`）。
 */
const props = withDefaults(defineProps<{
  monthly: YearStats['monthly']
  /** 歷年每月平均的 12 個值。null／未給就不畫虛線。 */
  average?: number[] | null
  /** 選定的年份；等於今年時，尚未到來的月份畫成斷點。null = 全期。 */
  year?: number | null
}>(), { average: null, year: null })

/**
 * 點一個月份 → 呼叫端開底部抽屜（David 2026-09-14 的第 5 點）。
 *
 * ★ **這裡只 emit 月份（1..12），不 emit 年份。**「那個月」的語意隨檢視視角變：
 *   · 指定年份（`year` 是數字）＝ 那一年的那個月。
 *   · 全期（`year` 是 null）＝ **跨年度的同一個月加總**——2014 的 3 月和 2026 的
 *     3 月會落在同一格，圖上那個點本來就是加總（呼叫端的圖說已經寫了
 *     「每個月份跨年度的加總」）。
 *   所以抽屜的標題與過濾一律由呼叫端用 `monthTitle()` / `inMonth()` 決定，
 *   scope 必須跟圖一致（`SCREENS §9c.2`：不一致就會出現「圖上 8 場、抽屜 24 張」）。
 */
const emit = defineEmits<{
  pick: [month: number]
}>()

const colorMode = useColorMode()
const isDark = computed(() => colorMode.value === 'dark')

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']

/**
 * 實線在 `series` 陣列裡的索引。
 *
 * ⚠️ 判斷式**刻意跟 series 裡那一段用同一個 `props.average ? … : …`**，不要改寫成
 *   `props.average?.length` 之類的「等價」寫法：兩邊只要漂移一格，點資料點就會被
 *   當成點到平均線而整個失效（或更糟，反過來）。平均線先畫（它要疊在實線下面），
 *   所以有平均線時實線是 1、沒有時是 0。
 */
const mainSeriesIndex = computed(() => (props.average ? 1 : 0))

const option = computed<EChartsOption>(() => {
  const p = chartPalette(isDark.value)
  const ax = axisStyle(isDark.value)
  return {
    ...baseChartOption(isDark.value),
    tooltip: {
      ...baseTooltip(isDark.value),
      trigger: 'axis' as const,
      // 見 AttendanceCalendar 的同一條註解。trigger:'axis' 給的是陣列。
      formatter: (params: unknown) => {
        const rows = params as { name: string, value: number | null, seriesName: string }[]
        if (!rows?.length)
          return ''
        // 兩條線都要出現在 tooltip 裡，否則「比平均多」這件事只能靠目測
        const lines = rows
          .filter(r => r.value !== null && r.value !== undefined)
          .map(r => `${r.seriesName}\u3000${r.value} 場`)
        return [rows[0]?.name ?? '', ...lines].join('<br>')
      },
    },
    grid: { left: 34, right: 12, top: 12, bottom: 28 },
    xAxis: {
      type: 'category' as const,
      data: MONTHS,
      boundaryGap: false,
      ...ax,
      /**
       * ★★ **月份標籤要可點，這不是加碼是必要條件。**
       * 實線的 `symbolSize` 只有 6px；在觸控裝置上 6px 的目標基本上點不到
       * （手指的實際接觸面遠大於它，而 ECharts 的命中判定就是那個圖形本身）。
       * 只做「點資料點」等於這個功能在手機上不存在 ⇒ 把 x 軸標籤也開成可點，
       * 兩條路徑 emit 同一個月份（處理在 `onPick()`）。
       *
       * ⚠️ `tooltip: { show: false }` **是 `triggerEvent` 的必要配套，不是美化**。
       *    理由完整寫在 `~/utils/hour-heatmap-option.ts` 的 `totalsAxis`：
       *    echarts 對每一個軸標籤**無條件**塞 tooltipConfig，標籤一旦因為
       *    `triggerEvent` 變成 non-silent，滑過去就會冒出一個只寫著「3月」的泡泡。
       *    而 `AxisBuilder.isLabelSilent()` 只看 `triggerEvent || tooltip.show`，
       *    所以 `show: false` **不會**把標籤變回 silent，點擊仍然成立。
       *
       * ⚠️ 這兩個鍵**不會**動到上面那個 `trigger: 'axis'` 的 tooltip。
       *    查過 echarts 原始碼確認：`axisPointer/modelHelper.js` 的
       *    `collectAxesInfo()` 是用 `coordSysModel.getModel('tooltip', …)`——
       *    也就是 **grid** 的 tooltip，不是軸自己的。所以既有的「滑過去看兩條線
       *    的數字」完全沒被動到。（會被遮掉的只有「正好停在月份標籤那幾個字上」
       *    的那一小塊，而那本來就在 grid 外面、原本也不會出現軸 tooltip。）
       *
       * ⚠️ 放在 `...ax` **之後**：`axisStyle()` 目前沒有這兩個鍵，但它哪天長出來時
       *    要以這裡為準——這兩個鍵是功能不是樣式。
       */
      triggerEvent: true,
      tooltip: { show: false },
    },
    yAxis: {
      type: 'value' as const,
      minInterval: 1, // 場次是整數，不要出現 0.5 場
      ...ax,
      splitLine: { show: true, lineStyle: { color: p.sunken } },
    },
    series: [
      // 平均線先畫 ⇒ 疊在實線下面。它是基準不是主角。
      ...(props.average
        ? [{
            name: '歷年每月平均',
            type: 'line' as const,
            data: props.average,
            lineStyle: { color: p.heat[2], width: 1, type: 'dashed' as const },
            itemStyle: { color: p.heat[2] },
            symbol: 'none' as const,
            smooth: false,
            silent: true, // 基準線不接點擊：那一點不對應任何一筆紀錄
            z: 1,
          }]
        : []),
      {
        name: props.year === null ? '全部年度' : `${props.year} 年`,
        type: 'line' as const,
        data: monthlySeriesToDate(props.monthly, props.year),
        // 折線是 text0（§5.4b 對帳表）。不是琥珀——琥珀塗介面、不塗資料。
        lineStyle: { color: p.text0, width: 2 },
        itemStyle: { color: p.text0 },
        symbol: 'circle' as const,
        symbolSize: 6,
        smooth: false, // 場次是離散事件，平滑曲線會編造中間值
        z: 2,
      },
    ],
  }
})

/**
 * ECharts 的 click。**兩條路徑，emit 同一個月份。**
 *
 * ① **月份標籤**（主要路徑，手機上唯一點得到的）：`params.data` 是 undefined，
 *    改帶 `targetType: 'axisLabel'` + `componentType: 'xAxis'`，而 category 軸的
 *    `dataIndex` 就是類目索引 0..11（源頭是 `AxisBuilder`：category 軸時
 *    `eventData.dataIndex = tickValue`）。這條路徑要靠 x 軸的 `triggerEvent`，
 *    沒有它標籤是 silent、根本不產生事件。
 *    ⚠️ **不要改用 `params.value` 反查是哪一個月**——那是「3月」這種字串，
 *      多繞一次解析而且跟 `MONTHS` 的寫法綁死。用 `dataIndex`（同 `HourHeatmap`）。
 *
 * ② **資料點**：`componentType` 是 `'series'`，`dataIndex` 同樣是 0..11。
 *    ★ 要確認事件來自**實線**那一條。平均線已經 `silent: true`、現在送不出 click——
 *      但那是**別人可以一行改掉**的防線：哪天有人想給基準線加 hover emphasis，
 *      拿掉 `silent` 的那一秒，點平均線就會靜悄悄地開出一個月份抽屜，而且
 *      畫面上完全看不出點錯了（兩條線在同一個 x 上）。所以這裡再擋一次索引。
 *
 * ★ 場次為 0 的月份**照樣可以點**，開出來是一個空抽屜——與 `HourHeatmap`
 *   「112 個格子（含值為 0 的）都可點」同一條規矩。刻意不擋：使用者點了沒反應
 *   比點了看到「這個月沒有紀錄」更難理解。
 *   （尚未到來的月份是 null、不畫點，路徑 ② 自然點不到；路徑 ① 仍然點得到，
 *   那也對——「12 月我還沒去過」是一個合理的答案。）
 */
function onPick(params: {
  data?: unknown
  seriesIndex?: number
  componentType?: string
  targetType?: string
  dataIndex?: number
}) {
  if (params.targetType === 'axisLabel') {
    if (params.componentType === 'xAxis')
      emitMonth(params.dataIndex)
    return
  }
  if (params.componentType !== 'series')
    return
  if (params.seriesIndex !== mainSeriesIndex.value)
    return
  emitMonth(params.dataIndex)
}

/** 類目索引 0..11 → 月份 1..12。越界就不 emit——呼叫端不必自己防。 */
function emitMonth(dataIndex: number | undefined) {
  if (typeof dataIndex !== 'number')
    return
  const month = dataIndex + 1
  if (month >= 1 && month <= MONTHS.length)
    emit('pick', month)
}
</script>

<template>
  <div>
    <BaseChart :option="option" height="240px" label="月度趨勢" @pick="onPick" />
    <!-- 提示文字照 `HourHeatmap.vue` 的先例。先講標籤、再講資料點：標籤是大目標。 -->
    <p class="mt-2 text-xs text-muted">
      點月份或線上的點，看那個月看了什麼
    </p>
  </div>
</template>
