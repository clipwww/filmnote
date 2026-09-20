/**
 * 到期 TMDB 快取的清除（六個月條款的**第二道**防線；第一道是讀取端的
 * `expires_at > now()` 逐列把關 ⇒ 即使這支沒跑過也不會有逾期內容被送出去）。
 * 它做的是另一件事：不要在資料庫裡留著已無權保存的內容。★ 必須是 GET。
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
