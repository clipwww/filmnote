<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * 金額摘要那一句，**只在 client 端執行**。資料與「每年花費」band 共用 `useUserSpend()`
 * ——**同一個 key、同一次請求、同一份答案**：兩份查詢一定會在某次修改後對「看不看得到」
 * 「是不是全部」給出不同答案，而沒有人會把同一頁的兩個地方擺在一起看。
 */
/*
 * ★ 聚合是推論通道：拿得到的列可能只是全部的一部分 ⇒ 一定要標示「部分票價未公開」，
 * 而不是給一個看起來完整的總額。
 */
const props = defineProps<{ username: string }>()

const username = computed(() => props.username)
const { spend } = useUserSpend(username)

/**
 * `花了 NT$5x,xxx`（§4.4：數字不做成 stat tile，排成一行有量詞的句子）。
 * 涵蓋不完整時數字本身就帶「以上」，不是只靠底下那行小字。
 */
const segments = computed<StatSegment[]>(() => {
  const d = spend.value
  if (!d)
    return []
  return [{ prefix: '花了', value: spendText(d.total, d.currency, d.isPartial) }]
})
</script>

<template>
  <!--
    ★ `canSeeMoney` 為 false ⇒ **整個章節不存在**（`SCREENS §12-3`）。不是畫成 0、不是打馬賽克
      （否則總額÷場次就能反推個別票價），也不留佔位（§12-4「絕不渲染 NT$ ———」，那等於公告
      「這裡有一個價格」，反而洩漏了「這個人有記帳」）。
  -->
  <section v-if="spend?.canSeeMoney" class="mt-6">
    <StatLine :segments="segments" />
    <!--
      「涵蓋不完整」對本人與對路人是兩件不同的事，文案不能共用一句：
      本人看得到全部的票價列，缺的那幾筆是**根本沒記**；
      路人缺的那幾筆是**沒有公開**。混講會讓本人以為自己的資料被藏起來了。
    -->
    <p v-if="spend.isPartial" class="mt-1 text-sm text-muted">
      <template v-if="spend.isOwn">
        其中 {{ spend.unknownRecords }} 筆沒有記票價，這不是全部的花費。只有你看得到這個數字。
      </template>
      <template v-else>
        部分票價未公開，此金額只涵蓋 {{ spend.countedRecords }} / {{ spend.visibleRecords }} 筆紀錄。
      </template>
    </p>
    <p v-else-if="spend.isOwn" class="mt-1 text-sm text-muted">
      只有你看得到這個數字。
    </p>
  </section>
</template>
