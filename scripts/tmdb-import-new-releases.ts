/**
 * 把 TMDB「台灣上映中／即將上映」裡片庫還沒有的作品寫進片庫（seeding）。
 *   pnpm exec tsx --env-file=.env scripts/tmdb-import-new-releases.ts [--pages N] [--limit N]
 *   ...同上 --apply        ← 真的寫入；沒有這個旗標就只印數字
 * ⚠️ 與 `/app/import`／`scripts/import-mylog.ts` 的「個人紀錄匯入」是**兩件不同的事**，
 *   那一條完全不碰。這一支往**片庫**新增作品。
 */
// 授權來源：`BUILD_PLAN §8.3` 2026-09-20 David 第 1 則裁決
// （origin='tmdb'、title_zh_source='tmdb'、review_state='approved'）。
// 代價 David 已知並接受：片庫會出現**沒有在台灣上映過**的作品（TMDB 是全球片庫）
// ⇒ 不要為此加審核、不要加「僅台灣」過濾，那是已裁決的取捨。
//
// ★ 只送 ③ 候選新增。② 疑似已存在的該補 tmdb_id 而不是新增（走 admin 端的
//   `link_film_to_tmdb`，見 0017／0018），這一支刻意不替人決定。
//
// ⚠️ 兩道閘門，缺一不可（都會擋下 --apply）：
//   ① 0019 沒套用 ⇒ seed_films() 的 INSERT 分支寫不出 title_zh_source，
//      結果會是 origin='tmdb' 但 title_zh_source='gov'——與裁決相反，而且**不會報錯**。
//   ② 任何候選的 `resolve_film('tmdb:'||id)` 不是 null ⇒ 它會走 UPDATE 分支。
//      那條路不是這一支的用途，而且 UPDATE 分支的
//      `least(coalesce(first_seen_roc_year, 9999), null)` 會把年份寫成 **9999**
//      （least 忽略 NULL）。政府管線永遠帶著 firstSeenRocYear 所以碰不到，這一支沒有。

import type { KnownFilm } from '#pipeline/tmdb/classify'
import type { TmdbSearchResult } from '#pipeline/types'
import process from 'node:process'
import { Client, types as pgTypes } from 'pg'
import { classifyReleases } from '#pipeline/tmdb/classify'
import { TmdbClient } from '#pipeline/tmdb/client'
import { toSeedRow } from '#pipeline/tmdb/seed-row'

// ⚠️ 踩雷 #253：node-postgres 預設把 date/timestamp 解析成 JS Date，印出來會位移一天。
for (const oid of [1082, 1114, 1184, 1083])
  pgTypes.setTypeParser(oid, v => v)

const FILM_BATCH = 200 // seed_films 是 plpgsql 迴圈，批次太大會撞 statement timeout

function numArg(name: string, fallback: number): number {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const i = args.indexOf(`--${name}`)
  const n = Number(args[i + 1])
  return i >= 0 && Number.isFinite(n) ? n : fallback
}

