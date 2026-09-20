import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * US-47 帳號刪除（隱私權政策 §5「你隨時可以刪除帳號與所有資料」的實作）。
 * ★ 授權不在這個檔案裡，在 `delete_my_account()` 的 `auth.uid()` 上：那支 RPC 不收任何
 *   參數 ⇒ 結構上不可能被指向別人，比 TS 的 `if (user.id === target)` 硬（後者一定會有
 *   第二個呼叫端忘記寫）。全程用呼叫者自己的 client，完全不碰 service role。
 */
// ★ 順序刻意：**先清 bucket 再刪資料庫**。刪海報要走 `ugc_poster_delete`，而它的判準是
//   「film 存在且 created_by 是我」⇒ RPC 一跑完，作者就再也刪不掉自己的海報，檔案永遠
//   留在 bucket 裡而使用者被告知「都刪掉了」。失敗方向必須指向「還沒破壞任何東西」。
// ★ 「哪些作品要刪」只有一份判準（`account_purgeable_films`，由 preview RPC 回來），
//   這裡不重寫——重寫就是兩份，漂移的樣子是海報留在 bucket 裡而沒人記得它屬於誰。

const bodySchema = z.object({
  /**
   * 二次確認，必須等於自己現在的 username。0009 拿掉兩階段刪除後，誤刪的緩衝由這裡
   * 負責——它是**同步的**，不依賴一個「三十天後真的會有東西去執行」的排程。
   */
  confirm: z.string().min(1),
})

interface DoomedFilm { id: string, poster_path: string | null }

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  const parsed = bodySchema.safeParse((await readBody(event)) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '需要 confirm 欄位（填入你自己的使用者名稱）' })

  const db = await serverSupabaseClient(event)

  // ── ① 預覽。同時是「這個帳號存在嗎」的檢查與二次確認的比對基準 ──────────
  const { data: previewRaw, error: previewError } = await db.rpc('account_deletion_preview')
  if (previewError) {
    if (previewError.code === '42501')
      throw createError({ statusCode: 401, statusMessage: '請先登入' })
    throw createError({ statusCode: 500, statusMessage: `無法取得刪除預覽：${previewError.message}` })
  }

  const preview = previewRaw as unknown as {
    username: string
    records: number
    films_to_delete: DoomedFilm[]
    films_to_keep: number
    usernames_to_reserve: number
    strikes_retained: number
    counter_notices_retained: number
  } | null

  if (!preview?.username)
    throw createError({ statusCode: 404, statusMessage: '找不到這個帳號' })

  // 大小寫不敏感：username 在 DB 裡一律小寫（profile_username_shape），
  // 但使用者在手機上打字第一個字母常被自動大寫。
  if (parsed.data.confirm.trim().toLowerCase() !== preview.username)
    throw createError({ statusCode: 422, statusMessage: '確認字串與你的使用者名稱不符' })

  // ── ② 先清 bucket。清不乾淨就中止，資料庫一列都不動 ────────────────────
  const doomed = preview.films_to_delete ?? []
  let postersRemoved = 0

  for (const film of doomed) {
    // 路徑約定是 <film_id>/<random>.<ext>（0001 §14）⇒ 列 film id 前綴就是全部海報。
    // ⚠️ 不要改用 `film.ugc_poster_path`：實測它**經常是 null 但檔案確實存在**，
    //    用一個會說謊的欄位當刪除依據，漏掉的檔案不會有任何人發現。
    const { data: objects, error: listError } = await db.storage
      .from('ugc-poster')
      .list(film.id, { limit: 100 })

    if (listError) {
      throw createError({
        statusCode: 500,
        statusMessage: `無法列出作品 ${film.id} 的海報，已中止（尚未刪除任何資料）：${listError.message}`,
      })
    }

    // 資料夾與 Supabase 的空資料夾佔位符的 id 是 null，不是真的檔案。
    const paths = (objects ?? [])
      .filter(o => o.id !== null)
      .map(o => `${film.id}/${o.name}`)
    if (!paths.length)
      continue

    const { data: removed, error: removeError } = await db.storage.from('ugc-poster').remove(paths)
    if (removeError) {
      throw createError({
        statusCode: 500,
        statusMessage: `無法移除作品 ${film.id} 的海報，已中止（尚未刪除任何資料）：${removeError.message}`,
      })
    }

    // ★ remove() 對被 policy 擋下的路徑不回錯誤，只是回傳的陣列比較短 ⇒ 不比對數量
    //   就會安靜放過沒刪掉的檔案，然後往下把 film 刪掉，之後再也沒有人能刪它。
    if ((removed?.length ?? 0) !== paths.length) {
      throw createError({
        statusCode: 500,
        statusMessage: `作品 ${film.id} 的海報只移除了 ${removed?.length ?? 0}/${paths.length} 個，已中止（尚未刪除任何資料）`,
      })
    }
    postersRemoved += paths.length
  }

  // ── ③ 真的刪。單一交易，要嘛全成功要嘛什麼都沒發生 ─────────────────────
  const { data: summaryRaw, error: deleteError } = await db.rpc('delete_my_account')
  if (deleteError) {
    if (deleteError.code === '42501')
      throw createError({ statusCode: 401, statusMessage: '請先登入' })
    throw createError({ statusCode: 500, statusMessage: `刪除失敗：${deleteError.message}` })
  }

  const summary = summaryRaw as unknown as Record<string, unknown>

  // ★ 唯一的稽核痕跡：刪完之後資料庫不會留下任何「這個人存在過」的紀錄（那正是重點），
  //   所以只剩這一行 log 能證明刪除發生過。刻意只記 username 與筆數，不記 email。
  // eslint-disable-next-line no-console
  console.log('[account/delete]', JSON.stringify({
    username: preview.username,
    ...summary,
    postersRemoved,
    strikesRetained: preview.strikes_retained,
    counterNoticesRetained: preview.counter_notices_retained,
  }))

  // ── ④ 清掉登入 cookie ───────────────────────────────────────────────────
  // 不呼叫 `db.auth.signOut()`：那會打 GoTrue 的 /logout，而那個 user 已經不存在 ⇒
  // 回來一個沒有意義的 403，還會蓋掉上面真正的結果。JWT 等它自己過期即可——它指向的
  // uuid 已經沒有 profile，任何 RLS 都不會放行。
  for (const name of Object.keys(parseCookies(event))) {
    if (name.startsWith('sb-'))
      deleteCookie(event, name, { path: '/' })
  }

  return {
    ok: true,
    deleted: {
      username: preview.username,
      records: summary.records_deleted ?? 0,
      films: summary.films_deleted ?? 0,
      posters: postersRemoved,
      usernamesReserved: summary.usernames_reserved ?? 0,
    },
    // 使用者有權知道「刪除」之後還留下什麼，以及為什麼。
    retained: {
      // 已核准的自建作品留在公共片庫，但不再指向任何人
      filmsAnonymised: summary.films_kept_anonymised ?? 0,
      // 著作權法第六章之一要求的處理紀錄，profile_id 已切斷
      copyrightRecords: (preview.strikes_retained ?? 0) + (preview.counter_notices_retained ?? 0),
    },
  }
})
