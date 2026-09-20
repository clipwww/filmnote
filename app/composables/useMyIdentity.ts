import type { Database } from '~/types/database.types'

/**
 * 導覽列要知道的三件事：我是誰（username）、我是不是 staff、我能不能用匯入。
 * ⚠️ staff 一定要問 `is_staff()` 不可以自己從別的東西推。這不是授權（授權在 RLS），
 * 但**猜錯的方向很難看**。
 */
/*
 * 猜太寬會讓一般使用者看到一個點進去全是空佇列的「管理後台」（RLS 把每一列都濾掉，畫面上
 * 寫「沒有待審核的作品」——那是謊話）；猜太窄會讓 staff 找不到自己的工具。所以問資料庫。
 * ⚠️ `-admin-shared.ts` 也有一支 `useStaffGate()`，**刻意不共用**（跨檔耦合會在兩邊同時改
 * 的時候互相覆蓋），代價是多打一次 stable 的 SQL 函式。
 */
/*
 * `server: false` 的理由：middleware 讓 `/`、`/film/**`、`/venue/**`、`/legal/**` 的 SSR 一律
 * 看不到身分 ⇒ 伺服器端問了也只會得到「未登入」，而兩邊算出不同答案就是 hydration mismatch，
 * 且 Vue 的補救不對稱（#98：文字會被改正、屬性不會）。一律在 client 問，配 `<ClientOnly>`。
 */
export function useMyIdentity() {
  const supabase = useSupabaseClient<Database>()
  const user = useSupabaseUser()

  const { data: username } = useAsyncData('nav-my-username', async () => {
    if (!user.value?.sub)
      return null
    const { data } = await supabase
      .from('profile')
      .select('username')
      .eq('id', user.value.sub)
      .maybeSingle()
    return data?.username ?? null
  }, { server: false, watch: [user] })

  const { data: staff } = useAsyncData('nav-is-staff', async () => {
    if (!user.value?.sub)
      return false
    const { data, error } = await supabase.rpc('is_staff')
    // 問不到就當不是 staff：少一個入口只是不方便，多一個入口是假的畫面。
    return !error && data === true
  }, { server: false, watch: [user] })

  /**
   * 能不能用「匯入舊紀錄」。★ **一定要問伺服器，不可以在前端比對 email**：那個 email 是
   * server-only，送到瀏覽器就等於公開在每一頁的原始碼裡。`/api/import/allowed` 只回布林。
   */
  /*
   * ⚠️ 這**不是**權限邊界只是入口的顯示與否——真正的閘門在 `server/utils/import-auth.ts`，
   * 而連那個都只是功能閘門不是安全邊界。⇒ 這裡猜錯不會讓任何人多做到什麼，只會讓選單多
   * 一條點進去被擋的路。問不到就當不能用：多一個入口＝使用者點進去吃 403。
   */
  const { data: canImport, status: canImportStatus } = useAsyncData('nav-can-import', async () => {
    if (!user.value?.sub)
      return false
    try {
      const res = await $fetch<{ allowed: boolean }>('/api/import/allowed')
      return res?.allowed === true
    }
    catch {
      return false
    }
  }, { server: false, watch: [user] })

  return {
    username: computed(() => username.value ?? null),
    isStaff: computed(() => staff.value === true),
    isSignedIn: computed(() => !!user.value?.sub),
    canImport: computed(() => canImport.value === true),
    /**
     * 「問到了沒」——給需要分辨「還沒到」與「不准」的呼叫端（`/app/import`）。
     * ⚠️ 只看 `status === 'success'` **不夠**：這支 handler 在 `user` 還沒到時第一行就
     * `return false`，而**提早 return 的 useAsyncData 會立刻變 success 而不是 pending**。
     */
    /*
     * 所以必須同時要求 `user` 真的在了，否則「還在載入使用者」會被當成「問過了，不准」。
     * 導覽列不需要這個（少一個入口只是不方便）；**頁面需要**，因為對本人先顯示一次
     * 「沒有對外開放」再跳回來，是對使用者說一次謊。
     */
    canImportKnown: computed(() =>
      !!user.value?.sub && (canImportStatus.value === 'success' || canImportStatus.value === 'error')),
  }
}
