import type { KnownFilm, ReleaseLike } from '#pipeline/tmdb/classify'
import type { ImportPlanDb, ImportWriteDb, ReadbackRow, SuspectFilmRow } from '../server/utils/tmdb-import'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TmdbClient, TmdbError } from '#pipeline/tmdb/client'
import { buildImportPlan, rowsToImport } from '#pipeline/tmdb/import-plan'
import { linkPreconditions } from '#pipeline/tmdb/link-check'
import { toSeedRow } from '#pipeline/tmdb/seed-row'
import { parseTmdbId } from '../app/utils/tmdb-id'
import { tmdbClientFor, tmdbHttpError } from '../server/utils/tmdb-http'
import { executeImport, planImport } from '../server/utils/tmdb-import'
import { importBodySchema, importSourceSchema } from '../server/utils/tmdb-import-options'

/**
 * 後台「匯入新作品」（`/admin`）與 CLI 共用的判斷。
 * ★ server 那條路**沒有** CLI 的閘門 ①（PostgREST 讀不到 `pg_proc`），所以 payload 的形狀
 *   只剩這裡守：少了 `titleZhSource`，`seed_films()` 會把 TMDB 片名標成官方核准的，不會報錯。
 */

const release = (id: number, title: string, original = title): ReleaseLike => ({ id, title, original_title: original })
const film = (over: Partial<KnownFilm>): KnownFilm => ({ id: 'f', tmdb_id: null, title_zh: '', title_original: '', origin: 'gov', ...over })

describe('toSeedRow', () => {
  it('★ 永遠帶 titleZhSource=tmdb 與 source=tmdb（§8.3 第 1 則裁決）', () => {
    const row = toSeedRow(release(1368337, '奧德賽', 'The Odyssey'))
    expect(row).toEqual({
      id: 'tmdb:1368337',
      tmdbId: 1368337,
      titleZh: '奧德賽',
      titleOriginal: 'The Odyssey',
      source: 'tmdb',
      titleZhSource: 'tmdb',
    })
  })

  it('不送 firstSeenRocYear：UPDATE 分支會把缺席的年份寫成 9999', () => {
    expect(toSeedRow(release(1, 'x'))).not.toHaveProperty('firstSeenRocYear')
  })
})

describe('buildImportPlan', () => {
  const library = [
    film({ id: 'a', tmdb_id: 100, title_zh: '已收錄' }),
    film({ id: 'b', tmdb_id: null, title_zh: '孤兒片名' }),
  ]

  it('四類各就各位', () => {
    const plan = buildImportPlan(
      [release(100, '已收錄'), release(200, '孤兒片名'), release(300, '新片'), release(400, '有鍵沒列')],
      library,
      new Set(['tmdb:400']),
    )
    expect(plan.known.map(r => r.id)).toEqual([100])
    expect(plan.suspected.map(s => s.release.id)).toEqual([200])
    expect(plan.fresh.map(r => r.id)).toEqual([300])
    expect(plan.blocked.map(r => r.id)).toEqual([400])
  })

  it('〔對照〕沒有 identity 的新片不會被當成 blocked', () => {
    const plan = buildImportPlan([release(300, '新片')], library, new Set())
    expect(plan.fresh.map(r => r.id)).toEqual([300])
    expect(plan.blocked).toEqual([])
  })
})

describe('rowsToImport', () => {
  const plan = buildImportPlan(
    [release(100, '已收錄'), release(300, '新片甲'), release(301, '新片乙')],
    [film({ id: 'a', tmdb_id: 100 })],
    new Set(),
  )

  it('沒有勾選 ⇒ 送 ③ 全部', () => {
    expect(rowsToImport(plan).map(r => r.tmdbId)).toEqual([300, 301])
  })

  it('勾選只能縮小', () => {
    expect(rowsToImport(plan, [301]).map(r => r.tmdbId)).toEqual([301])
  })

  it('★ 勾選塞進 ① 的 id 也不會被送出去（不信瀏覽器）', () => {
    expect(rowsToImport(plan, [100, 300]).map(r => r.tmdbId)).toEqual([300])
  })
})

describe('parseTmdbId', () => {
  it('純數字與 TMDB 網址都認得', () => {
    expect(parseTmdbId('1368337')).toBe(1368337)
    expect(parseTmdbId('https://www.themoviedb.org/movie/1368337-the-odyssey?language=zh-TW')).toBe(1368337)
  })

  it('片名不是 id（交給搜尋）', () => {
    expect(parseTmdbId('奧德賽')).toBeNull()
    expect(parseTmdbId('2001太空漫遊')).toBeNull()
    // ★ 片名本身就是數字的不可以被當成 id
    expect(parseTmdbId('1917')).toBeNull()
    expect(parseTmdbId('2046')).toBeNull()
  })
})

