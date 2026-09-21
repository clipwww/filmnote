<script setup lang="ts">
/**
 * `/app/records/<id>/edit` — 2026-09-21 起**不再是一張表單**，只是一個轉址。
 *
 * 編輯改成在 `/app/records` 開抽屜（David 第 1 條：「不使用換頁，這樣不用處理返回上一頁
 * 狀態都被清掉」）。這個檔留著是為了**深連結不要死**：舊的書籤、貼出去的網址、
 * 以及任何我沒找到的入口，都還會走到這裡。
 *
 * ⚠️ `replace: true` 是必要的：用 push 的話，使用者從這個網址進來、關掉抽屜之後按
 * 「上一頁」會回到這個轉址頁、然後又被送回抽屜 ⇒ 上一頁變成永遠出不去的迴圈。
 */
const route = useRoute()
await navigateTo(
  { path: '/app/records', query: { edit: String(route.params.id) } },
  { replace: true },
)
</script>

<template>
  <div>
    <!--
      ⚠️ 轉址頁也要有**恰好一個根元素**：`tests/page-root.test.ts` 掃的是 `app/pages/**`
         每一個 `.vue`，不因為它不算「畫面」而例外。而且說明註解只能寫在根元素**之內**
         ——`<template>` 的直接子註解自己就是一個根節點（這一條我當場踩到了一次）。
    -->
  </div>
</template>
