<template>
  <div class="min-h-dvh flex flex-col bg-default text-default">
    <!--
      頂部導覽列（David 口中的「TopBar」——這個 repo 沒有 AppTopBar.vue，就是這一條）。

      `sticky top-0`：sticky 少了 `top-0` 等於沒作用。祖先鏈只有 `div.min-h-dvh`／`body`／
        `html`，三者都沒有 overflow／transform ⇒ 黏的就是文件本身（踩雷 #185：sticky 黏的是
        「最近的捲動祖先」，黏錯祖先時「position 是不是 sticky」那條斷言照樣是綠的）。
      `z-30`：全站 z 階的第一階（導覽 30 ／ 遮罩層 50 ／ toast 100，見 app/app.config.ts）。
        必須 > 1——`/app/records` 釘住的 `<th>` 帶著 `z-1`（`.nuxt/ui/table.ts`），而它的祖先
        `thead(relative)`／table `base(overflow-clip)`／UTable root(`relative` z:auto) 都不建立
        堆疊脈絡，那個 z-1 一路穿到根脈絡。給 z-1 會同值輸給樹序在後的 th，不給 z 輸得更慘。
      `bg-default`：**不透明**。刻意不抄官方 UHeader 的 `bg-default/75 backdrop-blur-sm`
        ——DS §0「不用漸層。不用發光。」，而且首頁 hero 是整面海報牆（index.vue 記過次要文字
        4.11:1 的舊帳），半透明壓上去會重演同一個事故。
        用 `bg-default` 而不是直接指名 paper-50／paper-950 的色票，是為了跟同檔第 2 行的
        根 div 用同一個 token，這次改動的視覺差異才會是零。
        ⚠️ 根 div 的 `bg-default` 目前是 paper-25／paper-900，而 main.css 給 body 的是
        DS §1.1 的台紙 paper-50／paper-950——兩者對不上是既有問題，等 David 裁決，
        **這一輪刻意不順手改**（改了就會在導覽列與內容之間多出一條色帶）。
      內層 `h-14` 不要動：那是 56px（＋`border-b` 1px ⇒ 總高 57px）。換成 Nuxt UI 的
        `h-(--ui-header-height)` 會變 4rem＝64px，平白長高 8px。
      不需要給 `<main>` 補 padding-top：sticky 仍佔正常流的位置，不會蓋住內容也不會跳版。
    -->
    <header class="sticky top-0 z-30 border-b border-default bg-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
        <NuxtLink to="/" class="flex items-center gap-2 text-highlighted" aria-label="影記 首頁">
          <!-- §2.6：字標是路徑不是字型。同一個元件也用在頁尾的顯名區，
               DS §9.1 的份量比值算的就是它——兩處必須是同一個東西。 -->
          <BrandWordmark :height="22" />
          <span class="text-[13px] text-muted">filmnote</span>
        </NuxtLink>
        <!--
          右上功能選單。`AppNav` 自己包 `<ClientOnly>`：選單內容取決於身分，
          而 `strip-auth-on-cacheable.ts` 讓 `/`、`/film/**`、`/venue/**`、
          `/legal/**` 的 SSR 一律看不到身分 ⇒ 不包就是必然的 hydration
          mismatch，而 Vue 只改正文字不改正屬性（踩雷 #98，實測過）。
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
