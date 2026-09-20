<script setup lang="ts">
import { useStaffGate } from './-admin-shared'

/**
 * 「你不是 staff」這件事的畫面。⚠️ **這不是安全機制**：真正的門在資料庫（那幾條 policy 的
 * `is_staff()` 分支，以及 RPC 進門先問的那一句）。把這個元件整個刪掉，非 staff 一樣什麼都
 * 拿不到——只是畫面會變成「沒有待審核的作品」，而那句話對非 staff 是**謊話**。
 */
/*
 * ★★ **這支 render 出來的根必須是一個永遠存在的單一元素**：`/admin/*` 四頁的頁面根節點就是
 * 這個元件，而 `app.pageTransition` 全站生效 ⇒ `<Transition>` 的 hooks 掛在這裡的根 vnode 上。
 * 通過分支原本是裸的 `<slot v-else />`，render 出來是 **Fragment**——那是會**真的噴**
 * `renders non-element root node` 的那一種，而且淡入對它是 no-op。
 */
/*
 * ⚠️ 那個警告是 **dev-only**，正式站只是沒有效果、不會有任何錯誤訊息；build／typecheck／
 * lint／test 一次都不 render 這條路由 ⇒ **沒有東西守得住它**（現在由 `tests/page-root.test.ts` 釘住）。
 * ⇒ 修法是模板裡那個沒有 class 的外層 div ＋ 三個內層 `<template v-if>`。
 */
/*
 * ⚠️ **不要「簡化」成三個平行的 `<div v-if/v-else-if/v-else>`**：那樣雖然也擺脫了 Fragment，
 * 但根會在三個元素之間**互相替換**，`checking` 翻成 `isStaff` 的瞬間骨架與內容會各自播一次
 * 換頁的進／離場動畫。
 */
const { isStaff, checking, error } = useStaffGate()
</script>

<template>
  <div>
    <!--
      ★★ 這個**沒有任何 class** 的外層 div 有功能、不是排版裝飾：它是這支元件（＝`/admin/*` 四頁
         的頁面根節點）唯一「永遠存在的單一元素」，理由見檔頭。三個分支一律是內層的 `<template v-if>`。
      ⚠️ **不要把 v-if 搬回這一層、也不要把它拆掉**（三個會互相替換的根會各自播一次進／離場）。
    -->
    <!--
      ★★ **這段註解必須寫在 div 裡面**：`<template>` 的直接子註解自己就是一個根節點，寫在上面就
         又變回兩個根（2026-09-14 實跑在 `/u/` 抓到 `[NUXT_E4004]`，起因正是「修根節點」那一次
         改動把說明註解放在了根元素**上方**）。`tests/page-root.test.ts` 現在把這件事釘住。
    -->
    <template v-if="checking">
      <div class="mx-auto max-w-5xl px-4 py-8">
        <USkeleton class="h-8 w-40" />
        <USkeleton class="mt-6 h-96 w-full rounded-sm" />
      </div>
    </template>

    <template v-else-if="!isStaff">
      <div class="mx-auto max-w-xl px-4 py-16">
        <h1 class="text-2xl font-bold tracking-tight">
          這一區只有審核人員能進來
        </h1>
        <p class="mt-3 text-muted">
          你的帳號沒有審核權限。就算硬進來也看不到任何資料——每一列都由資料庫的
          權限規則擋著，不是靠這一頁藏起來。
        </p>
        <p v-if="error" class="mt-3 text-sm text-muted">
          （查詢權限時發生錯誤：{{ error.message }}）
        </p>
        <UButton to="/app" class="mt-6" variant="soft" color="neutral">
          回到我的紀錄
        </UButton>
      </div>
    </template>

    <template v-else>
      <slot />
    </template>
  </div>
</template>
