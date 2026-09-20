import { parseRefreshOptions } from './tmdb-refresh-options'

/**
 * 手動觸發（`/api/admin/tmdb/refresh`）的參數夾。
 * ★ 獨立成純函式而不是端點裡一行 `Math.min`：寫在端點裡時 vitest 載不進去，
 *   把夾子刪掉 14 條測試照樣全綠（2026-09-08 對抗式覆核）。搬來這裡才弄壞會紅。
 */

/**
 * 一次手動觸發最多花多久。取「最壞假設下也活得下來」的值：真正的上限是 Vercel 的
 * Default Max Duration（不在版控裡，300 秒是**啟用 fluid compute 後**的數字，舊專案
 * 可能只有 10 秒）。⚠️ 要調高先去 Settings → Functions 確認，不要照文件改。
 */
// 被砍的症狀：回來的是 Vercel 錯誤頁不是我們的 JSON，畫面只剩一句沒頭沒尾的
// `[POST] "/api/admin/tmdb/refresh": <status>`，DB 那側留下 attempts 沒加的列。
export const MANUAL_MAX_BUDGET_MS = 25_000

/**
 * 預設預算，跟 cron 的 8 秒一樣。偏小是刻意的且不影響可用性：以時間收尾而非筆數，
 * 沒做完的列 `next_refresh_at` 仍 ≤ now()，下一次按下去 view 會再給出來。
 */
export const MANUAL_DEFAULT_BUDGET_MS = 8_000

/** 一次最多取幾列。⚠️ 開大不會做得更多——做多少是**預算**決定的，多的只會變成 `untouched`。 */
export const MANUAL_DEFAULT_LIMIT = 100

export interface ManualRefreshInput {
  limit?: number | undefined
  budgetMs?: number | undefined
}

/** 把管理者送來的參數夾成手動觸發能安全承受的範圍。 */
export function clampManualOptions(raw: ManualRefreshInput) {
  const base = parseRefreshOptions({
    limit: raw.limit ?? MANUAL_DEFAULT_LIMIT,
    budget: raw.budgetMs ?? MANUAL_DEFAULT_BUDGET_MS,
  })

  return {
    limit: base.limit,
    budgetMs: Math.min(base.budgetMs, MANUAL_MAX_BUDGET_MS),
    concurrency: base.concurrency,
  }
}
