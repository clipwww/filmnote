/**
 * TMDB 刷新的參數解析與它的上下限。
 *
 * ── 為什麼自成一個檔（唯一的理由，但它是硬的）─────────────────────────
 * **它必須能被 vitest 載入。** `tmdb-refresh.ts` 用了 Nitro 的 auto-import
 * （`createError` / `useRuntimeConfig` / `serviceSupabase`），而
 * `tsconfig.pipeline.json` 的程式（`include: ["src", "tests", "scripts", …]`）
 * 不認識那些全域名字。測試檔一 import 它，`pnpm typecheck:pipeline` 就噴一串
 * `TS2304: Cannot find name 'createError'`——**而 `pnpm typecheck:app` 是綠的**，
 * 因為 nuxt 那一邊有 auto-import 的型別。兩個 typecheck 看到的世界不一樣，
 * 只跑其中一個會得到相反的結論。
 *
 * ⇒ 這是這個 repo 既有的慣例，不是新規定：被測試 import 的模組**必須自足**
 *   ——不吃 auto-import、不用 `~/` 別名。`og-card`、`og-cmap`、`mylog-csv`、
 *   `app/utils/*` 全都是這樣。要測某支檔裡的純函式，**把純函式搬進自足模組**，
 *   不要去放寬 tsconfig（放寬之後那兩個 typecheck 就再也擋不住真正的錯）。
 *
 * ⚠️ 這裡對 `./tmdb-refresh` 只有 **`import type`**，執行期會被完全抹除，
 *   所以兩個檔互相參照不構成循環相依。
 */

export interface TmdbRefreshOptions {
  limit?: number
  budgetMs?: number
  concurrency?: number
}

/** 每次呼叫的預設處理上限。穩態需求是 2,400 列 / 150 天 ≈ 16 列/天。 */
export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000

/**
 * 預設時間預算。Vercel 的函式有執行時間上限（Hobby 方案曾是 10 秒），
 * 而「跑到一半被砍」會留下一批 attempts 沒加、next_refresh_at 沒推的列。
 * 所以以時間收尾而不是以筆數收尾：超過預算就停止取新工作，剩下的下一輪再做
 * （它們的 `next_refresh_at` 仍 ≤ now()，view 會再給出來）。
 */
export const DEFAULT_BUDGET_MS = 8_000
export const MAX_BUDGET_MS = 30 * 60_000

/** TmdbClient 的預設併發。8 併發的節流行為在 Step 9 之前從未被驗證過。 */
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
