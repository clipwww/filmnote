/**
 * 把匯入管線的三份輸出灌進 Supabase。
 *
 * 走 service_role（SUPABASE_SECRET_KEY）繞過 RLS。順序固定
 * venues → films → certificates，因為 certificate.film_id 指向 film。
 *
 * 冪等性由三個機制保證，重跑不會長出重複列：
 *   venue        upsert on conflict (id)，id = 統一編號
 *   film         seed_films() RPC 以 resolve_film(確定性鍵) 查存活作品；
 *                已被合併的敗方會被 resolve 到存活者，不會復活
 *   certificate  upsert on conflict (id)，id = 「年度:字號:正規化片名」
 *
 * 用法：npm run seed        （--dry-run 只讀不寫）
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

interface FilmRow {
  id: string
  tmdbId: number | null
  titleZh: string
  titleOriginal: string
  country: string
  runtimeMinutes: number | null
  firstSeenRocYear: number
  certificateIds: string[]
  source: string
}

interface CertificateRow {
  id: string
  permitNo: string
  rocYear: number
  gregorianYear: number
  rating: string | null
  titleZh: string
  titleOriginal: string
  country: string | null
  language: string | null
  producer: string | null
  runtimeMinutes: number | null
  versionNote: string | null
  defects: string[]
}

interface VenueRow {
  taxId: string
  name: string
  companyName: string
  hallCount: number
  address: string
  phone: string
  city: string
  kind: string
}

const DRY_RUN = process.argv.includes('--dry-run')
const DATA_DIR = fileURLToPath(new URL('../.data/', import.meta.url))

const FILM_BATCH = 200 // seed_films 是 plpgsql 迴圈，批次太大會撞 statement timeout
const ROW_BATCH = 500

async function readJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(`${DATA_DIR}${name}`, 'utf8')) as T
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** 匯入批次的 provenance。失敗時把 status 寫回 failed，不留下 running 的孤兒列。 */
async function startRun(db: SupabaseClient, kind: string, note: string): Promise<number> {
  const { data, error } = await db
    .from('import_run')
    .insert({ kind, note })
    .select('id')
    .single()
  if (error)
    throw new Error(`import_run 建立失敗：${error.message}`)
  return (data as { id: number }).id
}

async function finishRun(db: SupabaseClient, id: number, status: string, stats: unknown) {
  await db
    .from('import_run')
    .update({ status, stats, finished_at: new Date().toISOString() })
    .eq('id', id)
}

async function seedVenues(db: SupabaseClient, runId: number) {
  const venues = await readJson<VenueRow[]>('venues.json')
  // 四筆 virtual 場所由 migration 擁有（帶 sort_weight，US-7 靠它們）。
  // 這裡只灌真實影城，避免把 sort_weight 蓋回 0。
  const cinemas = venues.filter(v => !v.taxId.startsWith('virtual:'))
  const rows = cinemas.map(v => ({
    id: v.taxId,
    kind: 'cinema' as const,
    name: v.name.trim(),
    company_name: v.companyName ?? '',
    hall_count: v.hallCount ?? 0,
    address: v.address ?? '',
    phone: v.phone ?? '',
    city: v.city ?? '',
    raw: v,
    last_import_id: runId,
    last_seen_at: new Date().toISOString(),
  }))
  if (DRY_RUN)
    return { total: rows.length, written: 0 }

  let written = 0
  for (const batch of chunk(rows, ROW_BATCH)) {
    const { error } = await db.from('venue').upsert(batch, { onConflict: 'id' })
    if (error)
      throw new Error(`venue upsert 失敗：${error.message}`)
    written += batch.length
    process.stdout.write(`\r  venue ${written}/${rows.length}`)
  }
  process.stdout.write('\n')
  return { total: rows.length, written }
}

/**
 * 寫入邊界的防禦：runtime 0 一律當作「不知道」。
 *
 * 根因已由管線在 b776edd 修掉（TMDB 以 0 表示無片長資料），現行 .data 為 0 筆。
 * 這裡保留是因為 0 分鐘在語意上就不是片長，且 schema 的 check (1..1200) 是最後
 * 一道防線——與其讓一列壞資料炸掉整批 seed，不如在邊界收斂。
 */
function normalizeFilm(f: FilmRow): FilmRow {
  return f.runtimeMinutes === 0 ? { ...f, runtimeMinutes: null } : f
}

