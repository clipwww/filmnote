<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

/**
 * 右上角的功能選單（2026-09-06 David：「各頁面的連結入口, 選單沒有設計好」）。
 *
 * ── 它解決的是「可發現性」，不是「好看」 ──────────────────────────────
 * 這個專案蓋了 `/app/records/new`、`/app/films/new`、`/app/import`、
 * `/app/settings`、`/admin/**`、`/legal/**`，而**畫面上一個入口都沒有**——
 * 導覽列從頭到尾只有一顆「我的紀錄」。連「登出」都埋在 `/app` 儀表板的
 * 某一列裡。一個找不到的功能等於沒有做。
 *
 * ── ⚠️ 整顆包在 `<ClientOnly>` 裡（踩雷 #98）─────────────────────────
 * 選單內容取決於「有沒有登入」與「是不是 staff」，而
 * `server/middleware/strip-auth-on-cacheable.ts` 讓 `/`、`/film/**`、`/venue/**`、
 * `/legal/**` 的 SSR 一律 render 成未登入 ⇒ 已登入者在這幾頁必然 hydration
 * mismatch，而 Vue 只會改正文字、不會改正屬性（實測過：文字變成「我的紀錄」、
 * href 還停在 `/login`）。`fallback` 給出伺服器那一版，沒有 JS 的訪客也還有路走。
 *
 * ── ⚠️ `/admin` 的判斷走 `is_staff()`，不是猜的 ────────────────────────
 * 見 `useMyIdentity()` 的檔頭。附著除錯的那個瀏覽器 session 是 admin，
 * **不要因為自己看得到就以為所有人看得到**。
 */
const supabase = useSupabaseClient()
const colorMode = useColorMode()
const { username, isStaff, isSignedIn, canImport } = useMyIdentity()

/**
 * 觸發鈕上的 Google 頭像（2026-09-07 David：**只在登入後的私密面顯示，
 * 公開頁 `/u/**` 一律首字母**）。
 *
 * ── 這裡是它唯一會出現的地方 ─────────────────────────────────────────
 * 值來自 `useSupabaseUser()` 的 `user_metadata`，**不經過 `public.profile`**。
 * 理由寫在 `useMyAvatar()` 的檔頭：`avatar_url` 那一欄只要有值，`/api/u/` 與
 * `/u/` 兩根管子已經接好了，公開會自動發生。不落地是唯一在結構上守得住的做法。
 *
 * ── 首字母是我們決定的，不是 Nuxt UI 決定的 ───────────────────────────
 * `UAvatar` 內建的 fallback 是 `alt.split(' ')` 取每個詞的首字母——那是英文姓名的
 * 假設。顯式給 `:text` 把這個行為收回自己手上：日後函式庫改演算法，畫面不會靜靜地變。
 * **不轉大寫**：`/u/{username}` 的頭像現在畫的是小寫首字（`Avatar.vue` 不做轉換），
 * 同一個人在兩個畫面上該長一樣；要改就兩邊一起改，那是另一個決定。
 */
const avatarUrl = useMyAvatar()
const avatarInitial = computed(() => Array.from(username.value ?? '')[0] ?? '')

async function signOut() {
  await supabase.auth.signOut()
  // 留在 /app/** 只會被 middleware 彈回 /login，多一次跳轉。直接回首頁。
  await navigateTo('/')
}

/**
 * 明暗切換（2026-09-06 David：「少了 light / dark mode 的切換開關」）。
 *
 * ── 三態不是兩態 ─────────────────────────────────────────────────────
 * 跟隨系統／亮／暗。沒有明確選過的人應該跟著作業系統走——那是多數人期望的行為，
 * 也是 `@nuxtjs/color-mode` 的預設（`preference: 'system'`）。做成兩態的話，
 * 使用者第一次點下去就永久脫離了系統設定，而且沒有路回去。
 *
 * ── ⚠️ ISR 污染：查過了，這條路是乾淨的 ───────────────────────────────
 * `/` 與 `/film/**` 走 ISR，而 Vercel 以「路徑」為單位快取（踩雷 #1）⇒
 * 任何隨使用者而異的東西進了 SSR 輸出，就會被第一個訪客的版本烤進 CDN。
 * 主題偏好正是這一類。**實測 2026-09-06**：把 `nuxt-color-mode` cookie 設成
 * dark／light／不帶，抹掉 payload 裡的 SSR 時戳之後三份 HTML **逐位元組相同**，
 * `$scolor-mode` 在三種情況下都是 `"system"`——偏好只在瀏覽器端套用，
 * 沒有進伺服器輸出。
 * ⚠️ 這是**現在**的結論，不是永久保證：哪天有人在 SSR 期間讀了
 * `colorMode.value` 去挑顏色（踩雷 #88 那條），這個保證就沒了。
 * 驗法留在這裡：`curl -H 'Cookie: nuxt-color-mode=dark' …` 對照無 cookie 版本。
 */
const themeGroup = computed<DropdownMenuItem[]>(() => {
  const pick = (v: 'system' | 'light' | 'dark') => () => {
    colorMode.preference = v
  }
  return [
    { label: '外觀', type: 'label' },
    { type: 'checkbox', label: '跟隨系統', icon: 'i-lucide-monitor', checked: colorMode.preference === 'system', onUpdateChecked: pick('system') },
    { type: 'checkbox', label: '亮色', icon: 'i-lucide-sun', checked: colorMode.preference === 'light', onUpdateChecked: pick('light') },
    { type: 'checkbox', label: '暗色', icon: 'i-lucide-moon', checked: colorMode.preference === 'dark', onUpdateChecked: pick('dark') },
  ]
})

