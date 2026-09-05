/**
 * 到期 TMDB 快取的清除（六個月條款的**第二道**防線）。
 *
 * 第一道是讀取端：`film_public` 以 `expires_at > now()` 逐列把關，過期欄位
 * 直接變 NULL。所以即使這支從來沒跑過，也不會有逾期內容被送出去。
 *
 * 這支存在的理由是「不要在資料庫裡留著已無權保存的內容」——那是另一件事，
 * 與「不要送出去」不同。`purge_expired_tmdb_cache()` 會把過期列的內容欄位
 * 清空並退回 `pending`（原本是 `gone` 的保持 `gone`）。
 *
 * ★ 同樣必須是 GET（Vercel Cron 只發 GET）。
 */
export default defineEventHandler(async (event) => {
  assertCronCaller(event)

  const db = serviceSupabase()
  const { data, error } = await db.rpc('purge_expired_tmdb_cache')

  if (error)
    throw createError({ statusCode: 500, statusMessage: `purge_expired_tmdb_cache 失敗：${error.message}` })

  const report = { purged: data ?? 0 }
  console.log('[cron/tmdb-purge]', JSON.stringify(report))
  return report
})
