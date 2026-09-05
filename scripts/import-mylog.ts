/**
 * 舊 log 專案的觀影紀錄匯入（US-56/57/58、BUILD_PLAN §5 Step 10）。
 *
 *   pnpm import:mylog                 # 預演，不寫入
 *   pnpm import:mylog -- --apply      # 實際寫入
 *   pnpm import:mylog -- --file .data/mylog.json --apply
 *   pnpm import:mylog -- --apply --unmapped-venue=ugc
 *
 * **預設是預演**。這支腳本寫的是線上資料庫，而且與 nuxt session 共用同一個
 * 專案，所以要寫入必須明講 `--apply`。
 *
 * 冪等靠 `viewing_record` 的 `unique (user_id, import_key) where import_key is not null`。
 * import_key 直接用上游的 `id`——它是原始 CSV 列的 base64，天生確定性，
 * 不需要另外算 hash。重跑會走 `on conflict do update`，筆數不變。
 *
 * 憑證一律從 .env 讀（DATABASE_URL、TMDB_API_KEY），任何輸出都不得帶出它們。
 */

import type { MyLogItem, NormalizedRecord } from '#pipeline/import/mylog'
import type { VenueAlias } from '#pipeline/import/venue-aliases'
import type { Certificate, TmdbMovieDetail, TmdbSearchResult } from '#pipeline/types'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { Client } from 'pg'
import { expandDoubleFeature, resolveDoubleFeature } from '#pipeline/import/double-features'
import { normalizeRecords } from '#pipeline/import/mylog'
import { ALL_OVERRIDES, resolveTmdbOverride } from '#pipeline/import/tmdb-overrides'
import { AMBIGUOUS_ALIASES, resolveVenueAlias } from '#pipeline/import/venue-aliases'
import { matchCertificate } from '#pipeline/match/matcher'
import { normalizeTitle } from '#pipeline/normalize/title'
import { TmdbClient } from '#pipeline/tmdb/client'

const SOURCE_URL = 'https://mechakucha-api.vercel.app/my-log/movie'

/** 匯入時給紀錄的預設能見度。個別紀錄之後可由使用者自行調整。 */
const RECORD_VISIBILITY = 'public'

interface Options {
  apply: boolean
  file: string | null
  /** 名冊查無的影廳（已歇業／海外）怎麼處理。 */
  unmappedVenue: 'skip' | 'ugc' | 'virtual'
  /** 關掉 TMDB 查詢，只用既有片庫比對。除錯用。 */
  noTmdb: boolean
  /** 匯入對象的 email。CLI 優先於 IMPORT_TARGET_EMAIL。 */
  email: string | null
  /** 刪除 DB 中已不存在於來源的舊 import_key（例如片名拆分後被取代的那些）。 */
  pruneOrphans: boolean
}

function parseOptions(argv: string[]): Options {
  const args = argv.filter(a => a !== '--')
  const valueOf = (name: string): string | null => {
    const inline = args.find(a => a.startsWith(`${name}=`))
    if (inline)
      return inline.slice(name.length + 1)
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] ?? null : null
  }

  const unmapped = valueOf('--unmapped-venue') ?? 'skip'
  if (unmapped !== 'skip' && unmapped !== 'ugc' && unmapped !== 'virtual')
    throw new Error(`--unmapped-venue 只接受 skip / ugc / virtual，收到「${unmapped}」`)

  return {
    apply: args.includes('--apply'),
    file: valueOf('--file'),
    unmappedVenue: unmapped,
    noTmdb: args.includes('--no-tmdb'),
    email: valueOf('--email') ?? process.env.IMPORT_TARGET_EMAIL ?? null,
    pruneOrphans: args.includes('--prune-orphans'),
  }
}

// -----------------------------------------------------------------------------
// 取得來源資料
// -----------------------------------------------------------------------------

interface MyLogResponse {
  success: boolean
  resultCode: string
  resultMessage: string
  items: MyLogItem[]
}

async function loadItems(file: string | null): Promise<MyLogItem[]> {
  if (file) {
    const body = JSON.parse(await readFile(file, 'utf8')) as MyLogResponse | MyLogItem[]
    return Array.isArray(body) ? body : body.items
  }

  const response = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'filmnote-import/0.1' } })
  if (!response.ok)
    throw new Error(`來源回應 HTTP ${response.status}`)

  const body = await response.json() as MyLogResponse
  if (!body.success || !Array.isArray(body.items))
    throw new Error(`來源回應異常：${body.resultMessage}`)
  return body.items
}

