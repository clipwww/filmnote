/**
 * 「電影片分級及相關資訊」CSV → Certificate[]
 *
 * 只處理 110 年起的 9 欄 schema。104–109 年把中文與外文片名合併在
 * 同一欄、且分級證明字號格式三度變更，需另寫清洗邏輯，目前不在範圍內。
 *
 * 以陣列而非物件模式解析，是為了能偵測欄數異常——實測 113 年有兩列
 * 因 CSV 引號損壞而多出一欄，若用 `columns: true` 會靜默錯位。
 */

import type { Certificate, RowDefect } from '#pipeline/types'
import { parse } from 'csv-parse/sync'
import { findTitleCorrection } from '#pipeline/import/title-corrections'
import { inspectOriginalTitle, inspectTitleZh } from '#pipeline/normalize/defensive'
import { parseRuntimeMinutes } from '#pipeline/normalize/runtime'
import { extractVersionNote, normalizeTitle } from '#pipeline/normalize/title'

/** 110 年起的欄位，順序即為 CSV 的欄序。 */
const COLUMNS = [
  '年度',
  '分級證明字號',
  '級別',
  '中文片名',
  '原文片名',
  '國別',
  '語言',
  '出品公司',
  '映演時間',
] as const

const COLUMN_COUNT = COLUMNS.length
/** 原文片名在欄序中的位置，也是引號損壞時被切碎的欄位。 */
const ORIGINAL_TITLE_INDEX = 4

/** 民國年轉西元年。 */
export function rocToGregorian(rocYear: number): number {
  return rocYear + 1911
}

interface AlignedRow {
  cells: string[]
  defects: RowDefect[]
}

/**
 * 把一列的欄位對回正確的位置。
 *
 * 多出欄位時，假定切碎的是「原文片名」（唯一常含逗號的自由文字欄），
 * 並以「最後一欄能否解析成片長」作為回推正確與否的驗證。驗證不過就
 * 不硬修，標記後原樣放行——錯誤的修正比不修正更難察覺。
 */
export function alignRow(cells: string[]): AlignedRow {
  if (cells.length === COLUMN_COUNT)
    return { cells, defects: [] }

  const extra = cells.length - COLUMN_COUNT
  const canRecover
    = extra > 0
      && parseRuntimeMinutes(cells.at(-1)) !== null
      && parseRuntimeMinutes(cells[COLUMN_COUNT - 1]) === null

  if (!canRecover) {
    const padded = [...cells]
    padded.length = COLUMN_COUNT
    return {
      cells: padded.map(cell => cell ?? ''),
      defects: ['column-count-unexpected'],
    }
  }

  const head = cells.slice(0, ORIGINAL_TITLE_INDEX)
  const merged = cells
    .slice(ORIGINAL_TITLE_INDEX, ORIGINAL_TITLE_INDEX + extra + 1)
    .join(',')
  const tail = cells.slice(ORIGINAL_TITLE_INDEX + extra + 1)

  return {
    cells: [...head, merged, ...tail],
    defects: ['column-shift-recovered'],
  }
}

export function parseRatingCsv(csv: string): Certificate[] {
  const rows = parse(csv, {
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as string[][]

  const header = rows[0]
  if (!header)
    return []

  const missing = COLUMNS.filter(col => !header.includes(col))
  if (missing.length) {
    throw new Error(
      `分級資料的欄位與預期不符，缺少：${missing.join('、')}。`
      + `本解析器僅支援 110 年起的 9 欄 schema。`,
    )
  }

  return rows
    .slice(1)
    .filter(cells => cells.some(cell => cell.trim()))
    .map(cells => toCertificate(alignRow(cells)))
}

function toCertificate({ cells, defects: rowDefects }: AlignedRow): Certificate {
  const defects: RowDefect[] = [...rowDefects]
  const at = (index: number): string => (cells[index] ?? '').trim()

  const rocYear = Number(at(0))
  const permitNo = at(1)

  const titleZhRawSource = at(3)
  /**
   * 中文片名的編碼損毀處理（`normalize/defensive.ts` 的 `inspectTitleZh` 有完整推理）。
   *
   * ★ `private-use` 與 `replacement` 是**確定**的損毀：字元本身就不是任何真的字。
   *   `question-marks` / `suspect-question-mark` 則可能是真的問號
   *   （《孩子，你好嗎？》），所以只標記、不動片名——沿用既有行為。
   *
   * 確定損毀時的順序是：
   *   ① 人工對照表（`import/title-corrections.ts`）有答案就用它——那是唯一能得到
   *      **正確台灣片名**的路徑，而「記得住台灣的片名」是這個產品的第一個理由。
   *   ② 沒有對照就**寫空字串**，絕不把損毀字串帶下去。
   *      不擋下整列：片庫少一部片 ⇒ 使用者搜不到 ⇒ 自己建 UGC ⇒ 日後要人工合併。
   *      空字串還會自己痊癒（`apply_tmdb_snapshot` 會用 TMDB 標題補 `title_zh = ''`）。
   */
  const corruption = inspectTitleZh(titleZhRawSource)
  const isDefinitelyCorrupt = corruption === 'private-use' || corruption === 'replacement'
  const correction = isDefinitelyCorrupt ? findTitleCorrection(rocYear, permitNo) : undefined
  const titleZhRaw = isDefinitelyCorrupt ? (correction?.titleZh ?? '') : titleZhRawSource

  if (!titleZhRawSource)
    defects.push('title-zh-missing')
  else if (corruption)
    defects.push('title-zh-suspect-encoding')

  const originalRaw = at(ORIGINAL_TITLE_INDEX)
  const original = inspectOriginalTitle(originalRaw)
  if (original.defect)
    defects.push(original.defect)

  const runtimeRaw = at(8)
  const runtimeMinutes = parseRuntimeMinutes(runtimeRaw)
  if (runtimeMinutes === null && runtimeRaw)
    defects.push('runtime-unparseable')

  const { title, note } = extractVersionNote(titleZhRaw)

  return {
    // 確定性代理鍵：permitNo 只在 113 年唯一（見 Certificate.id 的說明），
    // 加上年度與正規化片名後在 110–113 年全部 3,116 筆上實測唯一。
    // ★ 用**來源**片名算 id，不是修正後的。修正會改變片名，若 id 跟著變，
    //   同一列在修正前後會變成兩筆不同的紀錄（`import_key` 那個坑的同一家族）。
    id: `${rocYear}:${permitNo}:${normalizeTitle(titleZhRawSource)}`,
    permitNo,
    rocYear,
    gregorianYear: rocToGregorian(rocYear),
    rating: at(2),
    // 保留剝除標註後的片名作為顯示與比對的基準；標註存入 versionNote，資訊不遺失。
    titleZh: title,
    // 原文片名損毀時存空字串，比對器會自動只走中文片名路徑。
    titleOriginal: original.usable ? originalRaw : '',
    country: at(5),
    language: at(6),
    producer: at(7),
    runtimeMinutes,
    versionNote: note,
    defects,
  }
}
