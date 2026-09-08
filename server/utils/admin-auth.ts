// ★ 顯式 import `createError` 而不是靠 nitro 的自動匯入。理由不是風格：本檔要能被
//   `tests/` 直接 import 起來測，而 vitest 沒有 nitro 的自動匯入（`createError`
//   會是 ReferenceError）。h3 是 nuxt 的相依，兩邊解析到的是同一個。
import { createError } from 'h3'

/**
 * `/api/admin/**` 裡「要動用 service_role 去做事」那一類端點的授權決策。
 *
 * ── 為什麼這支存在，而 approve / merge 不需要它 ─────────────────────────────
 * `approve.post.ts` / `merge.post.ts` 從頭到尾用**呼叫者自己的** client，授權由
 * `approve_film()` / `merge_films()` 內部的 `is_staff()` 決定——那是最好的形狀，
 * 判斷只有一份，寫在資料庫裡。
 *
 * 但 TMDB 維護做的兩件事都**只有 service_role 做得到**：
 *   - `tmdb_refresh_due` 這個 view 只 grant 給 `service_role`（9999_grants.sql:85）
 *   - `purge_expired_tmdb_cache()` 進門問的是 `is_service_context()`，不是 `is_staff()`
 * 也就是說**沒有任何一支 RPC 會替我們問「呼叫者是不是 staff」**。少了這個檔案，
 * 端點就是「誰打得到就跑」，而它跑的是一個看得到全站資料的 client。
 *
 * ── 順序是這個檔案唯一的重點 ────────────────────────────────────────────────
 *   ① 有沒有登入 → 沒有就 401
 *   ② 用**使用者自己的** client 問資料庫 `is_staff()` → 不是 true 就 403
 *   ③ **通過②之後**，呼叫端才去拿 `serviceSupabase()` 幹活
 *
 * ⚠️ 踩雷 #26 的精神：`service_role` **不做任何身分檢查**。所以它在這裡只能拿來
 *   「執行工作」，絕不能拿來「判斷誰有權限」。本檔從頭到尾沒有 import
 *   `serviceSupabase`，那是刻意的——這個模組看不到 service role，就不可能不小心
 *   拿它去問 `is_staff()`。那樣做的後果見下方 `StaffProbe` 的註解，**跟直覺相反**。
 *
 * ⚠️ 同理，本檔不 import `assertCronCaller`。`CRON_SECRET` 是給 Vercel Cron 的
 *   機器憑證，瀏覽器發起的管理動作一律走使用者身分。兩條路不可以接在一起，
 *   而且那個 secret 不可以出現在任何會送到瀏覽器的東西裡。
 *
 * ⚠️ BUILD_PLAN §1.1 記載這個 repo 的授權**真的被攻破過**，攻破它的正是「已登入
 *   但不是 staff」的一般使用者（以他的身分呼叫 merge 實測回 204）。所以 ② 不是
 *   形式：**只擋匿名的守門，在這個 repo 是已知會失效的守門。**
 *   `tests/admin-tmdb-auth.test.ts` 針對這一種呼叫者有專門的斷言。
 *
 * ── 為什麼是「注入 probe」而不是「傳 event 進來」 ───────────────────────────
 * 因為要能測。`#supabase/server` 是 Nuxt 模組建出來的別名，vitest 解析不到它
 * （實測：靜態 import 與動態 import 都會在 `vite:import-analysis` 直接失敗，
 * 訊息是 `Missing "#supabase/server" specifier in "filmnote" package`）。把
 * supabase 的接線留在端點檔、決策留在這裡，「已登入的一般使用者會不會被擋」
 * 就變成一條純函式的斷言，不必起伺服器、也不必真的準備一個非 staff 帳號。
 *
 * 附帶的好處是稽核性：端點檔裡看得到 `serverSupabaseClient(event)` 這個字，
 * 讀的人一眼就知道「問 is_staff() 的是使用者自己的 client」。包進共用函式裡
 * 反而會讓那件最該被看見的事消失。
 */

/**
 * 通過守門的呼叫者。只取 `id`——稽核日誌需要它，其餘欄位這裡用不到。
 *
 * ⚠️ 這個 `id` 是 `assertStaffFrom` **顯式重建**出來的（`{ id: user.sub }`），
 * 不是把 probe 給的物件原樣透傳。原樣透傳的話整包 JWT claims（含 email、
 * app_metadata、session_id）就會跟著這個回傳值散進呼叫端，而呼叫端會把它
 * 寫進稽核日誌。**這裡窄化一次，外面就不可能多印。**
 */
export interface StaffCaller {
  id: string
}

