import { z } from 'zod'

/**
 * 後台匯入的輸入契約。自足模組（不碰 `#supabase/server`），vitest 才載得進來。
 * ★ 上限都是替「有人在瀏覽器前面等、函式隨時可能被砍」設的，不是替 TMDB 配額。
 */
export const MAX_PAGES = 5
export const MAX_IDS = 20
export const MAX_SEARCH_RESULTS = 10

export const importSourceSchema = z.discriminatedUnion('kind', [
  /** TMDB「台灣上映中／即將上映」，與 CLI 同一份清單。 */
  z.object({ kind: z.literal('releases'), pages: z.coerce.number().int().min(1).max(MAX_PAGES) }),
  /** 片名搜尋。只給預覽用：匯入一律改送 `ids`，片名以 TMDB 明細為準。 */
  z.object({ kind: z.literal('search'), q: z.string().trim().min(1).max(120) }),
  /** 指定 TMDB id。清單裡沒有的片（例如上映超過一個多月、已掉出「上映中」的）走這條。 */
  z.object({ kind: z.literal('ids'), ids: z.array(z.coerce.number().int().positive()).min(1).max(MAX_IDS) }),
])
export type ImportSource = z.infer<typeof importSourceSchema>

export const importBodySchema = z.object({
  source: importSourceSchema.refine(s => s.kind !== 'search', { message: '匯入請改送 ids' }),
  /** 瀏覽器的勾選。只能縮小範圍，見 `rowsToImport()`。 */
  only: z.array(z.coerce.number().int().positive()).max(500).optional(),
})

/**
 * 從貼上的文字取 TMDB id：純數字，或 `themoviedb.org/movie/1368337-the-odyssey` 這種網址。
 * 取不到回 null（交給呼叫端當成片名搜尋）。
 */
export function parseTmdbId(input: string): number | null {
  const s = input.trim()
  const m = /^(\d{1,9})$/.exec(s) ?? /themoviedb\.org\/movie\/(\d{1,9})/.exec(s)
  return m ? Number(m[1]) : null
}
