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

      `#header-year-scope`（2026-09-14 David：「往下滑時希望 header 也有選項可以直接切換
        年份」）：**永遠存在、預設是空的** teleport 落點，夾在字標與 `AppNav` 之間。
        `app/components/YearScopeBar.vue` 會在年表被捲出畫面之後，把年份切換器
        Teleport 進來；它的呼叫點是 `/app` 與 `/u/[username]` 年表那條 `ChartBand`
        的**後面**（那裡是它留下觀測用 sentinel 的位置）。
        為什麼是 teleport 而不是第二條 sticky bar：那條 bar 得釘 `top-[57px]`，
        而 57 是**抄**這裡的 `h-14`＋`border-b` 抄來的——列高一改，它不會編譯失敗、
        不會有測試變紅，只會靜靜錯開一條縫；而且多一層 sticky 就多一個 z 階要跟
        `UDrawer` 的遮罩（50，見 `app/app.config.ts` 的 z 階）對帳。
        ⚠️ **它是空的時候不可以佔位。** 這一行是 `flex items-center justify-between`，
        加進來之後是三個子元素——空的 div 寬 0、高 0，字標仍然靠左、`AppNav` 仍然靠右，
        視覺差異是零。所以它身上**不可以**有 padding／margin／`flex-1`，
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
