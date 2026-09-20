import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/database.types'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'

let cached: SupabaseClient<Database> | null = null

/**
 * service_role client。**只有 cron / 排程路由能用**，RLS 對它完全讓開，而
 * `apply_tmdb_snapshot()`／`purge_expired_tmdb_cache()` 認的是 `is_service_context()`
 * ⇒ 刷新流程只能走這支。★ 絕不可用在任何會把輸出回給瀏覽器的路由：那是
 * `publicSupabase()`（匿名視角、可快取）的工作，這支看得到全部資料 ⇒ 不可外流。
 */
// 金鑰走 process.env：改用 runtimeConfig 得改共用檔 nuxt.config.ts 並把名字改成
// NUXT_SUPABASE_SECRET_KEY，而 .env.example 早就用 SUPABASE_SECRET_KEY。
export function serviceSupabase(): SupabaseClient<Database> {
  if (cached)
    return cached

  const url = process.env.SUPABASE_URL || useRuntimeConfig().public.supabase?.url
  const key = process.env.SUPABASE_SECRET_KEY

  if (!url || !key) {
    // ⚠️ 缺金鑰不能退回匿名 client：那會靜默地什麼都刷不到（RLS 讓 view 回 0 列）
    //    而 cron 面板顯示「成功」。寧可 503。
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
