import type { Database } from '~/types/database.types'
import { z } from 'zod'
import { linkPreconditions } from '#pipeline/tmdb/link-check'
import { tmdbKey } from '#pipeline/tmdb/seed-row'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 替片庫既有作品補 TMDB id（後台匯入預覽裡「疑似已存在」那一類的出口）。
 * 走 `link_film_to_tmdb()`，與 0017／0018 人工補 id 同一支函式。
 */
// ★ 函式本身遇到「id 已被別人持有」會**靜默合併**而不是報錯 ⇒ 前置檢查在
//   `src/tmdb/link-check.ts`，而且呼叫後再比一次回傳值：不等於 filmId 就是合併了。
// ★ 補 id **不碰 title_zh_source**：政府片仍然是 gov，cron 的 apply_tmdb_snapshot 也不會
//   蓋掉它的片名。讀回時一起確認。
// 授權三步，順序不可調換：① 登入 → ② 使用者自己的 client 問 is_staff() → ③ 通過後
// 才動 service role（`link_film_to_tmdb` 只授權給 service_role，9999_grants.sql:230）。

const bodySchema = z.object({
  filmId: z.string().uuid(),
  tmdbId: z.coerce.number().int().positive(),
})

export default defineEventHandler(async (event) => {
  const staff = await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  const parsed = bodySchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '需要 filmId（uuid）與 tmdbId（正整數）' })
  const { filmId, tmdbId } = parsed.data

  assertWithinRateLimit(event, { windowMs: 60_000, max: 10, scope: 'admin-tmdb-link' })

  const db = await serverSupabaseClient<Database>(event)
  const [{ data: target }, { data: holders }, { data: ident }] = await Promise.all([
    db.from('film').select('id,tmdb_id,merged_into_film_id,title_zh_source,origin,review_state').eq('id', filmId).maybeSingle(),
    // ⚠️ 不加 merged_into_film_id is null：link_film_to_tmdb 的查詢連死列都算。
    db.from('film').select('id,merged_into_film_id').eq('tmdb_id', tmdbId),
    db.from('film_identity').select('film_id').eq('key', tmdbKey(tmdbId)),
  ])
  const check = linkPreconditions(target, holders ?? [], (ident ?? []).some(r => r.film_id !== filmId))
  if (!check.ok)
    throw createError({ statusCode: check.status, statusMessage: check.reason })

  const { data: returned, error } = await serviceSupabase().rpc('link_film_to_tmdb', { p_film: filmId, p_tmdb: tmdbId })
  const audit = { by: staff.id, filmId, tmdbId, returned }
  // eslint-disable-next-line no-console -- 管理動作的稽核日誌
  console.log('[admin/tmdb/link]', JSON.stringify(audit))
  if (error)
    throw createError({ statusCode: 500, statusMessage: `link_film_to_tmdb 失敗：${error.message}` })
  if (returned !== filmId) {
    // 前置檢查應該已經擋掉這條路。走到這裡代表兩次查詢之間有人動了資料。
    throw createError({ statusCode: 500, statusMessage: `link_film_to_tmdb 把這部合併進了 ${returned}——前置檢查沒擋到，請回報` })
  }

  const [{ data: after }, { data: identAfter }] = await Promise.all([
    db.from('film').select('tmdb_id,origin,title_zh_source').eq('id', filmId).single(),
    db.from('film_identity').select('film_id').eq('key', tmdbKey(tmdbId)),
  ])
  return {
    filmId,
    tmdbId,
    after,
    ok: after?.tmdb_id === tmdbId
      && after?.title_zh_source === target!.title_zh_source
      && (identAfter ?? []).length === 1 && identAfter![0]!.film_id === filmId,
  }
})
