import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 回復通知（著作權法 §90-9）。
 *
 * 被取下的使用者主張自己沒有侵權時提出。提出之後：
 *   - 服務提供者轉送給著作權人（填 `forwarded_at`）
 *   - 著作權人 **10 個工作日**內未提出訴訟證明 → 須於 **14 個工作日**內回復
 * 兩個期限由 0001 的 `counter_notice_deadlines` trigger 自動算，各處不會漂移。
 *
 * ★ 用**呼叫者自己的** client（`serverSupabaseClient`）而不是 service_role：
 *   「誰可以對哪一件通知提回復」這個判斷已經寫在 RLS 裡了
 *   （0006 的 `takedown_affected_user` 只讓被取下的當事人讀得到那一列，
 *    0001 的 `counter_insert` 要求 `profile_id = auth.uid()`）。
 *   端點若改用 service_role，等於把那道判斷從資料庫搬到這個檔案裡重寫一次，
 *   而兩份判斷一定會漂移。這裡讓資料庫當唯一的真相。
 *
 * ★ 這支需要 session cookie。`server/middleware/strip-auth-on-cacheable.ts`
 *   會對 `/legal/**` 拔掉 cookie，**但不會動 `/api/legal/**`**（它比對的是
 *   路徑開頭）。把這支搬到 `/legal/` 底下會讓每個請求都變成未登入，而且
 *   沒有任何錯誤訊息——只會是 401。
 */

const counterSchema = z.object({
  noticeId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(10, '請說明主張未侵權的理由').max(2000),
})

export default defineEventHandler(async (event) => {
  assertWithinRateLimit(event, { scope: 'legal-counter', windowMs: 60 * 60_000, max: 10 })

  const user = await serverSupabaseUser(event)
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  /**
   * ⚠️ 踩雷 #13：`@nuxtjs/supabase` v2 的 `serverSupabaseUser()` 回的是 **JWT claims**
   * （`JwtPayload`），只有 `sub`，**沒有 `id`**。而 `JwtPayload` 有索引簽章，所以
   * `user.id` 在型別上完全合法——`pnpm typecheck` 不會說話，執行期才是 `undefined`。
   *
   * 這一支曾經整條壞掉而沒有人發現（2026-09-08 對抗式覆核抓到）：`profile_id` 是
   * `undefined` 時，PostgREST 的查詢會變成 `profile_id=eq.undefined` 回 400
   * `invalid input syntax for type uuid`，於是查重那一步就 500；就算繞過查重，
   * `.insert()` 也會把值為 `undefined` 的鍵整個從 JSON body 省掉，撞上 NOT NULL。
   * ⇒ **§90-9 的回復通知在那段期間是完全提不出來的**，而那是避風港流程的一環。
   *
   * 取一次、命名清楚，讓下面兩個用到的地方不可能再各自寫錯。
   */
  const profileId = user.sub

  const parsed = counterSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: '回復通知內容不完整',
      data: { issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) },
    })
  }
  const { noticeId, reason } = parsed.data

  const db = await serverSupabaseClient(event)

  // 讀得到這一列，就代表 RLS 認定呼叫者是被取下的當事人。讀不到就是 404 ——
  // 刻意不區分「不存在」與「不是你的」，否則這支端點會變成通知編號的探測器。
  const { data: notice, error: readError } = await db
    .from('takedown_notice')
    .select('id,status')
    .eq('id', noticeId)
    .maybeSingle()

  if (readError)
    throw createError({ statusCode: 500, statusMessage: readError.message })
  if (!notice)
    throw createError({ statusCode: 404, statusMessage: '找不到這件通知' })

  const { data: existing, error: dupError } = await db
    .from('counter_notice')
    .select('id')
    .eq('notice_id', noticeId)
    .eq('profile_id', profileId)
    .maybeSingle()

  if (dupError)
    throw createError({ statusCode: 500, statusMessage: dupError.message })
  if (existing)
    throw createError({ statusCode: 409, statusMessage: '你已經對這件通知提出過回復通知' })

  // counter_self policy 讓當事人讀得到自己的列，所以這裡可以 .select() 把
  // trigger 算好的兩個期限直接回給前端顯示。
  const { data: created, error: insertError } = await db
    .from('counter_notice')
    // subject_ref 由 0009 的 fill_subject_ref trigger 自動補成 profile_id，
    // 這裡仍然顯式帶上：它是 NOT NULL，所以型別要求寫入端給值——
    // **那是刻意的**。忘記帶會變成編譯錯誤，而不是等到某人刪帳號、
    // 三振紀錄的鏈斷掉之後才發現。trigger 是給 SQL 層寫入端（admin_add_strike）
    // 的後盾，型別是給 TypeScript 寫入端的。
    .insert({ notice_id: noticeId, profile_id: profileId, subject_ref: profileId, reason })
    .select('id,received_at,litigation_deadline_at,restore_deadline_at')
    .single()

  if (insertError)
    throw createError({ statusCode: 500, statusMessage: `提交失敗：${insertError.message}` })

  return {
    ok: true,
    counterNoticeId: created.id,
    receivedAt: created.received_at,
    // §90-9 的兩個法定期限。前端應顯示出來，讓當事人知道接下來會發生什麼。
    litigationDeadlineAt: created.litigation_deadline_at,
    restoreDeadlineAt: created.restore_deadline_at,
  }
})
