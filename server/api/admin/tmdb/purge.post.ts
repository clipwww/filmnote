import type { Database } from '~/types/database.types'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 到期 TMDB 快取清除的**手動觸發**（管理後台）。
 *
 * ── ⚠️ 這支不是合規開關，講清楚很重要 ─────────────────────────────────────
 * 六個月條款的**第一道防線是讀取端**：`film_public` 以 `expires_at > now()` 逐列
 * 把關，過期的欄位直接變 NULL（退回文字卡片）。所以**即使這支從來沒被按過，
 * 也不會有逾期內容被送出去**。
 *
 * 這支做的是另一件事：**不要在資料庫裡留著已無權保存的內容**。
 * `purge_expired_tmdb_cache()` 把過期列的內容欄位清空並退回 `pending`
 * （原本 `gone` 的維持 `gone`），回傳清了幾列。
 *
 * 這個區別必須出現在 UI 上。不講的話管理者會以為「沒按就會違規」——那是錯的，
 * 而且那種誤解會製造不必要的恐慌，也會讓人以為 cron 沒跑就出事了。
 *
 * ── ★ 授權：三步，順序不可調換 ─────────────────────────────────────────────
 *   ① `serverSupabaseUser(event)` → 沒登入 401
 *   ② 使用者自己的 client 問 `is_staff()` → 不是 true 就 403
 *   ③ **通過②之後**才 `serviceSupabase()`
 *
 * `purge_expired_tmdb_cache()` 進門問的是 `is_service_context()`，**不是**
 * `is_staff()`——它只認 service role。所以這支端點少了 ②，就等於任何人都能
 * 觸發一次全表清除。這是本專案裡少數「RPC 幫不上授權的忙」的地方。
 *
 * ⚠️ 不 import `assertCronCaller`；`CRON_SECRET` 不出現在這條路徑上。
 * ⚠️ cron 那支（`/api/cron/tmdb-purge`）保留不動，這是附加不是取代。
 */
export default defineEventHandler(async (event) => {
  // ① + ②。★ 在任何 service_role 的東西出現之前。
  const staff = await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    // ⚠️ 使用者自己的 client。換成 service role 的話 `is_staff()` 回 **false**
    //    （auth.uid() 是 NULL），連 David 自己都會被擋——見 admin-auth.ts 的說明。
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  // ③ 通過授權之後才拿 service role，而且它只用來「執行」，不用來判斷權限。
  const db = serviceSupabase()
  const { data, error } = await db.rpc('purge_expired_tmdb_cache')

  if (error)
    throw createError({ statusCode: 500, statusMessage: `清除失敗：${error.message}` })

  const report = { purged: data ?? 0 }

  // eslint-disable-next-line no-console -- 管理動作的稽核日誌
  console.log('[admin/tmdb/purge]', JSON.stringify({ by: staff.id, ...report }))

  return report
})
