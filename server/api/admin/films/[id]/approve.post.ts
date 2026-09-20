import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * UGC 作品的審核（Step 7）。★ 授權靠 `approve_film()` 裡的 `is_staff()`，不靠這個檔案
 * （§7 #26：service role 不做任何身分檢查，用它改 film 等於把判斷重寫一次然後漂移）⇒
 * 全程用呼叫者自己的 client。
 */
// ★ 這裡**沒有搬檔案**（BUILD_PLAN §5 Step 7 第 2 點的雙 bucket 是提案 1 的設計；
//   0001 §14 已改成單一 private bucket + RLS 把關，實測 2026-09-06 只有 `ugc-poster`）。
//   單 bucket 下審核不需要任何 storage 操作：`ugc_poster_read` 直接看作品狀態 ⇒ 改狀態
//   是單一 UPDATE（要嘛成功要嘛沒發生），搬檔則是複製+刪除兩步、中間失敗留下兩份或
//   零份。駁回也因此真的可逆。

const bodySchema = z.object({
  // 預設為通過。駁回要顯式傳 false，避免手滑把「按錯」變成「靜默駁回」。
  approve: z.boolean().default(true),
  /**
   * 審核意見，**駁回時必填**（0011）。這裡不自己檢查——`approve_film()` 會擋（23514），
   * 兩邊各寫一份會漂移成「某一條路徑上可以無理由駁回」。這裡只負責翻譯錯誤碼。
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

  // 先確認看得到。非 staff 讀不到別人的私密 UGC 作品 ⇒ 這裡一律 404，不區分
  // 「不存在」與「不是你能看的」，否則這支端點會變成私密作品 id 的探測器。
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
    // 送空字串而不是省略：型別產生器把有預設值的參數也標成必填。空字串與 null 在
    // `approve_film()` 裡等價（`coalesce(btrim(p_note),'') = ''` 兩者都擋）。
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

  // 海報的可見性是 approve 的**副作用**不是另一個步驟。刻意不回「posterNowPublic」
  // 之類的布林：實測 `film.ugc_poster_path` 由上傳流程寫入，端點讀到 null 時那個布林
  // 會是 false，而海報其實已經公開可讀——一個會說謊的欄位比沒有欄位更糟。
  return { ok: true, film: after }
})
