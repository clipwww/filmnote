/**
 * 來源資料損毀的偵測。
 *
 * 政府 CSV 是人工經 Excel 維護的產物，實測於 110–113 年出現三類損毀。
 * 這些筆數很少（約 0.1%），但若不處理會讓比對器拿著垃圾字串去查 TMDB，
 * 浪費配額並產生假陽性。偵測到損毀時改走中文片名的查詢路徑。
 */

import type { RowDefect } from '~/types'

/**
 * Excel 把片名誤判為日期後寫回的樣式。
 *
 * 實測案例：《福田村事件》的原文片名欄位值為 `Sep-23`——原片名應為
 * 日文，被 Excel 當成 2023 年 9 月而改寫。
 */
const EXCEL_DATE_RE = /^(?:[a-z]{3}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/i

/** 編碼轉換失敗後留下的連續問號。 */
const CORRUPTED_RE = /^\?{3,}$/

export function isExcelDateArtifact(value: string): boolean {
  return EXCEL_DATE_RE.test(value.trim())
}

export function isCorruptedEncoding(value: string): boolean {
  return CORRUPTED_RE.test(value.trim())
}

/**
 * 判定一列的原文片名是否可信。
 *
 * 不可信時，比對器應只用中文片名查詢，不要把損毀字串送進 TMDB。
 */
export function inspectOriginalTitle(value: string | undefined | null): {
  usable: boolean
  defect: RowDefect | null
} {
  const trimmed = (value ?? '').trim()

  if (!trimmed)
    return { usable: false, defect: 'original-title-missing' }
  if (isExcelDateArtifact(trimmed))
    return { usable: false, defect: 'original-title-excel-date' }
  if (isCorruptedEncoding(trimmed))
    return { usable: false, defect: 'original-title-corrupted' }

  return { usable: true, defect: null }
}
