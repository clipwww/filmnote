import { z } from 'zod'

/**
 * 侵權通知的受理窗口（著作權法 §90-4 第 3、4 款、§90-6）。
 * ★ **未登入者必須能提交**：那是法定義務不是便利功能，著作權人不該為了通知我們而
 *   先註冊帳號 ⇒ 這支不驗身分。
 */
// ★ 這張表在 API 層是**單向**的：anon 有 INSERT grant、沒有 SELECT grant（實測 42501，
//   比 RLS 更早擋下）⇒ 用匿名 client 而不是 service_role，端點的權限不該大於法律要求
//   的那一點點。也因此 `.insert()` 後面**不能**接 `.select()`（拿不到 RETURNING 會整個
//   請求失敗），回應只回 `{ ok: true }`。
// ★ 路由在 `/api/legal/…` 而不是 `/legal/…`：middleware 會對後者拔掉 session cookie。
//   這支不需要身分，但隔壁的 counter-notice 需要——兩支放一起才不會有人搬過去然後對著
//   「登入了卻說沒登入」除錯半天。

const noticeSchema = z.object({
  // §90-6 及施行辦法要求的記載事項
  claimantName: z.string().trim().min(1, '請填寫姓名或名稱').max(100),
  claimantEmail: z.email('電子郵件格式不正確').max(200),
  claimantPhone: z.string().trim().max(50).optional().nullable(),
  workDescription: z.string().trim().min(10, '請說明受侵害的著作為何').max(2000),
  targetUrl: z.url('請填寫可指向侵權內容的完整網址').max(500),
  // 「聲明係基於善意」。未勾選就不是一份完整的通知。
  statementGoodFaith: z.literal(true, { error: '必須聲明本通知係基於善意所為' }),
})

/**
 * 從本站的 `/film/{slug}` 網址解析出作品。
 *
 * 解析不出來不是錯誤——通知可以指向任何頁面，甚至可能寫錯。解析得出來時
 * 先把 `target_film_id` 填好，人工處理時就不必再對一次網址。
 */
async function resolveTargetFilm(targetUrl: string): Promise<string | null> {
  const slug = (() => {
    try {
      const path = new URL(targetUrl).pathname
      return /^\/film\/([^/]+)\/?$/.exec(path)?.[1] ?? null
    }
    catch {
      return null
    }
  })()
  if (!slug)
    return null

  const { data } = await publicSupabase().rpc('resolve_film', { p_key: `slug:${decodeURIComponent(slug)}` })
  return data ?? null
}

export default defineEventHandler(async (event) => {
  // 全站唯一對匿名開放寫入的表，資料庫層完全沒有防護（§6.2）。
  // ⚠️ 上限 5→20（2026-09-07）：原因不是流量而是**備援消失了**——同日起 `/legal/copyright`
  //    不再公告電子郵件，這張表成為 §90-4 第 3 款唯一的受理窗口，觸發限流等於把唯一的
  //    法定窗口關掉一小時，而擋到的人是法務或權利人。濫用成本低於關閉它的成本。
  // ⚠️ 這個數字不精確，**不要寫進使用者看得到的文案**：限流是行程內記憶體、每個實例
  //    各一份 ⇒ 實際上限比 20 寬鬆，寫死在畫面上就是另一個做不到的承諾。
  assertWithinRateLimit(event, { scope: 'legal-notice', windowMs: 60 * 60_000, max: 20 })

  const parsed = noticeSchema.safeParse(await readBody(event))
  if (!parsed.success) {
    throw createError({
      statusCode: 422,
      statusMessage: '通知內容不完整',
      data: { issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) },
    })
  }

  const body = parsed.data
  const { error } = await publicSupabase()
    .from('takedown_notice')
    .insert({
      claimant_name: body.claimantName,
      claimant_email: body.claimantEmail,
      claimant_phone: body.claimantPhone ?? null,
      work_description: body.workDescription,
      target_url: body.targetUrl,
      target_film_id: await resolveTargetFilm(body.targetUrl),
      statement_good_faith: true,
      // status 交給 default 'received'：policy 的 with check 就是釘死這個值。
    })

  if (error)
    throw createError({ statusCode: 500, statusMessage: `受理失敗：${error.message}` })

  // 刻意不回傳 id：呼叫者讀不到這張表，給了 id 也沒有用途，只是多一個可枚舉的數字。
  return { ok: true }
})