/** 法遵四頁做成子選單：它們每一頁的頁尾都連得到，這裡是第二條路不是唯一那條。 */
const legalGroup: DropdownMenuItem = {
  label: '條款與著作權',
  icon: 'i-lucide-scale',
  children: [
    { label: '服務條款', to: '/legal/terms' },
    { label: '隱私權政策', to: '/legal/privacy' },
    { label: '著作權政策', to: '/legal/copyright' },
    { label: '侵權通知', to: '/legal/dmca' },
  ],
}

const items = computed<DropdownMenuItem[][]>(() => {
  if (!isSignedIn.value) {
    return [
      [{ label: '登入', icon: 'i-lucide-log-in', to: '/login' }],
      [{ label: '搜尋作品', icon: 'i-lucide-search', to: '/search' }],
      themeGroup.value,
      [legalGroup],
    ]
  }

  const groups: DropdownMenuItem[][] = [
    [
      { label: '儀表板', icon: 'i-lucide-layout-dashboard', to: '/app' },
      { label: '個人紀錄管理', icon: 'i-lucide-list', to: '/app/records' },
      { label: '記一場', icon: 'i-lucide-plus', to: '/app/records/new' },
      { label: '新增作品', icon: 'i-lucide-clapperboard', to: '/app/films/new' },
      // 「匯入舊紀錄」只有本人看得到（David 2026-09-20：「沒權限的話 Menu 也不需要出現」）。
      // 判準來自 `/api/import/allowed`（只回布林，email 不出伺服器）。
      // ⚠️ 這是入口的顯示與否，**不是**權限——真正的閘門在
      //   `server/utils/import-auth.ts`，而那個自己也只是功能閘門不是安全邊界。
      //   猜錯不會讓任何人多做到什麼，只會讓選單多一條點進去被擋的路。
      ...(canImport.value
        ? [{ label: '匯入舊紀錄', icon: 'i-lucide-upload', to: '/app/import' }]
        : []),
    ],
    [
      { label: '搜尋作品', icon: 'i-lucide-search', to: '/search' },
      // 「別人看到的我」是一個真實需求：票價開關、私密紀錄的效果都只有從這裡看得出來。
      ...(username.value
        ? [{ label: '看我的公開頁', icon: 'i-lucide-user', to: `/u/${username.value}` }]
        : []),
      { label: '設定', icon: 'i-lucide-settings', to: '/app/settings' },
    ],
  ]

  // staff 才有。`/admin` 自己有一層分頁導覽（作品審核／DMCA 承辦／資料回報），
  // 這裡只給一個入口，不重複列它的三條——那三個標籤屬於 admin 那一側。
  if (isStaff.value)
    groups.push([{ label: '管理後台', icon: 'i-lucide-shield-check', to: '/admin' }])

  // 外觀跟帳號無關，登入與否都在同一個位置——使用者不必記得它「登入後才有」。
  groups.push(themeGroup.value)
  groups.push([legalGroup])
  groups.push([{ label: '登出', icon: 'i-lucide-log-out', onSelect: signOut }])
  return groups
})
</script>

<template>
  <ClientOnly>
    <div class="flex items-center gap-2">
      <!-- 未登入時多留一顆一按就到的登入鈕：選單裡也有，但登入是最常見的那一件事 -->
      <UButton v-if="!isSignedIn" to="/login" variant="soft" size="sm">
        登入
      </UButton>

      <UDropdownMenu
        :items="items"
        :content="{ align: 'end', sideOffset: 6 }"
        :ui="{ content: 'w-52' }"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          trailing-icon="i-lucide-chevron-down"
          :aria-label="isSignedIn ? `${username ?? '帳號'} 的功能選單` : '功能選單'"
        >
          <!--
            `referrerpolicy="no-referrer"` 落得到 <img> 上，是因為 `Avatar.vue` 是
            `inheritAttrs: false` ＋ `v-bind="$attrs"` 綁在圖片那一支（讀過原始碼確認）。
            它擋不掉「向 Google 發了一個請求」，但可以不告訴 Google 這個請求是從哪一頁發的。
            `alt=""`：按鈕自己有 `aria-label`，旁邊又已經寫著 username，這顆圓圈是裝飾。
            沒有頭像時整顆不畫（旁邊的文字已經說明是誰）；有頭像但網址壞掉時（Google 換了
            大頭貼、或整個連不上），`UAvatar` 自己的 `@error` 會翻成下面那個 `:text`，
            畫面上是首字母而不是一張破圖。
            `?? undefined` 在 `v-if` 之下是多餘的——留著是給型別看的：具名 slot 的內容會被
            編到一個函式裡，`v-if` 的縮小很可能到不了裡面，而 `src` 只收 `string | undefined`。
            不加 `:chip`：這顆圓圈就坐在裸台紙上，ring-offset 會露出票根紙色（DS :484）。
          -->
          <template v-if="avatarUrl" #leading>
            <UAvatar
              :src="avatarUrl ?? undefined"
              :text="avatarInitial"
              alt=""
              size="2xs"
              referrerpolicy="no-referrer"
            />
          </template>

          {{ isSignedIn ? (username ?? '我的') : '選單' }}
        </UButton>
      </UDropdownMenu>
    </div>

    <!--
      伺服器那一版：未登入的樣子。沒有 JS 的訪客拿到的是一顆真的能用的登入鈕，
      而不是一個空位——這一站的公開頁（含法遵頁）不該把可用性押在 JS 上。
    -->
    <template #fallback>
      <UButton to="/login" variant="soft" size="sm">
        登入
      </UButton>
    </template>
  </ClientOnly>
</template>
