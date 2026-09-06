import type { TmdbSearchResult } from '#pipeline/types'
import { z } from 'zod'
import { TmdbClient } from '#pipeline/tmdb/client'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 匯入流程的 TMDB 線上比對（`/app/import`）。
 *
 * ★ 為什麼一定要是 server 端點：`NUXT_TMDB_API_KEY` 是 server-only。
 *   瀏覽器打不到 TMDB，**也不該打得到**——把 key 丟進 client bundle 等於公開它，
 *   而 TMDB 的條款把 key 綁在申請者身上。
 *
 * ★ 這支**只讀不寫**。它不建作品、不寫 film_identity、不碰快照表。
 *   匯入 UI 拿到候選之後，實際建立仍走既有的 `film` insert 與
 *   `link_film_to_tmdb()`——那條路徑上有 tmdb_id 的唯一鍵、有 policy、有
 *   film_identity 的同步 trigger。在這裡順手建一部作品會繞過全部三樣。
 *
 * ★ 回傳值刻意帶上 `existing`：同一個 tmdb_id 在片庫裡已經有作品時，UI 要顯示的
 *   是「對應到這一部」而不是「建立新作品」。少了這個欄位，使用者會替已經存在的
 *   片再建一部 UGC，然後日後要人工合併——那正是 §7 #81 那批孤兒的來源。
 *   ⚠️ `film.tmdb_id` 有 UNIQUE 而且是存在性 oracle（踩雷 #35），所以這裡只回
 *   「片庫裡有沒有」與該作品的公開識別（slug/title），**不回 id 以外的內部狀態**，
 *   而且整支端點要求登入。
 */

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  /** 年份只用來排序，不用來過濾——TMDB 的 release_date 與台灣上映年常常差一年。 */
  year: z.coerce.number().int().min(1880).max(2200).optional(),
})

const MAX_RESULTS = 8

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '需要 q（1–120 字）' })

  // TMDB 的配額是綁在我們的 key 上的，所以節流保護的是**我們自己**，
  // 不是使用者。匯入畫面一次可能有幾十個未比對片名，手滑按「全部比對」
  // 就是幾十個請求。
  assertWithinRateLimit(event, { windowMs: 60_000, max: 30, scope: 'tmdb-search' })

  const apiKey = useRuntimeConfig().tmdbApiKey
  if (!apiKey) {
    // 沒有 key 時回 503 而不是空陣列。空陣列會被 UI 呈現成「TMDB 查無此片」，
    // 於是使用者去建了一部其實 TMDB 有的 UGC 作品——一個會說謊的空結果
    // 比一個錯誤訊息貴得多。
    throw createError({ statusCode: 503, statusMessage: '未設定 NUXT_TMDB_API_KEY，線上比對暫不可用' })
  }

  let results: TmdbSearchResult[]
  try {
    results = await new TmdbClient({ apiKey, concurrency: 1 }).search(parsed.data.q)
  }
  catch (cause) {
    // TmdbError 已含狀態碼；這裡統一翻成 502——是上游壞了，不是我們壞了。
    throw createError({
      statusCode: 502,
      statusMessage: `TMDB 查詢失敗：${cause instanceof Error ? cause.message : String(cause)}`,
    })
  }

  const year = parsed.data.year
  const ranked = [...results]
    .sort((a, b) => {
      if (year) {
        // 年份吻合的往前排。差一年也算吻合——TMDB 記的是首映地上映日，
        // 台灣上映常常跨到下一年（實測 2,480 部裡這種情況並不罕見）。
        const da = Math.abs(Number(a.release_date?.slice(0, 4)) - year)
        const db = Math.abs(Number(b.release_date?.slice(0, 4)) - year)
        const na = Number.isFinite(da) ? da : 99
        const nb = Number.isFinite(db) ? db : 99
        if (na !== nb)
          return na - nb
      }
      return (b.popularity ?? 0) - (a.popularity ?? 0)
    })
    .slice(0, MAX_RESULTS)

  // 片庫裡已經有哪幾個 tmdb_id。用呼叫者自己的 client（film_read policy），
  // 已核准的公開作品所有登入者都看得到，所以這裡不會多洩漏任何東西。
  const db = await serverSupabaseClient(event)
  const ids = ranked.map(r => r.id)
  const existingById = new Map<number, { id: string, slug: string | null, title_zh: string }>()
  if (ids.length) {
    const { data: films } = await db
      .from('film')
      .select('id,slug,title_zh,tmdb_id')
      .in('tmdb_id', ids)
      .is('merged_into_film_id', null)
    for (const f of films ?? []) {
      if (f.tmdb_id !== null)
        existingById.set(f.tmdb_id, { id: f.id, slug: f.slug, title_zh: f.title_zh })
    }
  }

  return {
    query: parsed.data.q,
    // 空陣列代表 TMDB 確實查無此片，不是錯誤（TmdbClient.search 的契約）。
    // 上面所有失敗路徑都 throw 了，所以這裡的 [] 是可以信的。
    results: ranked.map(r => ({
      tmdbId: r.id,
      title: r.title,
      originalTitle: r.original_title,
      releaseDate: r.release_date || null,
      posterPath: r.poster_path,
      existing: existingById.get(r.id) ?? null,
    })),
  }
})
