<script setup lang="ts">
/**
 * 折線圖圖例的那一小段線。實線（資料）或虛線（基準）。
 *
 * ── 為什麼圖例是 HTML 不是畫在 canvas 裡 ──────────────────────────────────
 * canvas 裡的圖例拿不到鍵盤與螢幕閱讀器（`DS §5.6`）。
 *
 * ── ★★ 為什麼要有這個元件，而不是在頁面上寫 `:style="{ background: … }"` ──
 * 顏色**不可以在 JS 裡用 `useColorMode()` 挑再寫進 inline style**（踩雷 #88）：
 * 伺服器端算出來的是一種模式、瀏覽器 hydrate 時是另一種 ⇒
 * `Hydration completed but contains mismatches`，而畫面看起來完全正常。
 *
 * `/app` 是 `ssr: false` 所以看不到，但 `/u/` 是 SSR——2026-09-06 把圖表搬過去時
 * 實測就炸了（`rendered on server: background:#29211A` vs
 * `expected on client: background:#F8EDDC`）。兩頁各寫一份 inline style
 * 的話，`/app` 那份會永遠看起來是對的，於是沒有人會發現 `/u/` 那份是錯的。
 *
 * 正解與 `YearStrip`／`DistributionBars` 同一招：亮暗兩組值都印成 custom property
 * （常數 ⇒ SSR 與 client 必然相同），由 Nuxt UI 註冊的 `dark:` variant 挑一組。
 */
const props = withDefaults(defineProps<{
  /** `ink` = 資料線（實線）；`baseline` = 歷年平均（虛線）。 */
  kind?: 'ink' | 'baseline'
}>(), { kind: 'ink' })

const vars = computed(() => (props.kind === 'baseline'
  // 基準線用 heat[2]，比資料線淡——它是對照不是主角
  ? { '--swatch-l': CHART.light.heat[2], '--swatch-d': CHART.dark.heat[2] }
  : { '--swatch-l': CHART.light.text0, '--swatch-d': CHART.dark.text0 }))
</script>

<template>
  <span
    v-if="kind === 'baseline'"
    class="inline-block h-0 w-4 border-t border-dashed align-middle [border-color:var(--swatch-l)] dark:[border-color:var(--swatch-d)]"
    :style="vars"
    aria-hidden="true"
  />
  <span
    v-else
    class="inline-block h-0.5 w-4 align-middle [background-color:var(--swatch-l)] dark:[background-color:var(--swatch-d)]"
    :style="vars"
    aria-hidden="true"
  />
</template>
