import type { DueRow, RefreshDb } from '../server/utils/tmdb-refresh'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TmdbClient } from '#pipeline/tmdb/client'
import { runTmdbRefresh } from '../server/utils/tmdb-refresh'

/**
 * `runTmdbRefresh` 的介面測試：假 fetch 的 TmdbClient ＋ 記憶體版 RefreshDb。
 * ★ TMDB 不會配合我們回 429、Supabase 也不會配合寫回失敗 ⇒ 收工條件與失敗路徑只能在這裡釘住。
 */

interface Reply { status: number, body?: unknown }

/** 依 `/movie/{id}` 回應；陣列代表依序回應，最後一個重複。 */
function fakeTmdb(replies: Record<number, Reply | Reply[]>, onRequest?: () => void, concurrency = 1): TmdbClient {
  const seen = new Map<number, number>()
  const fetchImpl = (async (url: URL) => {
    onRequest?.()
    const id = Number(url.pathname.split('/').pop())
    const r = replies[id] ?? { status: 404 }
    const list = Array.isArray(r) ? r : [r]
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    const reply = list[Math.min(n, list.length - 1)]!
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body } as Response
  }) as unknown as typeof fetch
  return new TmdbClient({ apiKey: 'x', concurrency, fetchImpl, sleepImpl: async () => {} })
}

const detail = (id: number) => ({ status: 200, body: { id, title: `片${id}`, original_title: `Film ${id}`, release_date: '2024-01-01', poster_path: null, popularity: 0, imdb_id: null, overview: '', runtime: 100 } })

function fakeDb(rows: DueRow[], over: Partial<{ patchError: (n: number) => string | null, applyError: string | null }> = {}) {
  const patches: { filmId: string, patch: Record<string, unknown> }[] = []
  const applied: string[] = []
  const db: RefreshDb = {
    claimDue: async limit => ({ rows: rows.slice(0, limit), due: rows.length }),
    patchSnapshot: async (filmId, patch) => {
      patches.push({ filmId, patch: patch as unknown as Record<string, unknown> })
      return { error: over.patchError?.(patches.length) ?? null }
    },
    applySnapshot: async (filmId) => {
      applied.push(filmId)
      return { error: over.applyError ?? null }
    },
  }
  return { db, patches, applied }
}

