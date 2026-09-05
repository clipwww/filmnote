import type { ConsolidateInput } from '~/pipeline/consolidate'
import type { Certificate, MatchOutcome, TmdbMovieDetail } from '~/types'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runResumable } from '~/pipeline/checkpoint'
import { consolidate, summarize, unmatchedFilmKey } from '~/pipeline/consolidate'
import { taiwanReleaseDate, TmdbClient, TmdbError } from '~/tmdb/client'

function cert(partial: Partial<Certificate>): Certificate {
  return {
    id: '113:局影外第113001號:test',
    permitNo: '局影外第113001號',
    rocYear: 113,
    gregorianYear: 2024,
    rating: '普',
    titleZh: '',
    titleOriginal: '',
    country: '美國',
    language: '英語',
    producer: '',
    runtimeMinutes: null,
    versionNote: null,
    defects: [],
    ...partial,
  }
}

const matched = (tmdbId: number): MatchOutcome => ({ matched: true, tmdbId, score: 5, signals: ['zh-exact'] })
const unmatched: MatchOutcome = { matched: false, reason: 'score-too-low', score: 0 }

/** 產生假的 fetch，依序回傳預設的回應。 */
function stubFetch(responses: { status: number, body?: unknown }[]): typeof fetch {
  let index = 0
  return (async () => {
    const response = responses[Math.min(index++, responses.length - 1)]!
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response
  }) as unknown as typeof fetch
}

describe('tMDB client 的重試與節流', () => {
  const noSleep = async () => {}

  it('遭遇 429 時重試並最終成功', async () => {
    const client = new TmdbClient({
      apiKey: 'x',
      fetchImpl: stubFetch([
        { status: 429 },
        { status: 429 },
        { status: 200, body: { results: [{ id: 1, title: '測試片' }] } },
      ]),
      sleepImpl: noSleep,
    })

    const results = await client.search('測試')
    expect(results).toHaveLength(1)
    expect(client.stats.retries).toBe(2)
    expect(client.stats.throttled).toBe(2)
  })

  it('重試次數用盡後拋出 TmdbError', async () => {
    const client = new TmdbClient({
      apiKey: 'x',
      maxRetries: 2,
      fetchImpl: stubFetch([{ status: 503 }]),
      sleepImpl: noSleep,
    })

    await expect(client.search('測試')).rejects.toBeInstanceOf(TmdbError)
  })

  it('不可重試的狀態碼立刻拋錯，不浪費配額', async () => {
    const client = new TmdbClient({
      apiKey: 'x',
      fetchImpl: stubFetch([{ status: 401 }]),
      sleepImpl: noSleep,
    })

    await expect(client.search('測試')).rejects.toMatchObject({ status: 401 })
    // 只送了一次請求，沒有重試
    expect(client.stats.requests).toBe(1)
    expect(client.stats.retries).toBe(0)
  })

  it('空查詢不發出請求', async () => {
    const client = new TmdbClient({
      apiKey: 'x',
      fetchImpl: stubFetch([{ status: 200, body: { results: [] } }]),
      sleepImpl: noSleep,
    })

    expect(await client.search('   ')).toEqual([])
    expect(client.stats.requests).toBe(0)
  })

  it('搜尋無結果回傳空陣列而非拋錯', async () => {
    const client = new TmdbClient({
      apiKey: 'x',
      fetchImpl: stubFetch([{ status: 200, body: {} }]),
      sleepImpl: noSleep,
    })

    expect(await client.search('查無此片')).toEqual([])
  })

  it('併發不超過設定上限', async () => {
    let active = 0
    let peak = 0
    const client = new TmdbClient({
      apiKey: 'x',
      concurrency: 3,
      sleepImpl: noSleep,
      fetchImpl: (async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return { ok: true, status: 200, json: async () => ({ results: [] }) } as Response
      }) as unknown as typeof fetch,
    })

    await Promise.all(Array.from({ length: 12 }, (_, i) => client.search(`片${i}`)))
    expect(peak).toBeLessThanOrEqual(3)
  })
})

