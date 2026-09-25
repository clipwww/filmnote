/**
 * TMDB 的一筆 → `seed_films()` 的 payload。CLI（`scripts/tmdb-import-new-releases.ts`）與
 * 後台（`server/utils/tmdb-import.ts`）共用這一支：兩份各寫一次一定會漂移，而漂移的樣子是
 * 其中一條路寫出 `title_zh_source='gov'` 的 TMDB 作品，不會報錯。
 */
// 授權來源：`BUILD_PLAN §8.3` 2026-09-20 David 第 1 則裁決
// （origin='tmdb'、title_zh_source='tmdb'、review_state='approved'）。

import type { ReleaseLike } from './classify'

/** `seed_films()` 的 payload。欄位契約與 `scripts/seed-supabase.ts` 的 FilmRow 同一份。 */
export interface SeedFilmRow {
  id: string
  tmdbId: number
  titleZh: string
  titleOriginal: string | null
  source: 'tmdb'
  /** ★ 0019 才認得這個欄位。缺席時 seed_films() 落回 'gov'——那正是要避免的結果。 */
  titleZhSource: 'tmdb'
}

/** 確定性鍵。`resolve_film()` 以它去重，`film_identity.kind` 由 `tmdb:` 前綴決定。 */
export function tmdbKey(id: number): string {
  return `tmdb:${id}`
}

export function toSeedRow(r: ReleaseLike): SeedFilmRow {
  return {
    id: tmdbKey(r.id),
    tmdbId: r.id,
    titleZh: r.title ?? '',
    titleOriginal: r.original_title || null,
    source: 'tmdb',
    titleZhSource: 'tmdb',
  }
  // ⚠️ 刻意不送 country／runtimeMinutes／firstSeenRocYear：清單端點都不給，
  //    而 release_date 是 TMDB 的**主要**上映日不是台灣的——
  //    「台灣什麼時候算上映」以政府核准資料為權威，不在這裡定義它。
  //    runtime 與 release_year 由 cron 的 apply_tmdb_snapshot() 之後補上。
}
