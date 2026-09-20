// 顯式 import：本檔要能被 vitest 直接 import，而 vitest 沒有 nitro 的自動匯入。
import { createError } from 'h3'

/**
 * 「匯入舊紀錄」（`/app/import`）限定本人使用。2026-09-20 加。
 * ⚠️ 這是**功能閘門不是權限邊界**：寫入是瀏覽器端帶使用者自己的 JWT 走 RLS 做的，
 * 任何登入者本來就能從 `/app/records/new` 寫自己的紀錄 ⇒ 擋這裡不會多擋住什麼。
 */

/** 通過閘門的呼叫者。只取 `id`，其餘 JWT claims（含 email）不往外傳。 */
export interface ImportCaller {
  id: string
}

export interface ImportOwnerProbe {
  /**
   * 目前登入者；未登入回 `null`。
   * ⚠️ 形狀是 `{ sub }` 不是 `{ id }`（踩雷 #13）：`serverSupabaseUser()` 回的是 JWT
   * claims，寫成 `user.id` 會是 undefined，而 `pnpm typecheck` 一個字都不會說。
   */
  user: () => Promise<{ sub: string, email?: unknown } | null>
  /**
   * 允許使用匯入的 email。端點傳 `process.env.IMPORT_TARGET_EMAIL`——不走
   * runtimeConfig 是為了不要多一個 `NUXT_` 開頭的名字（`cron-auth.ts` 付過這個代價），
   * 也杜絕誤放進 `runtimeConfig.public` ⇒ 被序列化進每一頁的 SSR payload。
   */
  allowedEmail: () => string | undefined
}

export type ImportVerdict
  = | { allowed: true, caller: ImportCaller }
  /** ⚠️ `reason` 只留在伺服器端：回給瀏覽器等於讓人探測這個環境設了什麼。 */
    | { allowed: false, reason: 'not-configured' | 'no-email-claim' | 'not-owner' }

/**
 * 只做 `trim()` ＋ `toLowerCase()`。
 * ⚠️ 刻意不處理 Gmail 的 `.` 與 `+` 別名：那會讓「誰能用」變成要推理的問題。
 */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * 未登入 throw 401（那是「還沒有身分」）；其餘回裁決不 throw，讓端點各自決定要
 * 403 還是回布林。★ 失敗方向是關的：沒設 `IMPORT_TARGET_EMAIL` ⇒ 全部拒絕。
 * ⚠️ email 判準撐不起防線：它取自 JWT claim，可信度取決於 Supabase 的驗證設定。
 */
export async function decideImportOwnerFrom(probe: ImportOwnerProbe): Promise<ImportVerdict> {
  const user = await probe.user()
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  const allowed = normalizeEmail(probe.allowedEmail())
  if (!allowed)
    return { allowed: false, reason: 'not-configured' }

  const mine = normalizeEmail(user.email)
  if (!mine)
    return { allowed: false, reason: 'no-email-claim' }

  return mine === allowed
    ? { allowed: true, caller: { id: user.sub } }
    : { allowed: false, reason: 'not-owner' }
}

/**
 * 端點用的守門：不是本人就 403（不是 401——他登入了，再登入幾次也不會變成本人）。
 * ★ throw 而不是回布林：回傳值會被呼叫端忘記檢查，而忘記的那一次端點已經在跑了。
 */
export async function assertImportOwnerFrom(probe: ImportOwnerProbe): Promise<ImportCaller> {
  const verdict = await decideImportOwnerFrom(probe)
  if (!verdict.allowed)
    throw createError({ statusCode: 403, statusMessage: '「匯入舊紀錄」是個人專用工具，這個帳號不能使用' })
  return verdict.caller
}
