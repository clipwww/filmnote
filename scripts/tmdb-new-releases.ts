/**
 * 從 TMDB 的「台灣上映中／即將上映」找出片庫還沒有的作品——**只看不寫**。
 *
 *   pnpm tsx --env-file=.env scripts/tmdb-new-releases.ts
 *   pnpm tsx --env-file=.env scripts/tmdb-new-releases.ts --pages 2
 *
 * ── ★ 為什麼這一支只做 dry-run ────────────────────────────────────────────
 * 真正的寫入要走 `seed_films()`，而那支函式是**全片庫 2,764 部作品的寫入路徑**。
 * 它還需要一條這裡沒有的改動（政府片名日後進來時要能覆蓋 TMDB 片名，
 * 見 `BUILD_PLAN §8.3` 2026-09-20 的裁決框）。**在那條改動做好之前寫入是危險的**，
 * 所以這一支刻意沒有任何 INSERT／UPDATE，連 service key 都不用。
 *
 * ── ★ 三分類，不是「新／舊」兩分類 ─────────────────────────────────────
 * 實測 2026-09-20：片庫有 **267 部 `origin='gov'` 的作品沒有 `tmdb_id`**
 * （比對器沒配到，例如《間諜家家酒》——片商用英文片名登記）。
 * **從 TMDB 盲目新增，那 267 部裡只要有一部也出現在台灣上映清單裡，就會變成重複作品。**
 * 所以要分三類，而第二類的正確動作是 `link_film_to_tmdb()` 補 id，**不是新增**：
 *
 *   ① 已收錄     —— `film.tmdb_id` 已經有這個 id
 *   ② 疑似已存在 —— 片名對得上一部**沒有 tmdb_id** 的既有作品 ⇒ 應該補 id
 *   ③ 候選新增   —— 兩者皆非
 *
 * ⚠️ ② 只是**線索不是判定**。片名比對用的是 `normalizeTitle()`（跟比對器同一支），
 *   但這裡刻意不跑 `scoreCandidate()`：那需要 `Certificate` 的年份與片長，
 *   而清單端點不給片長。**這一支的職責是把可疑的攤出來給人看，不是替人決定。**
 *
 * ⚠️ 清單端點回的 `release_date` 是 TMDB 的**主要**上映日，不一定是台灣的。
 *   台灣上映日要一部一次 `detail()`，這一支不做——**不要把它印成「台灣上映日」**。
 */

import type { TmdbSearchResult } from '#pipeline/types'
import process from 'node:process'
import { Client, types as pgTypes } from 'pg'
import { normalizeTitle } from '#pipeline/normalize/title'
import { TmdbClient } from '#pipeline/tmdb/client'

// ⚠️ 踩雷 #253：node-postgres 預設把 date/timestamp 解析成 JS Date，印出來會位移一天
//    （2016-09-28 變成 2016-09-27T16:00Z）。`scripts/db.ts` 為此關掉了解析器，
//    這一支不經過它，所以要自己套同一道防護——即使目前只取文字欄位，
//    日後有人加一個日期欄位時這道防護要已經在。
for (const oid of [1082, 1114, 1184, 1083])
  pgTypes.setTypeParser(oid, v => v)

function arg(name: string, fallback: number): number {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const i = args.indexOf(`--${name}`)
  const n = Number(args[i + 1])
  return i >= 0 && Number.isFinite(n) ? n : fallback
}

interface KnownFilm {
  id: string
  tmdb_id: number | null
  title_zh: string
  title_original: string
  origin: string
}

async function loadLibrary(): Promise<KnownFilm[]> {
  const url = process.env.DATABASE_URL
  if (!url)
    throw new Error('缺少 DATABASE_URL')
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    // 只取文字與整數欄位，不取日期——見檔頭那條 #253 的註解。
    const { rows } = await client.query<KnownFilm>(
      `select id, tmdb_id, coalesce(title_zh,'') as title_zh,
              coalesce(title_original,'') as title_original, origin::text as origin
         from public.film
        where merged_into_film_id is null`,
    )
    return rows
  }
  finally {
    await client.end()
  }
}

async function main() {
  const maxPages = arg('pages', 5)
  const apiKey = process.env.NUXT_TMDB_API_KEY ?? process.env.TMDB_API_KEY
  if (!apiKey)
    throw new Error('缺少 NUXT_TMDB_API_KEY')

  const tmdb = new TmdbClient({ apiKey })
  const [nowPlaying, upcoming] = await Promise.all([
    tmdb.taiwanReleases('now_playing', maxPages),
    tmdb.taiwanReleases('upcoming', maxPages),
  ])

  // 同一部片可能同時出現在兩支清單裡（上映中 ∩ 即將上映的邊界日）。以 id 去重。
  const releases = new Map<number, TmdbSearchResult>()
  for (const r of [...nowPlaying, ...upcoming])
    releases.set(r.id, r)

  const library = await loadLibrary()
  const byTmdbId = new Set(library.map(f => f.tmdb_id).filter((v): v is number => v !== null))

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

  const known: TmdbSearchResult[] = []
  const suspected: { r: TmdbSearchResult, hits: KnownFilm[] }[] = []
  const fresh: TmdbSearchResult[] = []

  for (const r of releases.values()) {
    if (byTmdbId.has(r.id)) {
      known.push(r)
      continue
    }
    const hits = [
      ...(orphansByTitle.get(normalizeTitle(r.title)) ?? []),
      ...(orphansByTitle.get(normalizeTitle(r.original_title)) ?? []),
    ]
    const uniq = [...new Map(hits.map(h => [h.id, h])).values()]
    if (uniq.length)
      suspected.push({ r, hits: uniq })
    else
      fresh.push(r)
  }

  console.log('── 來源 ──')
  console.log(`  now_playing ${nowPlaying.length} 筆／upcoming ${upcoming.length} 筆`)
  console.log(`  去重後 ${releases.size} 部；片庫 ${library.length} 部`
    + `（其中 ${library.filter(f => f.tmdb_id === null).length} 部沒有 tmdb_id）`)

  console.log(`\n── ① 已收錄（tmdb_id 已存在）：${known.length} 部 ──`)

  console.log(`\n── ② ⚠️ 疑似已存在、應該補 id 而不是新增：${suspected.length} 部 ──`)
  for (const { r, hits } of suspected) {
    console.log(`  TMDB ${r.id}  ${r.title} / ${r.original_title}`)
    for (const h of hits)
      console.log(`      ↳ 片庫既有 ${h.id}（origin=${h.origin}）${h.title_zh} / ${h.title_original}`)
  }
  if (!suspected.length)
    console.log('  （無）')

  console.log(`\n── ③ 候選新增：${fresh.length} 部 ──`)
  for (const r of fresh.slice(0, 40))
    console.log(`  TMDB ${r.id}  ${r.title} / ${r.original_title}  主要上映日=${r.release_date || '(無)'}`)
  if (fresh.length > 40)
    console.log(`  …還有 ${fresh.length - 40} 部（本清單刻意截斷，不是只有這些）`)

  console.log('\n⚠️ 這一支沒有寫入任何東西。要真的匯入，先做 BUILD_PLAN §8.3 那條'
    + ' seed_films() 的改動（政府片名要能覆蓋 TMDB 片名），否則新作品的中文片名'
    + '會被永遠鎖在 TMDB 的群眾翻譯上。')
}

await main()