describe('輸入契約', () => {
  it('匯入不接受 search：片名要以 TMDB 明細為準，不是搜尋結果', () => {
    expect(importBodySchema.safeParse({ source: { kind: 'search', q: '奧德賽' } }).success).toBe(false)
    expect(importBodySchema.safeParse({ source: { kind: 'ids', ids: [1368337] } }).success).toBe(true)
  })

  it('頁數與 id 數有上限', () => {
    expect(importSourceSchema.safeParse({ kind: 'releases', pages: 6 }).success).toBe(false)
    expect(importSourceSchema.safeParse({ kind: 'ids', ids: Array.from({ length: 21 }, (_, i) => i + 1) }).success).toBe(false)
  })
})

describe('兩支端點的授權順序', () => {
  // ★ 先去掉註解：檔頭註解裡就寫著 `planImport()`，不去掉的話 indexOf 會找到註解而不是呼叫。
  const src = (name: string) => readFileSync(
    fileURLToPath(new URL(`../server/api/admin/tmdb/${name}`, import.meta.url)),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  // refresh 也在內：service role 與 TmdbClient 改由端點建好傳進 runTmdbRefresh，接線落在這些檔裡。
  it.each(['import-preview.post.ts', 'import.post.ts', 'link.post.ts', 'refresh.post.ts'])('%s：assertStaffFrom 在任何讀寫之前', (name) => {
    const s = src(name)
    const gate = s.indexOf('await assertStaffFrom(')
    expect(gate).toBeGreaterThan(0)
    for (const call of ['planImport(', 'executeImport(', 'runTmdbRefresh(', 'tmdbClientFor(', 'readBody(', 'serviceSupabase(', '.from('])
      expect(!s.includes(call) || s.indexOf(call) > gate, call).toBe(true)
  })

  it('預覽那一支完全不碰 service role', () => {
    expect(src('import-preview.post.ts')).not.toMatch(/serviceSupabase|executeImport/)
  })
})

describe('linkPreconditions（補 TMDB id）', () => {
  const orphan = { id: 'f1', tmdb_id: null, merged_into_film_id: null, origin: 'gov', review_state: 'approved' }

  it('孤兒、沒人持有這個 id ⇒ 放行', () => {
    expect(linkPreconditions(orphan, [], false)).toEqual({ ok: true })
  })

  it('找不到 ⇒ 404；已合併 ⇒ 409', () => {
    expect(linkPreconditions(null, [], false)).toMatchObject({ ok: false, status: 404 })
    expect(linkPreconditions({ ...orphan, merged_into_film_id: 'f9' }, [], false)).toMatchObject({ ok: false, status: 409 })
  })

  it('★ 審核中的使用者作品 ⇒ 409：link 會撞 film_ugc_review（2026-09-25 實測）', () => {
    expect(linkPreconditions({ ...orphan, origin: 'ugc', review_state: 'pending' }, [], false)).toMatchObject({ ok: false, status: 409 })
    // 〔對照〕已核准的使用者作品可以補
    expect(linkPreconditions({ ...orphan, origin: 'ugc', review_state: 'approved' }, [], false)).toEqual({ ok: true })
  })

  it('已經有 tmdb_id ⇒ 409（改 id 會撞 film_identity_one_primary，0017）', () => {
    expect(linkPreconditions({ ...orphan, tmdb_id: 5 }, [], false)).toMatchObject({ ok: false, status: 409 })
  })

  it('★ id 已在別的列上（含已合併的死列）⇒ 409：link_film_to_tmdb 會靜默合併', () => {
    expect(linkPreconditions(orphan, [{ id: 'f2', merged_into_film_id: null }], false)).toMatchObject({ ok: false, status: 409 })
    expect(linkPreconditions(orphan, [{ id: 'f3', merged_into_film_id: 'f4' }], false)).toMatchObject({ ok: false, status: 409 })
  })

  it('★ 識別鍵已屬於別人 ⇒ 409：identity 觸發器會把鍵搶過來', () => {
    expect(linkPreconditions(orphan, [], true)).toMatchObject({ ok: false, status: 409 })
  })
})

// ── 介面測試：假 fetch 的 TmdbClient ＋ 記憶體版 ImportPlanDb / ImportWriteDb ──────────

interface Reply { status: number, body?: unknown }

/** 依路徑回應：`/movie/now_playing`、`/movie/upcoming`、`/search/movie`、`/movie/{id}`。 */
function fakeTmdb(routes: Record<string, Reply>): TmdbClient {
  const fetchImpl = (async (url: URL) => {
    const reply = routes[url.pathname.replace('/3', '')] ?? { status: 404 }
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response
  }) as unknown as typeof fetch
  return new TmdbClient({ apiKey: 'x', concurrency: 1, maxRetries: 0, fetchImpl, sleepImpl: async () => {} })
}

function tmdbDetail(id: number, title: string, extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: { id, title, original_title: title, release_date: '2026-01-01', poster_path: null, popularity: 0, imdb_id: null, overview: '', runtime: 120, ...extra },
  }
}

