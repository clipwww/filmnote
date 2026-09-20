<template>
  <div class="min-h-dvh flex flex-col bg-default text-default">
    <!--
      頂部導覽列。`sticky top-0`（少了 `top-0` 等於沒作用；祖先鏈都沒有 overflow／transform
      ⇒ 黏的是文件本身，#185）。`z-30` 是全站 z 階第一階（導覽 30／遮罩 50／toast 100）。
    -->
    <!--
      ⚠️ `z-30` 必須 > 1：`/app/records` 釘住的 `<th>` 帶著 `z-1`，而它的祖先都不建立堆疊脈絡，
         那個 z-1 一路穿到根脈絡 ⇒ 給 z-1 會同值輸給樹序在後的 th，不給 z 輸得更慘。
    -->
    <!--
      `bg-default` **不透明**：刻意不抄官方 UHeader 的半透明＋blur（DS §0「不用漸層不用發光」，
      而且首頁 hero 是整面海報牆，`index.vue` 記過次要文字 4.11:1 的舊帳）。用 token 而不是直接
      指名色票，是為了跟根 div 用同一個，這次改動的視覺差異才會是零。
    -->
    <!--
      ⚠️ 根 div 的 `bg-default` 是 paper-25／900，而 main.css 給 body 的是台紙 paper-50／950
         ——兩者對不上是既有問題，等 David 裁決，**這一輪刻意不順手改**（改了會多出一條色帶）。
      ⚠️ 內層 `h-14` 不要動（56px ＋ border 1 ⇒ 總高 57px）。換成 `h-(--ui-header-height)` 會變 64px。
    -->
    <!--
      `#header-year-scope`：**永遠存在、預設是空的** teleport 落點，夾在字標與 `AppNav` 之間。
      為什麼不是第二條 sticky bar：那條得釘 `top-[57px]`，而 57 是抄這裡的 `h-14`＋border 來的
      ——列高一改它不會編譯失敗也不會有測試變紅，只會靜靜錯開一條縫。
    -->
    <!--
      ⚠️ **它是空的時候不可以佔位**：這一行是 `flex items-center justify-between`，空的 div 寬高
         都是 0 ⇒ 視覺差異是零。所以它身上不可以有 padding／margin／`flex-1`，
         這一行也不要改成 `gap-*`（那會在它空著的時候憑空多出兩道間隙）。
    -->
    <header class="sticky top-0 z-30 border-b border-default bg-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
        <NuxtLink to="/" class="flex items-center gap-2 text-highlighted" aria-label="影記 首頁">
          <!-- §2.6：字標是路徑不是字型。同一個元件也用在頁尾的顯名區，
               DS §9.1 的份量比值算的就是它——兩處必須是同一個東西。 -->
          <BrandWordmark :height="22" />
          <span class="text-[13px] text-muted">filmnote</span>
        </NuxtLink>

        <!-- 年份切換器的落點。空的時候寬 0、視覺零影響——理由與限制見上面那段註解。 -->
        <div id="header-year-scope" class="flex min-w-0 items-center" />

        <!--
          右上功能選單。`AppNav` 自己包 `<ClientOnly>`：選單內容取決於身分，而
          `strip-auth-on-cacheable.ts` 讓 `/`、`/film/**`、`/venue/**`、`/legal/**` 的 SSR 一律看不到
          身分 ⇒ 不包就是必然的 hydration mismatch，而 Vue 只改正文字不改正屬性（#98，實測過）。
        -->
        <AppNav />
      </div>
    </header>

    <main class="flex-1">
      <slot />
    </main>

    <!-- 顯名標示是授權的生效要件，不是禮貌（政府資料開放授權條款第 1 版）。
         元件內有三條份量規則與驗收方式。 -->
    <AttributionFooter />
  </div>
</template>
