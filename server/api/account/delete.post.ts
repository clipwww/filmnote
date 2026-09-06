import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * US-47 帳號刪除。
 *
 * 隱私權政策 §5 寫著「你隨時可以刪除帳號與所有資料」。在 0009 之前那句話是
 * 做不到的承諾——沒有函式、沒有端點，只有一個從來沒有任何東西寫過的
 * `profile_private.deletion_requested_at`。這支端點是那句話的實作。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 授權不在這個檔案裡，在 `delete_my_account()` 的 `auth.uid()` 上。
 *   那支 RPC **不收任何參數**，所以它在結構上不可能被指向別人——這比任何
 *   TypeScript 的 `if (user.id === target)` 都硬，因為後者一定會有第二個呼叫端
 *   忘記寫（踩雷 #26 的同一個家族）。
 *   這裡從頭到尾用**呼叫者自己的** client，完全不碰 service role。
 *
 * ★ 順序是刻意的：**先清 bucket，再刪資料庫**。
 *   移除海報要走 `ugc_poster_delete` policy，而那條 policy 的判準是
 *   「film 那一列存在，且 created_by 是我」。一旦 RPC 跑完，film 沒了、
 *   created_by 也沒了，作者就再也刪不掉自己的海報——檔案會永遠留在 bucket 裡，
 *   而使用者被告知「所有資料都刪掉了」。
 *   所以失敗的方向必須指向「還沒破壞任何東西」：bucket 清不乾淨就整支中止，
 *   使用者可以重試，資料庫一列都沒動。
 *
 * ★ 「哪些作品要刪」只有一份判準（`account_purgeable_films`），由 preview RPC
 *   回給這裡。這裡**不重寫那組條件**——重寫就是兩份，兩份就會漂移，
 *   而漂移的樣子是「海報留在 bucket 裡，沒有人記得它屬於誰」。
 */

const bodySchema = z.object({
  /**
   * 二次確認。必須等於自己現在的 username。
   *
   * 0009 拿掉了兩階段刪除的殘骸（`deletion_requested_at`），誤刪的緩衝改由這裡
   * 負責。它比緩衝期好的地方是它是**同步的**：使用者當下就知道自己在做什麼，
   * 不必依賴一個「三十天後真的會有東西去執行」的排程——那個排程在這個專案裡
   * 從未真的觸發過。
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
    // 路徑約定是 <film_id>/<random>.<ext>（0001 §14），所以列 film id 這個前綴
    // 就是這部作品的全部海報。不要改用 `film.ugc_poster_path`——實測那個欄位
    // 由上傳流程負責寫入，而它**經常是 null 但檔案確實存在**（交接筆記第 5 節）。
    // 用一個會說謊的欄位當刪除依據，漏掉的檔案不會有任何人發現。
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

    // ★ remove() 對「policy 擋下來」的路徑不會回錯誤，只是回傳的陣列比較短。
    //   不比對數量的話，這裡會安靜地放過沒刪掉的檔案，然後往下把 film 刪掉
    //   ——那之後就再也沒有人能刪它了。
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

  // ★ 這一行是這支端點唯一的稽核痕跡。帳號刪除之後，資料庫裡不會留下任何
  //   「這個人存在過」的紀錄（那正是重點），所以「刪除這件事發生過」只剩下
  //   Vercel 的 log。刻意只記 username 與筆數，不記 email。
  // 帳號刪除後資料庫裡不會留下任何「這個人存在過」的痕跡（那正是重點），
  // 這一行是唯一能證明刪除發生過的東西。它不是 warn 也不是 error，
  // 降級成那兩者只會讓它混進真正的問題裡。
  // eslint-disable-next-line no-console
  console.log('[account/delete]', JSON.stringify({
    username: preview.username,
    ...summary,
    postersRemoved,
    strikesRetained: preview.strikes_retained,
    counterNoticesRetained: preview.counter_notices_retained,
  }))

  // ── ④ 清掉登入 cookie ───────────────────────────────────────────────────
  // 不呼叫 `db.auth.signOut()`：那會打 GoTrue 的 /logout，而那個 user 已經不存在，
  // 回來的是一個沒有意義的 403，還會蓋掉上面真正的結果。
  // access token 是 JWT，本來就要等它自己過期；但它指向的 uuid 已經沒有 profile，
  // 所以任何 RLS 判斷都不會放行（policy 全部走 profile / account_is_servable）。
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
