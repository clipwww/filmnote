import type { Database } from '~/types/database.types'

/**
 * 導覽列要知道的三件事：**我是誰**（username，給「看我的公開頁」）、
 * **我是不是 staff**（決定要不要出現管理後台）、以及
 * **我能不能用匯入**（David 2026-09-20：「沒權限的話 Menu 也不需要出現」）。
 *
 * ── ⚠️ staff 一定要問 `is_staff()`，不可以自己從別的東西推 ────────────
 * 這不是授權——授權在 RLS，`/admin/**` 的每一條 policy 才是真的門。
 * 但**猜錯的方向很難看**：猜太寬會讓一般使用者看到一個點進去全是空佇列的
 * 「管理後台」（RLS 把每一列都濾掉，畫面上寫「沒有待審核的作品」——那是謊話）；
 * 猜太窄會讓 staff 找不到自己的工具。所以問資料庫，那是唯一不會漂移的答案。
 *
 * ⚠️ `app/pages/admin/-admin-shared.ts` 也有一支 `useStaffGate()`，key 是
 * `admin-is-staff`。**刻意不共用**：那個檔屬於另一個 session，跨檔耦合會在
 * 兩邊同時改的時候互相覆蓋。代價是進 `/admin/**` 時多打一次 `is_staff()`，
 * 那是一支 stable 的 SQL 函式，可以接受。
 *
 * ── 為什麼 `server: false` ────────────────────────────────────────────
 * `server/middleware/strip-auth-on-cacheable.ts` 讓 `/`、`/film/**`、`/venue/**`、
 * `/legal/**` 的 SSR 一律看不到身分，所以伺服器端問了也只會得到「未登入」。
 * 兩邊算出不同答案就是 hydration mismatch，而 Vue 對 mismatch 的補救不對稱
 *（踩雷 #98：文字會被改正、屬性不會）。一律在 client 問，配 `<ClientOnly>`。
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
   * 能不能用「匯入舊紀錄」。判準是登入帳號的 email 是否等於 `IMPORT_TARGET_EMAIL`。
   *
   * ★ **一定要問伺服器，不可以在前端比對 email。** 那個 email 是 server-only，
   *   送到瀏覽器就等於公開在每一頁的原始碼裡（`nuxt.config.ts` 那段
   *   `copyrightContactEmail` 的墓碑註解講的就是這件事）。
   *   `/api/import/allowed` 只回一個布林，永遠不回 email。
   *
   * ⚠️ 這**不是**權限邊界，只是入口的顯示與否——真正的閘門在
   *   `server/utils/import-auth.ts`，而且連那個都只是功能閘門不是安全邊界
   *   （匯入的實際寫入走瀏覽器端的 RLS，任何登入者本來就能寫自己的紀錄）。
   *   ⇒ 這裡猜錯不會讓任何人多做到什麼，只會讓選單多一條點進去被擋的路。
   *
   * 問不到就當不能用——同 `is_staff` 那條的理由，而且這裡更強：
   * 多一個入口＝使用者點進去吃 403，那是一個看起來像壞掉的畫面。
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
     *
     * ⚠️ 只看 `status === 'success'` **是不夠的**：這支 handler 在 `user` 還沒到時
     *   第一行就 `return false`，而**提早 return 的 useAsyncData 會立刻變 success
     *   而不是 pending**（這個 repo 已經記過同一個形狀）。所以必須同時要求
     *   `user` 真的在了，否則「還在載入使用者」會被當成「問過了，不准」。
     *
     * 導覽列不需要這個（那裡少一個入口只是不方便）；**頁面需要**，
     * 因為對本人先顯示一次「沒有對外開放」再跳回來，是對使用者說一次謊。
     */
    canImportKnown: computed(() =>
      !!user.value?.sub && (canImportStatus.value === 'success' || canImportStatus.value === 'error')),
  }
}
