import type { SupabaseClient } from '@supabase/supabase-js'
import type { TmdbDetailForSnapshot } from './tmdb-snapshot'
import type { Database, Json } from '~/types/database.types'
import { TmdbClient, TmdbError } from '#pipeline/tmdb/client'
import { failurePatch, outcomeForError, snapshotFromDetail } from './tmdb-snapshot'

/**
 * TMDB 快照的批次刷新。
 *
 * 為什麼不掛 pg_cron：Supabase 免費專案閒置會暫停，cron 不跑而**沒有任何人
 * 會知道**（0001 §5 的註解）。所以排程放在 Vercel Cron，由 HTTP 觸發。
 *
 * 為什麼合規不靠這支跑得成功：`film_public` 以 `expires_at > now()` 逐列把關，
 * 刷新一直失敗的話過期欄位自動變 NULL（退回文字卡片）。這支的職責是「讓內容
 * 保持新鮮」，不是「維持合規」——後者是讀取端的結構性保證。
 */

/** 每次呼叫的預設處理上限。穩態需求是 2,400 列 / 150 天 ≈ 16 列/天。 */
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

/**
 * 預設時間預算。Vercel 的函式有執行時間上限（Hobby 方案曾是 10 秒），
 * 而「跑到一半被砍」會留下一批 attempts 沒加、next_refresh_at 沒推的列。
 * 所以以時間收尾而不是以筆數收尾：超過預算就停止取新工作，剩下的下一輪再做
 * （它們的 `next_refresh_at` 仍 ≤ now()，view 會再給出來）。
 */
const DEFAULT_BUDGET_MS = 8_000
const MAX_BUDGET_MS = 30 * 60_000

/** TmdbClient 的預設併發。8 併發的節流行為在 Step 9 之前從未被驗證過。 */
const DEFAULT_CONCURRENCY = 8
const MAX_CONCURRENCY = 16

/**
 * 累計被 429 節流這麼多次就收工。
 *
 * 被節流時繼續灌請求只會延長懲罰，而且會把整批列的 attempts 一起推高
 * （＝一次上游抽風換來 2,400 列的指數退避）。停下來讓下一輪再試比較便宜。
 */
const THROTTLE_ABORT_AT = 10

export interface TmdbRefreshOptions {
  limit?: number
  budgetMs?: number
  concurrency?: number
}

export interface TmdbRefreshReport {
  /** view 中到期待刷新的總列數（不受 limit 影響）。 */
  due: number
  /** 這一輪實際取出來準備處理的列數。 */
  claimed: number
  fresh: number
  gone: number
  failed: number
  /** 取出來但因為收工而沒動到的列數。 */
  untouched: number
  /** `apply_tmdb_snapshot()` 成功套用回 film 的次數。 */
  applied: number
  tmdb: { requests: number, retries: number, throttled: number }
  elapsedMs: number
  abortedBy: 'budget' | 'throttle' | 'fatal' | null
  /** 取樣的錯誤訊息，最多 5 筆，供 cron 紀錄裡直接看到原因。 */
  errors: string[]
}

interface DueRow {
  film_id: string
  tmdb_id: number
  attempts: number
}

function clamp(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n))
    return fallback
  return Math.max(min, Math.min(Math.trunc(n), max))
}

