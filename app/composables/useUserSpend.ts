import type { Ref } from 'vue'
import type { Database } from '~/types/database.types'
import type { SpendView, YearStats } from '~/utils/stats'

/**
 * `/u/` 上跟**金額**有關的一切，單一資料來源。兩個呈現（頁首那句與「每年花費」band）必須對
 * 三件事完全一致：看不看得到、是不是全部、看不到時整個章節不存在（不是畫成 0 不是馬賽克）。
 * 兩份查詢一定會在某次修改後分岔，而沒有人會把同一頁的兩個地方擺在一起看（`backend.md §6e`）。
 */
/*
 * ★ 一定是 client 端、用觀看者自己的 session：票價因觀看者而異 ⇒ 必須由 RLS 決定；而 `/u/`
 * 是 SSR，伺服器端算出的金額會被序列化進 `__NUXT_DATA__` ⇒ 一律 `server: false`，
 * 呼叫端用 `<ClientOnly>` 包住。這也是 `/api/u/…/stats` 逐欄挑白名單、金額一個都不回的原因。
 */
/*
 * ★ 判準與投影在 `spendViewModel()`（`utils/stats.ts`，`/app` 同一支）。`canSeeMoney` 為 false
 * 時呼叫端**整個章節不要 render**（否則總額÷場次能反推）。
 */
export type UserSpend = SpendView

export function useUserSpend(username: Ref<string | null | undefined>) {
  const supabase = useSupabaseClient<Database>()
  const user = useSupabaseUser()

  const { data, status } = useAsyncData(
    // key 帶觀看者：登入／登出之後這份答案完全不同，共用同一格快取會讓
    // 剛登出的人還看得到自己的金額（或反過來）。
    () => `user-spend:${username.value ?? ''}:${user.value?.sub ?? 'anon'}`,
    async (): Promise<UserSpend | null> => {
      if (!username.value)
        return null
      // ★ 走與圖表同一支 RPC（security invoker ⇒ RLS 依觀看者求值），
      //   不要自己 join viewing_record_cost 再就地加總——那會變成第二份定義。
      const { data, error } = await supabase.rpc('user_year_stats', {
        p_username: username.value,
        // 型別產生器讀不出參數預設值；null = 涵蓋全部年度
        p_year: null as unknown as number,
      })
      if (error)
        throw error
      return spendViewModel(data as unknown as YearStats | null)
    },
    // ★ server: false —— 金額絕不進 SSR 的輸出。
    { server: false, watch: [username, user] },
  )

  return { spend: computed(() => data.value ?? null), status }
}
