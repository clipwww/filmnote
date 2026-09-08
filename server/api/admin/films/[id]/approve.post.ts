import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * UGC 作品的審核（Step 7）。BUILD_PLAN 說這是「提案 1 沒做完、承認會 404 的那一步」。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 這裡**沒有搬檔案**，而 BUILD_PLAN §5 Step 7 第 2 點說要搬。那份散文描述的是
 *   提案 1 的雙 bucket 設計（`ugc-poster-pending` → `ugc-poster`），而 0001 §14
 *   已經改成**單一 private bucket + RLS 讀取把關**，理由寫在那裡：
 *   `public = true` 會讓 storage.objects 的列舉權限把未審核海報全網公開。
 *
 *   實測（2026-09-06）`storage.buckets` 只有 `ugc-poster` 一個，`ugc-poster-pending`
 *   只存在於 `docs/research/design/schema-evolution-first.md`（＝提案 1）。
 *
 *   單 bucket 設計下，審核**不需要任何 storage 操作**：`ugc_poster_read` policy
 *   的判準就是那部作品是否 `visibility='public' and review_state='approved'
 *   and moderation_state='visible'`，所以 `approve_film()` 一改狀態，海報就同時
 *   從「只有作者與 staff 讀得到」變成「所有人讀得到」。
 *
 *   這比搬檔好，而且不只是省事：搬檔是「複製 → 刪除」兩步，中間失敗會留下
 *   兩份或零份，而且失敗的那一半沒有任何東西會記得。改狀態則是單一 UPDATE，
 *   要嘛成功要嘛沒發生。**駁回**也因此是真的可逆——不必再把檔案搬回去。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 授權不靠這個檔案，靠 `approve_film()` 裡的 `is_staff()`。
 *   踩雷 #26：`serverSupabaseServiceRole` **不做任何身分檢查**。用 service role
 *   直接改 film 等於把「誰可以審核」這個判斷從資料庫搬到這裡重寫一次，而兩份
 *   判斷一定會漂移。所以這支從頭到尾用**呼叫者自己的** client。
 */

const bodySchema = z.object({
  // 預設為通過。駁回要顯式傳 false，避免手滑把「按錯」變成「靜默駁回」。
  approve: z.boolean().default(true),
  /**
   * 審核意見。**駁回時必填**（0011）。
   *
   * 這裡不做「駁回一定要有 note」的檢查——`approve_film()` 會擋（23514）。
   * 兩邊各寫一份判斷就會漂移，而漂移的樣子是「某一條路徑上可以無理由駁回」。
   * 這裡只負責把 4xx 翻譯成人看得懂的話。
   */
  note: z.string().trim().max(500).optional(),
})

export default defineEventHandler(async (event) => {
  const filmId = getRouterParam(event, 'id')
  if (!filmId || !z.uuid().safeParse(filmId).success)
    throw createError({ statusCode: 400, statusMessage: '作品 id 格式不正確' })

  const user = await serverSupabaseUser(event)
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  const parsed = bodySchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: 'approve 必須是布林值' })

  const db = await serverSupabaseClient(event)

  // 先確認看得到。非 staff 讀不到別人的私密 UGC 作品（film_read policy），
  // 於是這裡就是 404 —— 不區分「不存在」與「不是你能看的」，否則這支端點
  // 會變成私密作品 id 的探測器。
  const { data: before, error: readError } = await db
    .from('film')
    .select('id,title_zh,origin,visibility,review_state,ugc_poster_path')
    .eq('id', filmId)
    .maybeSingle()

  if (readError)
    throw createError({ statusCode: 500, statusMessage: readError.message })
  if (!before)
    throw createError({ statusCode: 404, statusMessage: '找不到這部作品' })

  const { error: rpcError } = await db.rpc('approve_film', {
    p_film: filmId,
    p_approve: parsed.data.approve,
    // 送空字串而不是省略：`scripts/gen-types.ts` 把**有預設值的參數也標成必填**
    // （`p_approve` 也是），所以 TS 這邊必須給值。空字串與 null 在
    // `approve_film()` 裡等價——`coalesce(btrim(p_note),'') = ''` 兩者都擋，
    // 核准時則一律把 review_note 清成 null。
    p_note: parsed.data.note ?? '',
  })

  if (rpcError) {
    // 42501 是 approve_film 內 is_staff() 擋下的。回 403 而不是 500——
    // 那不是伺服器壞了，是呼叫者沒有權限。
    if (rpcError.code === '42501')
      throw createError({ statusCode: 403, statusMessage: '需要審核權限' })
    // 23514 是「駁回沒填理由」。那是呼叫端的問題，不是伺服器壞了——
    // 回 500 的話 UI 只會顯示「伺服器錯誤」，審核者不知道自己少填了什麼。
    if (rpcError.code === '23514')
      throw createError({ statusCode: 422, statusMessage: '駁回必須填寫理由（作者要知道怎麼改）' })
    throw createError({ statusCode: 500, statusMessage: `審核失敗：${rpcError.message}` })
  }

  const { data: after, error: afterError } = await db
    .from('film')
    .select('id,slug,title_zh,visibility,review_state,review_note,ugc_poster_path')
    .eq('id', filmId)
    .maybeSingle()

  if (afterError || !after)
    throw createError({ statusCode: 500, statusMessage: '審核已套用，但讀回結果失敗' })

  // eslint-disable-next-line no-console
  console.log('[admin/films/approve]', JSON.stringify({
    filmId,
    approve: parsed.data.approve,
    by: user.sub, // 踩雷 #13：v2 回的是 JWT claims，只有 sub；user.id 型別合法但執行期是 undefined
    hasNote: !!parsed.data.note,
    from: `${before.visibility}/${before.review_state}`,
    to: `${after.visibility}/${after.review_state}`,
  }))

  // 海報的可見性是 approve 的**副作用**，不是另一個步驟：`ugc_poster_read`
  // policy 直接看作品的 visibility / review_state。這裡刻意不回一個
  // 「posterNowPublic」之類的布林值——實測發現 `film.ugc_poster_path` 由上傳流程
  // 負責寫入，端點讀到 null 時那個布林值會是 false，而海報其實已經公開可讀了。
  // 一個會說謊的欄位比沒有欄位更糟。呼叫端要判斷就看 film.ugc_poster_path。
  return { ok: true, film: after }
})
