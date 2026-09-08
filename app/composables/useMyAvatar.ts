import { pickAvatarUrl } from '../utils/avatar'

/**
 * 登入者自己的 Google 頭像網址。**只給登入後的私密面用**（現在只有 `AppNav`）。
 *
 * ── ⚠️ 這個值刻意不落地到資料庫 ───────────────────────────────────────
 * 2026-09-07 David 的裁決：頭像只出現在登入後的私密面，公開頁 `/u/**` 一律首字母。
 * 而「不寫進 `public.profile.avatar_url`」不是實作上的偷懶，它是**唯一在結構上
 * 成立的做法**——那一欄一旦有值，公開就自動發生，不需要任何人再寫一行程式：
 *   1. `anon` 對 `public.profile` 的 SELECT 欄位清單本來就含 `avatar_url`
 *      （實查 `information_schema.column_privileges`），`profile_read` policy
 *      對未終止服務者放行；
 *   2. `server/api/u/[username].get.ts` 的白名單**已經** select 了 `avatar_url`
 *      並回傳 `avatarUrl`；
 *   3. `app/pages/u/[username].vue` 的 `<UAvatar :src="profile.avatarUrl">`
 *      **已經**接好。
 * 三根管子都通著，只差水。所以正確的控制點是「不要有值」，不是「前端不要畫」——
 * 用 `v-if` 藏起來對 SSR 的 `__NUXT_DATA__` 完全無效（全專案硬約束 3）。
 * ⇒ **不要**把這支回傳的東西寫進 `profile.avatar_url`，也不要為它開 migration。
 *   要讓錯誤的方向是「少一張圖」，而不是「洩漏」。
 *
 * ── 兩條取得途徑，先便宜的那條 ────────────────────────────────────────
 * `useSupabaseUser()` 給的是 `auth.getClaims()` 解出來的 JWT payload；GoTrue 的
 * access token 慣例上會帶 `user_metadata`，但 `JwtPayload.user_metadata` 在型別上
 * 是 **optional**（`@supabase/auth-js` types.d.ts:1685），而**我沒有實測過這顆
 * 專案的 token 到底帶不帶**（要驗它得拿一張真的 JWT，那需要建帳號＝寫資料庫）。
 * 所以：claims 有就用（零網路請求），沒有才退一步打一次 `auth.getUser()`
 * （那會向 GoTrue 的 `/user` 發一趟請求，`Session.user.user_metadata` 在型別上
 * 是必填，是唯一有保證的路徑）。兩條都拿不到就回 `null`，畫面退成首字母。
 *
 * ── 為什麼 `server: false` ────────────────────────────────────────────
 * 同 `useMyIdentity()` 的檔頭：`server/middleware/strip-auth-on-cacheable.ts`
 * 讓 `/`、`/film/**`、`/venue/**`、`/legal/**` 的 SSR 一律看不到身分，
 * 伺服器端問了也只會得到「未登入」，兩邊算出不同答案就是 hydration mismatch，
 * 而 Vue 的補救不對稱（踩雷 #98：文字會被改正、屬性不會）。一律在 client 問，
 * 由 `<ClientOnly>` 包住。
 *
 * ── 為什麼不併進 `useMyIdentity()` ────────────────────────────────────
 * 這一輪的授權範圍不含那支檔（多條線同時在改這棵工作樹，動別人的檔會互相覆蓋）。
 * 順帶一個好處：那支問的是**資料庫**（profile / `is_staff()`），這支問的是
 * **auth 的 metadata**，兩者的失效模式不一樣，分開比較好讀。
 */

/** 回一個 `computed`：登入者的 Google 頭像網址，沒有就是 `null`。 */
export function useMyAvatar() {
  const supabase = useSupabaseClient()
  const user = useSupabaseUser()

  // 快路徑：claims 直接帶著 metadata 的話，一趟網路請求都不必發。
  const fromClaims = computed(() => pickAvatarUrl(user.value?.user_metadata))

  // 慢路徑：只有在快路徑落空、而且真的有人登入時才打。匿名者早退，不發請求。
  const { data: fromGoTrue } = useAsyncData('nav-my-avatar', async () => {
    if (!user.value?.sub || fromClaims.value)
      return null
    const { data, error } = await supabase.auth.getUser()
    // 問不到就當沒有頭像：少一張圖只是樸素，畫面會退成首字母，不會壞。
    if (error)
      return null
    return pickAvatarUrl(data.user?.user_metadata)
  }, { server: false, watch: [user] })

  return computed(() => fromClaims.value ?? fromGoTrue.value ?? null)
}
