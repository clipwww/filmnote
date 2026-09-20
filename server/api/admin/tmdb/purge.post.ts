import type { Database } from '~/types/database.types'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 到期 TMDB 快取清除的**手動觸發**（管理後台）。
 * ⚠️ **這不是合規開關**：六個月條款的第一道防線是讀取端（`film_public` 以
 * `expires_at > now()` 逐列把關）⇒ 即使這支從來沒被按過也不會有逾期內容送出去。
 * 它做的是「不要在資料庫裡留著已無權保存的內容」。這個區別必須出現在 UI 上，
 * 否則管理者會以為沒按就會違規。
 */
// ★ 授權三步不可調換：① 登入 → ② 使用者自己的 client 問 is_staff() → ③ 才 service role。
//   `purge_expired_tmdb_cache()` 進門問的是 `is_service_context()` **不是** is_staff ⇒
//   少了 ② 就等於任何人都能觸發一次全表清除。這是少數「RPC 幫不上授權的忙」的地方。
// ⚠️ 不 import assertCronCaller；cron 那支保留不動，這是附加不是取代。
export default defineEventHandler(async (event) => {
  // ① + ②。★ 在任何 service_role 的東西出現之前。
  const staff = await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    // ⚠️ 必須是使用者自己的 client；換成 service role 連 David 都會被擋（見 admin-auth.ts）。
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
