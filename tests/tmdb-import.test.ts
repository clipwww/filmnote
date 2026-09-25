import type { KnownFilm, ReleaseLike } from '#pipeline/tmdb/classify'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildImportPlan, rowsToImport } from '#pipeline/tmdb/import-plan'
import { linkPreconditions } from '#pipeline/tmdb/link-check'
import { toSeedRow } from '#pipeline/tmdb/seed-row'
import { parseTmdbId } from '../app/utils/tmdb-id'
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

  it.each(['import-preview.post.ts', 'import.post.ts', 'link.post.ts'])('%s：assertStaffFrom 在任何讀寫之前', (name) => {
    const s = src(name)
    const gate = s.indexOf('await assertStaffFrom(')
    expect(gate).toBeGreaterThan(0)
    for (const call of ['planImport(', 'executeImport(', 'readBody(', 'serviceSupabase(', '.from('])
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