function fakePlanDb(library: KnownFilm[], identity: string[] = [], suspects: SuspectFilmRow[] = []) {
  const pages: number[] = []
  const db: ImportPlanDb = {
    libraryPage: async (from, size) => {
      pages.push(from)
      return library.slice(from, from + size)
    },
    identityKeys: async keys => new Set(keys.filter(k => identity.includes(k))),
    suspectFilms: async ids => suspects.filter(f => ids.includes(f.id)),
  }
  return { db, pages }
}

describe('planImport', () => {
  it('★ 片庫分頁讀到底：第 1,000 列之後的作品也算進來', async () => {
    // PostgREST 一次最多 1,000 列；只讀第一頁的話第 1,200 列那部會被當成新片。
    const library = Array.from({ length: 1500 }, (_, i) => film({ id: `f${i}`, tmdb_id: i === 1200 ? 777 : null, title_zh: `庫存${i}` }))
    const { db, pages } = fakePlanDb(library)
    const tmdb = fakeTmdb({ '/movie/777': tmdbDetail(777, '第二頁的片') })
    const preview = await planImport({ db, tmdb }, { kind: 'ids', ids: [777] })
    expect(pages).toEqual([0, 1000])
    expect(preview.librarySize).toBe(1500)
    expect(preview.known.map(r => r.id)).toEqual([777])
  })

  it('ids 模式：404 進 notFound，台灣上映日取明細裡最早的一天', async () => {
    const { db } = fakePlanDb([])
    const tmdb = fakeTmdb({
      '/movie/1': tmdbDetail(1, '新片', { release_dates: { results: [{ iso_3166_1: 'TW', release_dates: [{ release_date: '2026-03-01T00:00:00.000Z' }, { release_date: '2026-02-14T00:00:00.000Z' }] }] } }),
    })
    const preview = await planImport({ db, tmdb }, { kind: 'ids', ids: [1, 2] })
    expect(preview.notFound).toEqual([2])
    expect(preview.fresh.map(r => [r.id, r.twReleaseDate])).toEqual([[1, '2026-02-14']])
  })

  it('已有 identity 的進 blocked', async () => {
    const { db } = fakePlanDb([], ['tmdb:5'])
    const preview = await planImport({ db, tmdb: fakeTmdb({ '/movie/5': tmdbDetail(5, '有鍵沒列') }) }, { kind: 'ids', ids: [5] })
    expect(preview.blocked.map(r => r.id)).toEqual([5])
  })

  it('★ ② 的判斷證據用傳進來的那個 client 補打明細，並帶出片庫那側', async () => {
    const { db } = fakePlanDb(
      [film({ id: 'b', title_zh: '孤兒片名' })],
      [],
      [{ id: 'b', runtime_minutes: 118, release_year: 2025, first_seen_roc_year: 114, country: '美國', ugc_poster_path: null, origin: 'gov', review_state: 'approved' }],
    )
    const tmdb = fakeTmdb({
      '/movie/now_playing': { status: 200, body: { results: [{ id: 200, title: '孤兒片名', original_title: 'Orphan' }], total_pages: 1 } },
      '/movie/upcoming': { status: 200, body: { results: [], total_pages: 1 } },
      '/movie/200': tmdbDetail(200, '孤兒片名', { runtime: 117 }),
    })
    const preview = await planImport({ db, tmdb }, { kind: 'releases', pages: 1 })
    expect(preview.suspected.map(s => s.release.id)).toEqual([200])
    expect(preview.evidence.releases[200]).toEqual({ runtime: 117, twReleaseDate: null })
    expect(preview.evidence.films.b).toMatchObject({ runtimeMinutes: 118, hasUgcPoster: false, pendingUgc: false })
    // 清單兩支＋明細一支，全記在同一個 client 上（沒有另建第二個）。
    expect(tmdb.stats.requests).toBe(3)
  })

  it('上游 TMDB 壞掉時原樣拋出 TmdbError，交給端點翻成 502', async () => {
    const { db } = fakePlanDb([])
    const failing = planImport({ db, tmdb: fakeTmdb({ '/search/movie': { status: 503 } }) }, { kind: 'search', q: '奧德賽' })
    await expect(failing).rejects.toBeInstanceOf(TmdbError)
    expect(await failing.catch(tmdbHttpError)).toMatchObject({ statusCode: 502 })
  })
})