const due = (...ids: number[]): DueRow[] => ids.map(id => ({ film_id: `f${id}`, tmdb_id: id, attempts: 0 }))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runTmdbRefresh', () => {
  it('全部成功：寫回快照、套用回 film、沒有收工原因', async () => {
    const { db, patches, applied } = fakeDb(due(1, 2))
    const report = await runTmdbRefresh({ db, tmdb: fakeTmdb({ 1: detail(1), 2: detail(2) }) })
    expect(report).toMatchObject({ due: 2, claimed: 2, fresh: 2, failed: 0, gone: 0, untouched: 0, applied: 2, abortedBy: null })
    expect(patches.map(p => p.patch.state)).toEqual(['fresh', 'fresh'])
    expect(applied).toEqual(['f1', 'f2'])
  })

  it('★ 累計 10 次 429 就收工，沒輪到的列算 untouched', async () => {
    // maxRetries=5 ⇒ 一列吃 5 次節流才放棄；第二列結束時累計 10 次，第三列不再開工。
    const { db, patches } = fakeDb(due(1, 2, 3))
    const report = await runTmdbRefresh({ db, tmdb: fakeTmdb({ 1: { status: 429 }, 2: { status: 429 }, 3: { status: 429 } }) })
    expect(report).toMatchObject({ claimed: 3, failed: 2, untouched: 1, abortedBy: 'throttle' })
    expect(report.tmdb.throttled).toBe(10)
    expect(patches.map(p => [p.filmId, p.patch.state])).toEqual([['f1', 'failed'], ['f2', 'failed']])
  })

  it('★ 401 是設定錯誤：整批中止，而且一列狀態都不寫回', async () => {
    const { db, patches, applied } = fakeDb(due(1, 2, 3))
    const report = await runTmdbRefresh({ db, tmdb: fakeTmdb({ 1: { status: 401 }, 2: detail(2), 3: detail(3) }) })
    expect(report).toMatchObject({ abortedBy: 'fatal', fresh: 0, failed: 0, gone: 0, untouched: 3 })
    expect(patches).toEqual([])
    expect(applied).toEqual([])
  })

  it('404 ⇒ gone，寫回 gone 的欄位', async () => {
    const { db, patches } = fakeDb(due(1))
    const report = await runTmdbRefresh({ db, tmdb: fakeTmdb({}) })
    expect(report).toMatchObject({ gone: 1, untouched: 0, abortedBy: null })
    expect(patches[0]!.patch.state).toBe('gone')
  })

  it('★ 快照寫回失敗：算 failed、改寫一筆退避狀態、不套用回 film', async () => {
    const { db, patches, applied } = fakeDb(due(1), { patchError: n => (n === 1 ? 'statement timeout' : null) })
    const report = await runTmdbRefresh({ db, tmdb: fakeTmdb({ 1: detail(1) }) })
    expect(report).toMatchObject({ fresh: 0, failed: 1, applied: 0, untouched: 0 })
    expect(patches.map(p => p.patch.state)).toEqual(['fresh', 'failed'])
    expect(patches[1]!.patch).toMatchObject({ attempts: 1, last_error: '寫回快照失敗：statement timeout' })
    expect(applied).toEqual([])
    expect(report.errors[0]).toContain('寫回快照失敗')
  })

  it('apply_tmdb_snapshot 失敗：快照仍算 fresh，但 applied 不加且留下錯誤', async () => {
    const { db } = fakeDb(due(1), { applyError: 'boom' })
    const report = await runTmdbRefresh({ db, tmdb: fakeTmdb({ 1: detail(1) }) })
    expect(report).toMatchObject({ fresh: 1, applied: 0 })
    expect(report.errors).toEqual(['film f1 apply_tmdb_snapshot 失敗：boom'])
  })

  it('★ worker 數照 TmdbClient 的併發開（不是預設的 8）', async () => {
    // 10 個請求要同時在飛才放行：worker 數若另取預設值 8，會卡在 8 個而逾時。
    const ids = Array.from({ length: 10 }, (_, i) => i + 1)
    const { db } = fakeDb(due(...ids))
    let inFlight = 0
    let release!: () => void
    const allIn = new Promise<void>((resolve) => {
      release = resolve
    })
    const tmdb = fakeTmdb(Object.fromEntries(ids.map(id => [id, detail(id)])), () => {
      if (++inFlight === ids.length)
        release()
    }, ids.length)
    const gated = tmdb as unknown as { detail: (id: number) => Promise<unknown> }
    const original = gated.detail.bind(tmdb)
    gated.detail = async id => original(id).then(async (d) => {
      await allIn
      return d
    })
    const report = await runTmdbRefresh({ db, tmdb })
    expect(report).toMatchObject({ fresh: 10, untouched: 0 })
  }, 2000)

  describe('時間預算', () => {
    /** 每一次 TMDB 請求讓時鐘走 100ms。 */
    function clockedTmdb(replies: Record<number, Reply>) {
      let now = 0
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      return fakeTmdb(replies, () => {
        now += 100
      })
    }

    it('超過預算就不取新工作，剩下的算 untouched', async () => {
      const { db } = fakeDb(due(1, 2))
      const report = await runTmdbRefresh({ db, tmdb: clockedTmdb({ 1: detail(1), 2: detail(2) }) }, { budgetMs: 50 })
      expect(report).toMatchObject({ fresh: 1, untouched: 1, abortedBy: 'budget' })
    })

    it('★ 最後一列剛好做完才超過預算 ⇒ 是正常收尾，不是 budget', async () => {
      // 判斷順序顛倒（先問預算再問還有沒有工作）時這裡會回報 'budget' 而 untouched=0 的假警報。
      const { db } = fakeDb(due(1))
      const report = await runTmdbRefresh({ db, tmdb: clockedTmdb({ 1: detail(1) }) }, { budgetMs: 50 })
      expect(report).toMatchObject({ fresh: 1, untouched: 0, abortedBy: null })
    })
  })
})
