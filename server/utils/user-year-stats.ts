/**
 * `public.user_year_stats(p_username, p_year)` 的回傳形狀。
 *
 * 產生器把這支 RPC 的回傳標成 `Json`（它宣告 `returns jsonb`），型別資訊
 * 因此得手寫。之所以回 jsonb 而不是 `returns table`：這份統計是異質的——
 * 每日次數、星期×時段矩陣、各種分布，塞不進一張平表；而拆成七支 RPC 會讓
 * 一個統計頁打七次往返。
 *
 * ⚠️ 契約變更請同步 `supabase/migrations/0003_user_year_stats.sql`。
 *
 * ⚠️ **這份資料不得進入任何可快取的輸出。** `totals.spend` 受呼叫者的 RLS
 * 影響——同一個 URL 對不同人是不同的數字。放進 SSR 快取或 CDN，第一個造訪
 * 者（可能是本人）的票價就會被送給後面所有人。統計一律以呼叫者自己的
 * session 即時查詢。
 */

/** ISO 星期：1 = 週一 … 7 = 週日。 */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

export interface UserYearStatsTotals {
  /** 場次數（一次進場算一筆；雙片連映已拆成兩筆）。 */
  records: number
  /** 相異作品數。 */
  films: number
  /** 總票數。 */
  tickets: number
  /**
   * 已知票價加總。**只涵蓋呼叫者看得到的票價**——
   * 未登入者看別人的頁面時，除非對方開啟票價公開，否則這裡是 0。
   */
  spend: number
  spend_currency: 'TWD'
  /**
   * `spend` 是否不完整（= `spend_unknown_records > 0`）。
   *
   * 為 true 時**不可**把 `spend` 當成總花費呈現。措辭要看 `is_own`：
   * · `is_own = false` → 「部分票價未公開」
   * · `is_own = true`  → 「N 筆未記錄票價」（自己的資料沒有被隱藏的問題）
   */
  spend_is_partial: boolean
  /** 有票價可計的場次數。 */
  spend_known_records: number
  /** 無票價可計的場次數。 */
  spend_unknown_records: number
  /** `watched_time` 為 NULL 的場次數，這些進不了星期×時段熱力圖。 */
  records_without_time: number
}

export interface UserYearStatsDaily {
  /** `YYYY-MM-DD`，台北牆上日期，未經時區轉換。 */
  date: string
  records: number
  tickets: number
}

export interface UserYearStatsWeekdayHour {
  weekday: IsoWeekday
  /** 0–23，台北牆上時間。 */
  hour: number
  records: number
}

export interface UserYearStatsMonthly {
  /** 1–12。 */
  month: number
  records: number
  tickets: number
  spend: number
  spend_is_partial: boolean
}

export interface UserYearStatsVenue {
  venue_id: string
  name: string | null
  city: string | null
  kind: string | null
  records: number
}

export interface UserYearStatsCountry {
  /** 空字串代表讀不到作品資訊（他人的私密 UGC 作品），UI 顯示「未分類」。 */
  country: string
  records: number
}

export interface UserYearStatsFormat {
  /** `screening_format.code`。 */
  code: string
  label: string
  records: number
}

export interface UserYearStatsRepeat {
  film_id: string
  title_zh: string | null
  slug: string | null
  /** TMDB 海報路徑，需自行接上 image.tmdb.org。無快取時為 null。 */
  poster_path: string | null
  /** 該年度看了幾次（一律 >= 2）。 */
  records: number
}

export interface UserYearStats {
  /** 正規化後的 username（呼叫時給舊名也會回傳現名）。 */
  username: string
  /** 查詢的年度；null 代表涵蓋全部年度。 */
  year: number | null
  /** 呼叫者是否就是這個頁面的主人。決定 `spend_is_partial` 的措辭。 */
  is_own: boolean
  /** 這位使用者有紀錄的所有年度，新到舊。供年度切換器使用（US-42）。 */
  available_years: number[]
  totals: UserYearStatsTotals
  /** 貢獻圖（US-34）。 */
  daily: UserYearStatsDaily[]
  /** 星期 × 時段熱力圖（US-35）。 */
  weekday_hour: UserYearStatsWeekdayHour[]
  /** 月度趨勢（US-36）。 */
  monthly: UserYearStatsMonthly[]
  /** 影城分布（US-37），依次數遞減。 */
  venues: UserYearStatsVenue[]
  /** 國別分布，依次數遞減。 */
  countries: UserYearStatsCountry[]
  /** 版本分布，依次數遞減。 */
  formats: UserYearStatsFormat[]
  /** 多刷排行（US-41），只含該年度看兩次以上者，依次數遞減。 */
  repeats: UserYearStatsRepeat[]
}

/**
 * RPC 查無此使用者（或帳號不可服務）時回傳 SQL NULL，
 * supabase-js 收到的 `data` 就是 `null`——那是 404 而不是錯誤。
 */
export type UserYearStatsResult = UserYearStats | null
