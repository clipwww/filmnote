/**
 * TMDB API 客戶端。
 *
 * 重試與退避是**防禦性設計，非已證實的需求**：110–113 年全量匯入的
 * 9,076 次請求中，重試 0 次、遭 429 節流 0 次。但那次執行的實際併發
 * 接近 1（呼叫端當時逐筆等待），所以高併發下的節流行為仍未驗證。
 *
 * Python 原型曾在 8 併發下觀察到批次間約 6 倍的速度差異（709 筆/259 秒
 * vs 868 筆/1,669 秒），原因未確認——未量測 429，可能是網路或上游延遲
 * 而非節流。提高併發後若出現 429，`stats.throttled` 會記錄下來。
 *
 * 無論如何，不假設任何一次呼叫會成功：匯入管線必須能中斷續跑
 * （見 pipeline/checkpoint.ts）。
 */

import type { TmdbMovieDetail, TmdbSearchResult } from '#pipeline/types'

const BASE_URL = 'https://api.themoviedb.org/3'

/** TMDB 的區域代碼。台灣上映日與分級皆在此區塊下。 */
export const TW_REGION = 'TW'

export interface TmdbClientOptions {
  apiKey: string
  /** 同時進行的請求數上限。8 併發下的節流行為尚未驗證。 */
  concurrency?: number
  /** 單一請求的重試次數上限。 */
  maxRetries?: number
  /** 讓測試注入假的 fetch。 */
  fetchImpl?: typeof fetch
  /** 讓測試跳過真實等待。 */
  sleepImpl?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

/** 節流與伺服器端錯誤，值得重試。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

export class TmdbError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'TmdbError'
  }
}

/**
 * 併發閘門。
 *
 * 不用第三方套件是因為需求很小，而且這裡的行為值得被讀懂：
 * 超過上限的請求排隊等待，而非被丟棄或平行送出。
 */
class Gate {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit)
      await new Promise<void>(resolve => this.queue.push(resolve))

    this.active++
    try {
      return await task()
    }
    finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

export class TmdbClient {
  private readonly gate: Gate
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>

  /** 統計資訊，供匯入結束時回報。 */
  readonly stats = { requests: 0, retries: 0, throttled: 0 }

  constructor(private readonly options: TmdbClientOptions) {
    this.gate = new Gate(options.concurrency ?? 8)
    this.maxRetries = options.maxRetries ?? 5
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleepImpl ?? defaultSleep
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`)
    url.searchParams.set('api_key', this.options.apiKey)
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value)

    return this.gate.run(async () => {
      // 必須看到前一次的結果才知道要不要重試、退避多久。
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        this.stats.requests++

        const response = await this.fetchImpl(url, {
          headers: { 'User-Agent': 'filmnote-ingest/0.1' },
        }).catch((cause: unknown) => {
          // 網路層失敗也走重試路徑，與 5xx 同等對待。
          return { ok: false, status: 0, cause } as unknown as Response
        })

        if (response.ok)
          return await response.json() as T

        if (!RETRYABLE_STATUS.has(response.status) && response.status !== 0)
          throw new TmdbError(`TMDB 回應 HTTP ${response.status}：${url.pathname}`, response.status)

        if (attempt === this.maxRetries)
          throw new TmdbError(`TMDB 重試 ${this.maxRetries} 次後仍失敗：${url.pathname}`, response.status)

        this.stats.retries++
        if (response.status === 429)
          this.stats.throttled++

        // 指數退避。429 時額外拉長：被節流時短間隔重試通常只會延長懲罰。
        const base = response.status === 429 ? 2000 : 500
        await this.sleep(base * 2 ** attempt)
      }

      throw new TmdbError(`無法取得 ${url.pathname}`)
    })
  }

  /** 以片名搜尋。回傳空陣列代表 TMDB 確實查無此片，不是錯誤。 */
  async search(query: string): Promise<TmdbSearchResult[]> {
    const trimmed = query.trim()
    if (!trimmed)
      return []

    const data = await this.request<{ results?: TmdbSearchResult[] }>(
      '/search/movie',
      { query: trimmed, language: 'zh-TW' },
    )
    return data.results ?? []
  }

  /**
   * 台灣的**上映中**與**即將上映**清單。
   *
   * ── 為什麼是這兩支而不是 `/discover` ──────────────────────────────────
   * `/discover/movie` 要自己組 `release_date.gte` 與 `with_release_type`，
   * 而「台灣什麼時候算上映」正是這個專案最不想自己定義的東西——
   * 政府核准資料才是權威。`now_playing` / `upcoming` 的 `region=TW`
   * 由 TMDB 自己用台灣的上映資料算，我們只拿它當**線索**，不當事實。
   *
   * ⚠️ 回傳的 `release_date` 是 TMDB 的**主要**上映日，**不一定是台灣的**。
   *   要台灣上映日必須另外呼叫 `detail()` 再走 `taiwanReleaseDate()`——
   *   那是一部片一次請求，所以**不要在掃清單的時候順手做**。
   *
   * ⚠️ TMDB 的分頁上限是 500 頁，但這兩支實務上只有數頁。`maxPages` 是保險，
   *   不是分頁器：超過就停，並由呼叫端決定要不要吵。
   */
  async taiwanReleases(kind: 'now_playing' | 'upcoming', maxPages = 5): Promise<TmdbSearchResult[]> {
    const out: TmdbSearchResult[] = []
    for (let page = 1; page <= maxPages; page++) {
      const data = await this.request<{ results?: TmdbSearchResult[], total_pages?: number }>(
        `/movie/${kind}`,
        { language: 'zh-TW', region: TW_REGION, page: String(page) },
      )
      out.push(...(data.results ?? []))
      if (page >= (data.total_pages ?? 1))
        break
    }
    return out
  }

  /** 取影片明細，含台灣上映日所需的 release_dates。 */
  async detail(id: number): Promise<TmdbMovieDetail> {
    return this.request<TmdbMovieDetail>(`/movie/${id}`, {
      language: 'zh-TW',
      append_to_response: 'release_dates',
    })
  }
}

/** 自明細中取出台灣的上映日。查無時回傳 null。 */
export function taiwanReleaseDate(detail: TmdbMovieDetail): string | null {
  const tw = detail.release_dates?.results.find(r => r.iso_3166_1 === TW_REGION)
  return tw?.release_dates[0]?.release_date.slice(0, 10) ?? null
}
