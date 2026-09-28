/**
 * 台北牆上時間：全站唯一的 `Asia/Taipei` 格式器（2026-09-28 裁決：「今天」一律是台北）。
 * 前端（`app/utils/taipei-time.ts` 轉出）、伺服器（`mylog-csv`）、匯入（`mylog`）共用這一份，
 * 各自再包一層自己的失敗策略（app 回 `''`、匯入 throw）。
 */
/*
 * ⚠️ 本檔會被瀏覽器載入：不可以有 `node:` import（踩雷 #130，build exit 0 但功能靜默消失）。
 * ⚠️ 只收 `timestamptz` 瞬間。`watched_on` 這種 date 欄位是字串，**不要**丟進來——
 * `new Date('2026-03-01')` 當 UTC 午夜解析，UTC 以西整個退一天（`stats.ts` 的 `inMonth()`）。
 */

// 用 Intl 而非硬寫 +8：台灣 1979 年以前實施過日光節約時間，硬寫會靜默地錯一小時。
// `hourCycle: 'h23'` 不用 `hour12: false`：後者在部分引擎會把午夜印成 `24:00`。
const TAIPEI_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 皆為補零字串：`year` 四位，其餘兩位。 */
export interface TaipeiParts {
  year: string
  month: string
  day: string
  hour: string
  minute: string
}

/** 某個瞬間的台北牆上時間。解析不了回 null，由呼叫端決定要回空字串還是 throw。 */
export function taipeiParts(instant: string | number | Date | null | undefined): TaipeiParts | null {
  if (instant === null || instant === undefined || instant === '')
    return null
  const d = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(d.getTime()))
    return null
  const p: Record<string, string> = {}
  for (const part of TAIPEI_PARTS.formatToParts(d))
    p[part.type] = part.value
  return { year: p.year ?? '', month: p.month ?? '', day: p.day ?? '', hour: p.hour ?? '', minute: p.minute ?? '' }
}

/** `2026-09-27T16:30:00Z` → `2026-09-28`。管理後台的 `dayText` 與法遵頁的生效日都是這個格式。 */
export function taipeiDateText(instant: string | number | Date | null | undefined): string {
  const p = taipeiParts(instant)
  return p ? `${p.year}-${p.month}-${p.day}` : ''
}

/**
 * `2026-09-05T18:29:18.9+00:00` → `2026/09/06 02:29`（管理後台「最後一次刷新」要對帳到分）。
 * 分隔符在字串裡組好：Vue 的 whitespace 'condense' 會摺掉 template 裡相鄰插值間的空白。
 */
export function taipeiDateTimeText(instant: string | number | Date | null | undefined): string {
  const p = taipeiParts(instant)
  return p ? `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}` : ''
}

/**
 * 台北的「今天」`YYYY-MM-DD`，給 `watched_on` 當預設值。**不要**用 `toISOString()`（UTC：
 * 台北早上 8 點前會變昨天），也不要用瀏覽器本地日期（人在海外時會跟 DB 的台北日期分岔）。
 */
export function taipeiToday(now: number | Date = Date.now()): string {
  return taipeiDateText(now)
}

/** 台北的年與月（1..12）。`stats.ts` 用它判斷「今年還沒到的月份」。無效的 Date 回 null，不 throw。 */
export function taipeiYearMonth(now: number | Date = Date.now()): { year: number, month: number } | null {
  const p = taipeiParts(now)
  return p ? { year: Number(p.year), month: Number(p.month) } : null
}

/**
 * 從 `from` 到 `to` 跨過幾個**台北日曆天**（`to` 較早回負數）。不是 24 小時的倍數：
 * 台北 23:50 到隔天 00:10 是 1 天——`floor(ms / 86_400_000)` 會說 0，列表就寫成「今天」。
 */
export function taipeiCalendarDaysBetween(
  from: string | number | Date | null | undefined,
  to: string | number | Date | null | undefined,
): number | null {
  const a = taipeiParts(from)
  const b = taipeiParts(to)
  if (!a || !b)
    return null
  const utc = (p: TaipeiParts) => Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))
  return Math.round((utc(b) - utc(a)) / 86_400_000)
}

/** `今天`／`昨天`／`N 天前`（以台北日曆天計）。給佇列列表用，精確到天就夠了。 */
export function taipeiAgoText(
  instant: string | number | Date | null | undefined,
  now: number | Date = Date.now(),
): string {
  const days = taipeiCalendarDaysBetween(instant, now)
  if (days === null)
    return ''
  if (days <= 0)
    return '今天'
  if (days === 1)
    return '昨天'
  return `${days} 天前`
}
