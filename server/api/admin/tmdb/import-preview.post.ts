import type { Database } from '~/types/database.types'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 後台「匯入新作品」的預覽：TMDB 的一批作品對著片庫分成 ①②③ 與 blocked，**不寫任何東西**。
 * 用 POST：它最多打 TMDB 十幾次，不該被連結或預抓。
 */
// 授權跟 `refresh.post.ts` 同一套：① 登入 → ② 使用者自己的 client 問 is_staff()。
// 這一支完全不碰 service role——讀片庫用的就是那個 staff client。

export default defineEventHandler(async (event) => {
  await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  const parsed = importSourceSchema.safeParse((await readBody(event).catch(() => ({})))?.source)
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '來源格式不對：releases（pages 1–5）／search（q）／ids（1–20 個）' })

  assertWithinRateLimit(event, { windowMs: 60_000, max: 20, scope: 'admin-tmdb-import-preview' })

  return planImport(await serverSupabaseClient<Database>(event), parsed.data)
})