// -----------------------------------------------------------------------------
// 作品比對
// -----------------------------------------------------------------------------

/**
 * 既有片庫的中文片名索引。
 *
 * 同一個正規化片名對到多部作品時記為 ambiguous 而不硬挑一部——
 * 挑錯會把觀影紀錄掛到別部片上，比暫時走 TMDB 重查昂貴得多。
 */
interface TitleIndex {
  unique: Map<string, string>
  ambiguous: Set<string>
}

async function loadTitleIndex(db: Client): Promise<TitleIndex> {
  const { rows } = await db.query<{ id: string, title_zh: string }>(
    `select id, title_zh from public.film
     where merged_into_film_id is null and title_zh <> ''`,
  )

  const seen = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const row of rows) {
    const key = normalizeTitle(row.title_zh)
    if (!key)
      continue
    const prior = seen.get(key)
    if (prior && prior !== row.id)
      ambiguous.add(key)
    else
      seen.set(key, row.id)
  }
  for (const key of ambiguous)
    seen.delete(key)

  return { unique: seen, ambiguous }
}

/**
 * 把舊 log 的一筆紀錄包成比對器吃的 Certificate。
 *
 * 舊 log 沒有原文片名也沒有片長，所以只有中文片名的訊號會觸發，
 * 片長交叉驗證（比對器防花絮誤配的那一關）在這裡形同關閉——
 * 這是來源資料的限制，不是比對器的問題。因此報告會逐片列出
 * 命中的訊號與分數，讓人能挑出只靠 zh-prefix 低空飛過的可疑配對。
 */
function asCertificate(title: string, country: string, year: number): Certificate {
  return {
    id: `legacy:mylog:${normalizeTitle(title)}`,
    permitNo: '',
    rocYear: year - 1911,
    gregorianYear: year,
    rating: '',
    titleZh: title,
    titleOriginal: '',
    country,
    language: '',
    producer: '',
    runtimeMinutes: null,
    versionNote: null,
    defects: [],
  }
}

type FilmSource = 'existing' | 'tmdb-new' | 'tmdb-existing' | 'ugc' | 'override'

interface FilmResolution {
  title: string
  filmId: string | null
  source: FilmSource
  tmdbId: number | null
  score: number
  signals: string[]
  note: string
  /**
   * 未命中時 TMDB 回的前幾筆候選。
   *
   * US-58 要的是「看到哪些片沒比對到，好決定要不要手動處理」——
   * 只寫「未命中」等於把問題丟回去。實測 17 部未命中裡有 14 部
   * TMDB 其實有，只是片名寫法差一點（「電影版」vs「劇場版」、
   * 「星際大戰九部曲」vs「STAR WARS」）。把候選列出來，
   * 人就能一眼確認，而不必自己再查一次。
   */
  candidates: { id: number, title: string, originalTitle: string, year: string }[]
}

function briefCandidates(list: TmdbSearchResult[]): FilmResolution['candidates'] {
  return list.slice(0, 3).map(c => ({
    id: c.id,
    title: c.title ?? '',
    originalTitle: c.original_title ?? '',
    year: c.release_date?.slice(0, 4) ?? '?',
  }))
}

// -----------------------------------------------------------------------------
// 寫入
// -----------------------------------------------------------------------------

/**
 * 決定要把紀錄掛到哪個使用者。**必須明確指定 email**。
 *
 * 不做任何推測：不用 `limit 1`、不用 `order by created_at`、不假設
 * 「DB 裡只有一個 profile」。這個 repo 同時有三個 session 在建測試資料，
 * 那類假設已經壞過一次——第一次匯入時 profile 只有一筆，第二次跑
 * 就多了 nuxt session 的 zzstep4@example.com。匯到錯的人身上比匯不進去糟得多。
 *
 * email 由 `IMPORT_TARGET_EMAIL` 或 `--email` 傳入，**不寫死在程式碼裡**
 * （本專案可能開源）。.env.example 有說明但不填值。
 */
