import type { Database } from '~/types/database.types'
import { createClient } from '@supabase/supabase-js'

let cached: ReturnType<typeof createClient<Database>> | null = null

/**
 * 匿名視角 client。★ ISR 路由的 SSR fetch 只能用這支：`serverSupabaseClient(event)`
 * 會帶 cookie ⇒ RLS 依觀看者而異，放進 ISR 快取等於把第一位造訪者看到的內容發給
 * 所有人（§3 注意事項 1、踩雷 #1）。個人化內容一律留到 client 端補。
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
