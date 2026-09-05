/**
 * TMDB 明細 → `film_tmdb_snapshot` 一列的純轉換，以及失敗退避的計算。
 *
 * 刻意與 `tmdb-refresh.ts` 分家：這一支不碰 Supabase、不碰 `useRuntimeConfig()`，
 * 因此可以被 `tests/**` 直接匯入而不需要 Nuxt 環境。快照映射裡真正會出錯的是
 * 「TMDB 的空值長什麼樣子」（見下方三個註解），那正是值得被單元測試釘住的部分。
 */

import type { TmdbMovieDetail } from '#pipeline/types'
import { taiwanReleaseDate } from '#pipeline/tmdb/client'

/**
 * TMDB 明細中「快照表要存、但比對器用不到」的欄位。
 *
 * `#pipeline/types` 的 `TmdbMovieDetail` 只宣告比對器用得到的欄位（那是刻意的
 * 最小介面）。快照表另外有 `backdrop_path` 與 `genre_ids` 兩欄，這裡以擴充型別
 * 補上，而不是去改 `src/**`——那不在本 session 的檔案分工內。
 *
 * ★ `genres`（明細）而非 `genre_ids`（搜尋結果）：同一份資料在 TMDB 的兩個
 *   端點是不同形狀的，取明細時只有 `genres: [{id, name}]`。
 */
export interface TmdbDetailForSnapshot extends TmdbMovieDetail {
  backdrop_path?: string | null
  genres?: { id: number, name: string }[]
}

/** 快照表中由刷新流程寫入的欄位。刻意不含 `film_id` / `tmdb_id`（那是鍵）。 */
export interface TmdbSnapshotPatch {
  state: 'fresh'
  title_zh: string | null
  title_original: string | null
  overview: string | null
  poster_path: string | null
  backdrop_path: string | null
  runtime_minutes: number | null
  release_date: string | null
  tw_release_date: string | null
  genre_ids: number[] | null
  /**
   * ★ 宣告成索引簽章而非 `TmdbDetailForSnapshot`：`database.types` 的 `Json`
   *   要求 `{ [key: string]: Json | undefined }`，而一個具名 interface 沒有索引
   *   簽章就不滿足它（TS 對 interface 不做隱含索引推斷，type alias 才會）。
   *   直接放 interface 會讓 `.update()` 整個參數型別不相容。
   */
  payload: { [key: string]: unknown }
  fetched_at: string
  expires_at: string
  next_refresh_at: string
  attempts: number
  last_error: null
}

/** 六個月條款的上限。180 天 < 6 個月，刻意留餘裕（0001 的 default 亦同）。 */
export const CACHE_TTL_DAYS = 180
/** 排程提前於到期前 30 天刷新：一次沒跑到還有 30 天可以補。 */
export const REFRESH_INTERVAL_DAYS = 150

/** `film.runtime_minutes` 的 check constraint 範圍（0001）。 */
const RUNTIME_MIN = 1
const RUNTIME_MAX = 1200

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function addDays(from: Date, days: number): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString()
}

/** 空字串當 null。TMDB 對「沒有這個值」一律回 `""` 而不是省略欄位。 */
function textOrNull(value: string | null | undefined): string | null {
  return value?.trim() || null
}

/**
 * TMDB 的 `runtime` 有兩種假值要分開處理：
 *   - `0` 代表「不知道」，不是真的 0 分鐘（匯入時實測，見 scripts/import-mylog.ts）
 *   - 超出 1–1200 的值會直接違反 check constraint ⇒ 整批 update 失敗
 * 兩者都收斂成 null，讓一部片長異常的片不至於拖垮一整批刷新。
 */
export function snapshotRuntime(runtime: number | null | undefined): number | null {
  if (typeof runtime !== 'number' || !Number.isFinite(runtime))
    return null
  const rounded = Math.round(runtime)
  return rounded >= RUNTIME_MIN && rounded <= RUNTIME_MAX ? rounded : null
}

/**
 * `date` 欄位只接受真正的日期字串。TMDB 的 `release_date` 在資料不全時是 `""`，
 * 直接餵進 Postgres 會是 22007（invalid input syntax for type date）。
 */
export function snapshotDate(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return ISO_DATE_RE.test(trimmed) ? trimmed : null
}

/**
 * 明細 → 快照列。
 *
 * ★ `title_zh` 寫進**快照表**，不代表會蓋掉 `film.title_zh`：套用是
 *   `apply_tmdb_snapshot()` 的職責，而它只在 `title_zh_source = 'tmdb'`
 *   時才覆寫。政府核准的中文片名因此在結構上不可能被 TMDB 蓋掉。
 */
