<script setup lang="ts">
import tmdbLogo from '~/assets/tmdb-blue-square.svg'

/**
 * 顯名標示頁尾（`DESIGN_SYSTEM §9`、`SCREENS §15`）。**這不是禮貌區塊，是授權的生效要件**：
 * 政府資料開放授權條款第 1 版「未盡顯名標示義務者，**視為自始未取得授權**」——這兩段文字少
 * 一段，全站 2,764 部作品與 107 家電影院的授權就是自始不存在。所以它掛在 layout 上。
 */
/*
 * TMDB logo 的份量規則（DS §9.1，三條都要成立）：① 高度 ≤ 字標高度的 60%（14/24 = 58.3%）；
 * ② 面積 ≤ 字標面積的 50%（22.9%）；③ 字標是這一區的第一個品牌元素，logo 只在句尾。
 * 兩個元素各帶一個 `data-brand`，那是**規格的一部分不是可選的**——沒有它就無法驗收這三條。
 */
/*
 * ⚠️ 尺寸寫死成 px 而不是 `text-` 尺標：這個比值是對 TMDB 條款的承諾，不可以跟著哪一天有人
 * 調字級一起漂走。⚠️ TMDB 亮藍與我們的 amber-400 **明度與 chroma 幾乎相同、色相差 134°**，
 * 也就是那個 logo 在視網膜上跟我們的重點色一樣大聲 ⇒ logo 附近不放琥珀元素（四條法遵連結
 * 是唯一例外，且刻意排在它下面一列）。
 */
/*
 * 為什麼是 `<img>` 不是 inline SVG：官方素材裡有 `<style>.cls-1{…}</style>` 與一個 id，
 * inline 進 HTML 之後兩者都會落在**文件層級**跟站上同名的東西撞（SVG 的 `<style>` 在 HTML 裡
 * 不是 scoped）。用 `<img>` 還順帶保證送出去的位元組與官方檔**逐位元組相同**——商標不可以
 * 改色、不可以重繪。2,577 bytes < Vite 的 4KB 門檻 ⇒ 實際上會變成 data URI，不多一個請求。
 */

/** 官方素材 viewBox `0 0 185.04 133.4`。比例固定，換素材前不要動這個數字。 */
const TMDB_RATIO = 185.04 / 133.4
const TMDB_HEIGHT = 14
const WORDMARK_HEIGHT = 24

const legalLinks = [
  { to: '/legal/terms', label: '服務條款' },
  { to: '/legal/privacy', label: '隱私權政策' },
  { to: '/legal/copyright', label: '著作權政策' },
  { to: '/legal/dmca', label: '侵權通知' },
]
</script>

<template>
  <footer class="mt-12 border-t border-default">
    <div class="mx-auto max-w-5xl px-4 py-8 text-[13px] leading-relaxed text-muted">
      <!-- ③ 字標在前：這一區的第一個品牌元素 -->
      <BrandWordmark data-brand="filmnote" :height="WORDMARK_HEIGHT" class="text-highlighted" />

      <p class="mt-4 max-w-[74ch]">
        本站部分資料採用文化部影視及流行音樂產業局「電影片分級及相關資訊」與「全國電影院資料」開放資料，依政府資料開放授權條款第 1 版提供。
      </p>

      <!--
        ⚠️ logo 與句子之間的間距由 `ms-1.5` 給，**不是靠標籤之間的空白**。
        Vue 的 whitespace 處理預設是 'condense'，相鄰元素之間的換行會被吃掉，
        靠空白做間距會 render 成「…by TMDB.[logo]」黏在一起。
      -->
      <p class="mt-1.5 max-w-[74ch]">
        This product uses the TMDB API but is not endorsed or certified by TMDB.<img
          data-brand="tmdb"
          :src="tmdbLogo"
          alt="TMDB"
          :width="Math.round(TMDB_HEIGHT * TMDB_RATIO * 100) / 100"
          :height="TMDB_HEIGHT"
          :style="{ height: `${TMDB_HEIGHT}px`, width: `${TMDB_HEIGHT * TMDB_RATIO}px` }"
          class="ms-1.5 inline-block align-middle"
        >
      </p>

      <nav class="mt-4 flex flex-wrap gap-x-5 gap-y-1">
        <NuxtLink
          v-for="link in legalLinks"
          :key="link.to"
          :to="link.to"
          class="text-primary hover:underline"
        >
          {{ link.label }}
        </NuxtLink>
      </nav>
    </div>
  </footer>
</template>
