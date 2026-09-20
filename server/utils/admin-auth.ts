// 顯式 import：本檔要能被 vitest 直接 import，而 vitest 沒有 nitro 的自動匯入。
import { createError } from 'h3'

/**
 * `/api/admin/**` 裡要動用 service_role 的那些端點的授權決策。
 * 之所以需要自己判斷：沒有任何 RPC 會代問「呼叫者是不是 staff」
 * （`tmdb_refresh_due` 只 grant 給 service_role，`purge_expired_tmdb_cache()` 問的是 `is_service_context()`）。
 */

/** 通過守門的呼叫者。只取 `id`，JWT claims 不往外傳（理由見函式結尾）。 */
export interface StaffCaller {
  id: string
}

/**
 * 守門需要的兩件事，由端點注入（不傳 `event`：vitest 解析不到 Nuxt 別名 `#supabase/server`）。
 * ⚠️ `isStaff` 必須用 `serverSupabaseClient(event)`：接成 service role 時 `auth.uid()`
 * 是 NULL ⇒ `is_staff()` 永遠 false（2026-09-07 實測），後果是**所有人被擋**而不是都放行。
 */
export interface StaffProbe {
  /**
   * 目前登入者；未登入回 `null`。
   * ⚠️ 形狀是 `{ sub }` 不是 `{ id }`（踩雷 #13）：`serverSupabaseUser()` 回的是 JWT
   * claims，寫成 `user.id` 會是 undefined，而 `pnpm typecheck` 一個字都不會說。
   */
  user: () => Promise<{ sub: string } | null>
  /** 以**呼叫者自己的**權限問資料庫 `is_staff()`。 */
  isStaff: () => Promise<{
    data: boolean | null
    error: { code?: string, message?: string } | null
  }>
}

/**
 * 守門本體。順序不可調換：① 有沒有登入 → ② 用**呼叫者自己的** client 問 `is_staff()`
 * → ③ 通過後呼叫端才拿 service role（§7 #26：service_role 不做任何身分檢查）。
 * ⚠️ 只擋匿名在這個 repo 是已知會失效的守門（§1.1，被已登入的一般使用者攻破過）。
 */
export async function assertStaffFrom(probe: StaffProbe): Promise<StaffCaller> {
  // ① 先確認有身分，才談這個身分有沒有權限。
  const user = await probe.user()
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  // ② ⚠️ 這裡回 403 時要修的是「接錯了哪個 client」，不是換一個判準：
  //    改問 `is_service_context()` 或乾脆拿掉這一步，就是 §1.1 那個洞。
  const { data, error } = await probe.isStaff()

  if (error) {
    // 42501 是 RPC 被權限擋下。那不是伺服器壞了，是這個人沒有權限。
    if (error.code === '42501')
      throw createError({ statusCode: 403, statusMessage: '需要審核權限' })

    // ⚠️ 連不上／逾時／函式不存在一律擋下。「問不到答案就當作有權限」是這一類守門
    //    最常見的死法，而那條路只在資料庫出事時才走得到 ⇒ 正常情況永遠測不到。
    throw createError({
      statusCode: 500,
      statusMessage: `查詢審核權限失敗：${error.message ?? '未知錯誤'}`,
    })
  }

  // ★ `data !== true` 而不是 `!data`：`null`（RPC 回了空答案）也必須擋。
  if (data !== true)
    throw createError({ statusCode: 403, statusMessage: '需要審核權限' })

  // ★ 顯式重建，絕不 `return user`：probe 給的是整包 JWT claims（email、
  //   app_metadata、session_id），而呼叫端會把這個回傳值寫進稽核日誌。
  return { id: user.sub }
}
