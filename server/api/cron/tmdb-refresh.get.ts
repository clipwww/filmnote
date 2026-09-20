/**
 * TMDB 快照刷新（`BUILD_PLAN §5 Step 9`）。
 * ★ 必須是 **GET**：Vercel Cron 一律以 GET 觸發，設成 POST 的失敗是靜默的
 *   （面板顯示已觸發，handler 從沒被呼叫）。★ 走 service_role ⇒ 輸出永遠不可快取。
 */
// 排程理由（`vercel.json` 不能寫註解）：`0 19 * * *` 是 UTC ⇒ 03:00 台北；一天一次是
// Hobby 的最短間隔，而穩態需求 2,400 列 / 150 天 ≈ 16 列/天，limit=100 綽綽有餘；
// tmdb-purge 排在 30 分鐘後，讓刷新先把該續期的列推遠再清真正到期的。
//
// ⚠️ Hobby 的實際限制是**間隔與精度**不是名額：每專案 100 條、一天一次、精度是該
//    小時內（±59 分）⇒ `0 19 * * *` 會落在 03:00–03:59 之間的任何一刻。cron 所有
//    方案都有（https://vercel.com/docs/cron-jobs/usage-and-pricing ，last_updated
//    2026-07-15，查證 2026-09-07）。
//
// 手動觸發給人用的入口是 `POST /api/admin/tmdb/refresh`（登入 + is_staff 守門）。
// 要直接打這一支：
//   curl -H "Authorization: Bearer $NUXT_CRON_SECRET" \
//     'http://localhost:3000/api/cron/tmdb-refresh?limit=200&budget=120000'
export default defineEventHandler(async (event) => {
  assertCronCaller(event)

  const options = parseRefreshOptions(getQuery(event) as Record<string, unknown>)
  const report = await runTmdbRefresh(options)

  // cron 的執行紀錄是這支唯一的觀測面，數字一定要進 log 而不只是回應 body。
  console.log('[cron/tmdb-refresh]', JSON.stringify(report))

  return report
})