async function resolveUserId(db: Client, email: string | null): Promise<string> {
  if (!email) {
    throw new Error(
      '缺少匯入對象。請設 IMPORT_TARGET_EMAIL 環境變數或加 --email <address>。\n'
      + '刻意不提供預設值：DB 裡有多個 session 建的測試帳號，猜錯會把紀錄匯到別人身上。',
    )
  }

  const { rows } = await db.query<{ id: string, username: string }>(
    `select p.id, p.username from public.profile p
     join auth.users u on u.id = p.id where lower(u.email) = lower($1)`,
    [email],
  )
  if (rows.length === 0)
    throw new Error(`profile 中找不到這個 email 的使用者（已比對 auth.users）`)
  if (rows.length > 1)
    throw new Error(`這個 email 對到不只一個 profile，請人工確認`)

  console.log(`匯入對象：${rows[0]!.username}`)
  return rows[0]!.id
}

/** 建立或取回 TMDB 作品。已存在（含被合併過）時回傳存活的那一部。 */
async function upsertTmdbFilm(db: Client, detail: TmdbMovieDetail, country: string): Promise<string> {
  const existing = await db.query<{ id: string | null }>(
    `select public.resolve_film($1) as id`,
    [`tmdb:${detail.id}`],
  )
  if (existing.rows[0]?.id)
    return existing.rows[0].id

  const { rows } = await db.query<{ id: string }>(
    `insert into public.film
       (tmdb_id, title_zh, title_zh_source, title_original, title_original_source,
        country, runtime_minutes, release_year, origin, review_state, visibility)
     values ($1, $2, 'tmdb', $3, 'tmdb', $4, $5, $6, 'tmdb', 'approved', 'public')
     on conflict (tmdb_id) do update set updated_at = now()
     returning id`,
    [
      detail.id,
      detail.title ?? '',
      detail.original_title ?? '',
      country,
      // TMDB 實測會回 runtime 0 代表「不知道」，不是真的 0 分鐘。
      detail.runtime && detail.runtime > 0 ? detail.runtime : null,
      Number(detail.release_date?.slice(0, 4)) || null,
    ],
  )
  return rows[0]!.id
}

/**
 * 把先前匯入建出來的 UGC 作品併進人工指定的 TMDB 作品。
 *
 * 第一次匯入時這 16 部還沒有人工對照表，各自建了一部 UGC 作品、
 * 觀影紀錄也掛在上面。現在有了明確答案，正確的收尾不是留下孤兒，
 * 而是走 schema 既有的合併機制：`merge_films` 會搬 viewing_record、
 * 改 film_identity 指向、寫 film_merge_log，並把敗方標記為已合併。
 *
 * 合併後 `resolve_film('ugc:mylog:<片名>')` 會沿著 merged_into_film_id
 * 走到 TMDB 作品，所以這個動作本身也是冪等的——第二次跑就沒有敗方可併了。
 */
async function mergeLegacyUgcFilm(db: Client, title: string, winnerId: string): Promise<boolean> {
  const key = `ugc:mylog:${normalizeTitle(title)}`
  const { rows } = await db.query<{ id: string | null }>(
    `select public.resolve_film($1) as id`,
    [key],
  )
  const loserId = rows[0]?.id
  if (!loserId || loserId === winnerId)
    return false

  await db.query(
    `select public.merge_films($1, $2, $3)`,
    [loserId, winnerId, `舊 log 匯入：人工對照表指定 ${title}`],
  )
  return true
}

/**
 * 建立或取回 UGC 作品。
 *
 * 以 `ugc:mylog:<正規化片名>` 當 film_identity 的鍵，重跑才不會每次都新建一部。
 * 依 SPEC「UGC 新增者預設 private、審核通過後才進公共片庫」，
 * 這裡一律 visibility=private + review_state=pending，進 Step 7 的審核佇列。
 */
async function upsertUgcFilm(
  db: Client,
  title: string,
  country: string,
  userId: string,
): Promise<string> {
  const key = `ugc:mylog:${normalizeTitle(title)}`
  const existing = await db.query<{ id: string | null }>(
    `select public.resolve_film($1) as id`,
    [key],
  )
  if (existing.rows[0]?.id)
    return existing.rows[0].id

  const { rows } = await db.query<{ id: string }>(
    `insert into public.film
       (title_zh, title_zh_source, title_original, country,
        origin, review_state, visibility, created_by)
     values ($1, 'ugc', '', $2, 'ugc', 'pending', 'private', $3)
     returning id`,
    [title, country, userId],
  )
  const filmId = rows[0]!.id

  await db.query(
    `insert into public.film_identity (key, kind, film_id)
     values ($1, 'ugc', $2) on conflict (key) do update set film_id = excluded.film_id`,
    [key, filmId],
  )
  return filmId
}

