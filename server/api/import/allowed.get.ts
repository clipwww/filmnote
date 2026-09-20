import process from 'node:process'
import { decideImportOwnerFrom } from '~~/server/utils/import-auth'
import { serverSupabaseUser } from '#supabase/server'

/**
 * `/app/import` 問「我可不可以用這個工具」。回 `{ allowed: boolean }`。
 *
 * ★ 這支存在的唯一理由是 UI：允許使用的 email 是 server-only，**不能送到瀏覽器**
 *   （`nuxt.config.ts:163-164` 的墓碑註解：`runtimeConfig.public` 的每一個值都會
 *   序列化進 SSR payload，「畫面上沒有」不等於「沒有送出去」）。所以頁面沒辦法
 *   自己比對，只能問一個布林回來。
 *
 * ⚠️ **它不是防線，擋 UI 的那一半只是 UX**。真正的閘門在 `parse-csv` 與
 *   `tmdb-search` 上——而就算那兩支也擋不住「寫紀錄」這件事本身，
 *   因為寫入是瀏覽器端帶使用者自己的 JWT 走 RLS 做的。詳見 `import-auth.ts` 檔頭。
 *
 * ── ⚠️ 兩條不可以違反的設計 ────────────────────────────────────────────────
 *
 * ① **走同一支判斷函式**（`decideImportOwnerFrom`），不要在這裡自己再寫一次
 *    email 比對。兩份一定會漂移，而漂移的樣子是「頁面說不准、端點卻放行」
 *    或反過來——兩種都會讓下一個人不知道該相信哪一個。
 *
 * ② **不准的時候也回 200**，用布林表達，不要用 403。403 與 200 的差別本身就是
 *    資訊：那會把這支端點變成一台 email 探測器，任何登入者都能拿它二分搜尋
 *    「誰是本人」。同理，`reason`（沒設定／沒有 email claim／不是本人）
 *    **只留在伺服器端**，不往回傳值裡放。
 *    ★ 未登入仍然回 401：那不是裁決，是「還沒有身分可以裁決」。
 */
export default defineEventHandler(async (event) => {
  const verdict = await decideImportOwnerFrom({
    user: () => serverSupabaseUser(event),
    allowedEmail: () => process.env.IMPORT_TARGET_EMAIL,
  })

  return { allowed: verdict.allowed }
})
