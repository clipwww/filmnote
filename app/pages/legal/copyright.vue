<script setup lang="ts">
/**
 * `/legal/copyright` — 著作權政策（`SCREENS §15.2`）。**這一頁是顯名標示的正式落點**，頁尾的
 * `AttributionFooter` 只是縮寫版。政府資料開放授權條款第 1 版：「未盡顯名標示義務者，
 * 視為自始未取得授權」。正文在 `legal_document`，這一頁補兩件正文給不了的東西。
 */
/*
 * ① 受理窗口的公告落點（§90-4 第 3 款要「公告接收通知文件之聯繫窗口資訊」），而公告出去的
 * 窗口只有一個：`/legal/dmca` 那張表。⚠️ **本服務不公告任何電子郵件**——專案沒有寄信能力，
 * 而原本公告的網域實測是 NXDOMAIN（8.8.8.8 查無 NS/A/MX/SOA），寄過去必退信。
 */
/*
 * ⚠️ 不要因為「多一個管道比較保險」把設定值形式的聯繫信箱加回來：那種值會跟著
 * `runtimeConfig.public` 序列化進每一份 SSR payload，**「畫面上沒有」不等於「沒有送出去」**。
 * 真的要開第二個管道，先確定有人收得到再說。
 */
/*
 * ② 連到使用者自己的三振狀態（§15.2：「條款寫了但使用者查不到自己有幾次，第三次就是突襲」）。
 * 這條只有登入者需要，而 `/legal/**` 是即時 SSR ＋ `no-store`（曾經寫成 `prerender: true`，
 * 實測從未生效，踩雷 #91）；SSR 也判斷不了身分（middleware 對 `/legal/**` 拔掉 session cookie）
 * ⇒ 只能在 client 判斷，所以包在 `<ClientOnly>` 裡。
 */
const user = useSupabaseUser()

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
          ⚠️ 這一節只剩一段文字加一顆按鈕，那是**刻意的**不是還沒寫完：這裡曾經公告一個電子郵件，
             2026-09-07 裁定拿掉（理由見檔頭 ①）。再列第二個管道之前，先確認那個管道真的有人收得到。
          ⚠️ 中文句子與行內元素之間不可以斷行（#92）：condense 會把含換行的空白摺成**一個空格**。
        -->
        <p class="mt-3.5 max-w-[34em]">
          著作權相關的通知請用下面的侵權通知表單——它會把著作權法第 90 條之 6 要求記載的事項一次收齊。不需要註冊，也不需要登入。
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
