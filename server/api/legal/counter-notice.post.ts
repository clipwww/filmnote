import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 回復通知（著作權法 §90-9）。被取下者主張未侵權時提出；轉送著作權人後，對方 10 個
 * 工作日內未提訴訟證明就須於 14 個工作日內回復。兩個期限由 0001 的
 * `counter_notice_deadlines` trigger 算，各處不會漂移。
 */
// ★ 用呼叫者自己的 client 而不是 service_role：「誰可以對哪一件通知提回復」已經寫在
//   RLS 裡（`takedown_affected_user` + `counter_insert` 的 profile_id = auth.uid()），
//   改用 service_role 等於把那道判斷搬來這裡重寫一次然後漂移。
// ★ 這支需要 session cookie，而 middleware 會對 `/legal/` 底下拔掉 cookie（比對路徑
//   開頭，不動 `/api/legal/`）⇒ 搬過去會讓每個請求都變成未登入，而且只會是 401。

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
   * ⚠️ 踩雷 #13：`serverSupabaseUser()` 回的是 JWT claims，只有 `sub` 沒有 `id`，而
   * `user.id` 在型別上完全合法 ⇒ typecheck 不會說話、執行期才是 undefined。這一支曾
   * 因此整條壞掉而沒人發現（2026-09-08 抓到，§90-9 的回復通知那段期間完全提不出來）。
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

  // 讀得到就代表 RLS 認定呼叫者是當事人；讀不到一律 404，不區分「不存在」與「不是
  // 你的」，否則這支端點會變成通知編號的探測器。
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
    // subject_ref 有 trigger 會自動補，這裡仍顯式帶上：它是 NOT NULL ⇒ 忘記帶是編譯
    // 錯誤，而不是等到某人刪帳號、三振紀錄的鏈斷掉才發現。trigger 是 SQL 寫入端的後盾。
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
