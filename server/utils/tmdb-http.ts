import type { TmdbClientOptions } from '#pipeline/tmdb/client'
// 顯式 import：本檔要能被 vitest 直接載入（§7 #211），而 vitest 沒有 Nitro 的自動匯入。
import { createError } from 'h3'
import { TmdbClient } from '#pipeline/tmdb/client'

/**
 * 伺服器端點建 TmdbClient 與翻譯 TMDB 錯誤的唯一一處（之前 refresh／import／tmdb-search 各寫一份）。
 * key 由端點從 `useRuntimeConfig(event)` 取出傳進來：接線留在端點看得見，這裡測得到。
 */

/** 沒有 key 回 503。★ 不回空結果：空陣列會被 UI 呈現成「TMDB 查無此片」，使用者於是替 TMDB 有的片建 UGC。 */
export function tmdbClientFor(apiKey: string | undefined, options: Omit<TmdbClientOptions, 'apiKey'> = {}): TmdbClient {
  if (!apiKey)
    throw createError({ statusCode: 503, statusMessage: '未設定 NUXT_TMDB_API_KEY，TMDB 暫不可用' })
  return new TmdbClient({ ...options, apiKey })
}

/**
 * 端點 catch 到的錯誤翻成 HTTP。已經是 HTTP 錯誤（例如讀片庫失敗的 500）原樣放行，其餘一律 502：
 * 是上游壞了不是我們壞了。TmdbError 自帶的狀態碼只進訊息，不當成我們的回應碼。
 */
export function tmdbHttpError(cause: unknown): Error {
  if (cause instanceof Error && 'statusCode' in cause)
    return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  return createError({ statusCode: 502, statusMessage: `TMDB 查詢失敗：${message}` })
}
