/**
 * 後台「匯入新作品」的判斷：TMDB 的一批作品對著片庫分成四類。純函式、沒有 I/O ——
 * 預覽與真正的匯入必須共用同一段判斷，否則「畫面上看到的」與「寫下去的」會分岔。
 */
// ★ 在 `classifyReleases()` 的 ①②③ 之外多一類 `blocked`：③ 裡已經有 `tmdb:<id>` identity 的。
//   它會走 `seed_films()` 的 UPDATE 分支，而那條路的 `least(coalesce(first_seen_roc_year, 9999), null)`
//   會把年份寫成 9999（CLI 的閘門 ②）。

import type { KnownFilm, ReleaseLike } from './classify'
import type { SeedFilmRow } from './seed-row'
import { classifyReleases } from './classify'
import { tmdbKey, toSeedRow } from './seed-row'

export interface ImportPlan<R extends ReleaseLike> {
  /** ① tmdb_id 已經在片庫裡。 */
  known: R[]
  /** ② 片名對得上一部沒有 tmdb_id 的既有作品 ⇒ 該補 id，不是新增。這裡不替人決定。 */
  suspected: { release: R, hits: KnownFilm[] }[]
  /** ③ 可以匯入。 */
  fresh: R[]
  /** ③ 裡已經有 identity 的 ⇒ 會走 UPDATE 分支，拒絕。 */
  blocked: R[]
}

export function buildImportPlan<R extends ReleaseLike>(
  releases: Iterable<R>,
  library: readonly KnownFilm[],
  existingKeys: ReadonlySet<string>,
): ImportPlan<R> {
  const { known, suspected, fresh } = classifyReleases(releases, library)
  return {
    known,
    suspected,
    fresh: fresh.filter(r => !existingKeys.has(tmdbKey(r.id))),
    blocked: fresh.filter(r => existingKeys.has(tmdbKey(r.id))),
  }
}

/**
 * 要真的送出去的列：只從 ③ 取，`only` 給了就再取交集。
 * ★ `only` 是瀏覽器送來的勾選——只能**縮小**範圍，永遠不能把 ①②或 blocked 的塞進來。
 */
export function rowsToImport<R extends ReleaseLike>(plan: ImportPlan<R>, only?: readonly number[]): SeedFilmRow[] {
  const picked = only ? new Set(only) : null
  return plan.fresh.filter(r => !picked || picked.has(r.id)).map(toSeedRow)
}
