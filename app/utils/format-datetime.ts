/**
 * 日期與時間的顯示格式。
 *
 * ⚠️ 不要在 template 裡用相鄰的插值加空白來做分隔：
 *     {{ r.watchedOn }}<span v-if="t"> {{ t }}</span>
 *   Vue 的 whitespace 處理預設是 'condense'，會把元素與插值之間的空白摺疊掉，
 *   實際 render 出來是 `2026-07-2616:00`。分隔符必須在字串裡就組好。
 */

/** `21:30:00` → `21:30`；null/空 → null。 */
export function shortTime(time: string | null | undefined): string | null {
  if (!time)
    return null
  return time.slice(0, 5)
}

/** `2026-07-26` + `16:00:00` → `2026-07-26 16:00`（只有日期時就只回日期）。 */
export function dateTimeText(
  date: string | null | undefined,
  time?: string | null,
): string {
  if (!date)
    return ''
  const t = shortTime(time)
  return t ? `${date} ${t}` : date
}

/** 把一組資訊用中點串起來，並濾掉空值——避免出現「· · digital」這種殘骸。 */
export function metaLine(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.length > 0).join(' · ')
}

/**
 * `2026-07-26` + `16:00:00` → `2026/07/26 16:00`。**維護後台專用的機器可讀格式。**
 *
 * ⚠️ 這不是票根卡那一套（`Jul` / `26 Sun` / `16:00`，見 `utils/ticket.ts` 的
 * `dateBand()`）。兩套並存是刻意的，分界線是頁面的性質：
 *   · 回顧用的頁面（`/app`、`/u/`、`/film/`）留票根語彙——那裡在講一段經驗。
 *   · `/app/records` 是**個人資料維護後台**（David 2026-09-06），
 *     那裡在對帳、排序、找哪一筆填錯了，需要的是一眼可比對的標準格式。
 *
 * ⚠️ 沒有時間時**只回日期，不補 `--:--` 之類的佔位**。缺席靠「別的列後面都有
 * 一截、這一列沒有」自己顯現就夠了；佔位符會變成一整欄的雜訊，而且看起來像
 * 「有一個時間但不給你看」（同 `SCREENS §12` 第 4 條的理由）。
 *
 * ⚠️ 日期不合格式時回空字串（同 `dateBand()` 的嚴格度），不做「盡量拼湊」——
 * `watched_on` 是資料庫的 `date` 欄位，拼湊出來的東西只會掩蓋真正的資料問題。
 */
export function watchedAtText(date: string | null | undefined, time?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '')
  if (!m)
    return ''
  const [, y, mo, d] = m as unknown as [string, string, string, string]
  const t = shortTime(time)
  return t ? `${y}/${mo}/${d} ${t}` : `${y}/${mo}/${d}`
}
