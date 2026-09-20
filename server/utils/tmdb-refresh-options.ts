/**
 * TMDB 刷新的參數解析與上下限。自成一檔的唯一理由：**被測試 import 的模組必須自足**
 * （不吃 Nitro auto-import、不用 `~/` 別名），否則 `typecheck:pipeline` 噴一串
 * `TS2304: Cannot find name 'createError'` 而 `typecheck:app` 是綠的——兩者看到的世界不同。
 */
// 要測某支檔裡的純函式就把它搬進自足模組，不要放寬 tsconfig（放寬後那兩個
// typecheck 就再也擋不住真正的錯）。對 `./tmdb-refresh` 只有 import type，不構成循環相依。

export interface TmdbRefreshOptions {
  limit?: number
  budgetMs?: number
  concurrency?: number
}

/** 每次呼叫的預設處理上限。穩態需求是 2,400 列 / 150 天 ≈ 16 列/天。 */
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

/**
 * 預設時間預算。以時間收尾而不是以筆數收尾：函式跑到一半被 Vercel 砍會留下一批
 * attempts 沒加、next_refresh_at 沒推的列。超過預算就不取新工作，剩的下一輪再做。
 */
export const DEFAULT_BUDGET_MS = 8_000
export const MAX_BUDGET_MS = 30 * 60_000

/** TmdbClient 的預設併發。⚠️ 8 併發的節流行為只在 Step 9 驗過那一次。 */
export const DEFAULT_CONCURRENCY = 8
export const MAX_CONCURRENCY = 16

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