describe('台灣上映日的取出', () => {
  const detail = (results: TmdbMovieDetail['release_dates']): TmdbMovieDetail => ({
    id: 1,
    title: '',
    original_title: '',
    release_date: '2024-01-01',
    poster_path: null,
    popularity: 0,
    imdb_id: null,
    overview: '',
    runtime: 100,
    release_dates: results,
  })

  it('取出 TW 區的上映日', () => {
    expect(taiwanReleaseDate(detail({
      results: [
        { iso_3166_1: 'US', release_dates: [{ release_date: '2024-01-01T00:00:00.000Z' }] },
        { iso_3166_1: 'TW', release_dates: [{ release_date: '2024-02-14T00:00:00.000Z' }] },
      ],
    }))).toBe('2024-02-14')
  })

  it('沒有台灣資料時回傳 null', () => {
    // 實測 110 年僅 42.6% 的片有台灣上映日，這是常見情況而非異常
    expect(taiwanReleaseDate(detail({
      results: [{ iso_3166_1: 'US', release_dates: [{ release_date: '2024-01-01' }] }],
    }))).toBeNull()
    expect(taiwanReleaseDate(detail(undefined))).toBeNull()
  })
})

describe('核准紀錄收斂為作品', () => {
  it('命中同一 TMDB id 的多張證明書收斂為一部作品', () => {
    // 《SPY x FAMILY CODE: White》在 113 年有 4 張證明書
    const inputs: ConsolidateInput[] = [1, 2, 3, 4].map(n => ({
      certificate: cert({
        id: `113:局影外第11300${n}號:spyxfamilycodewhite`,
        permitNo: `局影外第11300${n}號`,
        titleZh: 'SPY x FAMILY CODE: White',
        runtimeMinutes: 110,
      }),
      outcome: matched(945961),
    }))

    const films = consolidate(inputs)
    expect(films).toHaveLength(1)
    expect(films[0]!.certificateIds).toHaveLength(4)
    expect(films[0]!.id).toBe('tmdb:945961')
  })

  it('跨年度的同一部片收斂，並保留最早的年度', () => {
    const films = consolidate([
      { certificate: cert({ id: 'a', rocYear: 113, titleZh: '某片' }), outcome: matched(100) },
      { certificate: cert({ id: 'b', rocYear: 110, titleZh: '某片' }), outcome: matched(100) },
    ])

    expect(films).toHaveLength(1)
    expect(films[0]!.firstSeenRocYear).toBe(110)
  })

  it('未命中的作品 tmdbId 為 null——這是必須可為空的欄位', () => {
    const films = consolidate([
      { certificate: cert({ id: 'a', titleZh: '銀魂劇場版 2D 一國傾城篇' }), outcome: unmatched },
    ])

    expect(films[0]!.tmdbId).toBeNull()
    expect(films[0]!.source).toBe('gov')
  })

  it('未命中的作品以中文與原文片名一起收斂', () => {
    const films = consolidate([
      { certificate: cert({ id: 'a', titleZh: '銀魂劇場版', titleOriginal: 'Gintama' }), outcome: unmatched },
      { certificate: cert({ id: 'b', titleZh: '銀魂劇場版', titleOriginal: 'Gintama' }), outcome: unmatched },
    ])

    expect(films).toHaveLength(1)
    expect(films[0]!.certificateIds).toEqual(['a', 'b'])
  })

  it('同名但原文不同的片不被誤併', () => {
    const films = consolidate([
      { certificate: cert({ id: 'a', titleZh: '熱帶往事', titleOriginal: 'Are You Lonesome Tonight' }), outcome: unmatched },
      { certificate: cert({ id: 'b', titleZh: '熱帶往事', titleOriginal: 'Tropical Memories' }), outcome: unmatched },
    ])

    expect(films).toHaveLength(2)
  })

  it('中文與原文皆空時退回使用核准紀錄自身的 id，不與他片混同', () => {
    expect(unmatchedFilmKey(cert({ id: 'x', titleZh: '', titleOriginal: '' }))).toBe('gov:orphan:x')

    const films = consolidate([
      { certificate: cert({ id: 'x', titleZh: '', titleOriginal: '' }), outcome: unmatched },
      { certificate: cert({ id: 'y', titleZh: '', titleOriginal: '' }), outcome: unmatched },
    ])
    expect(films).toHaveLength(2)
  })

  it('中文片名以政府核准名為準，原文片名以 TMDB 為準', () => {
    const films = consolidate([{
      certificate: cert({ id: 'a', titleZh: '紅豬', titleOriginal: 'Porco Rosso' }),
      outcome: matched(11621),
      tmdb: { titleZh: '紅豬(TMDB版本)', titleOriginal: '紅の豚', runtimeMinutes: 93 },
    }])

    // 政府核准名勝出：TMDB 的中文標題只有 83.2% 與官方一致
    expect(films[0]!.titleZh).toBe('紅豬')
    // TMDB 的原文勝出：政府欄位有 Excel 誤判與編碼損毀
    expect(films[0]!.titleOriginal).toBe('紅の豚')
  })

  it('原文片名損毀時採用 TMDB 的值', () => {
    const films = consolidate([{
      // 《福田村事件》的原文片名被解析器清空
      certificate: cert({ id: 'a', titleZh: '福田村事件', titleOriginal: '' }),
      outcome: matched(1),
      tmdb: { titleZh: '', titleOriginal: '福田村事件', runtimeMinutes: 137 },
    }])

    expect(films[0]!.titleOriginal).toBe('福田村事件')
  })

  it('統計反映收斂消去的重複量', () => {
    const inputs: ConsolidateInput[] = [
      { certificate: cert({ id: 'a', titleZh: '片一' }), outcome: matched(1) },
      { certificate: cert({ id: 'b', titleZh: '片一' }), outcome: matched(1) },
      { certificate: cert({ id: 'c', titleZh: '片二' }), outcome: unmatched },
    ]
    const stats = summarize(inputs, consolidate(inputs))

    expect(stats).toEqual({ certificates: 3, films: 2, matched: 1, unmatched: 1, collapsed: 1 })
  })
})

