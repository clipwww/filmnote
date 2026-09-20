import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 作品合併（Step 7）。★ 授權同 approve：靠 `merge_films()` 裡的
 * `is_service_context() or is_staff()`，不在這裡重寫也不用 service role（§7 #26）。
 * §1.1 記載這條曾以**一般登入使用者呼叫實測回 204**（合併成功）⇒ 驗收必須測已登入的
 * 一般使用者，不是只測匿名。
 */
// ⚠️ BUILD_PLAN §5 Step 7 第 4 點寫「viewing_record 一列不動」，**實作不是這樣而且實作
//    是對的**：所有公開讀取路徑都 join film_id 並要求 `merged_into_film_id is null`，
//    紀錄還指著敗方就會整批從公開頁消失。真正的不變量是「一筆紀錄都不會不見」，由
//    `film_merge_log.moved_records` 記錄並在驗收中斷言。

const bodySchema = z.object({
  loserId: z.uuid('敗方 id 格式不正確'),
  winnerId: z.uuid('勝方 id 格式不正確'),
  reason: z.string().trim().min(1, '請說明合併理由').max(500),
}).refine(v => v.loserId !== v.winnerId, {
  error: '不可合併至自身',
  path: ['loserId'],
})

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  const parsed = bodySchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: '合併參數不正確',
      data: { issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) },
    })
  }
  const { loserId, winnerId, reason } = parsed.data

  const db = await serverSupabaseClient(event)

  // 兩部都要看得到才動手。看不到就是 404（同 approve：不當 id 探測器）。
  const { data: films, error: readError } = await db
    .from('film')
    .select('id,title_zh,merged_into_film_id')
    .in('id', [loserId, winnerId])

  if (readError)
    throw createError({ statusCode: 500, statusMessage: readError.message })
  if (!films || films.length !== 2)
    throw createError({ statusCode: 404, statusMessage: '找不到其中一部作品' })

  const winner = films.find(f => f.id === winnerId)!
  if (winner.merged_into_film_id)
    throw createError({ statusCode: 409, statusMessage: '勝方本身已被合併，請改指向最終的那一部' })

  const { error: rpcError } = await db.rpc('merge_films', {
    p_loser: loserId,
    p_winner: winnerId,
    p_reason: reason,
  })

  if (rpcError) {
    if (rpcError.code === '42501')
      throw createError({ statusCode: 403, statusMessage: '需要審核權限' })
    throw createError({ statusCode: 500, statusMessage: `合併失敗：${rpcError.message}` })
  }

  // 回讀合併紀錄，讓呼叫端看到「搬了幾筆」而不是只有一個 ok。
  const { data: log } = await db
    .from('film_merge_log')
    .select('id,moved_records,created_at')
    .eq('loser_id', loserId)
    .eq('winner_id', winnerId)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  // 合併會搬動別人的紀錄，是少數不可逆的管理動作。權威的稽核軌跡在 film_merge_log，
  // 這一行是給函式日誌看的——出事時那裡最先看得到，查 DB 要另一套權限。
  // eslint-disable-next-line no-console -- 管理動作的稽核日誌，見上方說明
  console.log('[admin/films/merge]', JSON.stringify({
    loserId,
    winnerId,
    by: user.sub, // 踩雷 #13：v2 回的是 JWT claims，只有 sub；user.id 型別合法但執行期是 undefined
    movedRecords: log?.moved_records ?? null,
  }))

  return { ok: true, loserId, winnerId, movedRecords: log?.moved_records ?? null }
})