/**
 * 守門需要的兩件事，由端點接上真正的 supabase client。
 *
 * ⚠️ `isStaff` 必須用 `serverSupabaseClient(event)`（帶請求裡那個使用者的 JWT）。
 *
 * ★ 接成 service role 會怎樣，跟直覺相反，而且我實測過（2026-09-07，直接以
 *   service key 呼叫 `POST /rest/v1/rpc/is_staff`，回 **`false`**）：
 *
 *     `is_staff()` 的定義是 `exists(select 1 from profile_private
 *      where id = auth.uid() and role in ('moderator','admin'))`（0001:129）。
 *     service role 的 `auth.uid()` 是 NULL ⇒ 永遠 false。
 *
 *   所以接錯的後果**不是「所有人都變成 staff」，而是「所有人都被擋」**——
 *   包括 David 自己。那是 fail-closed 的壞法，會表現成「按了說我沒有權限」。
 *
 * ⚠️ 真正會開門的是**下一步**：有人為了修好那個 403，把 ② 改成問
 *   `is_service_context()`（service role 對它永遠是 true），或乾脆把 ② 拿掉。
 *   **拿掉 ② 才是 §1.1 那個洞**：任何登入者都能觸發一次 service role 的工作。
 *   所以看到這裡回 403 時，要修的是「接錯了哪個 client」，不是「換一個判準」。
 */
export interface StaffProbe {
  /**
   * 目前登入者；未登入回 `null`。
   *
   * ⚠️ **形狀是 `{ sub }` 不是 `{ id }`，這不是筆誤**（踩雷 #13）。
   * `@nuxtjs/supabase` v2 的 `serverSupabaseUser()` 回的是 **JWT claims**
   * （`JwtPayload`，`sub` 是 `RequiredClaims` 的必填欄位），**沒有 `id`**。
   *
   * ★ 這裡刻意讓型別**直接吃 `serverSupabaseUser()` 的回傳值**，端點一行轉換都不用寫。
   *   寫成 `{ id: string }` 再要求三個呼叫點各自轉一次 `{ id: c.sub }`，就是給了
   *   三個寫錯的機會——而寫錯的症狀是 `undefined`（`JwtPayload` 有索引簽章，
   *   `user.id` 型別上完全合法），**`pnpm typecheck` 一個字都不會說**。
   *   同一條踩雷在這個 repo 已經害過 `/app/import` 的匯入對帳、
   *   以及 `counter-notice.post.ts` 的整條 §90-9 回復通知流程（2026-09-08 修）。
   */
  user: () => Promise<{ sub: string } | null>
  /** 以**呼叫者自己的**權限問資料庫 `is_staff()`。 */
  isStaff: () => Promise<{
    data: boolean | null
    error: { code?: string, message?: string } | null
  }>
}

/**
 * 守門的決策本體。通過回傳呼叫者，不通過一律 throw。
 *
 * ★ 每一個「不放行」的分支都用 throw 而不是回傳布林值：回傳值會被呼叫端忘記
 *   檢查，而忘記檢查的那一次，service_role 已經在跑了。
 */
export async function assertStaffFrom(probe: StaffProbe): Promise<StaffCaller> {
  // ① 沒登入就到此為止。★ 這一步失敗時**不會**去問 is_staff()——問了也沒意義
  //    （匿名 client 的 is_staff() 是 false），但更重要的是順序本身要看得出來：
  //    先確認有身分，才談這個身分有沒有權限。
  const user = await probe.user()
  if (!user)
    throw createError({ statusCode: 401, statusMessage: '請先登入' })

  // ② 權限問資料庫，不在這裡自己算。
  const { data, error } = await probe.isStaff()

  if (error) {
    // 42501 是 RPC 被權限擋下。那不是伺服器壞了，是這個人沒有權限。
    if (error.code === '42501')
      throw createError({ statusCode: 403, statusMessage: '需要審核權限' })

    // 其餘錯誤（連不上、逾時、函式不存在）一律**擋下**而不是放行。
    // 「問不到答案就當作有權限」是這一整類守門最常見的死法，而它在正常情況下
    // 永遠測不到——那條路只在資料庫出事時才走得到。
    throw createError({
      statusCode: 500,
      statusMessage: `查詢審核權限失敗：${error.message ?? '未知錯誤'}`,
    })
  }

  // ★ `data !== true` 而不是 `!data`：`null`（RPC 回了空答案）也必須擋。
  if (data !== true)
    throw createError({ statusCode: 403, statusMessage: '需要審核權限' })

  // ★ **顯式重建，絕不 `return user`。** probe 給的是整包 JWT claims
  //   （email、app_metadata、user_metadata、session_id 都在裡面），而呼叫端
  //   拿到這個回傳值之後會把它寫進稽核日誌。窄化成一個欄位，外面就不可能多印。
  return { id: user.sub }
}
