<script setup lang="ts">
/**
 * 「每年花費」。⚠️ 三種觀看者長得不一樣而三種都必須對：本人看全部、`show_cost` 的路人看
 * 公開紀錄的票價、其他人**一列都拿不到 ⇒ 整條不存在**（`SCREENS §12-3/§12-4`：畫成 0 就能用
 * 總額÷場次反推、留佔位等於公告「這裡有一個價格」）。判斷由 RLS 做不由這個元件做。
 */
/*
 * ★ `spend_is_partial` 要看得出來而且是**逐年**的（全期那個只要任一年不完整就是 true，
 *   標上去等於沒標）。兩層缺一不可：① 數字寫「NT$3,120 以上」——中文不需圖例，而且它跟著
 *   數字走，截圖只截一列時但書仍在；② 長條右緣是虛線開口（單靠色差低於 WCAG 3:1，`DS §1.3`）。
 */
/*
 * 不用圖表庫（同 `DistributionBars`／`YearStrip`，`SCREENS §9b.4`）：HTML 排版在 375px 自動
 * 換行、螢幕閱讀器讀得到數字、鍵盤可達、零 canvas，而「虛線開口」CSS 一行就有。
 */
/**
 * 每一列三段 `{金額} / {場數} 場 / {票數} 張`（2026-09-07 指定，分隔用斜線不是全形空白）。
 * ⚠️ **場數與張數永遠完整，不可以跟著 `isPartial` 變灰**——不完整的只有金額。把兩個完整的
 * 數字染上「不完整」的訊號，是「把沒公開講成沒花錢」的鏡像。條件式只掛在金額那一段。
 */
const props = defineProps<{
  byYear: { year: number, spend: number, records: number, tickets: number, isPartial: boolean }[]
  currency: string
  /** 缺的那幾筆對本人是「沒記」、對路人是「沒公開」，文案不可共用。 */
  isOwn: boolean
  /**
     * 「只有你看得到這些數字。」要不要出現，預設出現。那句是為 `/u/` 寫的（回答「我分享出去
     * 別人看到什麼」）；`/app` 整頁私密，同一句在那裡不回答任何問題 ⇒ 傳 `:privacy-note="false"`。
     */
  privacyNote?: boolean
}>()

/**
 * ⚠️ **有紀錄的年份一列都不能少。** 第一版寫 `filter(y => y.spend > 0 || y.isPartial)`，實測抓到
 * 那是錯的：David **2015 年 2 場、票價都記了、合計 NT$0**（兌換票），那一列直接從圖上消失
 * ——年表有那一年、花費圖沒有（`SCREENS §12.1`：NT$0 不等於隱藏）。只濾 `records === 0`。
 */
const rows = computed(() => props.byYear.filter(y => y.records > 0))

const max = computed(() => Math.max(1, ...rows.value.map(y => y.spend)))
const anyPartial = computed(() => rows.value.some(y => y.isPartial))

/**
 * ⚠️ 顏色不可在 JS 裡用 `useColorMode()` 挑再寫進 inline style（#88／#168）。現在只在
 * `<ClientOnly>` 裡所以不會炸，但 `DistributionBars` 當初也是「只在 `ssr: false` 的 `/app`」，
 * 搬一次就炸了。亮暗兩組都印成 custom property，由 `dark:` variant 挑。
 */
const BAR_VARS = {
  '--spend-fill-l': CHART.light.heat[4],
  '--spend-fill-d': CHART.dark.heat[4],
  '--spend-track-l': CHART.light.heat[0],
  '--spend-track-d': CHART.dark.heat[0],
}

/**
 * 底下那一句小字。⚠️ **在 JS 端組好整串再插值**，不要在模板裡拆成相鄰元素——Vue 的 whitespace
 * `condense` 會把元素↔元素之間的換行空白整個吃掉（#92），兩句話會黏成別的形狀。
 * 有 partial 時先解釋「以上」（本人是「沒記」、路人是「沒公開」，文案不可共用），再接隱私那句。
 */
