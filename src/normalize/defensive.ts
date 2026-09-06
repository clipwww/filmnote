/**
 * 來源資料損毀的偵測。
 *
 * 政府 CSV 是人工經 Excel 維護的產物，實測於 110–113 年出現三類損毀。
 * 這些筆數很少（約 0.1%），但若不處理會讓比對器拿著垃圾字串去查 TMDB，
 * 浪費配額並產生假陽性。偵測到損毀時改走中文片名的查詢路徑。
 */

import type { RowDefect } from '#pipeline/types'

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
 * 中文片名裡是否有疑似編碼損毀的問號。
 *
 * 只做「有沒有 ASCII 問號」這個粗判，不試圖區分真問號與損毀——實測
 * 15 筆命中中，《孩子，你好嗎？》系列 5 筆是真問號，其餘是損毀，
 * 兩者在字串層面沒有可靠的判別特徵。
 *
 * 判別交給 consolidate：有 TMDB 中文標題就用它（實測 4 筆有配對的
 * 全都是真損毀，且 TMDB 的標題正確），沒有則保留原值並標記。
 */
export function hasSuspectQuestionMark(value: string | undefined | null): boolean {
  return (value ?? '').includes('?')
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

// -----------------------------------------------------------------------------
// 私用區字元損毀
//
// ★ 這與上面的「問號型」是**不同的失敗模式**，不要合成一條規則。
//
//   問號型：解碼器**失敗了而且說了**——把無法轉換的 Big5 位元組寫成 ASCII `?`。
//           資訊在那一刻就沒了，字串裡只剩下「這裡本來有東西」。
//
//   私用區：解碼器**成功了**——某張映射表把那些位元組對應到 Unicode 私用區
//           （U+E000–U+F8FF 等）。字串在編碼上完全合法，任何 UTF-8 檢查都不會
//           抱怨，`length` 正常、比對正常、寫進資料庫也正常。
//           **這正是它能一路走到公開頁而沒有被任何一層攔下的原因。**
//
//   實測（2026-09-06）：110–113 年的資料裡有 2 筆，`film` 與 `certificate` 各 2 列。
//     111 年第111250號 `LEOPOLDSTADT` → 「利<U+F8F8><U+F8F8>铪i德城（英國國家劇院現場）」
//     111 年第111403號 `BLDG. N`      → 「Ｎ<U+F8F8><U+F8F8>妠刉x鬼」
//   兩者的頭尾都完好，只有中間幾個字變成垃圾——符合逐字映射失敗的形態。
//
// ⚠️ 私用區字元**看起來不一定像亂碼**。它在不同字型下可能被畫成任意字形，
//    甚至是空白或方框，所以「肉眼檢查片名」抓不到它。只能用碼位判斷。
// -----------------------------------------------------------------------------

/**
 * Unicode 私用區。三段都要查：
 *   - U+E000–U+F8FF     BMP 私用區（Big5 轉換失敗最常落在這裡）
 *   - U+F0000–U+FFFFD   增補私用區 A
 *   - U+100000–U+10FFFD 增補私用區 B
 *
 * ★ 必須用 `u` 旗標，否則後兩段的代理對會被當成兩個獨立的 BMP 字元而漏判。
 * ★ 一律寫成 `\uXXXX` 逃脫，**不要把私用區字元字面貼進原始碼**——它們在編輯器、
 *   終端機、剪貼簿之間很容易被吃掉或替換成別的字元，而且肉眼看不出來已經壞了。
 *   （寫這一行時就被吃掉過一次：字面版本變成了 `[-]`，一個什麼都比對不到的
 *   字元類別，而 tsc 完全不會抱怨。）
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
 * 判定中文片名的損毀型態。**依嚴重度由確定到可疑排序**，只回報最確定的那一種。
 *
 * ── 偵測到之後該怎麼辦 ────────────────────────────────────────────────────
 *
 * 既有解法是「有 TMDB 中文標題就用它」（見 `hasSuspectQuestionMark` 的註解），
 * 但那條路對**沒有配到 TMDB** 的作品走不通——實測那 2 筆正好都沒有 tmdb_id。
 * 所以需要一條在「沒有替代來源」時仍然正確的規則：
 *
 *   ① 有人工對照表（`src/import/title-corrections.ts`）→ 用它。這是唯一能得到
 *      **正確台灣片名**的路徑，而「記得住台灣的片名」是這個產品的第一個理由。
 *   ② 沒有對照 → **保留這一列，但不要把損毀字串寫進 `title_zh`，寫空字串。**
 *
 * 為什麼是「保留但清空」而不是「擋下不匯入」：
 *   - 擋下 ⇒ 片庫少一部片 ⇒ 看過它的人在「新增紀錄」搜不到 ⇒ 只好自己建一部
 *     UGC 作品 ⇒ 日後要人工合併。用一個看不見的資料缺陷換來一個使用者做錯的
 *     動作，不划算；而且政府核准紀錄本身也跟著不見了。
 *   - 寫進損毀字串 ⇒ 公開頁上出現一個**錯的片名**。這是這個產品最不該犯的錯。
 *   - 寫空字串 ⇒ schema 的 `title_zh` 預設就是 `''`，而 `apply_tmdb_snapshot()`
 *     對 `title_zh = ''` 的列**會**用 TMDB 標題補上（不論 title_zh_source）。
 *     也就是說這個狀態會在日後配到 TMDB 時**自己痊癒**，不需要有人記得回來處理。
 *
 * ⚠️ 代價（必須讓前端知道）：`displayTitle('')` 回空字串。目前 DB 裡沒有任何
 *    一列 `title_zh = ''`，所以還沒有畫面壞掉，但顯示層應該退回 `title_original`。
 */
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