export function snapshotFromDetail(
  detail: TmdbDetailForSnapshot,
  now: Date = new Date(),
): TmdbSnapshotPatch {
  return {
    state: 'fresh',
    title_zh: textOrNull(detail.title),
    title_original: textOrNull(detail.original_title),
    overview: textOrNull(detail.overview),
    poster_path: textOrNull(detail.poster_path),
    backdrop_path: textOrNull(detail.backdrop_path),
    runtime_minutes: snapshotRuntime(detail.runtime),
    release_date: snapshotDate(detail.release_date),
    tw_release_date: snapshotDate(taiwanReleaseDate(detail)),
    genre_ids: detail.genres ? detail.genres.map(g => g.id) : null,
    // 具名 interface 沒有索引簽章，不滿足 `Json` 的 `{ [key: string]: … }`。
    // 攤平成新物件再轉型：payload 是原樣留存的快取，不做結構驗證是刻意的。
    payload: { ...detail } as { [key: string]: unknown },
    fetched_at: now.toISOString(),
    expires_at: addDays(now, CACHE_TTL_DAYS),
    next_refresh_at: addDays(now, REFRESH_INTERVAL_DAYS),
    attempts: 0,
    last_error: null,
  }
}

/** 退避上限 3 天：再久就等於這一列被靜默放棄。 */
const BACKOFF_CAP_MINUTES = 60 * 24 * 3

/**
 * 失敗退避：1 小時起跳，逐次加倍，上限 3 天。
 *
 * `attempts` 傳入的是「這次失敗後」的累計次數（≥ 1）。
 */
export function backoffMinutes(attempts: number): number {
  const steps = Math.max(0, Math.min(Math.floor(attempts) - 1, 12))
  return Math.min(60 * 2 ** steps, BACKOFF_CAP_MINUTES)
}

/**
 * 失敗時寫回的欄位。
 *
 * ★ 刻意**不動 `expires_at`**。已有的快取內容繼續用它原本的到期日，
 *   排程一直失敗的話會自然到期 → 讀取端 view 把欄位變 NULL。
 *   合規因此不依賴「刷新一定會成功」（BUILD_PLAN §5 Step 9 的第一條驗收）。
 */
export function failurePatch(previousAttempts: number, message: string, now: Date = new Date()): {
  state: 'failed'
  attempts: number
  last_error: string
  next_refresh_at: string
} {
  const attempts = Math.max(0, previousAttempts) + 1
  return {
    state: 'failed',
    attempts,
    // last_error 是 text，但 TMDB 的錯誤訊息偶爾很長；截斷避免無意義的膨脹。
    last_error: message.slice(0, 500),
    next_refresh_at: new Date(now.getTime() + backoffMinutes(attempts) * 60_000).toISOString(),
  }
}

/**
 * 這兩個狀態碼代表「設定錯了」，不是「這一列有問題」。
 * 繼續跑會讓每一列都失敗一次並累加 attempts，把整個佇列推進退避——
 * 一個打錯的 API key 換來三天沒有海報。
 */
const FATAL_STATUS = new Set([401, 403])

/** 一次 TMDB 失敗該怎麼收尾。`fatal` 代表整批中止且**不寫任何狀態**。 */
export type FailureOutcome
  = | { kind: 'fatal' }
    | { kind: 'gone', patch: ReturnType<typeof gonePatch> }
    | { kind: 'failed', patch: ReturnType<typeof failurePatch> }

/**
 * 把一個 TMDB 錯誤翻成該寫回去的東西。
 *
 * 抽成純函式的理由：**429 是驗收條件之一，卻沒辦法叫 TMDB 真的回 429**。
 * Step 9 的 2,483 次實測請求裡節流 0 次，所以那條路徑在真實資料上永遠測不到。
 * 決策邏輯獨立出來之後，429 / 500 / 網路中斷 / 404 四種收尾至少能被單元測試釘住，
 * 而不是靠讀程式碼相信它。
 *
 * `status` 為 `undefined` 或 0 代表網路層失敗（`TmdbClient` 用 0 表示），
 * 與 5xx 同等對待：可重試 ⇒ 退避，不動 `expires_at`。
 */
export function outcomeForError(
  status: number | undefined,
  previousAttempts: number,
  message: string,
  now: Date = new Date(),
): FailureOutcome {
  if (status !== undefined && FATAL_STATUS.has(status))
    return { kind: 'fatal' }
  if (status === 404)
    return { kind: 'gone', patch: gonePatch(message, now) }
  return { kind: 'failed', patch: failurePatch(previousAttempts, message, now) }
}

/**
 * TMDB 說這個 id 不存在時寫回的欄位。
 *
 * `expires_at` 拉到現在 ⇒ 讀取端 view 立刻把 TMDB 欄位變 NULL，
 * 實際的欄位清空交給 `purge_expired_tmdb_cache()`（它會保留 `state='gone'`）。
 * 清空邏輯只留一個擁有者，避免兩處各自定義「什麼算清乾淨」。
 */
export function gonePatch(message: string, now: Date = new Date()): {
  state: 'gone'
  expires_at: string
  next_refresh_at: string
  last_error: string
} {
  return {
    state: 'gone',
    expires_at: now.toISOString(),
    // state='gone' 已被 tmdb_refresh_due 排除，這裡只是不留一個永遠到期的排程值。
    next_refresh_at: addDays(now, 3650),
    last_error: message.slice(0, 500),
  }
}
