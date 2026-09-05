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