/** 從 query string 解析選項。上限存在的理由是誤打一個 0 不該變成 DoS。 */
export function parseRefreshOptions(query: Record<string, unknown>): Required<TmdbRefreshOptions> {
  return {
    limit: clamp(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
    budgetMs: clamp(query.budget, DEFAULT_BUDGET_MS, 500, MAX_BUDGET_MS),
    concurrency: clamp(query.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
  }
}

/**
 * 取出到期的列。
 *
 * `tmdb_refresh_due` 是 `security_invoker` view 且只 grant 給 service_role，
 * 所以這裡拿到 0 列有兩種完全不同的意思：真的沒到期，或是**client 不是
 * service_role**。後者才是危險的那個——它不會報錯。因此 `due` 一併回報，
 * 呼叫者看到 `due: 0` 時可以自己去 SQL 對一次。
 */
async function claimDue(db: SupabaseClient<Database>, limit: number): Promise<{ rows: DueRow[], due: number }> {
  const { data, error, count } = await db
    .from('tmdb_refresh_due')
    .select('film_id,tmdb_id,attempts', { count: 'exact' })
    // view 內已有 order by，這裡明寫一次是因為 PostgREST 會把 view 包進子查詢，
    // 不保證外層順序。最舊到期的先刷。
    .order('expires_at', { ascending: true, nullsFirst: true })
    .limit(limit)

  if (error)
    throw createError({ statusCode: 500, statusMessage: `讀取 tmdb_refresh_due 失敗：${error.message}` })

  const rows: DueRow[] = []
  for (const row of data ?? []) {
    // view 的欄位型別全是 nullable（PostgREST 對 view 一律如此），實際上
    // film_id / tmdb_id 在來源表是 not null。這裡只是把型別收窄。
    if (row.film_id && typeof row.tmdb_id === 'number')
      rows.push({ film_id: row.film_id, tmdb_id: row.tmdb_id, attempts: row.attempts ?? 0 })
  }

  return { rows, due: count ?? rows.length }
}

export async function runTmdbRefresh(options: TmdbRefreshOptions = {}): Promise<TmdbRefreshReport> {
  const startedAt = Date.now()
  const limit = options.limit ?? DEFAULT_LIMIT
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY

  const apiKey = useRuntimeConfig().tmdbApiKey
  if (!apiKey)
    throw createError({ statusCode: 503, statusMessage: '未設定 NUXT_TMDB_API_KEY' })

  const db = serviceSupabase()
  const { rows, due } = await claimDue(db, limit)

  const tmdb = new TmdbClient({ apiKey, concurrency })
  const report: TmdbRefreshReport = {
    due,
    claimed: rows.length,
    fresh: 0,
    gone: 0,
    failed: 0,
    untouched: 0,
    applied: 0,
    tmdb: tmdb.stats,
    elapsedMs: 0,
    abortedBy: null,
    errors: [],
  }

  const noteError = (message: string) => {
    if (report.errors.length < 5)
      report.errors.push(message)
  }

  let cursor = 0

  /** 該不該再取一件工作。回傳 false 代表收工。 */
  const canContinue = (): boolean => {
    if (report.abortedBy)
      return false
    if (tmdb.stats.throttled >= THROTTLE_ABORT_AT) {
      report.abortedBy = 'throttle'
      return false
    }
    if (Date.now() - startedAt >= budgetMs) {
      report.abortedBy = 'budget'
      return false
    }
    return true
  }

  const refreshOne = async (row: DueRow): Promise<void> => {
    let detail: TmdbDetailForSnapshot
    try {
      detail = await tmdb.detail(row.tmdb_id) as TmdbDetailForSnapshot
    }
    catch (cause) {
      const status = cause instanceof TmdbError ? cause.status : undefined
      const message = cause instanceof Error ? cause.message : String(cause)

      // 決策抽在 tmdb-snapshot.ts，這樣 429 / 5xx / 網路中斷 / 404 四種收尾
      // 能被單元測試釘住——TMDB 不會配合我們回 429。
      const outcome = outcomeForError(status, row.attempts, message)

      if (outcome.kind === 'fatal') {
        // 設定層的錯。不寫任何狀態回去，讓佇列保持原樣。
        report.abortedBy = 'fatal'
        noteError(`tmdb ${row.tmdb_id}：${message}（設定錯誤，整批中止）`)
        return
      }

      if (outcome.kind === 'gone')
        report.gone++
      else
        report.failed++

      const { error } = await db.from('film_tmdb_snapshot').update(outcome.patch).eq('film_id', row.film_id)
      if (error)
        noteError(`tmdb ${row.tmdb_id} 寫回失敗狀態時出錯：${error.message}`)
      else
        noteError(`tmdb ${row.tmdb_id}：${message}`)
      return
    }

    const snapshot = snapshotFromDetail(detail)
    const { error: writeError } = await db
      .from('film_tmdb_snapshot')
      .update({ ...snapshot, payload: snapshot.payload as Json })
      .eq('film_id', row.film_id)

    if (writeError) {
      report.failed++
      const patch = failurePatch(row.attempts, `寫回快照失敗：${writeError.message}`)
      await db.from('film_tmdb_snapshot').update(patch).eq('film_id', row.film_id)
      noteError(`film ${row.film_id} 寫回快照失敗：${writeError.message}`)
      return
    }

    report.fresh++

    // 套用回 film 本體。★ 只覆寫 title_zh_source='tmdb' 的欄位——政府核准的
    //   中文片名由函式本身的 CASE 擋住，不是靠這裡少傳一個欄位。
    const { error: applyError } = await db.rpc('apply_tmdb_snapshot', { p_film_id: row.film_id })
    if (applyError)
      noteError(`film ${row.film_id} apply_tmdb_snapshot 失敗：${applyError.message}`)
    else
      report.applied++
  }

  const worker = async (): Promise<void> => {
    // ★ 先判斷「還有工作嗎」再判斷「還能繼續嗎」。順序顛倒的話，最後一輪
    //   剛好超過時間預算就會回報 abortedBy='budget' 而 untouched=0，
    //   看起來像被砍掉其實是正常收尾——那種假警報會讓人去調錯的旋鈕。
    while (cursor < rows.length && canContinue()) {
      const row = rows[cursor++]
      if (!row)
        return
      await refreshOne(row)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()))

  // 收工時 cursor 可能已經超前（每個 worker 各取了一件才發現要停），
  // 所以未處理數以「總數 − 三種結果之和」回算，不用 cursor。
  report.untouched = rows.length - report.fresh - report.gone - report.failed
  report.elapsedMs = Date.now() - startedAt
  return report
}
