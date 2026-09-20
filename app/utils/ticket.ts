/**
 * 票根卡的文字組裝（`DESIGN_SYSTEM §4.3`）。⚠️ **分隔符必須在字串裡就組好**：
 * Vue 的 whitespace 預設 'condense'，用相鄰元素加空白做分隔會 render 成 `2D16:00`。
 * 所以 meta 行是一個字串、一次插值。
 */

/** 日期帶（票根撕線那一側）要顯示的幾段。 */
export interface DateBand {
  year: string
  /**
   * 月份的英文縮寫：`Jul`。順帶解決一件事：`Jul` 由 Inter 供應（拉丁排字型堆疊第一），
   * 而 `tabular-nums` 本來就只能由 Inter 提供 ⇒ 整條日期帶在同一套字型的同一組度量裡，
   * 多張卡的數字真的對得齊。
   */
  month: string
  /** 日，補零到兩位，配 tabular-nums 才對得齊。 */
  day: string
  /**
   * 星期的英文縮寫：`Sun`。⚠️ **刻意不用中文的「日」**——月份變成 `Jul` 之後，
   * `Jul / 26 / 日` 裡的「日」同時是「星期日」與「日期的單位」，緊貼一個拉丁月份與兩位數
   * 之後會被讀成後者。要改回中文請連月份一起改（混排那版正是被這條換掉的）。
   */
  weekday: string
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * `2026-07-26` → `{ year, month, day, weekday }`。⚠️ 刻意用 `Date.UTC` 算星期：
 * `new Date('2026-07-26').getDay()` 把字串當 UTC 午夜再轉本地，UTC 以西全境退一天而且不報錯。
 * `watched_on` 是台北牆上時間的日期，本來就沒有時區可言。
 */
/*
 * ⚠️ 縮寫用寫死的陣列不用 `Intl.DateTimeFormat`：後者的輸出隨 ICU 版本而異
 * （`Sept` 與 `Sep` 在不同 Node／瀏覽器上都出現過），而這三個字母要在每一台機器上等寬對齊。
 */
export function dateBand(date: string | null | undefined): DateBand | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  if (!m)
    return null
  const [, y, mo, d] = m as unknown as [string, string, string, string]
  const dow = new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()
  return { year: y, month: MONTH_ABBR[+mo - 1]!, day: d, weekday: WEEKDAY_ABBR[dow]! }
}

/**
 * 票價的顯示文字，三種狀態必須看得出差別（§4.3）：null ⇒ 這一項**不存在**（絕不渲染
 * `NT$ ———` 之類的佔位，那等於公告「這裡有一個價格但不給你看」）；0 ⇒ `免費`
 * （實測 16 筆是招待票／兌換票，顯示 `NT$0` 會被讀成「零元」）；其他 ⇒ `NT$520`。
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
 * meta 第一段：影城（含廳別）。⚠️ **必須是不可切開的單位**（呼叫端給 `whitespace-nowrap`）。
 * 存的是政府主檔的官方全名：實測 108 家名稱長度（全形計 2）中位 14、p95 22、最長 30，
 * 超過 24 的只有一家——正好是 David 68% 場次的主場。
 */
/*
 * 375px 的票根卡裡可用 277px，13px 實量：最長影城名 + `(7廳)` 是 248.9px（單行放得下），
 * 整串擠成一行是 360.5px（必換行，斷點會落在名稱中間）。斷在名稱中間的後果是「影城」跑到
 * 第二行開頭、緊接著「數位」，讀起來像在一個叫**「影城 數位」**的地方看的。
 */
export function venueSegment(m: Pick<TicketMeta, 'venueName' | 'hallLabel'>): string | null {
  const parts = [m.venueName, m.hallLabel ? `(${m.hallLabel})` : null]
    .filter((p): p is string => !!p && p.length > 0)
  return parts.length ? parts.join(' ') : null
}

/**
 * meta 第二段：版本／時間／張數／票價。**開眼式括號量詞串，不用中點分隔**——中點串
 * （`A · B · C`）是 Letterboxd 的簽名也是 AI 生成設計的預設長相，§0 已明文避開；
 * 括號與量詞是台灣人看售票網站與票根本來就在讀的寫法。票價一律排最後（§4.3）。
 */
export function detailSegment(m: Omit<TicketMeta, 'venueName' | 'hallLabel'>): string | null {
  const parts = [
    m.formatLabel,
    // ⚠️ 場次時間**不在這裡**：2026-09-06 起它搬到日期帶的最後一行
    // （David：「觀影時間放到日期下面」）。兩邊都印就是同一個值出現兩次，
    // 而讀的人會以為那是兩個不同的時間。要改回來的話兩邊一起改。
    m.ticketCount ? `${m.ticketCount}張` : null,
    costText(m.cost),
  ].filter((p): p is string => !!p && p.length > 0)
  return parts.length ? parts.join(' ') : null
}

/**
 * 兩段串成一行。給不需要斷行控制的地方用（例如純文字的 aria-label）；
 * **畫面上的票根卡不要用這個**，它會把影城名跟其餘量詞串黏成一條，
 * 375px 下必然斷在影城名中間。
 */
export function ticketMetaLine(m: TicketMeta): string {
  return [venueSegment(m), detailSegment(m)].filter(Boolean).join(' ')
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
