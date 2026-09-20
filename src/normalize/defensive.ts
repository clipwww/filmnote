/**
 * 來源資料損毀的偵測。政府 CSV 是人工經 Excel 維護的產物，實測 110–113 年有三類損毀。
 * 筆數很少（約 0.1%），但不處理會讓比對器拿垃圾字串去查 TMDB，浪費配額又產生假陽性。
 */

import type { RowDefect } from '#pipeline/types'

/** Excel 把片名誤判為日期後寫回的樣式。實測《福田村事件》的原文片名變成 `Sep-23`。 */
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
 * 中文片名裡是否有疑似編碼損毀的問號。只做粗判不區分真假——實測 15 筆命中裡
 * 《孩子，你好嗎？》系列 5 筆是真問號，其餘是損毀，字串層面沒有可靠的判別特徵。
 * 判別交給 consolidate：有 TMDB 中文標題就用它（實測 4 筆有配對的全是真損毀）。
 */
export function hasSuspectQuestionMark(value: string | undefined | null): boolean {
  return (value ?? '').includes('?')
}

/** 判定原文片名是否可信。不可信時比對器應只用中文片名查詢，不要把損毀字串送進 TMDB。 */
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

// ── 私用區字元損毀 ──
// ★ 與上面的「問號型」是**不同的失敗模式**，不要合成一條規則：問號型是解碼器失敗了
//   而且說了；私用區是解碼器**成功了**——字串在編碼上完全合法，length 正常、比對正常、
//   寫進資料庫也正常，**這正是它能一路走到公開頁而沒被任何一層攔下的原因**。
// 實測 2026-09-06：110–113 年有 2 筆（film 與 certificate 各 2 列），111 年第111250號
//   `LEOPOLDSTADT`、第111403號 `BLDG. N`，頭尾完好只有中間幾個字變垃圾。
// ⚠️ 私用區字元**看起來不一定像亂碼**（不同字型下可能是空白或方框）⇒ 肉眼檢查抓不到，
//    只能用碼位判斷。

/**
 * Unicode 私用區三段（BMP／增補 A／增補 B）。★ 必須用 `u` 旗標，否則後兩段的代理對
 * 會被當成兩個獨立 BMP 字元而漏判。
 * ★ 一律寫 `\uXXXX` 逃脫，**不要把私用區字元字面貼進原始碼**：寫這一行時就被吃掉過
 *   一次（變成 `[-]`，一個什麼都比對不到的字元類別，而 tsc 完全不會抱怨）。
 */
const PRIVATE_USE_RE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u

/** Unicode 替換字元。解碼器明講「這裡我解不出來」。 */
const REPLACEMENT_RE = /\uFFFD/

export function hasPrivateUseChars(value: string | undefined | null): boolean {
  return PRIVATE_USE_RE.test(value ?? '')
}

export function hasReplacementChars(value: string | undefined | null): boolean {
  return REPLACEMENT_RE.test(value ?? '')
}

/** 中文片名的損毀型態。`null` 代表沒有偵測到問題。 */
export type TitleZhCorruption
  /** 私用區字元。解碼「成功」但對應到私用區 ⇒ 任何編碼檢查都不會抱怨。 */
  = | 'private-use'
  /** U+FFFD。解碼器明確失敗，原始位元組的資訊已經沒了。 */
    | 'replacement'
  /** 連續 ASCII 問號，來源把無法轉換的字元寫成 `?`。 */
    | 'question-marks'
  /** 夾雜單獨的 `?`，可能是損毀也可能是真的問號（《孩子，你好嗎？》）。 */
    | 'suspect-question-mark'

/**
 * 判定中文片名的損毀型態，依嚴重度由確定到可疑排序，只回報最確定的那一種。
 */
// 偵測到之後：① 有人工對照表（`src/import/title-corrections.ts`）就用它——那是唯一能得到
//   正確台灣片名的路徑；② 沒有對照 ⇒ **保留這一列但把 `title_zh` 寫成空字串**，不要寫進
//   損毀字串。（「有 TMDB 中文標題就用它」那條路對沒配到 TMDB 的作品走不通，實測那 2 筆
//   正好都沒有 tmdb_id。）
// 為什麼是「保留但清空」：擋下不匯入 ⇒ 片庫少一部片 ⇒ 使用者搜不到只好自建 UGC ⇒ 日後要
//   人工合併，而且政府核准紀錄也跟著不見；寫進損毀字串 ⇒ 公開頁出現一個**錯的片名**，
//   那是這個產品最不該犯的錯；寫空字串 ⇒ `apply_tmdb_snapshot()` 對 `title_zh = ''` 的列
//   **會**用 TMDB 標題補上 ⇒ 這個狀態日後配到 TMDB 時會**自己痊癒**。
// ⚠️ 代價：`displayTitle('')` 回空字串。目前 DB 裡沒有任何一列 `title_zh = ''`，所以還沒有
//    畫面壞掉，但顯示層應該退回 `title_original`。
export function inspectTitleZh(value: string | undefined | null): TitleZhCorruption | null {
  const raw = value ?? ''
  if (hasPrivateUseChars(raw))
    return 'private-use'
  if (hasReplacementChars(raw))
    return 'replacement'
  if (isCorruptedEncoding(raw))
    return 'question-marks'
  if (hasSuspectQuestionMark(raw))
    return 'suspect-question-mark'
  return null
}