describe('中斷續跑', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'filmnote-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('第二次執行跳過已完成的項目', async () => {
    const path = join(dir, 'cp.json')
    const items = ['a', 'b', 'c']
    const processed: string[] = []

    await runResumable({
      path,
      items,
      keyOf: item => item,
      process: async (item) => {
        processed.push(item)
        return item.toUpperCase()
      },
    })
    expect(processed).toEqual(['a', 'b', 'c'])

    processed.length = 0
    const second = await runResumable({
      path,
      items,
      keyOf: item => item,
      process: async (item) => {
        processed.push(item)
        return item.toUpperCase()
      },
    })

    expect(processed).toEqual([])
    expect(second).toEqual({ a: 'A', b: 'B', c: 'C' })
  })

  it('循序模式下，中斷點之後的項目不被處理，續跑時補上', async () => {
    // concurrency: 1 讓中斷語意可精確斷言。併發下 'd' 會與 'c' 同時
    // 開跑而先完成，那是另一個測試涵蓋的正確行為。
    const path = join(dir, 'cp2.json')
    const items = ['a', 'b', 'c', 'd']

    await expect(runResumable({
      path,
      items,
      keyOf: item => item,
      concurrency: 1,
      flushEvery: 1,
      process: async (item) => {
        if (item === 'c')
          throw new Error('模擬中斷')
        return item.toUpperCase()
      },
    })).rejects.toThrow('模擬中斷')

    const processed: string[] = []
    const result = await runResumable({
      path,
      items,
      keyOf: item => item,
      concurrency: 1,
      process: async (item) => {
        processed.push(item)
        return item.toUpperCase()
      },
    })

    // a、b 已完成不再重做；c、d 補上
    expect(processed).toEqual(['c', 'd'])
    expect(result).toEqual({ a: 'A', b: 'B', c: 'C', d: 'D' })
  })

  it('checkpoint 損毀時從頭開始而非拿壞資料續跑', async () => {
    const path = join(dir, 'cp3.json')
    await runResumable({ path, items: ['a'], keyOf: i => i, process: async i => i })

    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{ 這不是合法 JSON', 'utf8')

    const processed: string[] = []
    await runResumable({
      path,
      items: ['a'],
      keyOf: i => i,
      process: async (i) => {
        processed.push(i)
        return i
      },
    })

    expect(processed).toEqual(['a'])
  })

  it('真的併發處理，而非逐筆等待', async () => {
    // 這是回歸測試：先前的版本逐筆 await，導致下游客戶端的併發閘門
    // 永遠只看到一個請求，實測吞吐掉到應有的五分之一。
    const path = join(dir, 'cp-concurrent.json')
    let active = 0
    let peak = 0

    await runResumable({
      path,
      items: Array.from({ length: 20 }, (_, i) => `item${i}`),
      keyOf: item => item,
      concurrency: 5,
      process: async (item) => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
        return item
      },
    })

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(5)
  })

  it('併發數不超過設定上限', async () => {
    const path = join(dir, 'cp-cap.json')
    let active = 0
    let peak = 0

    await runResumable({
      path,
      items: Array.from({ length: 30 }, (_, i) => `x${i}`),
      keyOf: item => item,
      concurrency: 3,
      process: async (item) => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 2))
        active--
        return item
      },
    })

    expect(peak).toBeLessThanOrEqual(3)
  })

  it('併發下每個項目只被處理一次', async () => {
    const path = join(dir, 'cp-once.json')
    const counts = new Map<string, number>()

    const result = await runResumable({
      path,
      items: Array.from({ length: 50 }, (_, i) => `k${i}`),
      keyOf: item => item,
      concurrency: 8,
      process: async (item) => {
        counts.set(item, (counts.get(item) ?? 0) + 1)
        return item.toUpperCase()
      },
    })

    expect([...counts.values()].every(n => n === 1)).toBe(true)
    expect(Object.keys(result)).toHaveLength(50)
  })

  it('併發下中途失敗仍保住已完成的進度', async () => {
    const path = join(dir, 'cp-partial.json')
    const items = Array.from({ length: 20 }, (_, i) => `p${i}`)

    await expect(runResumable({
      path,
      items,
      keyOf: item => item,
      concurrency: 4,
      flushEvery: 2,
      process: async (item) => {
        if (item === 'p15')
          throw new Error('模擬中斷')
        return item
      },
    })).rejects.toThrow('模擬中斷')

    // 失敗前完成的項目已落地，重跑時不必重做
    const saved = JSON.parse(await readFile(path, 'utf8'))
    expect(Object.keys(saved.done).length).toBeGreaterThan(0)
    expect(saved.done).not.toHaveProperty('p15')

    const reprocessed: string[] = []
    await runResumable({
      path,
      items,
      keyOf: item => item,
      concurrency: 4,
      process: async (item) => {
        reprocessed.push(item)
        return item
      },
    })
    expect(reprocessed).not.toContain(Object.keys(saved.done)[0])
  })

  it('進度寫入磁碟，可供外部觀察', async () => {
    const path = join(dir, 'cp4.json')
    await runResumable({
      path,
      items: ['x', 'y'],
      keyOf: i => i,
      flushEvery: 1,
      process: async i => `${i}!`,
    })

    const saved = JSON.parse(await readFile(path, 'utf8')) as { done: Record<string, string> }
    expect(saved.done).toEqual({ x: 'x!', y: 'y!' })
  })
})
