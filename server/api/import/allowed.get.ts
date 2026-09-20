import process from 'node:process'
import { decideImportOwnerFrom } from '~~/server/utils/import-auth'
import { serverSupabaseUser } from '#supabase/server'

/**
 * `/app/import` 問「我可不可以用這個工具」，回 `{ allowed: boolean }`。存在的唯一理由
 * 是 UI：允許使用的 email 是 server-only、**不能送到瀏覽器**（見 nuxt.config 的墓碑
 * 註解），頁面沒辦法自己比對。⚠️ 它不是防線，擋 UI 只是 UX（見 import-auth.ts）。
 */
// 兩條不可違反的設計：
// ① 走同一支 `decideImportOwnerFrom`，不要在這裡再寫一次 email 比對——兩份會漂移成
//    「頁面說不准、端點卻放行」或反過來。
// ② **不准時也回 200**，用布林表達不要用 403：兩者的差別本身就是資訊，會把這支變成
//    一台 email 探測器。`reason` 同理只留在伺服器端。未登入仍回 401（那不是裁決）。
export default defineEventHandler(async (event) => {
  const verdict = await decideImportOwnerFrom({
    user: () => serverSupabaseUser(event),
    allowedEmail: () => process.env.IMPORT_TARGET_EMAIL,
  })

  return { allowed: verdict.allowed }
})