/** 名冊查無的影廳（已歇業／海外）建成 ugc: 場所，狀態記 closed 或 active。 */
async function upsertUgcVenue(db: Client, entry: VenueAlias): Promise<string> {
  const seed = entry.seed
  if (!seed)
    throw new Error(`「${entry.alias}」沒有 seed 資料，無法建 ugc venue`)

  const id = ugcVenueId(entry.alias)
  await db.query(
    `insert into public.venue (id, kind, name, city, status, closed_at, selectable)
     values ($1, 'cinema', $2, $3, $4, $5::date, $6)
     on conflict (id) do update set
       name = excluded.name, city = excluded.city, status = excluded.status,
       closed_at = excluded.closed_at, selectable = excluded.selectable,
       last_seen_at = now()`,
    [id, seed.name, seed.city, seed.status, seed.closedAt, seed.selectable],
  )
  return id
}

/** ugc venue 的確定性 id。以 hex 保底，避免片假名等被正規化成空字串。 */
function ugcVenueId(alias: string): string {
  const slug = normalizeTitle(alias)
  // normalizeTitle 只剝標點不轉寫，片假名會原樣留下；venue.id 沒有字元限制
  // （只有 `ugc:%` 的前綴約束），但為了 id 好讀好比對，非 ASCII 一律走 hex。
  return /^[\w-]+$/.test(slug) && slug
    ? `ugc:mylog:${slug}`
    : `ugc:mylog:${Buffer.from(alias, 'utf8').toString('hex').slice(0, 32)}`
}

