<script setup lang="ts">
import { useStaffGate } from './-admin-shared'

/**
 * 「你不是 staff」這件事的畫面。
 *
 * ⚠️ **這不是安全機制。** 真正的門在資料庫：`film_read` / `takedown_staff` /
 * `report_read` 那幾條 policy 的 `is_staff()` 分支，以及 `approve_film()`、
 * `merge_films()`、`admin_takedown()` 進門先問的那一句。把這個元件整個刪掉，
 * 非 staff 一樣什麼都拿不到——只是畫面會變成「沒有待審核的作品」，
 * 而那句話對非 staff 是**謊話**。
 *
 * 所以這裡問一次 `is_staff()`，只為了讓錯誤訊息是真的。
 * 「能打開這一頁」不等於「是 staff」，前端不做這個假設。
 *
 * ★★ **這支元件 render 出來的根，必須是一個永遠存在的單一元素**（2026-09-14 修）。
 *   `/admin/*` 四頁（`index`／`films`／`reports`／`takedowns`）的
 *   **頁面根節點就是這個元件**，而 `nuxt.config.ts` 的 `app.pageTransition` 已經
 *   全站生效 ⇒ `<Transition>` 的 hooks 掛在這裡 render 出來的根 vnode 上。
 *   通過分支原本寫的是裸的 `<slot v-else />`，render 出來的根是 **Fragment**——
 *   那正是 `nuxt.config.ts` 與 `DESIGN_SYSTEM §6` 兩處親手點名、**真的會噴**
 *   `Component inside <Transition> renders non-element root node that cannot be
 *   animated.` 的那一種（不是那種靜默的註解節點），而且淡入對它是 no-op。
 *   ⚠️ 那個警告是 **dev-only**，正式站只是沒有效果、不會有任何錯誤訊息；
 *      build／typecheck／lint／test 一次都不 render 這條路由，所以**沒有東西守得住它**。
 *   ⇒ 修法是模板裡那個**沒有 class 的外層 div ＋ 三個內層 `<template v-if>`**
 *     （`LegalDocumentView.vue`／`film/[slug].vue` 同一個寫法）。版面由各分支自己的
 *     容器、以及頁面自己的容器（`AdminShell`，`admin/index.vue` 是它自己那個
 *     `mx-auto max-w-5xl px-4 py-8`）決定，外層這一層純粹是 render 結構 ⇒ 視覺差異是零。
 *   ⚠️ **不要「簡化」成三個平行的 `<div v-if/v-else-if/v-else>`。** 那樣雖然也擺脫了
 *     Fragment，但根會在三個元素之間**互相替換**，`checking` 翻成 `isStaff` 的瞬間
 *     骨架與內容會各自播一次換頁的進／離場動畫。
 */
const { isStaff, checking, error } = useStaffGate()
</script>

<template>
  <div>
    <!--
      ★★ 這個**沒有任何 class** 的外層 div 有功能、不是排版裝飾：它是這支元件
         （＝`/admin/*` 四頁的頁面根節點）唯一「永遠存在的單一元素」，理由見檔頭。
         三個分支一律是內層的 <template v-if>，跟 `LegalDocumentView.vue` 同一個寫法。
      ⚠️ **不要把 v-if 搬回這一層、也不要把它拆掉。** 三個平行的 `<div v-if/v-else-if/v-else>`
         雖然也不是 Fragment，但那是三個**會互相替換**的根——換頁淡入的 hooks 每次
         render 都會重掛到當下那一個上，`checking` 翻成 `isStaff` 的瞬間骨架與內容會
         各自播一次進／離場。版面差異由各分支自己的容器（下面那兩個 class）承擔，
         這一層不負責外觀 ⇒ 加上它的視覺差異是零。
      ★★ **這段註解必須寫在 div 裡面**：`<template>` 的直接子註解自己就是一個根節點，
         寫在上面就又變回兩個根（2026-09-14 David 實跑在 `/u/` 抓到 `[NUXT_E4004]`，
         起因正是「修根節點」那一次改動把說明註解放在了根元素**上方**）。
         `tests/page-root.test.ts` 現在把這件事釘住，不再靠人記得。
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
