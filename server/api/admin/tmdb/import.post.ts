import type { Database } from '~/types/database.types'
import { rowsToImport } from '#pipeline/tmdb/import-plan'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 後台「匯入新作品」的寫入。與 CLI `scripts/tmdb-import-new-releases.ts --apply` 同一套判斷，
 * 差異見 `server/utils/tmdb-import.ts` 的檔頭（沒有閘門 ①，改成讀回）。
 */
// ★ **不信瀏覽器送來的預覽**：這裡自己重跑一次 `planImport()`，瀏覽器的勾選（`only`）
//   只能從 ③ 裡再縮小範圍。
// 授權三步，順序不可調換：① 登入 → ② 使用者自己的 client 問 is_staff() → ③ 通過後
// 才動 service role（`executeImport()` 內部呼叫 `serviceSupabase()`）。

export default defineEventHandler(async (event) => {
  const staff = await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  const parsed = importBodySchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '來源格式不對：releases（pages 1–5）或 ids（1–20 個）' })

  assertWithinRateLimit(event, { windowMs: 60_000, max: 5, scope: 'admin-tmdb-import' })

  const plan = await planImport(await serverSupabaseClient<Database>(event), parsed.data.source)
  // 閘門 ②：會走 UPDATE 分支的一筆都不送（那條路會把年份寫成 9999）。
  if (plan.blocked.length) {
    throw createError({
      statusCode: 422,
      statusMessage: `${plan.blocked.length} 部已經有 tmdb identity，會走 UPDATE 分支，整批拒絕（例如 TMDB ${plan.blocked[0]!.id}）`,
    })
  }
  const rows = rowsToImport(plan, parsed.data.only)
  if (!rows.length)
    return { written: 0, readback: [], plan }

  const result = await executeImport(rows)

  // eslint-disable-next-line no-console -- 管理動作的稽核日誌
  console.log('[admin/tmdb/import]', JSON.stringify({
    by: staff.id,
    source: parsed.data.source,
    written: result.written,
    tmdbIds: rows.map(r => r.tmdbId),
    notOk: result.readback.filter(r => !r.ok).map(r => r.tmdbId),
  }))

  return { ...result, plan }
})