// -----------------------------------------------------------------------------
// 主流程
// -----------------------------------------------------------------------------

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl)
    throw new Error('缺少 DATABASE_URL')

  const items = await loadItems(options.file)
  const { records: normalized, issues } = normalizeRecords(items)

  // 雙片連映一筆拆成多筆。放在正規化之後、比對之前——拆完的每一筆
  // 才是真正要寫進 viewing_record 的單位，後面的作品比對與冪等都以它為準。
  const records: NormalizedRecord[] = []
  let expandedFrom = 0
  for (const record of normalized) {
    const feature = resolveDoubleFeature(record.title)
    if (!feature) {
      records.push(record)
      continue
    }
    expandedFrom++
    records.push(...expandDoubleFeature(record, feature))
  }

  console.log(`來源 ${items.length} 筆，正規化通過 ${normalized.length} 筆，異常 ${issues.length} 筆`)
  if (expandedFrom)
    console.log(`雙片連映 ${expandedFrom} 筆展開為 ${records.length - normalized.length + expandedFrom} 筆，總計 ${records.length} 筆`)

  const db = new Client({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300_000,
  })
  await db.connect()

  try {
    const userId = await resolveUserId(db, options.email)
    const index = await loadTitleIndex(db)

    // --- 影廳 ---------------------------------------------------------------
    const venueOf = new Map<string, string>()
    const unmappedVenues = new Map<string, number>()
    for (const record of records) {
      const alias = resolveVenueAlias(record.venueAlias)
      if (!alias) {
        unmappedVenues.set(record.venueAlias, (unmappedVenues.get(record.venueAlias) ?? 0) + 1)
        continue
      }
      if (alias.venueId) {
        venueOf.set(record.venueAlias, alias.venueId)
        continue
      }
      unmappedVenues.set(record.venueAlias, (unmappedVenues.get(record.venueAlias) ?? 0) + 1)
      if (options.unmappedVenue === 'virtual')
        venueOf.set(record.venueAlias, 'virtual:other')
      else if (options.unmappedVenue === 'ugc' && options.apply)
        venueOf.set(record.venueAlias, await upsertUgcVenue(db, alias))
      else if (options.unmappedVenue === 'ugc')
        venueOf.set(record.venueAlias, ugcVenueId(alias.alias))
    }

    // --- 作品 ---------------------------------------------------------------
    // 以相異片名為單位比對：169 筆只有 134 個相異片名，逐筆查會多打 35 次 TMDB。
    const byTitle = new Map<string, NormalizedRecord[]>()
    for (const record of records) {
      const list = byTitle.get(record.title)
      if (list)
        list.push(record)
      else byTitle.set(record.title, [record])
    }

    const tmdbKey = process.env.TMDB_API_KEY
    const tmdb = !options.noTmdb && tmdbKey
      ? new TmdbClient({ apiKey: tmdbKey, concurrency: 4 })
      : null
    if (!tmdb)
      console.log('未啟用 TMDB 查詢，只以既有片庫比對')

    const resolutions: FilmResolution[] = []
    for (const [title, group] of byTitle) {
      const first = group[0]!
      const year = Math.min(...group.map(r => Number(r.watchedOn.slice(0, 4))))
      const key = normalizeTitle(title)

      // 人工對照表最優先——它是查證過的明確答案，勝過任何自動比對。
      const override = resolveTmdbOverride(title)
      if (override) {
        let filmId: string | null = null
        let merged = false
        if (options.apply && tmdb) {
          const detail = await tmdb.detail(override.tmdbId)
          filmId = await upsertTmdbFilm(db, detail, first.country)
          merged = await mergeLegacyUgcFilm(db, title, filmId)
        }
        resolutions.push({
          title,
          filmId,
          source: 'override',
          tmdbId: override.tmdbId,
          score: 0,
          signals: [],
          note: `${override.tmdbTitle}（${override.releaseYear}）`
            + `　理由：${override.reason}${merged ? '　［已併回先前建的 UGC 作品］' : ''}`,
          candidates: [],
        })
        continue
      }

      const existingId = index.unique.get(key)
      if (existingId) {
        resolutions.push({
          title,
          filmId: existingId,
          source: 'existing',
          tmdbId: null,
          score: 0,
          signals: [],
          note: '既有片庫中文片名完全吻合',
          candidates: [],
        })
        continue
      }

      if (!tmdb) {
        resolutions.push({
          title,
          filmId: null,
          source: 'ugc',
          tmdbId: null,
          score: 0,
          signals: [],
          note: index.ambiguous.has(key) ? '既有片庫有同名多部，未硬挑' : '未啟用 TMDB',
          candidates: [],
        })
        continue
      }

      // 候選先依熱門度排序：比對器遇到同分時保留先出現的那個，
      // 排序後同分就會落在較熱門的候選上，這對舊 log 的口語片名比較安全。
      const candidates = (await tmdb.search(title))
        .slice()
        .sort((a: TmdbSearchResult, b: TmdbSearchResult) => (b.popularity ?? 0) - (a.popularity ?? 0))

      const outcome = matchCertificate(
        asCertificate(title, first.country, year),
        candidates,
        () => null,
      )

      // 只靠前綴訊號的配對一律降級為未命中。
      //
      // 比對器平常有片長交叉驗證擋住前綴誤配，但舊 log 沒有片長欄位，
      // 那一關在這裡形同關閉（見 asCertificate）。實測這個缺口確實會咬人：
      // 《Fate stay night Heaven's feel》會被 b.startsWith(a) 配到
      // 《Fate/stay night [Heaven's Feel] II.迷途之蝶》——第一部配到第二部。
      // 這不是改比對邏輯，是呼叫端在護欄失效時自己補一道：
      // 沒有 zh-exact／original-exact 就不算數，寧可進 UGC 佇列讓人決定。
      const exactSignal = outcome.matched
        && (outcome.signals.includes('zh-exact') || outcome.signals.includes('original-exact'))

      if (outcome.matched && !exactSignal) {
        resolutions.push({
          title,
          filmId: null,
          source: 'ugc',
          tmdbId: null,
          score: outcome.score,
          signals: outcome.signals,
          note: `僅前綴吻合、無片長可交叉驗證，降級為未命中（score=${outcome.score}）`,
          candidates: briefCandidates(candidates),
        })
        continue
      }

      if (!outcome.matched) {
        resolutions.push({
          title,
          filmId: null,
          source: 'ugc',
          tmdbId: null,
          score: outcome.score,
          signals: [],
          note: `TMDB 未命中（${outcome.reason}，候選 ${candidates.length} 筆）`,
          candidates: briefCandidates(candidates),
        })
        continue
      }

      const detail = await tmdb.detail(outcome.tmdbId)
      const existed = await db.query<{ id: string | null }>(
        `select public.resolve_film($1) as id`,
        [`tmdb:${outcome.tmdbId}`],
      )
      resolutions.push({
        title,
        filmId: existed.rows[0]?.id ?? null,
        source: existed.rows[0]?.id ? 'tmdb-existing' : 'tmdb-new',
        tmdbId: outcome.tmdbId,
        score: outcome.score,
        signals: outcome.signals,
        note: `${detail.title}／${detail.original_title}（${detail.release_date?.slice(0, 4) ?? '?'}）`,
        candidates: [],
      })

      if (options.apply) {
        const filmId = await upsertTmdbFilm(db, detail, first.country)
        resolutions[resolutions.length - 1]!.filmId = filmId
      }
    }

    if (tmdb)
      console.log(`TMDB 請求 ${tmdb.stats.requests} 次，重試 ${tmdb.stats.retries}，遭節流 ${tmdb.stats.throttled}`)

    const filmOf = new Map<string, FilmResolution>(resolutions.map(r => [r.title, r]))

    // --- 寫入 ---------------------------------------------------------------
    let runId: number | null = null
    if (options.apply) {
      const { rows } = await db.query<{ id: string }>(
        `insert into public.import_run (kind, source_url, note)
         values ('legacy_log', $1, $2) returning id`,
        [options.file ?? SOURCE_URL, `mylog 匯入，來源 ${items.length} 筆`],
      )
      runId = Number(rows[0]!.id)

      // UGC 作品在寫紀錄前先補齊，避免逐筆寫入時反覆判斷。
      for (const resolution of resolutions) {
        if (resolution.source === 'ugc' && !resolution.filmId) {
          const group = byTitle.get(resolution.title)!
          resolution.filmId = await upsertUgcFilm(db, resolution.title, group[0]!.country, userId)
        }
      }
    }

    const skipped: { record: NormalizedRecord, why: string }[] = []
    let written = 0
    let orphanKeys: string[] = []
    let pruned = 0

    if (options.apply) {
      await db.query('begin')
      try {
        for (const record of records) {
          const venueId = venueOf.get(record.venueAlias)
          const film = filmOf.get(record.title)
          if (!venueId) {
            skipped.push({ record, why: `影廳「${record.venueAlias}」尚無對應` })
            continue
          }
          if (!film?.filmId) {
            skipped.push({ record, why: `作品「${record.title}」尚無對應` })
            continue
          }

          const { rows } = await db.query<{ id: string }>(
            `insert into public.viewing_record
               (user_id, film_id, venue_id, watched_on, watched_time, tz,
                ticket_count, hall_label, format_code, format_note, memo,
                visibility, import_key)
             values ($1,$2,$3,$4,$5,'Asia/Taipei',$6,$7,$8,$9,$10,$11,$12)
             on conflict (user_id, import_key) where import_key is not null
             do update set
               film_id = excluded.film_id, venue_id = excluded.venue_id,
               watched_on = excluded.watched_on, watched_time = excluded.watched_time,
               ticket_count = excluded.ticket_count, hall_label = excluded.hall_label,
               format_code = excluded.format_code, format_note = excluded.format_note,
               memo = excluded.memo, updated_at = now()
             returning id`,
            [
              userId,
              film.filmId,
              venueId,
              record.watchedOn,
              record.watchedTime,
              record.ticketCount,
              record.hallLabel,
              record.formatCode,
              record.formatNote,
              record.memo,
              RECORD_VISIBILITY,
              record.importKey,
            ],
          )

          // 票價走分表——viewing_record 本體沒有金額欄位，
          // 整條票價隱私規則就靠 viewing_record_cost 的那兩條 policy。
          //
          // amount 為 null 代表這一筆不記金額（連映拆出來的第二筆，
          // 票價全額掛在第一筆）。此時要**刪掉**既有的那一列而不是寫 0——
          // 寫 0 會被年度總花費當成一筆 0 元消費列出來，而事實是「不適用」。
          // 刪除也讓重跑收斂：先前若寫過金額，這次會被清掉。
          if (record.amount === null) {
            await db.query(
              `delete from public.viewing_record_cost where record_id = $1`,
              [rows[0]!.id],
            )
          }
          else {
            await db.query(
              `insert into public.viewing_record_cost (record_id, amount, currency)
               values ($1, $2, 'TWD')
               on conflict (record_id) do update set amount = excluded.amount, updated_at = now()`,
              [rows[0]!.id, record.amount],
            )
          }
          written++
        }
        await db.query('commit')
      }
      catch (error) {
        await db.query('rollback')
        throw error
      }

      // 來源已不再產生的舊 import_key。
      //
      // 片名拆分會讓舊鍵被新鍵取代（`<id>` → `<id>#1`、`<id>#2`），
      // 不清掉的話同一次進場會同時存在舊的一筆與新的兩筆，總花費多算。
      // 預設只報不刪——自動刪除線上資料太危險，尤其這個 DB 有三個 session
      // 在用；要真的刪必須明講 --prune-orphans。
      const liveKeys = records.map(r => r.importKey)
      const { rows: orphans } = await db.query<{ import_key: string, title_zh: string }>(
        `select r.import_key, f.title_zh from public.viewing_record r
         join public.film f on f.id = r.film_id
         where r.user_id = $1 and r.import_key is not null
           and not (r.import_key = any($2::text[]))`,
        [userId, liveKeys],
      )
      orphanKeys = orphans.map(o => `${o.import_key.slice(0, 24)}… ${o.title_zh}`)

      if (orphans.length && options.pruneOrphans) {
        // cost 走 on delete cascade，跟著一起走。
        const { rowCount } = await db.query(
          `delete from public.viewing_record
           where user_id = $1 and import_key is not null
             and not (import_key = any($2::text[]))`,
          [userId, liveKeys],
        )
        pruned = rowCount ?? 0
      }

      await db.query(
        `update public.import_run set status = 'succeeded', finished_at = now(), stats = $2
         where id = $1`,
        [runId, JSON.stringify({
          source: items.length,
          normalized: records.length,
          written,
          skipped: skipped.length,
          issues: issues.length,
          pruned,
        })],
      )
    }
    else {
      for (const record of records) {
        if (!venueOf.get(record.venueAlias))
          skipped.push({ record, why: `影廳「${record.venueAlias}」尚無對應` })
      }
    }

    report({
      options,
      items,
      records,
      issues,
      resolutions,
      unmappedVenues,
      skipped,
      written,
      index,
      orphanKeys,
      pruned,
    })
  }
  finally {
    await db.end()
  }
}

