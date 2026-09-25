/**
 * 從貼上的文字取 TMDB id：`themoviedb.org/movie/1368337-the-odyssey` 這種網址，或 5 位以上的純數字。
 * 取不到回 null（交給呼叫端當成片名搜尋）。
 * ⚠️ 純數字要 5 位以上：《1917》《2046》這種片名本身就是數字，4 位以下當 id 會查到不相干的片。
 */
export function parseTmdbId(input: string): number | null {
  const s = input.trim()
  const m = /themoviedb\.org\/movie\/(\d{1,9})/.exec(s) ?? /^(\d{5,9})$/.exec(s)
  return m ? Number(m[1]) : null
}
