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
 */
defineProps<{
  items: DistItem[]
  /** 場次的量詞，例如「場」。 */
  unit?: string
}>()

const colorMode = useColorMode()
/** 條的填色用 heat[4]，不是色階淺端——淺端會讓條分不出長短（§1.3）。 */
const fill = computed(() => chartPalette(colorMode.value === 'dark').heat[4])
const track = computed(() => chartPalette(colorMode.value === 'dark').heat[0])
</script>

<template>
  <ul class="space-y-3">
    <li v-for="(it, i) in items" :key="it.name">
      <div class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 text-sm" :class="i === 0 ? 'font-medium text-highlighted' : 'text-toned'">
          {{ it.name }}
        </span>
        <span class="shrink-0 text-sm tabular-nums text-muted">{{ it.records }}{{ unit ?? '' }}</span>
      </div>
      <div class="mt-1 h-2 w-full rounded-[1px]" :style="{ backgroundColor: track }">
        <div
          class="h-full rounded-[1px]"
          :style="{
            backgroundColor: fill,
            width: `${Math.max(2, (it.records / Math.max(1, items[0]?.records ?? 1)) * 100)}%`,
          }"
        />
      </div>
    </li>
  </ul>
</template>
