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
 *   - 一天一次是 Hobby 方案的上限（每專案 2 條、最短一天一次），而穩態需求是
 *     2,400 列 / 150 天 ≈ 16 列/天，預設 `limit=100` 綽綽有餘。
 *   - `tmdb-purge` 排在 30 分鐘後，讓刷新先把該續期的列推遠，再清真正到期的。
 *
 * 手動觸發（本機）：
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
