<script setup lang="ts">
/**
 * 一條 band（`SCREENS.md §9`）。垂直長卷、一個 band 一張圖、滿容器寬，不是 2×2 的卡片牆。
 * ⚠️ **圖表一律畫在這張卡片上（`bg-default` 票根紙），不要直接放在裸台紙上**：零格對背景的
 * 對比亮色放卡片上 1.27:1、放台紙上只剩 1.16:1，整張圖看起來「少了一層」（§1.3）。
 */
/*
 * 每個 band 都要有資料表 fallback（§5.6）：heatmap 不支援 decal、色盲友善完全靠單色相明度階，
 * 而螢幕閱讀器從 canvas 什麼都拿不到。這份表同時也是「我就是想看數字」的人要的東西，
 * 以及對帳破洞的工具（§5.4b：資料表有值的格子在圖上都要有顏色）。
 */
defineProps<{
  title: string
  /** 圖說那一句話。**在 JS 端組好整串再傳進來**——切成相鄰元素靠空白分隔會被
   *  Vue 的 whitespace 'condense' 吃掉（見 utils/format-datetime.ts 檔頭）。 */
  insight?: string | null
  /** 資料的但書，例如「12 筆沒有記時間，沒有進這張圖」。 */
  note?: string | null
  tableSummary?: string
}>()

defineSlots<{
  default?: () => unknown
  caption?: () => unknown
  table?: () => unknown
}>()
</script>

<template>
  <section class="rounded-sm border border-default bg-default px-4 py-5">
    <h2 class="text-lg font-semibold text-highlighted">
      {{ title }}
    </h2>

    <slot name="caption" />
    <p v-if="insight" class="mt-1 text-toned">
      {{ insight }}
    </p>

    <div class="mt-4">
      <slot />
    </div>

    <p v-if="note" class="mt-3 text-sm text-muted">
      {{ note }}
    </p>

    <details v-if="$slots.table" class="mt-4 text-sm">
      <summary class="cursor-pointer text-muted select-none">
        {{ tableSummary ?? '看數字' }}
      </summary>
      <!-- 寬內容在自己的容器內捲動，頁面 body 永遠不橫向捲（§10 品質底線） -->
      <div class="mt-3 overflow-x-auto">
        <slot name="table" />
      </div>
    </details>
  </section>
</template>
