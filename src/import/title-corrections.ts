/**
 * 中文片名的人工對照表（編碼損毀修復）。
 *
 * 比照 `tmdb-overrides.ts` 的形態：**`reason` 欄是資產**，它記錄了每一筆「為什麼
 * 需要人工介入」以及「這個答案有多可靠」。日後要重新檢視時，那是唯一的依憑。
 *
 * ── 什麼情況會進這張表 ────────────────────────────────────────────────────
 * 來源資料的中文片名編碼損毀，**而且沒有可用的替代來源**。
 * 既有解法是「有 TMDB 中文標題就用它」，但那條路對沒配到 TMDB 的作品走不通
 * ——目前這兩筆正好都沒有 `tmdb_id`。
 *
 * ── 為什麼用 `permitNo` + `rocYear` 當鍵 ───────────────────────────────────
 * 不能用損毀的片名當鍵：那正是我們要修的東西，而且它在不同的處理階段可能被
 * 正規化成不同的樣子。`permitNo` 跨年度不唯一（踩雷 #44），所以要配上 `rocYear`。
 *
 * ⚠️ 這張表只修**已知**的那幾筆。真正的守門員是
 * `src/normalize/defensive.ts` 的 `inspectTitleZh()`——它負責讓新的損毀不會
 * 再無聲地走到公開頁。沒有被這張表涵蓋的損毀，處理方式見那支函式的註解。
 */

export interface TitleCorrection {
  rocYear: number
  permitNo: string
  /** 原文片名，用來人工核對這筆對照沒有配錯。 */
  titleOriginal: string
  /** 更正後的中文片名。 */
  titleZh: string
  /**
   * 這個答案的可靠度。
   * `confirmed` —— 多個獨立的台灣來源一致。
   * `probable`  —— 只有單一來源，或有寫法上的變體未經核對。
   */
  confidence: 'confirmed' | 'probable'
  reason: string
}

export const TITLE_CORRECTIONS: TitleCorrection[] = [
  {
    rocYear: 111,
    permitNo: '第111250號',
    titleOriginal: 'LEOPOLDSTADT',
    titleZh: '利奧波德城（英國國家劇院現場）',
    confidence: 'confirmed',
    reason:
      '來源的 title_zh 為「利<U+F8F8><U+F8F8>铪i德城（英國國家劇院現場）」，'
      + '「奧波」兩字損毀成四個私用區／垃圾字元，其餘完好。'
      + '三個獨立的台灣來源一致（開眼電影網、威秀影城片頁、OPENTIX 兩廳院套票頁）：'
      + 'Tom Stoppard 舞台劇的 NT Live 放映版，2022 年在台灣威秀上映。'
      + '損毀形態（頭尾完好、中間逐字失敗）也與這個還原互相印證。',
  },
  {
    rocYear: 111,
    permitNo: '第111403號',
    titleOriginal: 'BLDG. N',
    titleZh: 'Ｎ號棟鬧鬼',
    confidence: 'probable',
    reason:
      '來源的 title_zh 為「Ｎ<U+F8F8><U+F8F8>妠刉x鬼」，頭尾的「Ｎ」與「鬼」完好，'
      + '中間三字損毀成五個字元，結構吻合「Ｎ號棟鬧鬼」。日本片《N号棟》(2022)。'
      + '⚠️ 只找到單一台灣來源（LiTV 立視線上影視），且該來源寫作「N号棟鬧鬼」'
      + '——用的是日文漢字「号」而非「號」。政府核准的正式片名採用哪一個寫法'
      + '**尚未經政府資料核對**，故標為 probable。若日後在政府 CSV 的其他年度或'
      + '其他欄位找到佐證，以政府資料為準。',
  },
]

/** 以年度與字號查對照。查不到回 `undefined`。 */
export function findTitleCorrection(
  rocYear: number,
  permitNo: string,
): TitleCorrection | undefined {
  return TITLE_CORRECTIONS.find(c => c.rocYear === rocYear && c.permitNo === permitNo)
}
