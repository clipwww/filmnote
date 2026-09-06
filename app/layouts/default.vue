<script setup lang="ts">
const user = useSupabaseUser()
</script>

<template>
  <div class="min-h-dvh flex flex-col bg-default text-default">
    <header class="border-b border-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
        <NuxtLink to="/" class="flex items-center gap-2 text-highlighted" aria-label="影記 首頁">
          <!-- §2.6：字標是路徑不是字型。同一個元件也用在頁尾的顯名區，
               DS §9.1 的份量比值算的就是它——兩處必須是同一個東西。 -->
          <BrandWordmark :height="22" />
          <span class="text-[13px] text-muted">filmnote</span>
        </NuxtLink>
        <!--
          ⚠️ **這一顆按鈕必須包在 `<ClientOnly>` 裡**，原本沒有包，是壞的。

          `server/middleware/strip-auth-on-cacheable.ts` 讓 `/`、`/film/**`、`/venue/**`、
          `/legal/**` 的 SSR 一律 render 成未登入（那是對的，見該檔），
          ⇒ **已登入者在這幾頁上必然 hydration mismatch**。而 Vue 對 mismatch 的補救
          是不對稱的：**文字節點會被改正，屬性只會被警告不會被改**
          （hydrateElement 只 patch `on*` 事件，不 patch 一般 attribute）。
          於是實測到的畫面是：文字換成「我的紀錄」，`href` 卻還停在 `/login`
          ——已登入的人按下去會被丟去登入頁。2026-09-06 實測 `/`、`/film/*`、
          `/legal/*` 三處皆然；`/search` 不在拔 cookie 的名單裡所以是對的。

          ⚠️ 把 `to` 改成綁定值（讓它進 dynamicProps）**沒有用**，實測過。
          唯一乾淨的解法是讓伺服器與客戶端的第一次算繪一致：`<ClientOnly>` 的
          fallback 就是伺服器輸出的東西，掛載後才換成真的狀態，所以不存在 mismatch。
          fallback 保留一顆可用的「登入」按鈕，沒有 JS 的訪客也還有路可走。
        -->
        <nav class="flex items-center gap-2 text-sm">
          <ClientOnly>
            <UButton
              :to="user ? '/app' : '/login'"
              :variant="user ? 'ghost' : 'soft'"
              size="sm"
            >
              {{ user ? '我的紀錄' : '登入' }}
            </UButton>
            <template #fallback>
              <UButton to="/login" variant="soft" size="sm">
                登入
              </UButton>
            </template>
          </ClientOnly>
        </nav>
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
