import type { KnownFilm, ReleaseLike } from '#pipeline/tmdb/classify'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildImportPlan, rowsToImport } from '#pipeline/tmdb/import-plan'
import { toSeedRow } from '#pipeline/tmdb/seed-row'
import { importBodySchema, importSourceSchema, parseTmdbId } from '../server/utils/tmdb-import-options'

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

  it.each(['import-preview.post.ts', 'import.post.ts'])('%s：assertStaffFrom 在任何讀寫之前', (name) => {
    const s = src(name)
    const gate = s.indexOf('await assertStaffFrom(')
    expect(gate).toBeGreaterThan(0)
    for (const call of ['planImport(', 'executeImport(', 'readBody('])
      expect(!s.includes(call) || s.indexOf(call) > gate, call).toBe(true)
  })

  it('預覽那一支完全不碰 service role', () => {
    expect(src('import-preview.post.ts')).not.toMatch(/serviceSupabase|executeImport/)
  })
})