async function main() {
  const maxPages = numArg('pages', 5)
  const limit = numArg('limit', Number.POSITIVE_INFINITY)
  const apply = process.argv.includes('--apply')

  const url = process.env.DATABASE_URL
  if (!url)
    throw new Error('缺少 DATABASE_URL')
  const apiKey = process.env.NUXT_TMDB_API_KEY ?? process.env.TMDB_API_KEY
  if (!apiKey)
    throw new Error('缺少 NUXT_TMDB_API_KEY')

  const tmdb = new TmdbClient({ apiKey })
  const [nowPlaying, upcoming] = await Promise.all([
    tmdb.taiwanReleases('now_playing', maxPages),
    tmdb.taiwanReleases('upcoming', maxPages),
  ])
  const releases = new Map<number, TmdbSearchResult>()
  for (const r of [...nowPlaying, ...upcoming])
    releases.set(r.id, r)

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 300_000,
  })
  client.on('notice', msg => msg.message && console.log(`[notice] ${msg.message}`))
  await client.connect()
  try {
    const { rows: library } = await client.query<KnownFilm>(
      `select id, tmdb_id, coalesce(title_zh,'') as title_zh,
              coalesce(title_original,'') as title_original, origin::text as origin
         from public.film
        where merged_into_film_id is null`,
    )
    const { known, suspected, fresh } = classifyReleases(releases.values(), library)

    const selected = fresh.slice(0, Number.isFinite(limit) ? limit : fresh.length)
    const rows = selected.map(toSeedRow)

    // ── 閘門 ① 0019 套用了嗎 ────────────────────────────────────────────────
    const { rows: [fn] } = await client.query<{ patched: boolean }>(
      `select coalesce(pg_get_functiondef(p.oid) like '%titleZhSource%', false) as patched
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'seed_films'`,
    )
    const patched = fn?.patched === true

    // ── 閘門 ② 有沒有候選會走進 UPDATE 分支 ─────────────────────────────────
    const { rows: resolved } = await client.query<{ key: string, film_id: string }>(
      `select k as key, public.resolve_film(k) as film_id
         from unnest($1::text[]) as k
        where public.resolve_film(k) is not null`,
      [rows.map(r => r.id)],
    )

    console.log('── 來源 ──')
    console.log(`  now_playing ${nowPlaying.length} 筆／upcoming ${upcoming.length} 筆`
      + `（--pages ${maxPages}）`)
    console.log(`  去重後 ${releases.size} 部；片庫 ${library.length} 部存活`
      + `（其中 ${library.filter(f => f.tmdb_id === null).length} 部沒有 tmdb_id）`)
    console.log('\n── 如果真的跑，會發生什麼 ──')
    console.log(`  ① 已收錄（tmdb_id 已存在）      ${known.length} 部 ⇒ 不送，0 次寫入`)
    console.log(`  ② 疑似已存在（該補 id 不是新增）${suspected.length} 部 ⇒ 不送，需人工判斷`)
    const limitNote = Number.isFinite(limit) ? `，本次 --limit ${limit} ⇒ 只送 ${selected.length} 部` : ''
    console.log(`  ③ 候選新增                      ${fresh.length} 部${limitNote}`)
    console.log(`  ⇒ 會 INSERT 新作品              ${rows.length - resolved.length} 部`)
    console.log(`  ⇒ 會走 UPDATE 分支              ${resolved.length} 部（必須是 0，見檔頭閘門 ②）`)
    console.log(`  ⇒ 會觸發 0019 的 gov 翻轉分支   0 部`
      + '（翻轉只在**政府**片名進來時發生，這一支送的全是 TMDB 片名）')
    for (const r of suspected)
      console.log(`     ② TMDB ${r.release.id} ${r.release.title} ↳ ${r.hits.map(h => `${h.title_zh || h.title_original}(${h.origin})`).join('、')}`)

    console.log('\n── 閘門 ──')
    console.log(`  0019 已套用：${patched ? '是' : '否'}`)
    console.log(`  候選中會走 UPDATE 分支的：${resolved.length} 部`)

    if (!apply) {
      console.log('\n⚠️ dry-run，沒有寫入任何東西。要真的寫入請加 --apply。')
      return
    }

    if (!patched) {
      throw new Error(
        '拒絕寫入：seed_films() 還不認得 titleZhSource（0019 未套用）。'
        + '照現狀寫下去會得到 origin=tmdb 但 title_zh_source=gov——與 §8.3 的裁決相反，'
        + '而且群眾翻譯的片名會被標記成官方核准的，不會有任何錯誤訊息。',
      )
    }
    if (resolved.length) {
      throw new Error(
        `拒絕寫入：${resolved.length} 部候選會走進 UPDATE 分支（例如 ${resolved[0]!.key}）。`
        + '那條路會把 first_seen_roc_year 寫成 9999，而且不是這一支的用途。',
      )
    }
    if (!rows.length) {
      console.log('\n沒有候選，不做任何事。')
      return
    }

    // 整批一個交易：一半寫進去一半沒有，比完全沒寫還難收拾。
    await client.query('begin')
    try {
      let written = 0
      for (let i = 0; i < rows.length; i += FILM_BATCH) {
        const batch = rows.slice(i, i + FILM_BATCH)
        const { rows: [r] } = await client.query<{ n: number }>(
          'select public.seed_films($1::jsonb) as n',
          [JSON.stringify(batch)],
        )
        written += Number(r?.n ?? 0)
        process.stdout.write(`\r  seed_films ${written}/${rows.length}`)
      }
      process.stdout.write('\n')
      await client.query('commit')
      console.log(`✅ 已寫入 ${written} 部。`)
    }
    catch (e) {
      await client.query('rollback')
      throw e
    }
  }
  finally {
    await client.end()
  }
}

await main()
