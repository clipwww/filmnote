import type { SupabaseClient } from '@supabase/supabase-js'
import type { KnownFilm } from '#pipeline/tmdb/classify'
import type { ImportPlan } from '#pipeline/tmdb/import-plan'
import type { SeedFilmRow } from '#pipeline/tmdb/seed-row'
import type { TmdbSearchResult } from '#pipeline/types'
import type { ImportSource } from './tmdb-import-options'
import type { Database, Json } from '~/types/database.types'
import { TmdbClient, TmdbError } from '#pipeline/tmdb/client'
import { buildImportPlan } from '#pipeline/tmdb/import-plan'
import { tmdbKey } from '#pipeline/tmdb/seed-row'
import { MAX_SEARCH_RESULTS } from './tmdb-import-options'

/**
 * 後台「匯入新作品」的 I/O。判斷本身在 `src/tmdb/import-plan.ts`（純函式），這裡只負責
 * 取 TMDB、讀片庫、呼叫 `seed_films()`。
 */
// ★ 讀用**使用者自己的 client**（`film_staff` policy 看得到全部），寫才用 service role：
//   `seed_films` 只授權給 service_role，而 service client 的輸出不可以回給瀏覽器。
// ⚠️ 與 CLI 的差異：CLI 的閘門 ①（`pg_get_functiondef` 確認 0019 已套用）在這裡做不到，
//   PostgREST 讀不到 `pg_proc`。替代品是寫完**讀回**新列的 `title_zh_source`（`readback`），
//   外加 `tests/tmdb-import.test.ts` 釘住 payload 永遠帶 `titleZhSource: 'tmdb'`。

/** 畫面要顯示的一筆。`twReleaseDate` 只有 `ids` 模式拿得到（明細才有 release_dates）。 */
export interface ImportCandidate {
  id: number
  title: string
  original_title: string
  releaseDate: string | null
  twReleaseDate: string | null
  posterPath: string | null
}

// PostgREST 的 statement_timeout 是 8 秒（authenticator 的 rolconfig，2026-09-25 實查），
// 不是 CLI 直連的 300 秒 ⇒ seed_films 分小批送。
const SEED_BATCH = 20
const LIBRARY_PAGE = 1000

function toCandidate(r: TmdbSearchResult & { release_dates?: { results: { iso_3166_1: string, release_dates: { release_date: string }[] }[] } }): ImportCandidate {
  const tw = r.release_dates?.results.find(x => x.iso_3166_1 === 'TW')?.release_dates.map(d => d.release_date.slice(0, 10)).sort()[0]
  return {
    id: r.id,
    title: r.title ?? '',
    original_title: r.original_title ?? '',
    releaseDate: r.release_date || null,
    twReleaseDate: tw ?? null,
    posterPath: r.poster_path ?? null,
  }
}

function tmdbClient(): TmdbClient {
  const apiKey = useRuntimeConfig().tmdbApiKey
  if (!apiKey)
    throw createError({ statusCode: 503, statusMessage: '未設定 NUXT_TMDB_API_KEY' })
  return new TmdbClient({ apiKey, concurrency: 4 })
}

async function fetchCandidates(source: ImportSource): Promise<{ candidates: ImportCandidate[], notFound: number[] }> {
  const tmdb = tmdbClient()
  try {
    if (source.kind === 'releases') {
      const [a, b] = await Promise.all([
        tmdb.taiwanReleases('now_playing', source.pages),
        tmdb.taiwanReleases('upcoming', source.pages),
      ])
      const byId = new Map<number, ImportCandidate>()
      for (const r of [...a, ...b])
        byId.set(r.id, toCandidate(r))
      return { candidates: [...byId.values()], notFound: [] }
    }
    if (source.kind === 'search') {
      const rs = await tmdb.search(source.q)
      return { candidates: rs.slice(0, MAX_SEARCH_RESULTS).map(toCandidate), notFound: [] }
    }
    const notFound: number[] = []
    const candidates: ImportCandidate[] = []
    await Promise.all([...new Set(source.ids)].map(async (id) => {
      try {
        candidates.push(toCandidate(await tmdb.detail(id)))
      }
      catch (e) {
        if (e instanceof TmdbError && e.status === 404)
          notFound.push(id)
        else throw e
      }
    }))
    return { candidates: candidates.sort((x, y) => source.ids.indexOf(x.id) - source.ids.indexOf(y.id)), notFound }
  }
  catch (cause) {
    if (cause instanceof Error && 'statusCode' in cause)
      throw cause
    throw createError({ statusCode: 502, statusMessage: `TMDB 查詢失敗：${cause instanceof Error ? cause.message : String(cause)}` })
  }
}

