import type { Database } from '~/types/database.types'
import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * TMDB 快照刷新的**手動觸發**（管理後台）。`vercel.json` 的排程原封不動，這支是附加的：
 * cron 唯一的觀測面是 `console.log`、失敗沒有重試入口、剛匯入一批要等到隔天 03:00。
 * ★ 用 POST：「必須是 GET」只適用於 Vercel Cron 的觸發方式，這支是瀏覽器發起的變更
 *   操作，改成 GET 會讓一個改資料庫的端點可以被連結、被預抓。
 */
// 授權三步，順序不可調換：① 登入 → ② 使用者自己的 client 問 is_staff() → ③ 通過後
// 才動 service role（決策本體在 server/utils/admin-auth.ts，§7 #26）。
// ⚠️ 不 import assertCronCaller：CRON_SECRET 不出現在這條路徑上的任何地方，也不用
//    「後端拿 secret 去 fetch 自己的 cron 端點」那種代理作法（多一跳、多一次函式呼叫）。

/**
 * ⚠️ 調高時間預算之前先讀：300 秒是**啟用 fluid compute 時**的 Hobby 上限
 * （https://vercel.com/docs/functions/limitations#max-duration ，該頁 last_updated
 * 2026-08-24，查證 2026-09-07），而本專案有沒有啟用**在 repo 裡查不到** ⇒ 夾子取
 * 最壞假設下活得下來的值（8 秒／25 秒），症狀與確認方式見 admin-tmdb-options.ts。
 */
// ★ 跟直覺不同：預算只決定「要不要再取新工作」，**不會砍掉已經在飛的請求**。最壞
//   情況一個 in-flight 請求還要跑完 TmdbClient 的整套退避（maxRetries=5，429 是
//   2+4+8+16+32 = 62 秒純睡眠）⇒ elapsedMs 最壞是 budget + 62 秒有餘。

const bodySchema = z.object({
  limit: z.coerce.number().int().optional(),
  budgetMs: z.coerce.number().int().optional(),
})

export default defineEventHandler(async (event) => {
  // ① + ②。★ 這兩行在任何 service_role 的東西出現之前。
  const staff = await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    // ⚠️ 必須是帶使用者 JWT 的 client；換成 service role 會變成連 David 都被擋
    //    （理由與實測見 admin-auth.ts 的 StaffProbe）。
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  const parsed = bodySchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: 'limit / budgetMs 必須是整數' })

  // 兩層夾子不是重複：共用那一支的上限 30 分鐘對排程合理，對「有人在瀏覽器前面等、
  // 函式隨時可能被砍」不合理。★ 夾子本體刻意不寫在這個檔（這裡 import 了
  // `#supabase/server`，vitest 載不進來 ⇒ 寫在這裡一條斷言都守不到）。
  const options = clampManualOptions(parsed.data)

  // ③ 到這裡才動 service role——`runTmdbRefresh()` 內部呼叫 `serviceSupabase()`。
  const report = await runTmdbRefresh(options)

  // 與 cron 那支刻意重複：出事時函式日誌是最先看得到的地方，查資料庫要另一套權限。
  // 多記一個 `by`，因為這一次是人按的。
  // eslint-disable-next-line no-console -- 管理動作的稽核日誌
  console.log('[admin/tmdb/refresh]', JSON.stringify({ by: staff.id, options, ...report }))

  // ★ 回傳實際生效的 options：送 90 秒被夾成 25 秒時畫面要看得到，不是靜默改數字。
  return { ...report, options }
})
