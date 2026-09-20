// ★ 顯式 import `createError` 而不是靠 nitro 的自動匯入。理由同 `admin-auth.ts`：
//   本檔要能被 `tests/` 直接 import 起來測，而 vitest 沒有 nitro 的自動匯入。
import { createError } from 'h3'

/**
 * 「匯入舊紀錄」（`/app/import`）限定本人使用。
 *
 * David 2026-09-20：「補充一個點 『匯入舊紀錄』是只有登入帳號 email 與
 * IMPORT_TARGET_EMAIL 相同才可以用的功能」。
 *
 * ── ⚠️ 這是「功能閘門」，不是權限邊界。請不要把它讀成一道防線 ───────────────
 *
 * `/app/import` 的**實際寫入是瀏覽器端直接做的**：`app/pages/app/import.vue`
 * 用**使用者自己的 JWT ＋ RLS** 呼叫 `supabase.from('viewing_record').insert(...)`、
 * `from('film').insert(...)`、`from('viewing_record_cost').insert(...)`。
 * 伺服器端只有兩支端點（`parse-csv`、`tmdb-search`），兩支都不寫任何東西。
 *
 * ⇒ **擋掉這個工具不會阻止任何人做他原本做得到的事**：任何登入者本來就能寫
 *   自己的紀錄，`/app/records/new` 就是那條路。這裡擋的是「這個匯入 UI 與它
 *   背後兩支輔助端點」，擋的理由是它是個人專用工具，不是它有危險。
 *
 * ⚠️ 這段話請不要刪。這個 repo 反覆出事的形狀就是「以為有一道防線、其實沒有」
 *   （BUILD_PLAN §1.1 的授權事故就是那個形狀）。把功能閘門寫成安全機制，
 *   下一個人就會在它後面放真正需要保護的東西。
 *   ★ 附帶一提，email 這個判準本身也撐不起防線：它取自 JWT claim，可信度取決於
 *   Supabase 的 email 驗證設定，而那不是這支程式管得到的東西。
 *
 * ── 一個語意上的耦合，改值的人請先讀這裡 ───────────────────────────────────
 * `IMPORT_TARGET_EMAIL` 原本只有一個意思：「CLI 匯入腳本要把紀錄寫給誰」
 * （`.env.example`、`scripts/import-mylog.ts`）。2026-09-20 起它**同時**是
 * 「誰可以用匯入 UI」。兩個意思綁在同一個變數上，是 David 指定的。
 * ⚠️ 所以日後有人為了「把紀錄匯給另一個帳號」而改這個值，會**同時**把匯入 UI
 *   的使用權交給那個帳號——那通常不是他改那個值時想做的事。
 *
 * ── 為什麼讀 `process.env` 而不是 `useRuntimeConfig()` ─────────────────────
 * runtimeConfig 的鍵對應的環境變數名會是 `NUXT_IMPORT_TARGET_EMAIL`，於是同一件事
 * 有兩個名字（`.env` 與 `scripts/import-mylog.ts` 用的是 `IMPORT_TARGET_EMAIL`）。
 * `cron-auth.ts:31-32` 已經為了 `CRON_SECRET` / `NUXT_CRON_SECRET` 的分岔付過一次
 * 代價，`service-supabase.ts:28-29` 也直接讀 `process.env`。這裡只留一個名字。
 * ★ 另一個理由是安全的：這個值永遠不進 `runtimeConfig`，就不可能有人手滑把它
 *   放進 `runtimeConfig.public`——那會被序列化進每一頁的 SSR payload
 *   （`nuxt.config.ts:163-164` 的墓碑註解就是在講這件事）。
 *
 * ── 為什麼是「注入 probe」而不是「傳 event 進來」 ───────────────────────────
 * 同 `admin-auth.ts`：`#supabase/server` 是 Nuxt 模組建出來的別名，vitest 解析不到。
 * 決策留在這裡、supabase 的接線留在端點檔，「非本人會不會被擋」就變成一條純函式
 * 的斷言，不必起伺服器、也不必真的準備一個第二帳號。
 */

/** 通過閘門的呼叫者。只取 `id`，其餘 JWT claims（含 email）不往外傳。 */
export interface ImportCaller {
  id: string
}

export interface ImportOwnerProbe {
  /**
   * 目前登入者；未登入回 `null`。
   *
   * ⚠️ **形狀是 `{ sub }` 不是 `{ id }`，這不是筆誤**（踩雷 #13）：
   * `serverSupabaseUser()` 回的是 JWT claims，沒有 `id`。同一條踩雷害過的正是
   * `/app/import` 的匯入對帳。
   */
  user: () => Promise<{ sub: string, email?: unknown } | null>
  /** 允許使用匯入的 email；沒設時回 undefined／空字串。 */
  allowedEmail: () => string | undefined
}

export type ImportVerdict
  /** 是本人。 */
  = | { allowed: true, caller: ImportCaller }
  /**
   * 不是本人。`reason` 只給伺服器端的訊息用——**不要回給瀏覽器**，
   * 那會把「這個環境有沒有設 IMPORT_TARGET_EMAIL」變成可探測的資訊。
   */
    | { allowed: false, reason: 'not-configured' | 'no-email-claim' | 'not-owner' }

/**
 * email 比對前的正規化：只做 `trim()` ＋ `toLowerCase()`。
 *
 * ⚠️ **刻意不做更聰明的正規化**（Gmail 的 `.` 與 `+` 別名之類）。
 * 那會讓「誰能用這個工具」變成一個要推理的問題，而這個判準的價值就在於
 * 它可以一眼比對。大小寫與前後空白是輸入法與複製貼上必然會製造的差異，
 * 除此之外一律逐字。
 */
export function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * 判斷本體。**未登入一律 throw 401**（那不是「不是本人」，是「還沒有身分」）；
 * 其餘情況回傳裁決而不 throw，讓兩種呼叫端各自決定要 403 還是回一個布林。
 *
 * ★ 失敗方向是關閉的：`IMPORT_TARGET_EMAIL` 沒設時**所有人都不能用**，而不是
 *   所有人都能用。同 `rate-limit.ts` 的 `clientKey()`：「放行才是危險的預設值」。
 *   ⚠️ 線上目前設了值，所以這一條平常不會被走到——正因為如此它更需要測試守著，
 *   不然它壞掉的那天沒有任何徵兆。
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
 * 端點用的守門：不是本人就 **403**。
 *
 * ★ 403 而不是 401：他登入了，只是這個工具不給他用。回 401 會讓 UI 把他踢去
 *   重新登入，而登入幾次都不會變成本人。
 * ★ 不回傳布林值而是 throw：回傳值會被呼叫端忘記檢查，而忘記檢查的那一次，
 *   端點已經在跑了。
 */
export async function assertImportOwnerFrom(probe: ImportOwnerProbe): Promise<ImportCaller> {
  const verdict = await decideImportOwnerFrom(probe)
  if (!verdict.allowed)
    throw createError({ statusCode: 403, statusMessage: '「匯入舊紀錄」是個人專用工具，這個帳號不能使用' })
  return verdict.caller
}
