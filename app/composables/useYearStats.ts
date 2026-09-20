import type { Ref } from 'vue'
import type { Database } from '~/types/database.types'
import type { YearStats } from '~/utils/stats'

/**
 * 登入者自己的 username。`user_year_stats` 收的是 username 不是 id
 * （它同時服務公開的年度回顧頁），而 `useSupabaseUser()` 給的是 JWT claims，
 * 裡面只有 `sub`。
 */
export function useMyUsername() {
  const supabase = useSupabaseClient<Database>()
  const user = useSupabaseUser()

  const { data } = useAsyncData('my-username', async () => {
    if (!user.value?.sub)
      return null
    const { data } = await supabase
      .from('profile')
      .select('username')
      .eq('id', user.value.sub)
      .maybeSingle()
    return data?.username ?? null
  }, { server: false, watch: [user] })

  return computed(() => data.value ?? null)
}

/**
 * `user_year_stats(username, year)`。`year` 傳 `null` 代表涵蓋全部年度；查無此使用者
 * （或帳號不可服務）時 RPC 回 NULL，這裡就是 `null`。
 */
/*
 * ⚠️ 三件會靜默出錯的事，都寫在資料的形狀上不是這裡的程式碼裡：
 * ① 函式宣告 `returns jsonb` ⇒ `data` 直接就是物件，當成陣列取 `data[0].totals` 會得到
 *    undefined 而不是錯誤；
 * ② `weekday_hour.weekday` 是 **isodow**（1=週一）不是 `dow`（0=週日），當成 0-indexed 會讓
 *    整張熱力圖平移一天而且不報錯（轉換在 `hourGrid()`，有測試守著）；
 * ③ `daily` 是具名欄位不是 ECharts 要的 `[date, value]`（刻意的：不把圖表函式庫的格式綁進
 *    API 契約），前端 map 一下。
 */
export function useYearStats(username: Ref<string | null>, year: Ref<number | null>) {
  const supabase = useSupabaseClient<Database>()

  const { data, status, error, refresh } = useAsyncData(
    () => `year-stats:${username.value ?? ''}:${year.value ?? 'all'}`,
    async () => {
      if (!username.value)
        return null
      // 產生的型別把 `p_year` 標成必填的 number，但 SQL 是 `default null`，
      // 而 null 正是「涵蓋全部年度」的意思（年表要用）。型別產生器讀不出
      // 參數預設值，所以這裡明確放行。
      const { data, error } = await supabase.rpc('user_year_stats', {
        p_username: username.value,
        p_year: year.value as number,
      })
      if (error)
        throw error
      return (data as unknown as YearStats | null) ?? null
    },
    { server: false, watch: [username, year] },
  )

  return { stats: computed(() => data.value), status, error, refresh }
}
