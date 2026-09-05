import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/database.types'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

let cached: SupabaseClient<Database> | null = null

/**
 * 「服務端視角」client（service_role）。**只有 cron / 排程路由能用。**
 *
 * RLS 對它完全讓開，而 `is_service_context()` 也認得它——`apply_tmdb_snapshot()`
 * 與 `purge_expired_tmdb_cache()` 兩支都用那個判斷擋門，所以刷新流程只能走這支。
 *
 * ★ 絕不可用在任何會把輸出回給瀏覽器的路由上。與 `publicSupabase()` 的分工是
 *   刻意的：那一支是「匿名視角、輸出與觀看者無關 ⇒ 可快取」，這一支是
 *   「看得到全部資料 ⇒ 輸出永遠不可外流、不可快取」。
 *
 * ★ 金鑰讀 `process.env.SUPABASE_SECRET_KEY` 而不是 `useRuntimeConfig()`：
 *   runtimeConfig 只會替**已宣告的鍵**接 `NUXT_` 前綴的環境變數，要走那條路
 *   得改 `nuxt.config.ts`（共用檔，需主 session 核可）並把變數改名成
 *   `NUXT_SUPABASE_SECRET_KEY`。`.env.example` 早已用 `SUPABASE_SECRET_KEY`
 *   這個名字，改名的代價大於收益。
 */
export function serviceSupabase(): SupabaseClient<Database> {
  if (cached)
    return cached

  const url = process.env.SUPABASE_URL || useRuntimeConfig().public.supabase?.url
  const key = process.env.SUPABASE_SECRET_KEY

  if (!url || !key) {
    // 缺金鑰不能退回匿名 client——那會靜默地什麼都刷不到（RLS 讓 view 回 0 列），
    // 而 cron 面板顯示「成功」。寧可 500。
    throw createError({
      statusCode: 503,
      statusMessage: '未設定 SUPABASE_URL / SUPABASE_SECRET_KEY，服務端 client 無法建立',
    })
  }

  cached = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-filmnote-view': 'service' } },
  })
  return cached
}
