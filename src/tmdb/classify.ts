/**
 * 把 TMDB 的上映清單對著片庫分成三類。純函式、沒有 I/O ——
 * dry-run 與真正的匯入必須共用同一段判斷，否則「看到的數字」與「寫下去的東西」會分岔。
 */
// ★ 為什麼是三分類而不是「新／舊」兩分類：實測 2026-09-21 片庫有 267 部 origin='gov'
//   的作品沒有 tmdb_id（比對器沒配到，例如《間諜家家酒》片商用英文片名登記）
//   ⇒ 盲目新增時，那 267 部裡只要有一部也出現在上映清單裡就會變成重複作品。
// ⚠️ ② 只是**線索不是判定**：片名比對用 normalizeTitle()，刻意不跑 scoreCandidate()
//    （那需要片長而清單端點不給）。這裡的職責是把可疑的攤出來給人看，不是替人決定。
// ⚠️ 欄位刻意維持資料庫的 snake_case：兩個呼叫端都是直接餵 SQL 查出來的列，
//    多一層改名只會多一個出錯的地方。

import { normalizeTitle } from '#pipeline/normalize/title'

/** 片庫既有作品。欄位取自 `public.film`，只取比對用得到的那幾個。 */
export interface KnownFilm {
  id: string
  tmdb_id: number | null
  title_zh: string
  title_original: string
  origin: string
}

/** TMDB 清單端點的一筆。刻意只要求比對用得到的欄位，方便測試餵合成樣本。 */
export interface ReleaseLike {
  id: number
  title: string
  original_title: string
}

export interface Classified<R extends ReleaseLike> {
  /** ① tmdb_id 已經在片庫裡。 */
  known: R[]
  /** ② 片名對得上一部**沒有 tmdb_id** 的既有作品 ⇒ 該補 id，不是新增。 */
  suspected: { release: R, hits: KnownFilm[] }[]
  /** ③ 兩者皆非 ⇒ 候選新增。 */
  fresh: R[]
}

export function classifyReleases<R extends ReleaseLike>(
  releases: Iterable<R>,
  library: readonly KnownFilm[],
): Classified<R> {
  const byTmdbId = new Set(
    library.map(f => f.tmdb_id).filter((v): v is number => v !== null),
  )

  // 沒有 tmdb_id 的既有作品，以正規化片名建索引——那是「會被重複新增」的那一群。
  const orphansByTitle = new Map<string, KnownFilm[]>()
  for (const f of library) {
    if (f.tmdb_id !== null)
      continue
    for (const t of [f.title_zh, f.title_original]) {
      const k = normalizeTitle(t)
      if (!k)
        continue
      orphansByTitle.set(k, [...(orphansByTitle.get(k) ?? []), f])
    }
  }

  const out: Classified<R> = { known: [], suspected: [], fresh: [] }
  for (const r of releases) {
    if (byTmdbId.has(r.id)) {
      out.known.push(r)
      continue
    }
    const hits = [
      ...(orphansByTitle.get(normalizeTitle(r.title)) ?? []),
      ...(orphansByTitle.get(normalizeTitle(r.original_title)) ?? []),
    ]
    const uniq = [...new Map(hits.map(h => [h.id, h])).values()]
    if (uniq.length)
      out.suspected.push({ release: r, hits: uniq })
    else
      out.fresh.push(r)
  }
  return out
}
