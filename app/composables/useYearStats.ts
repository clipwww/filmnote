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
 * `user_year_stats(username, year)`。
 *
 * ⚠️ 三件會靜默出錯的事，都寫在資料的形狀上而不是這裡的程式碼裡：
 *
 * 1. **函式宣告 `returns jsonb`**，所以 supabase-js 的 `data` 直接就是物件
 *    （`data.totals.spend`），不是只有一個元素的陣列。當成陣列取
 *    `data[0].totals` 會得到 undefined 而不是錯誤。
 * 2. **`weekday_hour.weekday` 是 `isodow`（1=週一…7=週日）**，不是 `dow`
 *    的 0=週日。當成 0-indexed 會讓整張熱力圖平移一天而且不會報錯——
 *    轉換在 `utils/stats.ts` 的 `hourGrid()`，有測試守著。
 * 3. **`daily` 是具名欄位 `{date, records, tickets}`**，不是 ECharts calendar
 *    要的 `[date, value]`。那是刻意的（不想把圖表函式庫的資料格式綁進 API
 *    契約），前端 map 一下——`calendarSeries()`。
 *
 * 查無此使用者（或帳號不可服務）時 RPC 回 NULL，這裡就是 `null`。
 *
 * `year` 傳 `null` 代表涵蓋全部年度，年表 YearStrip 用的就是那一份。
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