/** 存活的片庫。★ 分頁讀：PostgREST 一次最多回 1,000 列，而片庫有 2,800 多部——不分頁就會少算。 */
async function readLibrary(db: SupabaseClient<Database>): Promise<KnownFilm[]> {
  const out: KnownFilm[] = []
  for (let from = 0; ; from += LIBRARY_PAGE) {
    const { data, error } = await db.from('film')
      .select('id,tmdb_id,title_zh,title_original,origin')
      .is('merged_into_film_id', null)
      .order('id')
      .range(from, from + LIBRARY_PAGE - 1)
    if (error)
      throw createError({ statusCode: 500, statusMessage: `讀片庫失敗：${error.message}` })
    for (const f of data ?? [])
      out.push({ id: f.id, tmdb_id: f.tmdb_id, title_zh: f.title_zh ?? '', title_original: f.title_original ?? '', origin: f.origin })
    if (!data || data.length < LIBRARY_PAGE)
      return out
  }
}

async function existingKeys(db: SupabaseClient<Database>, ids: number[]): Promise<Set<string>> {
  if (!ids.length)
    return new Set()
  const { data, error } = await db.from('film_identity').select('key').in('key', ids.map(tmdbKey))
  if (error)
    throw createError({ statusCode: 500, statusMessage: `讀 film_identity 失敗：${error.message}` })
  return new Set((data ?? []).map(r => r.key))
}

export interface ImportPreview extends ImportPlan<ImportCandidate> {
  notFound: number[]
  librarySize: number
}

export async function planImport(db: SupabaseClient<Database>, source: ImportSource): Promise<ImportPreview> {
  const { candidates, notFound } = await fetchCandidates(source)
  const library = await readLibrary(db)
  const keys = await existingKeys(db, candidates.map(c => c.id))
  return { ...buildImportPlan(candidates, library, keys), notFound, librarySize: library.length }
}

export interface ImportResult {
  written: number
  /** 讀回來每一筆的狀態。`ok=false` 就是 0019 沒生效或被改壞了——會說謊的成功比失敗貴。 */
  readback: { tmdbId: number, titleZh: string, origin: string, titleZhSource: string, ok: boolean }[]
}

export async function executeImport(rows: SeedFilmRow[]): Promise<ImportResult> {
  const db = serviceSupabase()
  let written = 0
  for (let i = 0; i < rows.length; i += SEED_BATCH) {
    const { data, error } = await db.rpc('seed_films', { p_films: rows.slice(i, i + SEED_BATCH) as unknown as Json })
    if (error)
      throw createError({ statusCode: 500, statusMessage: `seed_films 失敗（已寫入 ${written} 部）：${error.message}` })
    written += Number(data ?? 0)
  }
  const { data: back } = await db.from('film')
    .select('tmdb_id,title_zh,origin,title_zh_source,review_state')
    .in('tmdb_id', rows.map(r => r.tmdbId))
    .is('merged_into_film_id', null)
  return {
    written,
    readback: (back ?? []).map(f => ({
      tmdbId: f.tmdb_id!,
      titleZh: f.title_zh,
      origin: f.origin,
      titleZhSource: f.title_zh_source,
      ok: f.origin === 'tmdb' && f.title_zh_source === 'tmdb' && f.review_state === 'approved',
    })),
  }
}