// -----------------------------------------------------------------------------
// 報告
// -----------------------------------------------------------------------------

interface ReportInput {
  options: Options
  items: MyLogItem[]
  records: NormalizedRecord[]
  issues: { rawLine: string, reason: string, detail: string }[]
  resolutions: FilmResolution[]
  unmappedVenues: Map<string, number>
  skipped: { record: NormalizedRecord, why: string }[]
  written: number
  index: TitleIndex
  orphanKeys: string[]
  pruned: number
}

function report(input: ReportInput) {
  const { resolutions, records } = input
  const count = (source: FilmSource) => resolutions.filter(r => r.source === source).length
  const recordsOf = (source: FilmSource) =>
    records.filter(r => resolutions.find(x => x.title === r.title)?.source === source).length

  console.log(`\n${'='.repeat(64)}`)
  console.log(input.options.apply ? '匯入報告' : '匯入報告（預演，未寫入）')
  console.log('='.repeat(64))

  console.log(`\n來源 ${input.items.length} 筆 → 正規化 ${records.length} 筆 → 寫入 ${input.written} 筆`)
  if (input.issues.length) {
    console.log(`\n正規化異常 ${input.issues.length} 筆：`)
    for (const issue of input.issues)
      console.log(`  [${issue.reason}] ${issue.detail}\n    ${issue.rawLine}`)
  }

  console.log(`\n片名比對（相異片名 ${resolutions.length}）：`)
  console.log(`  既有片庫命中        ${count('existing')} 片／${recordsOf('existing')} 筆`)
  console.log(`  TMDB 命中（已在庫）  ${count('tmdb-existing')} 片／${recordsOf('tmdb-existing')} 筆`)
  console.log(`  TMDB 命中（新建）    ${count('tmdb-new')} 片／${recordsOf('tmdb-new')} 筆`)
  console.log(`  人工對照表指定      ${count('override')} 片／${recordsOf('override')} 筆`)
  console.log(`  未命中 → UGC 作品    ${count('ugc')} 片／${recordsOf('ugc')} 筆`)

  const overrides = resolutions.filter(r => r.source === 'override')
  if (overrides.length) {
    console.log(`\n人工對照表（src/import/tmdb-overrides.ts，共登錄 ${ALL_OVERRIDES.length} 筆）：`)
    for (const r of overrides)
      console.log(`  ${r.title}  → tmdb:${r.tmdbId} ${r.note}`)
  }

  const demoted = resolutions.filter(r => r.source === 'ugc' && r.signals.length)
  if (demoted.length) {
    console.log(`\n僅前綴吻合而被降級為未命中的 ${demoted.length} 片（無片長可交叉驗證，不硬猜）：`)
    for (const r of demoted)
      console.log(`  ${r.title}  [${r.signals.join(',')}] score=${r.score}`)
  }

  const weak = resolutions.filter(r =>
    (r.source === 'tmdb-new' || r.source === 'tmdb-existing')
    && !r.signals.includes('zh-exact') && !r.signals.includes('original-exact'))
  if (weak.length) {
    console.log(`\n⚠ 仍有 ${weak.length} 片未經精確訊號確認，請人工複核：`)
    for (const r of weak)
      console.log(`  ${r.title}  → ${r.note}  [${r.signals.join(',')}] score=${r.score}`)
  }

  const ugc = resolutions.filter(r => r.source === 'ugc')
  if (ugc.length) {
    console.log(`\n未比對到片庫、建為 UGC 作品的 ${ugc.length} 片：`)
    for (const r of ugc) {
      console.log(`  ${r.title}  （${r.note}）`)
      for (const c of r.candidates)
        console.log(`      TMDB 候選 ${c.id}：${c.title}／${c.originalTitle}（${c.year}）`)
    }
    const recoverable = ugc.filter(r => r.candidates.length).length
    if (recoverable) {
      console.log(`\n  其中 ${recoverable} 片 TMDB 查得到候選，只是片名寫法差一截而未達門檻。`)
      console.log('  比對器刻意不硬猜（SPEC：總分 < 3 一律進 UGC 佇列），這些請人工確認後手動指定。')
    }
  }

  if (input.unmappedVenues.size) {
    console.log(`\n無法對應的影廳 ${input.unmappedVenues.size} 個：`)
    for (const [alias, n] of input.unmappedVenues) {
      const entry = AMBIGUOUS_ALIASES.find(e => e.alias === alias)
      console.log(`  ${alias}（${n} 筆）— ${entry?.officialName ?? '對照表中沒有這個簡稱'}`)
      if (!entry?.seed && entry?.question) {
        console.log(`    待決：${entry.question}`)
      }
      else if (entry?.seed && input.options.unmappedVenue === 'ugc') {
        console.log(
          `    已建 ugc venue：status=${entry.seed.status}`
          + `${entry.seed.closedAt ? `、closed_at=${entry.seed.closedAt}` : ''}`
          + `、selectable=false（不出現在新增紀錄的選單）`,
        )
      }
    }
    console.log(`  處理方式：--unmapped-venue=${input.options.unmappedVenue}`)
  }

  if (input.skipped.length) {
    console.log(`\n略過 ${input.skipped.length} 筆：`)
    for (const s of input.skipped)
      console.log(`  ${s.record.watchedOn} ${s.record.title} — ${s.why}`)
  }

  if (input.index.ambiguous.size)
    console.log(`\n（既有片庫有 ${input.index.ambiguous.size} 個同名多部的片名，一律不硬挑，改走 TMDB）`)

  if (input.orphanKeys.length) {
    console.log(`\n來源已不再產生的舊 import_key ${input.orphanKeys.length} 筆${input.pruned ? `（已刪除 ${input.pruned} 筆）` : ''}：`)
    for (const key of input.orphanKeys)
      console.log(`  ${key}`)
    if (!input.pruned)
      console.log('  這些是舊版匯入留下的殘骸（例如片名拆分前的那一筆）。加 --prune-orphans 清除。')
  }

  if (!input.options.apply)
    console.log('\n這是預演。確認無誤後加 --apply 實際寫入。')
}

await main()
