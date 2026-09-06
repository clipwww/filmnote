<script setup lang="ts">
/**
 * `/legal/copyright` — 著作權政策（`SCREENS §15.2`、`BUILD_PLAN §6.1 ③`）。
 *
 * **這一頁是顯名標示的正式落點。** 頁尾的 `AttributionFooter` 只是每頁的縮寫版，
 * 全文在這裡：政府開放資料的資料集全名、TMDB 聲明、海報政策、三振條款、受理窗口。
 * 政府資料開放授權條款第 1 版：「未盡顯名標示義務者，視為自始未取得授權」。
 *
 * 正文（第 1–6 節）在 `legal_document`（`kind='copyright_policy'`）。
 * 這一頁在正文之後補兩件**正文給不了的東西**：
 *
 * ① **受理窗口的實際信箱。** 正文寫的是「本服務公告之著作權聯繫信箱」——
 *    條款正文裡不寫死信箱是對的（信箱換了要改的是公告不是條款，而已被同意過的
 *    條款依 0007 的 `legal_doc_immutable` 根本改不動），但「公告」總得有個地方，
 *    那個地方就是這一頁。
 *
 * ② **連到使用者自己的三振狀態。** §15.2：「條款寫了但使用者查不到自己有幾次，
 *    第三次就是突襲。」這一條只有登入者需要，而這一頁是 prerender 的靜態檔
 *    ⇒ 包在 `<ClientOnly>` 裡，掛載後才知道有沒有人在看。
 *    （順帶：`server/middleware/strip-auth-on-cacheable.ts` 對 `/legal/**` 拔 cookie，
 *     所以就算改成 SSR，伺服器端也一律看不到身分——這一段只能在 client 判斷。）
 */
const user = useSupabaseUser()

/**
 * ⚠️ 寫死在這裡是**已知的暫時解**。`.env` 有 `COPYRIGHT_CONTACT_EMAIL`，
 * 但它沒有進 `runtimeConfig.public`，而 `nuxt.config.ts` 是共用檔、
 * 動之前要先問主 session。搬進 runtimeConfig 之前，改信箱要記得改這裡。
 * 值與 `BUILD_PLAN §6.1 ③` 和 `.env` 一致。
 */
const CONTACT_EMAIL = 'copyright@filmnote.tw'

useSeoMeta({
  title: '著作權政策',
  description: '影記的資料來源與顯名標示、海報政策、侵權通知與取下流程、回復通知與三振條款。',
  robots: 'index, follow',
})
</script>

<template>
  <LegalDocumentView kind="copyright_policy">
    <template #after>
      <section class="mt-10 border-t border-default pt-6">
        <h2 id="contact" class="scroll-mt-20 text-xl/[1.4] font-semibold text-highlighted">
          受理窗口
        </h2>
        <!--
          ⚠️ 信箱**自成一行**，不夾在句子中間。中文句子與行內元素之間一斷行，
          Vue 的 whitespace 'condense' 就會留下一個空格，於是變成
          「…請寄到 copyright@… ，或直接用…」——標點前面多一個空隙。
          自成一行順帶讓人比較好選取複製，這一行是受理窗口，被複製的次數不會少。
        -->
        <p class="mt-3.5 max-w-[34em]">
          著作權相關的通知請寄到下面這個信箱，或直接用侵權通知表單——表單會把著作權法第 90 條之 6 要求記載的事項一次收齊，處理起來會快一點。
        </p>
        <p class="mt-2">
          <a :href="`mailto:${CONTACT_EMAIL}`" class="text-primary hover:underline">{{ CONTACT_EMAIL }}</a>
        </p>
        <UButton to="/legal/dmca" variant="soft" class="mt-4">
          填侵權通知表單
        </UButton>
      </section>

      <!--
        三振狀態：只有登入者看得到，而且 `strike_count = 0` 時 /app/settings
        那一區整塊不出現（§15.5）——所以這裡的措辭是「查看自己的狀態」，
        不是「你有幾次」。沒有事的人不該被這一行嚇到。
      -->
      <ClientOnly>
        <p v-if="user" class="mt-6 max-w-[34em] text-[13px] text-muted">
          第 5 節的三振條款對應到你自己的帳號狀態。
          <NuxtLink to="/app/settings" class="text-primary hover:underline">
            在帳號設定裡看得到 →
          </NuxtLink>
        </p>
      </ClientOnly>
    </template>
  </LegalDocumentView>
</template>
