/**
 * 票根卡（`TicketCard`）的文字組裝。`DESIGN_SYSTEM §4.3`。
 *
 * ⚠️ 這些函式的存在理由跟 `format-datetime.ts` 一樣：**分隔符必須在字串裡就組好**。
 * Vue 的 whitespace 處理預設是 'condense'，用相鄰元素加空白做分隔會 render 成
 * `2D16:00`。所以 meta 行是一個字串、一次插值。
 */

/** 日期帶（票根撕線那一側）要顯示的三段。 */
export interface DateBand {
  year: string
  /** 月，不補零——§4.3 的樣板是 `7` 不是 `07`。 */
  month: string
  /** 日，補零到兩位，配 tabular-nums 才對得齊。 */
  day: string
  /** 星期的單字：日一二三四五六。 */
  weekday: string
}

/**
 * `2026-07-26` → `{ year: '2026', month: '7', day: '26', weekday: '日' }`。
 *
 * ⚠️ 刻意用 `Date.UTC` 算星期，不用 `new Date('2026-07-26').getDay()`。
 * 後者把字串當 UTC 午夜解析後再轉成**本地**時間，任何 UTC 以西的時區
 * （美洲全境）都會退一天，而且不會報錯。`watched_on` 存的是台北牆上時間的
 * 日期，本來就沒有時區可言，全程留在 UTC 算才不會位移。
 */
export function dateBand(date: string | null | undefined): DateBand | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  if (!m)
    return null
  const [, y, mo, d] = m as unknown as [string, string, string, string]
  const weekday = '日一二三四五六'[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()]!
  return { year: y, month: String(+mo), day: d, weekday }
}

/**
 * 票價的顯示文字。三種狀態必須看得出差別（§4.3）：
 *
 *   null → `null`，這一項**不存在**。絕不渲染 `NT$ ———` 之類的佔位，
 *          那等於公告「這裡有一個價格但不給你看」。沒資料與被隱藏都走這條。
 *   0    → `免費`。實測 David 的紀錄有 16 筆是 0，那是招待票／兌換票，
 *          不是「不知道」也不是「零元」。顯示 `NT$0` 會讀成後者。
 *   其他 → `NT$520`
 */
export function costText(cost: number | null | undefined): string | null {
  if (cost === null || cost === undefined || Number.isNaN(cost))
    return null
  if (cost === 0)
    return '免費'
  return `NT$${Number(cost).toLocaleString('zh-Hant-TW')}`
}

export interface TicketMeta {
  venueName?: string | null
  hallLabel?: string | null
  formatLabel?: string | null
  /** `HH:mm` 或 `HH:mm:ss`，會自己截到分。 */
  watchedTime?: string | null
  ticketCount?: number | null
  cost?: number | null
}

/**
 * meta 行：`林口威秀 (7廳) 2D 16:00 2張 NT$520`
 *
 * **開眼式括號量詞串，不用中點分隔。** 中點串（`A · B · C`）是 Letterboxd 的
 * 簽名手法之一，也是 AI 生成設計的預設長相，§0 已明文避開。括號與量詞是
 * 台灣人看售票網站與票根本來就在讀的寫法。
 *
 * 票價一律排最後（§4.3）。
 */
export function ticketMetaLine(m: TicketMeta): string {
  const parts: (string | null | undefined)[] = [
    m.venueName,
    m.hallLabel ? `(${m.hallLabel})` : null,
    m.formatLabel,
    m.watchedTime ? m.watchedTime.slice(0, 5) : null,
    m.ticketCount ? `${m.ticketCount}張` : null,
    costText(m.cost),
  ]
  return parts.filter((p): p is string => !!p && p.length > 0).join(' ')
}

/**
 * 票根卡上那部片。欄位名一律 camelCase——四個呼叫端的原始資料形狀不同
 * （`/u/` 走 API 的 camelCase、`/app/records` 走 supabase 的 snake_case），
 * 在呼叫端各自對映一次，元件只認一種形狀。
 */
export interface TicketCardFilm {
  slug?: string | null
  titleZh?: string | null
  titleOriginal?: string | null
  tmdbPosterPath?: string | null
  ugcPosterUrl?: string | null
}

/** 票根卡的一筆紀錄。 */
export interface TicketCardRecord extends TicketMeta {
  id?: string | null
  /** `YYYY-MM-DD`。 */
  watchedOn?: string | null
  film?: TicketCardFilm | null
  memo?: string | null
  /** 只有本人看得到的紀錄。公開頁面永遠拿不到這種列，所以只有 `/app` 會用到。 */
  isPrivate?: boolean | null
}
