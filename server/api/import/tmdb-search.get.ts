import type { TmdbSearchResult } from '#pipeline/types'
import process from 'node:process'
import { z } from 'zod'
import { assertImportOwnerFrom } from '~~/server/utils/import-auth'
import { TmdbClient } from '#pipeline/tmdb/client'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * 匯入流程的 TMDB 線上比對（`/app/import`）。必須是 server 端點：TMDB key 是
 * server-only，丟進 client bundle 等於公開它（條款把 key 綁在申請者身上）。
 * ★ **只讀不寫**：建作品仍走 `film` insert + `link_film_to_tmdb()`，那條路上有唯一鍵、
 *   policy 與 film_identity 的同步 trigger，在這裡順手建會繞過全部三樣。
 */
// ★ 回傳帶 `existing`：片庫已有同一個 tmdb_id 時 UI 要顯示「對應到這一部」，少了它
//   使用者會替已存在的片再建一部 UGC（§7 #81 那批孤兒的來源）。
// ⚠️ `film.tmdb_id` 是存在性 oracle（踩雷 #35）⇒ 只回「有沒有」與公開識別，不回內部
//    狀態，而且整支端點要求登入。

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  /** 年份只用來排序，不用來過濾——TMDB 的 release_date 與台灣上映年常常差一年。 */
  year: z.coerce.number().int().min(1880).max(2200).optional(),
})

const MAX_RESULTS = 8

export default defineEventHandler(async (event) => {
  // 未登入 401、登入但不是本人 403。與 `parse-csv` 共用同一支判斷
  // （抄兩份一定會漂移，而漂移的方向會是兩支端點對同一個人給出不同答案）。
  await assertImportOwnerFrom({
    user: () => serverSupabaseUser(event),
    allowedEmail: () => process.env.IMPORT_TARGET_EMAIL,
  })

  const parsed = querySchema.safeParse(getQuery(event))
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: '需要 q（1–120 字）' })

  // 配額綁在我們的 key 上 ⇒ 節流保護的是**我們自己**：匯入畫面手滑按「全部比對」
  // 就是幾十個請求。
  assertWithinRateLimit(event, { windowMs: 60_000, max: 30, scope: 'tmdb-search' })

  const apiKey = useRuntimeConfig().tmdbApiKey
  if (!apiKey) {
    // 沒有 key 回 503 不回空陣列：空陣列會被 UI 呈現成「TMDB 查無此片」，於是使用者
    // 建了一部其實 TMDB 有的 UGC 作品——會說謊的空結果比錯誤訊息貴得多。
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
        // 年份吻合的往前排，差一年也算：TMDB 記首映地上映日，台灣上映常跨到下一年
        // （實測 2,480 部裡並不罕見）。
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

  // 用呼叫者自己的 client：已核准的公開作品所有登入者本來就看得到，不多洩漏東西。
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
    // 空陣列代表確實查無此片而不是錯誤：上面所有失敗路徑都 throw 了。
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
