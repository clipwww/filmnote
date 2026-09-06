<script setup lang="ts">
import type { DistItem } from '~/utils/stats'

/**
 * 分布長條（`SCREENS.md §9` band 5/6）。影城、版本、國別共用。
 *
 * ── 為什麼不是圓餅圖 ──────────────────────────────────────────
 * 實測 David 的分布極度傾斜：影城 115/169（68%）、國別 日本 98／美國 66／
 * 其餘 5 筆、版本 2D 126／4DX 20／IMAX 7。一個佔 68% 的扇形不傳達任何東西，
 * 而 375px 下每個標籤只分到約 90px，`林口MITSUI OUTLET PARK威秀影城`
 * 會被截到無法辨識（§5.2）。
 *
 * ── 為什麼這一張不用 ECharts ──────────────────────────────────
 * §5.2 要「標籤壓在條上」是為了讓長中文片名有整個容器寬可用；§1.3 又要求
 * 「條的填色不要用色階淺端，標籤要壓在條上就把標籤移到條的上方一行」。
 * 兩條加起來的結論就是**名稱自己一行、條在下面一行**——那是 HTML 排版，
 * 不是圖表。用 CSS 做還順便拿到：375px 自動換行、螢幕閱讀器讀得到數字、
 * 鍵盤可達、零 canvas。年表 YearStrip 也是同樣的理由不用圖表庫。
 *
 * ── ★★ 顏色不可以在 JS 裡用 `useColorMode()` 挑（踩雷 #88）─────────────────
 * 這支本來寫成 `const fill = computed(() => chartPalette(colorMode.value === 'dark')…)`
 * 再寫進 inline style。**在 `ssr: false` 的 `/app` 上完全正常**，
 * 2026-09-06 把它搬到 SSR 的 `/u/` 之後立刻炸：
 *
 *   [Vue warn] Hydration style mismatch
 *     - rendered on server: style="background-color:#685946"   ← 亮色的 heat[4]
 *     - expected on client: style="background-color:#A59788"   ← 暗色的 heat[4]
 *   Hydration completed but contains mismatches.
 *
 * 伺服器端算出來的是一種模式、瀏覽器 hydrate 時是另一種，而**畫面看起來
 * 完全正常**，只在 console 留一行。前一棒的交接筆記就是這樣預言的：
 * 「`/app` 是 `ssr: false` 所以看不到，同一個元件搬到 `/u/` 就會炸」。
 *
 * 正解（與 `YearStrip` 同一招）：把**亮暗兩組值都**印成 custom property
 * ——兩邊都是常數，SSR 與 client 必然相同——再由 Nuxt UI 註冊的
 * `@variant dark (&:where(.dark, .dark *))` 決定用哪一組。
 * ⚠️ 不要改用 SFC `<style scoped>` 裡的 `:global(.dark) X` 去挑，**實測沒有生效**。
 */
defineProps<{
  items: DistItem[]
  /** 場次的量詞，例如「場」。 */
  unit?: string
}>()

/**
 * 條的填色用 `heat[4]`，軌道用 `heat[0]`——不是色階淺端，淺端會讓條分不出長短（§1.3）。
 * 值仍然只有 `CHART` 一個來源，這裡只是把兩組都帶出去。
 */
const BAR_VARS = {
  '--bar-fill-l': CHART.light.heat[4],
  '--bar-fill-d': CHART.dark.heat[4],
  '--bar-track-l': CHART.light.heat[0],
  '--bar-track-d': CHART.dark.heat[0],
}
</script>

<template>
  <ul class="space-y-3" :style="BAR_VARS">
    <li v-for="(it, i) in items" :key="it.name">
      <div class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 text-sm" :class="i === 0 ? 'font-medium text-highlighted' : 'text-toned'">
          {{ it.name }}
        </span>
        <span class="shrink-0 text-sm tabular-nums text-muted">{{ it.records }}{{ unit ?? '' }}</span>
      </div>
      <div class="mt-1 h-2 w-full rounded-[1px] [background-color:var(--bar-track-l)] dark:[background-color:var(--bar-track-d)]">
        <!--
          寬度仍然是 inline style，那沒問題——它是純資料算出來的，
          SSR 與 client 必然相同。會對不起來的只有「依模式挑值」的那一種。
        -->
        <div
          class="h-full rounded-[1px] [background-color:var(--bar-fill-l)] dark:[background-color:var(--bar-fill-d)]"
          :style="{ width: `${Math.max(2, (it.records / Math.max(1, items[0]?.records ?? 1)) * 100)}%` }"
        />
      </div>
    </li>
  </ul>
</template>