async function seedFilms(db: SupabaseClient, rawFilms: FilmRow[]) {
  const films = rawFilms.map(normalizeFilm)
  if (DRY_RUN)
    return { total: films.length, written: 0 }
  let written = 0
  for (const batch of chunk(films, FILM_BATCH)) {
    const { data, error } = await db.rpc('seed_films', { p_films: batch })
    if (error)
      throw new Error(`seed_films 失敗：${error.message}`)
    written += typeof data === 'number' ? data : batch.length
    process.stdout.write(`\r  film ${written}/${films.length}`)
  }
  process.stdout.write('\n')
  return { total: films.length, written }
}

/**
 * 確定性鍵 → film uuid。
 * PostgREST 預設每頁 1,000 列，必須自行分頁，否則靜默只拿到前 1,000 筆
 * ——那會讓後面的 certificate 全部 film_id 為 null 而不報錯。
 */
async function loadIdentityMap(db: SupabaseClient): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const page = 1000
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from('film_identity')
      .select('key,film_id')
      .in('kind', ['gov', 'tmdb'])
      .range(from, from + page - 1)
    if (error)
      throw new Error(`film_identity 讀取失敗：${error.message}`)
    const rows = (data ?? []) as { key: string, film_id: string }[]
    for (const r of rows) map.set(r.key, r.film_id)
    if (rows.length < page)
      break
  }
  return map
}

async function seedCertificates(
  db: SupabaseClient,
  films: FilmRow[],
  runId: number,
) {
  const certs = await readJson<CertificateRow[]>('certificates.json')
  const identity = DRY_RUN ? new Map<string, string>() : await loadIdentityMap(db)

  // 每張證明書歸屬的作品，直接由 films.json 的 certificateIds 反查，
  // 不重跑比對——SPEC 已驗證 3,116 張全部恰好歸屬一次。
  const certToFilmKey = new Map<string, string>()
  for (const f of films) {
    for (const certId of f.certificateIds) certToFilmKey.set(certId, f.id)
  }

  let orphan = 0
  const rows = certs.map((c) => {
    const filmKey = certToFilmKey.get(c.id)
    const filmId = filmKey ? identity.get(filmKey) ?? null : null
    if (!DRY_RUN && filmKey && !filmId)
      orphan++
    return {
      id: c.id,
      film_id: filmId,
      permit_no: c.permitNo,
      roc_year: c.rocYear,
      gregorian_year: c.gregorianYear,
      rating: c.rating,
      title_zh: c.titleZh ?? '',
      title_original: c.titleOriginal ?? '',
      country: c.country,
      language: c.language,
      producer: c.producer,
      runtime_minutes: c.runtimeMinutes,
      version_note: c.versionNote,
      defects: c.defects ?? [],
      // 這是管線「已解析」的列，不是原始 CSV 行。要就地重算解析邏輯，
      // 得先讓 src/gov/rating.ts 一併保留原始行——目前尚未做。
      raw: c,
      import_run_id: runId,
    }
  })

  const unassigned = certs.length - certToFilmKey.size
  if (unassigned !== 0) {
    throw new Error(`有 ${unassigned} 張證明書未被任何 film 引用——films.json 與 certificates.json 不同步`)
  }
  if (orphan > 0) {
    throw new Error(`有 ${orphan} 張證明書的作品鍵在 film_identity 找不到——films 這一步沒跑完`)
  }
  if (DRY_RUN)
    return { total: rows.length, written: 0 }

  let written = 0
  for (const batch of chunk(rows, ROW_BATCH)) {
    const { error } = await db.from('certificate').upsert(batch, { onConflict: 'id' })
    if (error)
      throw new Error(`certificate upsert 失敗：${error.message}`)
    written += batch.length
    process.stdout.write(`\r  certificate ${written}/${rows.length}`)
  }
  process.stdout.write('\n')
  return { total: rows.length, written }
}

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) {
    console.error('缺少 SUPABASE_URL 或 SUPABASE_SECRET_KEY。')
    console.error('SUPABASE_SECRET_KEY 取自 Dashboard → Project Settings → API Keys 的 sb_secret_… （不是 publishable）。')
    process.exit(1)
  }

  const db = createClient(url, key, { auth: { persistSession: false } })
  const films = await readJson<FilmRow[]>('films.json')

  console.log(DRY_RUN ? '── seed（dry-run，不寫入）──' : '── seed ──')
  const runId = DRY_RUN ? 0 : await startRun(db, 'gov_rating', 'seed-supabase.ts')

  try {
    const venue = await seedVenues(db, runId)
    const film = await seedFilms(db, films)
    const certificate = await seedCertificates(db, films, runId)
    const stats = { venue, film, certificate }
    if (!DRY_RUN)
      await finishRun(db, runId, 'succeeded', stats)
    console.log('\n完成：', JSON.stringify(stats))
  }
  catch (err) {
    if (!DRY_RUN)
      await finishRun(db, runId, 'failed', { error: String(err) })
    throw err
  }
}

await main()
