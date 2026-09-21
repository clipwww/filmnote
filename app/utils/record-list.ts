/**
 * `/app/records` 表格的關鍵字搜尋與頁碼分頁。抽成獨立模組的唯一理由是**測得到**：
 * 這兩件事只活在 SFC 的 computed 裡時，typecheck／lint／test／build 四關全綠也看不見它們
 * （純 client 行為），而這一輪改的全部是 client 行為。
 */

/** `matchesQuery` 只需要這四個自由文字欄，不必整個 `MyRecord`（測試才不用造一整筆）。 */
export interface SearchableRecord {
  film?: { titleZh?: string | null, titleOriginal?: string | null } | null
  venueName?: string | null
  hallLabel?: string | null
  memo?: string | null
}

/**
 * 四個自由文字欄的子字串比對：作品名（中文與原文）／影城／影廳／備註。
 * ⚠️ **逐欄比對，不是把欄位串起來比一次**：串起來會讓「影城結尾＋備註開頭」這種跨欄的巧合
 * 算成命中，使用者盯著那一列找不到自己打的字在哪。
 * ⚠️ **不含日期字串**（交接 §8 卡點 2 還沒裁決）⇒ 打 `2024` 現在只比得到片名裡的 2024。
 */
export function matchesQuery(record: SearchableRecord, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q)
    return true
  // 兩邊都 toLowerCase 是為了 `titleOriginal`（拉丁字）；中日文的 toLowerCase 是 no-op，
  // 不會動到字形，所以可以無條件套在五個欄位上。
  return [
    record.film?.titleZh,
    record.film?.titleOriginal,
    record.venueName,
    record.hallLabel,
    record.memo,
  ].some(v => !!v && v.toLowerCase().includes(q))
}

/**
 * 第 `page` 頁（1 起算）的那一批。
 * ⚠️ 驗它的斷言**不可以只驗長度**（踩雷 #234）：JS 陣列會自己長，長度對不代表切到的是對的
 * 那一段 ⇒ 要驗內容（第 2 頁的第一筆是不是全集的第 `perPage + 1` 筆）。
 */
export function pageSlice<T>(rows: T[], page: number, perPage: number): T[] {
  const start = (Math.max(1, page) - 1) * perPage
  return rows.slice(start, start + perPage)
}
