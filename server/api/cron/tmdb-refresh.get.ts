/**
 * TMDB 快照刷新（BUILD_PLAN §5 Step 9）。
 *
 * ★ 必須是 **GET**。Vercel Cron 一律以 GET 觸發，設成 POST 排程叫不動，
 *   而且那種失敗是靜默的：cron 面板顯示已觸發，handler 從沒被呼叫。
 *   （前任的交接筆記寫 `.post.ts`，BUILD_PLAN 寫 `.get.ts`；以 BUILD_PLAN 為準。）
 *
 * ★ 這支端點看得到全站資料（service_role），輸出永遠不可快取。
 *   `nuxt.config.ts` 的 routeRules 已對 `/api/**` 設 `cache-control: no-store`。
 *
 * 排程寫在 `vercel.json`（JSON 不能有註解，所以理由記在這裡）：
 *   - `0 19 * * *` — Vercel Cron 的時間一律是 **UTC**，19:00 UTC = 03:00 台北。
 *   - 一天一次是 **Hobby 方案的最短間隔**，而穩態需求是 2,400 列 / 150 天
 *     ≈ 16 列/天，預設 `limit=100` 綽綽有餘。
 *   - `tmdb-purge` 排在 30 分鐘後，讓刷新先把該續期的列推遠，再清真正到期的。
 *
 * ★ 這段註解原本寫「每專案 **2 條**」——**那是錯的**，而且錯得有後果：它會讓人
 *   以為排程的名額很稀有，於是把「再加一條排程」當成不可能的選項。查證後的
 *   官方數字（https://vercel.com/docs/cron-jobs/usage-and-pricing ，該頁
 *   last_updated 2026-07-15，我查證的日期 2026-09-07）：
 *
 *                  每專案條數   最短間隔       精度
 *       Hobby        100        一天一次      該小時內（±59 分）
 *       Pro / Ent    100        一分鐘一次    分鐘級
 *
 *   而且 "Cron jobs are included in **all plans**."——所以「免費方案不能用 cron」
 *   這個常見的誤解也不成立。名額不是限制，**間隔與精度**才是：`0 19 * * *` 實際
 *   會落在 03:00–03:59 台北時間之間的任何一刻。
 *
 * ── 手動觸發 ───────────────────────────────────────────────────────────────
 * 給人用的入口在**管理後台 `/admin`**（`POST /api/admin/tmdb/refresh`，以登入身分
 * ＋ `is_staff()` 守門，看得到目前積欠幾列）。那一條是**附加**的，這一支排程沒有
 * 被取代，`vercel.json` 也沒有動。
 *
 * 這一支自己要手動打的話（本機、或要模擬排程時）：
 *   curl -H "Authorization: Bearer $NUXT_CRON_SECRET" \
 *     'http://localhost:3000/api/cron/tmdb-refresh?limit=200&budget=120000'
 */
export default defineEventHandler(async (event) => {
  assertCronCaller(event)

  const options = parseRefreshOptions(getQuery(event) as Record<string, unknown>)
  const report = await runTmdbRefresh(options)

  // cron 的執行紀錄是這支唯一的觀測面，數字一定要進 log 而不只是回應 body。
  console.log('[cron/tmdb-refresh]', JSON.stringify(report))

  return report
})
