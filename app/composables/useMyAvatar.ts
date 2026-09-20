import { pickAvatarUrl } from '../utils/avatar'

/**
 * 登入者自己的 Google 頭像網址，**只給登入後的私密面用**（公開頁 `/u/**` 一律首字母）。
 * ⚠️ **這個值刻意不落地到資料庫**，而那不是偷懶，是**唯一在結構上成立的做法**：
 * `profile.avatar_url` 一旦有值，公開就自動發生，不需要任何人再寫一行程式。
 */
/*
 * 三根管子都通著只差水：① `anon` 對 `profile` 的 SELECT 欄位清單本來就含 `avatar_url`；
 * ② `/api/u/[username]` 的白名單**已經** select 了它並回傳 `avatarUrl`；③ `/u/` 的
 * `<UAvatar :src="profile.avatarUrl">` **已經**接好。⇒ 正確的控制點是「不要有值」不是
 * 「前端不要畫」——用 `v-if` 藏起來對 SSR 的 `__NUXT_DATA__` 完全無效。
 */
/*
 * ⇒ **不要**把這支回傳的東西寫進 `profile.avatar_url`，也不要為它開 migration。
 * 要讓錯誤的方向是「少一張圖」而不是「洩漏」。
 */
/*
 * 兩條取得途徑，先便宜的那條：`useSupabaseUser()` 的 claims 有 `user_metadata` 就用（零網路
 * 請求），但它在型別上是 **optional** 而**我沒有實測過這顆專案的 token 到底帶不帶**
 * ⇒ 沒有才退一步打一次 `auth.getUser()`（`Session.user.user_metadata` 型別上必填，是唯一
 * 有保證的路徑）。兩條都拿不到就回 `null`，畫面退成首字母。
 */
/*
 * `server: false` 的理由同 `useMyIdentity()`：middleware 讓那幾條路由的 SSR 看不到身分，
 * 兩邊算出不同答案就是 hydration mismatch，而 Vue 的補救不對稱（#98）。
 * 不併進 `useMyIdentity()`：那支問的是**資料庫**、這支問的是 **auth 的 metadata**，
 * 兩者的失效模式不一樣，分開比較好讀。
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
