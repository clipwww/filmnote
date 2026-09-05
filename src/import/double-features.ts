import type { NormalizedRecord } from '#pipeline/import/mylog'

/**
 * 雙片連映：一次進場看兩部片，舊 log 記成一筆。
 *
 * 舊 log 把「少女與戰車最終章 1+2」當成一部片名，但 TMDB 上第1話與第2話
 * 是兩部獨立作品，沒有連映版條目。一筆 viewing_record 只能指向一部作品，
 * 所以必須拆成兩筆，各自指向正確的作品。
 *
 * 拆分會製造兩個必須小心處理的問題：
 *
 * **票價**：他一次進場只付一次錢。全額記在第一筆，第二筆**不記金額**
 * （連 viewing_record_cost 這一列都不建，而非記 0）。對半拆會捏造出
 * 不存在的價格，兩筆都記全額會讓年度總花費憑空翻倍——年度總花費是
 * 這個產品的核心價值之一，不能因為顯示上的方便而失真。
 *
 * **import_key**：`unique (user_id, import_key)` 是冪等的唯一依靠。
 * 兩筆共用原 id 會直接撞鍵，第二筆覆蓋第一筆，重跑筆數就會跳動。
 * 因此以 `<原id>#<序號>` 產生確定性且互斥的鍵。
 *
 * 實測 169 筆中有 5 筆是連映（3 筆 1+2、2 筆 3+4），其中 2024-03-09 那兩筆
 * 備註寫著「4DX連映馬拉松場(上)」與「(下)」——那是連映最直接的佐證。
 */

export interface DoubleFeaturePart {
  /**
   * 拆出來的片名。必須與 tmdb-overrides.ts 的 `logTitle` 一致，
   * 作品才解析得到——拆分只負責切開，指定作品仍統一走人工對照表。
   */
  title: string
}

export interface DoubleFeature {
  /** 舊 log `title` 欄的原字串，逐字比對。 */
  logTitle: string
  /** 依放映順序。第一部帶全額票價，其餘不記金額。 */
  parts: DoubleFeaturePart[]
  /** 判定依據，寫進拆出來的每一筆備註。 */
  note: string
}

export const DOUBLE_FEATURES: DoubleFeature[] = [
  {
    logTitle: '少女與戰車最終章 1+2',
    parts: [
      { title: '少女與戰車最終章 第1話' },
      { title: '少女與戰車最終章 第2話' },
    ],
    note: '第1話與第2話連映',
  },
  {
    logTitle: '少女與戰車最終章 3+4',
    parts: [
      { title: '少女與戰車最終章 第3話' },
      { title: '少女與戰車最終章 第4話' },
    ],
    note: '第3話與第4話連映',
  },
]

const BY_LOG_TITLE = new Map(DOUBLE_FEATURES.map(f => [f.logTitle, f]))

/** 逐字查表，查無回傳 null。 */
export function resolveDoubleFeature(logTitle: string): DoubleFeature | null {
  return BY_LOG_TITLE.get(logTitle.trim()) ?? null
}

/**
 * 把一筆連映紀錄展開成多筆。
 *
 * 回傳的每一筆共用同一個時間與場所（本來就是同一次進場），
 * 差別在片名、import_key 後綴，以及票價只掛在第一筆。
 */
export function expandDoubleFeature(
  record: NormalizedRecord,
  feature: DoubleFeature,
): NormalizedRecord[] {
  return feature.parts.map((part, index) => ({
    ...record,
    // 確定性後綴。原 id 是 base64，不含 '#'，不會與原鍵混淆。
    importKey: `${record.importKey}#${index + 1}`,
    title: part.title,
    // 只有第一筆帶金額。null = 不建 viewing_record_cost 這一列。
    amount: index === 0 ? record.amount : null,
    memo: composeMemo(record.memo, feature, index),
  }))
}

/**
 * 備註要說清楚這是連映拆出來的，否則半年後看到同一天同一影廳的兩筆，
 * 會以為自己重複記錄了。第二筆額外註明票價記在第一筆。
 */
function composeMemo(
  original: string | null,
  feature: DoubleFeature,
  index: number,
): string {
  const marker = `［連映拆分 ${index + 1}/${feature.parts.length}：${feature.note}，`
    + `原記錄為「${feature.logTitle}」一筆`
    + `${index === 0 ? '' : '，票價記於第 1 筆'}］`
  return original ? `${original}\n${marker}` : marker
}

/** 拆分後總筆數的預期值，供匯入報告與測試對帳。 */
export function expandedCount(titles: string[]): number {
  return titles.reduce((sum, title) => {
    const feature = resolveDoubleFeature(title)
    return sum + (feature ? feature.parts.length : 1)
  }, 0)
}
