<script setup lang="ts">
/**
 * 「每年花費」（David 2026-09-06 裁決：`/u/` 要做金額相關的圖表）。
 *
 * ── ★★ 「時有時無」是要設計的東西，不是要迴避的東西 ──────────────────────
 * 這條 band 對三種觀看者長得不一樣，而三種都必須是對的：
 *
 * | 觀看者 | 看得到什麼 |
 * |---|---|
 * | 本人 | 全部。缺的幾筆是**自己沒記** |
 * | 路人 ＋ `show_cost = true` | 公開紀錄的票價。缺的幾筆是**沒公開** |
 * | 路人 ＋ `show_cost = false` | **一列都拿不到 ⇒ 整條 band 不存在** |
 *
 * 第三種**不是畫成 0、不是打馬賽克、不留佔位**（`SCREENS §12-3`／`§12-4`）：
 * 畫成 0 的話 `總花費 ÷ 場次` 就能反推個別票價，隱私是假的；留一個
 * 「NT$ ———」的佔位則等於公告「這裡有一個價格」，反而洩漏了「這個人有記帳」。
 * 判斷不由這個元件做，由 RLS 做——`useUserSpend()` 的 `canSeeMoney`
 * 數的是**讀得到幾列票價**。
 *
 * ── ★ `spend_is_partial` 一定要看得出來，而且是逐年的 ────────────────────
 * 「使用者看到一張『每年花費』而不知道那是部分資料，比沒有這張圖更糟
 * ——那會讓他以為朋友一年只花了那麼多。」（David）
 *
 * 所以做了兩層，缺一不可：
 * ① **數字本身**寫「NT$3,120 以上」。中文裡不需要圖例就讀得懂，而且它跟著
 *    數字走——使用者截圖只截到一列時，那個但書仍然在。
 * ② **長條的右緣是虛線開口**，形狀也在說「還沒完」。單靠色差不行
 *    （`DS §1.3`：墨階相鄰階的對比低於 WCAG 1.4.11 的 3:1），
 *    而單靠底下一行小字會被跳過。
 *
 * ⚠️ 旗標是**逐年**的。全期那個 `spend_is_partial` 只要任何一年有未公開票價
 * 就是 true，標上去會讓每一年都掛著同一個但書——那等於沒有標。
 *
 * ── 為什麼不用圖表庫 ──────────────────────────────────────────────────────
 * 同 `DistributionBars` 與 `YearStrip`（`SCREENS §9b.4`）：名稱一行、條一行的
 * HTML 排版，375px 自動換行、螢幕閱讀器讀得到數字、鍵盤可達、零 canvas。
 * 而且「虛線開口」用 CSS 一行就有，canvas 要自己畫。
 */
const props = defineProps<{
  byYear: { year: number, spend: number, records: number, isPartial: boolean }[]
  currency: string
  /** 缺的那幾筆對本人是「沒記」、對路人是「沒公開」，文案不可共用。 */
  isOwn: boolean
}>()

/**
 * ⚠️ **有紀錄的年份一列都不能少。**
 *
 * 第一版寫 `filter(y => y.spend > 0 || y.isPartial)`，理由是「金額 0 的年份
 * 只會是一排空條」。實測抓到那是錯的：David 的 **2015 年 2 場、票價都記了、
 * 合計 NT$0**（兌換票），那一列直接從圖上消失——**年表上有那一年、
 * 花費圖上沒有**，而畫面看起來完全正常。
 * `SCREENS §12.1` 講的就是這件事：**NT$0 不等於隱藏。**
 *
 * 現在只濾掉「那一年根本沒有紀錄」的列（`records === 0`）；
 * 金額為 0 的年份照列，數字寫「免費」（見 `spendText()`）。
 */
const rows = computed(() => props.byYear.filter(y => y.records > 0))

const max = computed(() => Math.max(1, ...rows.value.map(y => y.spend)))
const anyPartial = computed(() => rows.value.some(y => y.isPartial))

/**
 * ⚠️ 顏色不可以在 JS 裡用 `useColorMode()` 挑再寫進 inline style（踩雷 #88／#168）。
 * 這個元件目前只在 `<ClientOnly>` 裡出現，所以現在不會炸——但 `DistributionBars`
 * 當初也是「只在 `ssr: false` 的 `/app` 上」，搬一次就炸了。
 * 亮暗兩組值都印成 custom property，由 Nuxt UI 註冊的 `dark:` variant 挑。
 */
const BAR_VARS = {
  '--spend-fill-l': CHART.light.heat[4],
  '--spend-fill-d': CHART.dark.heat[4],
  '--spend-track-l': CHART.light.heat[0],
  '--spend-track-d': CHART.dark.heat[0],
}

function width(spend: number): string {
  // ⚠️ **真正的 0 要畫成 0**，不能吃到下面那個下限。實測 2015 年合計 NT$0
  //    （兌換票）被 `Math.max(2, …)` 撐出一小段條，等於在暗示「有花錢」，
  //    而右邊的字寫著「免費」——圖與字互相矛盾。意義由「免費」那兩個字負責，
  //    條就該是空的。
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
          <span class="min-w-0 text-right text-sm tabular-nums" :class="y.isPartial ? 'text-muted' : 'text-highlighted'">
            {{ spendText(y.spend, currency, y.isPartial) }}
          </span>
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
      逐年的記號負責「哪一年不完整」，這一句負責「不完整是什麼意思」。
      兩者都要：只有記號的話沒有人知道「以上」在講什麼；只有這一句的話
      使用者不知道是哪幾年。
    -->
    <p v-if="anyPartial" class="mt-3 text-sm text-muted">
      <template v-if="isOwn">
        標「以上」的年份有幾筆沒有記票價，那幾年的金額不是全部。只有你看得到這些數字。
      </template>
      <template v-else>
        標「以上」的年份有未公開的票價，那幾年的金額只是看得到的部分。
      </template>
    </p>
    <p v-else-if="isOwn" class="mt-3 text-sm text-muted">
      只有你看得到這些數字。
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
