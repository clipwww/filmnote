import type { Ref } from 'vue'
import type { Database } from '~/types/database.types'
import type { YearStats } from '~/utils/stats'

/**
 * `/u/` 上跟**金額**有關的一切，單一資料來源。
 *
 * ── ★★ 為什麼是 composable 而不是各元件自己查 ────────────────────────────
 * 金額區塊有兩個呈現（頁首那句「花了 NT$5x,xxx」與「每年花費」那條 band），
 * 而它們必須對同三件事有**完全一致**的判斷：
 *
 *   ① 這個觀看者到底看不看得到金額
 *   ② 看得到的是不是全部（`spend_is_partial`）
 *   ③ 「看不到」時整個章節不存在——不是畫成 0、不是打馬賽克
 *
 * 兩份查詢一定會在某次修改後對這三件事給出不同答案，而那種不一致沒有人會發現
 * ——因為沒有人會把同一頁的兩個地方擺在一起看（`backend.md §6e` 對
 * 「一個欄位餵兩個用途」講的是同一件事）。所以只有一份 `useAsyncData`，
 * **key 相同 ⇒ 兩個呼叫端共用同一次請求、同一份答案**。
 *
 * ── ★ 為什麼一定是 client 端、而且用觀看者自己的 session ────────────────
 * 票價因觀看者而異（本人／`show_cost=true` 的路人／其他人），所以這件事
 * **必須**由 RLS 依觀看者決定，前端不能也不該自己判斷。而 `/u/` 是 SSR，
 * 任何在伺服器端算出來的金額都會被序列化進 `__NUXT_DATA__` 一起送出
 * ⇒ 一律 `server: false`，呼叫端用 `<ClientOnly>` 包住。
 *
 * ⚠️ 這也是為什麼 `/api/u/{username}/stats` 那支端點**逐欄挑白名單、
 *    金額一個都不回**：那支是匿名視角、輸出對所有人相同，金額不屬於它。
 *
 * ── ★ `show_cost = false` 時看起來是什麼樣子 ────────────────────────────
 * RLS 讓 `viewing_record_cost` 一列都讀不到 ⇒ RPC 回來的每一年 `spend` 都是 0、
 * `spend_known_records` 是 0。判準是 **`spend_known_records > 0`**，不是
 * 「總額 > 0」——後者會把「全部都是兌換票（NT$0）」誤判成「看不到」。
 * `canSeeMoney` 為 false 時呼叫端**整個章節不要 render**（`SCREENS §12-3`：
 * 否則 `總花費 ÷ 場次` 就能反推個別票價，隱私是假的）。
 */
export interface UserSpend {
  /** false ⇒ **整個金額章節不存在**。不是畫成 0，不是佔位。 */
  canSeeMoney: boolean
  /** 觀看者就是本人。來自 RPC 的 `is_own`（`auth.uid()`），不是前端自己比對 id。 */
  isOwn: boolean
  total: number
  currency: string
  /** 這個觀看者看得到的紀錄總數。 */
  visibleRecords: number
  /** 其中讀得到票價的有幾筆。 */
  countedRecords: number
  /** 讀不到票價的有幾筆。**本人是「沒記」、路人是「沒公開」，文案不可共用。 */
  unknownRecords: number
  /** 總額涵蓋不完整。 */
  isPartial: boolean
  /**
   * 逐年。⚠️ `spend_is_partial` 在這裡是**逐年**的旗標，那正是這張圖要的粒度
   * ——全期把十三年混在一起的那個 true 沒有用（只要任何一年有未公開票價
   * 就會是 true），標在圖上會讓每一年都掛著同一個但書。
   *
   * ⚠️ `tickets` 與 `records` 是**兩個不同的數字**（一場可能買多張票）。
   * 兩個都是 RPC 的 `by_year` 本來就在回的欄位，而且**本來就對匿名公開**
   *（`/api/u/{username}/stats` 的白名單也有）——把它們印在 band 上不是新的外洩。
   */
  byYear: { year: number, spend: number, records: number, tickets: number, isPartial: boolean }[]
}

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
      const s = data as unknown as YearStats | null
      if (!s?.totals)
        return null

      const t = s.totals
      return {
        // ★ 判準是「讀得到幾筆票價」，不是「總額大於零」
        canSeeMoney: (t.spend_known_records ?? 0) > 0,
        isOwn: !!s.is_own,
        total: t.spend ?? 0,
        currency: t.spend_currency ?? 'TWD',
        visibleRecords: t.records ?? 0,
        countedRecords: t.spend_known_records ?? 0,
        unknownRecords: t.spend_unknown_records ?? 0,
        isPartial: !!t.spend_is_partial,
        byYear: (s.by_year ?? [])
          // ⚠️ `spend` 在 DB 是 `numeric(12,2)`。`Number()` 不是裝飾：`SpendByYear`
          //    的 `width()` 用 `spend === 0` 嚴格比較決定「免費那一列的條寬是 0」，
          //    要是 JSON 那層把它送成字串 `'0.00'`，那一列會靜默長出一小段條，
          //    而右邊的字寫著「免費」——圖與字互相矛盾（踩雷 #171 的配套）。
          .map(y => ({ year: y.year, spend: Number(y.spend ?? 0), records: y.records, tickets: y.tickets, isPartial: !!y.spend_is_partial }))
          .sort((a, b) => b.year - a.year),
      }
    },
    // ★ server: false —— 金額絕不進 SSR 的輸出。
    { server: false, watch: [username, user] },
  )

  return { spend: computed(() => data.value ?? null), status }
}
