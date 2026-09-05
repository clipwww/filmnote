import type { Database } from '~/types/database.types'
import { createClient } from '@supabase/supabase-js'

let cached: ReturnType<typeof createClient<Database>> | null = null

/**
 * 明確的「匿名視角」client。★ ISR 路由的 SSR fetch 只能用這支。
 *
 * `serverSupabaseClient(event)` 會帶上請求的 cookie，於是 RLS 依**觀看者**而異；
 * 把那種結果放進 ISR 快取，等於把第一位造訪者看到的內容發給所有人
 * （docs/BUILD_PLAN.md §3 注意事項 1、踩雷 #1）。
 *
 * 這支不吃 cookie、不帶 Authorization，RLS 一律以 anon 求值 ⇒ 輸出與觀看者無關，
 * 可以安全地被快取。個人化內容（「我看過這部片幾次」）一律留到 client 端補。
 */
export function publicSupabase() {
  if (cached)
    return cached
  const { url, key } = useRuntimeConfig().public.supabase
  cached = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-filmnote-view': 'anonymous' } },
  })
  return cached
}
