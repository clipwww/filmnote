import type { Database } from '~/types/database.types'

/**
 * 導覽列要知道的兩件事：**我是誰**（username，給「看我的公開頁」）與
 * **我是不是 staff**（決定要不要出現管理後台）。
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

  return {
    username: computed(() => username.value ?? null),
    isStaff: computed(() => staff.value === true),
    isSignedIn: computed(() => !!user.value?.sub),
  }
}