describe('executeImport', () => {
  const rows = Array.from({ length: 45 }, (_, i) => toSeedRow(release(1000 + i, `新片${i}`)))

  function fakeWriteDb(over: { failBatch?: number, back?: ReadbackRow[] } = {}) {
    const batches: number[] = []
    const db: ImportWriteDb = {
      seedFilms: async (batch) => {
        batches.push(batch.length)
        if (batches.length === over.failBatch)
          return { count: 0, error: 'canceling statement due to statement timeout' }
        return { count: batch.length, error: null }
      },
      readback: async () => over.back ?? [],
    }
    return { db, batches }
  }

  it('分 20 部一批送（PostgREST 8 秒逾時），寫入數加總', async () => {
    const { db, batches } = fakeWriteDb()
    const result = await executeImport(db, rows)
    expect(batches).toEqual([20, 20, 5])
    expect(result.written).toBe(45)
  })

  it('★ 讀回判 ok：只有 origin=tmdb、title_zh_source=tmdb、已核准才算數', async () => {
    const { db } = fakeWriteDb({
      back: [
        { tmdb_id: 1000, title_zh: '新片0', origin: 'tmdb', title_zh_source: 'tmdb', review_state: 'approved' },
        // 0019 沒生效的樣子：寫進去了，但片名被標成官方的。
        { tmdb_id: 1001, title_zh: '新片1', origin: 'tmdb', title_zh_source: 'gov', review_state: 'approved' },
        { tmdb_id: 1002, title_zh: '新片2', origin: 'tmdb', title_zh_source: 'tmdb', review_state: 'pending' },
      ],
    })
    const result = await executeImport(db, rows.slice(0, 3))
    expect(result.readback.map(r => [r.tmdbId, r.ok])).toEqual([[1000, true], [1001, false], [1002, false]])
  })

  it('中途一批失敗 ⇒ 500，訊息帶已寫入的部數', async () => {
    const { db, batches } = fakeWriteDb({ failBatch: 2 })
    await expect(executeImport(db, rows)).rejects.toMatchObject({ statusCode: 500, statusMessage: expect.stringContaining('已寫入 20 部') })
    expect(batches).toEqual([20, 20])
  })
})

describe('tmdb-http：端點共用的建 client 與錯誤翻譯', () => {
  it('★ 沒有 key ⇒ 503，不是空結果', () => {
    expect(() => tmdbClientFor(undefined)).toThrow(expect.objectContaining({ statusCode: 503 }))
    expect(() => tmdbClientFor('')).toThrow(expect.objectContaining({ statusCode: 503 }))
    expect(tmdbClientFor('k')).toBeInstanceOf(TmdbClient)
  })

  it('已經是 HTTP 錯誤的原樣放行（讀片庫的 500 不能被改成 502）', () => {
    const own = Object.assign(new Error('讀片庫失敗'), { statusCode: 500 })
    expect(tmdbHttpError(own)).toBe(own)
    expect(tmdbHttpError(new TmdbError('TMDB 回應 HTTP 401', 401))).toMatchObject({ statusCode: 502 })
  })

  it('★ 不是 TMDB 的錯誤原樣放行（Nitro 回 500），不被報成 TMDB 故障', () => {
    const bug = new TypeError('Cannot read properties of undefined')
    expect(tmdbHttpError(bug)).toBe(bug)
    expect(tmdbHttpError(bug)).not.toHaveProperty('statusCode')
  })

  it('TMDB 回 200 但 body 不是 JSON ⇒ 仍是 TmdbError（翻 502 而不是當成我們的 bug）', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => JSON.parse('<html>') })) as unknown as typeof fetch
    const failing = tmdbClientFor('k', { fetchImpl, sleepImpl: async () => {} }).search('奧德賽')
    await expect(failing).rejects.toBeInstanceOf(TmdbError)
    expect(await failing.catch(tmdbHttpError)).toMatchObject({ statusCode: 502 })
  })
})