const footnote = computed<string | null>(() => {
  const privacy = props.isOwn && props.privacyNote !== false ? '只有你看得到這些數字。' : ''
  if (anyPartial.value) {
    return props.isOwn
      ? `標「以上」的年份有幾筆沒有記票價，那幾年的金額不是全部。${privacy}`
      : '標「以上」的年份有未公開的票價，那幾年的金額只是看得到的部分。'
  }
  return privacy || null
})

function width(spend: number): string {
  // ⚠️ **真正的 0 要畫成 0**，不能吃到下面那個下限：實測 2015 年合計 NT$0（兌換票）被
  //    `Math.max(2, …)` 撐出一小段條，等於暗示「有花錢」，而右邊的字寫著「免費」。
  if (spend === 0)
    return '0%'
  // 其餘至少 2%：金額很小的年份也要看得到自己有一條，否則會被讀成「那年沒去」
  return `${Math.max(2, (spend / max.value) * 100)}%`
}
</script>

<template>
  <div v-if="rows.length">
    <ul class="space-y-3" :style="BAR_VARS">
      <li v-for="y in rows" :key="y.year">
        <div class="flex items-baseline justify-between gap-3">
          <span class="shrink-0 text-sm tabular-nums text-toned">{{ y.year }}</span>
          <!--
            ★ 分隔的斜線是**兩個 span 之間的純文字節點**，`whitespace-nowrap` 只掛在兩個原子片段上：
              **nowrap 內部的空白不產生斷行點** ⇒ 把「 / 」寫進 nowrap span 裡，375px 會直接橫向溢出。
            ★ 反過來也不行——斷點絕不可落在數字與量詞之間（`utils/ticket.ts` 記過的「影城 數位」病）。
          -->
          <!--
            ⚠️ 整串寫在同一行是刻意的：元素↔元素之間的換行會被 whitespace 'condense' 吃掉（#92）。
            ⚠️ 顏色的條件式只掛在金額那一段——場數與張數永遠是完整的。
          -->
          <span class="min-w-0 text-right text-sm text-muted tabular-nums"><span class="whitespace-nowrap" :class="y.isPartial ? 'text-muted' : 'text-highlighted'">{{ spendText(y.spend, currency, y.isPartial) }}</span> / <span class="whitespace-nowrap">{{ spendCountsText(y.records, y.tickets) }}</span></span>
        </div>
        <div class="mt-1 h-2 w-full rounded-[1px] [background-color:var(--spend-track-l)] dark:[background-color:var(--spend-track-d)]">
          <!--
            ★ 涵蓋不完整的年份，長條右緣是**虛線開口**——形狀也在說「還沒完」。
              `border-r` 的虛線在 2px 高的條上看不出來，所以改用右側一小段
              重複的線性遮罩：純 CSS、不需要圖片、亮暗都跟著 fill 走。
          -->
          <div
            class="h-full rounded-[1px] [background-color:var(--spend-fill-l)] dark:[background-color:var(--spend-fill-d)]"
            :class="y.isPartial ? 'spend-open' : ''"
            :style="{ width: width(y.spend) }"
          />
        </div>
      </li>
    </ul>

    <!--
      逐年的記號負責「哪一年不完整」，這一句負責「不完整是什麼意思」，兩者都要。
      ⚠️ 整串在 script 端組好（見 `footnote`），不要拆回相鄰的 `<template>`（#92）。
    -->
    <p v-if="footnote" class="mt-3 text-sm text-muted">
      {{ footnote }}
    </p>
  </div>
</template>

<style scoped>
/*
  虛線開口：條的最右邊 10px 切成三段實／虛，讀起來像「還沒印完的收據」。
  用 mask 而不是疊一個假的背景色——疊底色的話換主題就要再維護一份色票，
  而 mask 只跟形狀有關（§5.4b：色票只有 CHART 一個來源）。
*/
.spend-open {
  mask-image: linear-gradient(
    to right,
    #000 calc(100% - 10px),
    #000 calc(100% - 8px),
    transparent calc(100% - 8px),
    transparent calc(100% - 6px),
    #000 calc(100% - 6px),
    #000 calc(100% - 4px),
    transparent calc(100% - 4px),
    transparent calc(100% - 2px),
    #000 calc(100% - 2px)
  );
}
</style>
