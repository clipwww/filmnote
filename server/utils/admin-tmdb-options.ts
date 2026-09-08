import { parseRefreshOptions } from './tmdb-refresh-options'

/**
 * 手動觸發（`/api/admin/tmdb/refresh`）的參數夾。
 *
 * ★ 為什麼獨立成一支純函式，而不是在端點裡寫一行 `Math.min`：
 *   對抗式覆核（2026-09-08）指出原本那一行**沒有任何斷言守得到**——
 *   端點檔 import 了 `#supabase/server`，vitest 載不進來，所以測試只能改去測
 *   `parseRefreshOptions`，而那支的上限是 30 分鐘、跟這裡的夾子無關。
 *   把夾子刪掉，14 條測試照樣全綠。這正是這個 repo 反覆記載的
 *   「檢查機制本身失效」——斷言存在、名字也對，但它守的不是它宣稱要守的東西。
 *   搬到這裡之後，弄壞它會紅。
 */

/**
 * 一次手動觸發最多花多久。
 *
 * ⚠️ **這個數字取決於 Vercel 的函式執行時間上限，而那件事本 repo 查不到。**
 * 官方文件的 300 秒是**啟用 fluid compute 之後**的 Hobby 上限；沒啟用的舊專案
 * 預設低得多（10 秒）。專案有沒有啟用要到 Vercel 的
 * Settings → Functions → Default Max Duration 看，那不在版控裡。
 *
 * ⇒ 所以這裡取一個**在最壞假設下也活得下來**的值。函式被砍的症狀很難看：
 *   回來的是 Vercel 的錯誤頁而不是我們的 JSON，前端取不到 `data.statusMessage`，
 *   畫面只會出現一句沒頭沒尾的 `[POST] "/api/admin/tmdb/refresh": <status>`，
 *   而資料庫那側留下一批 `attempts` 沒加、`next_refresh_at` 沒推的列。
 *
 * ⚠️ 要調高之前**先確認 Default Max Duration**，不要只因為「文件寫 300 秒」就改。
 */
export const MANUAL_MAX_BUDGET_MS = 25_000

/**
 * 預設預算。跟 cron 的 8 秒一樣，理由同上（最壞假設）。
 *
 * 這個值偏小是**刻意**的，而且不影響可用性：`runTmdbRefresh` 以時間收尾而不是
 * 以筆數收尾，沒做完的列 `next_refresh_at` 仍 ≤ now()，下一次按下去會再被 view
 * 給出來。介面上講的是「這一輪推進到預算上限，可以再按一次」。
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
