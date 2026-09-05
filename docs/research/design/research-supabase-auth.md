# research-supabase-auth

> 全部資料擷取日期：**2026-09-05**。所有版本號與程式碼片段均實際從 npm registry / GitHub raw / 官方文件站取得，非記憶。

---

## 1. 版本與 Nuxt 4 相容性

### 版本現況（npm registry，2026-09-05 擷取）

| 項目 | 值 |
|---|---|
| `@nuxtjs/supabase` latest | **2.0.10**（發布 2026-08-10） |
| 相依 | `@supabase/ssr ^0.12.4`、`@supabase/supabase-js ^2.112.2`、`defu ^6.1.7`、`pathe ^2.0.3` |
| `compatibility.nuxt` | `>=3.0.0`（宣告值，見下） |
| 模組自身 devDeps | `nuxt ^4.5.2`、`@nuxt/kit ^4.5.2`、`vite ^8.2.1` |
| `nuxt` latest | 4.5.2（2026-08-05） |
| `@supabase/ssr` latest | 0.12.6（2026-09-04） |

近期 stable 節奏：1.6.2 (2025-09-09) → **2.0.0 (2025-09-29)** → 2.0.1 → 2.0.2 → 2.0.3 → 2.0.4 → 2.0.5 → 2.0.6 → 2.0.7 → 2.0.8 → 2.0.9 (2026-05-21) → 2.0.10 (2026-08-10)。

`dist/module.mjs` 內宣告：

```js
meta: { name: '@nuxtjs/supabase', configKey: 'supabase', compatibility: { nuxt: '>=3.0.0' } }
```

宣告雖然是 `>=3.0.0`，但模組 CI 與 playground 都跑在 Nuxt 4.5.2 上（playground 用 `app/` 目錄結構），**Nuxt 4 是實際的開發基準**。可以放心用 4.5.2。

### v1 → v2 的破壞性變更（**這是本次最重要的一則**）

官方遷移指南 <https://supabase.nuxtjs.org/getting-started/migration>：

> `useSupabaseUser` 現在回傳 **JWT claims 而非完整 User 物件**。以前來自 `auth.getUser()`，現在來自 `auth.getClaims()`。`identities`、`last_sign_in_at`、`confirmed_at`、`email_confirmed_at` 不再直接可得。

原始碼證實（`dist/runtime/server/services/serverSupabaseUser.js`，v2.0.10）：

```js
export const serverSupabaseUser = async (event) => {
  const client = await serverSupabaseClient(event);
  const { data, error } = await client.auth.getClaims();
  if (error) throw createError({ statusMessage: error?.message });
  return data?.claims ?? null;
};
```

型別簽章：

```ts
// dist/runtime/server/services/serverSupabaseUser.d.ts
export declare const serverSupabaseUser: (event: H3Event) => Promise<JwtPayload | null>
// dist/runtime/composables/useSupabaseUser.d.ts
export declare const useSupabaseUser: () => Ref<JwtPayload | null>
```

**因此：`user.id` 不存在，要用 `user.sub`。** 官方 demo 已改用 `user!.sub`（`demo/server/api/tasks.ts`），CHANGELOG 2.0.2 也有一筆 `fix(demo): use sub instead of id`。相關使用者回報：issue #561「user.value.id is undefined... need to use user.value.sub」。

其他 v2 變更：
- `key` 現在是 **publishable key**（`sb_publishable_...`），取代 anon key。
- 新增 `secretKey`（`NUXT_SUPABASE_SECRET_KEY`），`serviceKey` **已 deprecated**。
- `cookieName` deprecated → `cookiePrefix`（預設 `sb-<project-ref>-auth-token`，由 URL hostname 推導）。
- 建議在 Dashboard 啟用 **JWT signing keys**（非對稱），否則 `getClaims()` 每次都會打 Auth server。

環境變數解析順序（`module.mjs` 實測）：
```
url:       NUXT_PUBLIC_SUPABASE_URL → SUPABASE_URL
key:       NUXT_PUBLIC_SUPABASE_KEY → SUPABASE_KEY → SUPABASE_PUBLISHABLE_KEY → SUPABASE_ANON_KEY → NUXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY → NUXT_PUBLIC_SUPABASE_ANON_KEY
secretKey: NUXT_SUPABASE_SECRET_KEY → SUPABASE_SECRET_KEY → SUPABASE_SERVICE_ROLE_KEY
```

### 已知 issue（GitHub API 實查）

| # | 狀態 | 影響 |
|---|---|---|
| **#635** | **open**（2026-07-27，2.0.10 仍未修） | **安全性**：`fetch-retry.js` 第三次失敗時 `console.error(..., safeInit)`，`safeInit` 只移除 `headers` **沒移除 `body`**。`/auth/v1/token?grant_type=refresh_token` 的 body 含 refresh token；若接 Sentry / Vercel log drain，refresh token 會落到 log。我已核對 2.0.10 的 dist，程式碼確實還是 `const { headers: _headers, ...safeInit } = init ?? {}`。 |
| #605 / #606 / #611 | closed，**2.0.9 修掉** | `ssr: false` 情境下 hard-refresh 會被踢回 `/login`。修法是把 client plugin 的守衛從 `if (!useSsrCookies)` 改成 `if (!currentSession.value)`。**務必用 ≥ 2.0.9。** |
| #582 | closed | `redirectOptions.callback` 設成 `'/'` 會讓首頁失去 SSR（模組會強制對 callback 路徑下 `ssr: false` route rule）。 |
| #545 | closed（非模組問題） | Safari 在 `http://localhost` 不接受 `Secure` cookie，而模組 `cookieOptions.secure` 預設 `true` → 本機 Safari 登入不持久。 |
| #608 | closed（docs） | `types` 預設 `~/types/database.types.ts`；Nuxt 4 的 `~` = `app/`，所以檔案要放 `app/types/database.types.ts`。 |

**沒有**任何 open 的 Nuxt 4 相容性 blocker。

---

## 2. Google Provider 完整設定

來源：<https://supabase.com/docs/guides/auth/social-login/auth-google>（原文 mdx：`apps/docs/content/guides/auth/social-login/auth-google.mdx`）

### 2.1 Google Cloud Console（Google Auth Platform）

**a) Data Access / Scopes**（<https://console.cloud.google.com/auth/scopes>）— Supabase Auth 需要三個：
- `openid` ← **要手動加**
- `.../auth/userinfo.email`（預設已有）
- `.../auth/userinfo.profile`（預設已有）

> 加更多 scope（尤其 sensitive / restricted 清單上的）會觸發 Google 審核，耗時很長。filmnote 只需要這三個。

**b) Audience**：決定哪些 Google 帳號可登入。做公開 SaaS 就選 External + Publish（Testing 模式只有 test users 能登入，且 refresh token 7 天過期）。

**c) Branding**：設 logo 與應用名稱。官方原文：

> 「Set up a custom domain for your project... If you don't set this up, users will see `<project-id>.supabase.co` which does not inspire trust and can make your application more susceptible to successful phishing attempts.」

Supabase 自訂網域是 **付費功能**，Hobby 階段就接受同意畫面顯示 `xxxx.supabase.co`。

**d) 建立 OAuth Client**（<https://console.cloud.google.com/auth/clients/create>），官方步驟逐字：

1. Create a new OAuth client ID，Application type 選 **Web application**。
2. **Authorized JavaScript origins** 填你的 app URL：
   - app 在 `https://example.com/app` → 填 `https://example.com`
   - 本機開發加 `http://localhost:<port>`（上線後記得移除）
3. **Authorized redirect URIs** 填 **Supabase 專案的 callback URL**：
   - 從 Dashboard 的 Google provider 頁複製，格式為 `https://<project-ref>.supabase.co/auth/v1/callback`
   - 本機用 supabase CLI 時填 `http://127.0.0.1:54321/auth/v1/callback`
4. Create，保存 **Client ID** 與 **Client Secret**，貼回 Supabase Dashboard 的 Google provider 頁。

**關鍵易錯點**：Authorized redirect URI 填的是 **Supabase 的 `/auth/v1/callback`**，不是你的 `/confirm`。你的 `/confirm` 是給 **Supabase 的 Redirect URLs allow list**，兩者不同層。

filmnote 具體要填：
```
Authorized JavaScript origins:
  https://filmnote.tw            (或實際 production domain)
  https://filmnote.vercel.app
  http://localhost:3000

Authorized redirect URIs:
  https://<project-ref>.supabase.co/auth/v1/callback
```

### 2.2 Supabase Dashboard

**a) Authentication → Providers → Google**：Enable，貼上 Client ID + Client Secret。（Web 流程不需要 "Skip nonce check"，那是 iOS native 才要。）

**b) Authentication → URL Configuration**（<https://supabase.com/docs/guides/auth/redirect-urls>）：

- **Site URL** = 沒帶 `redirectTo` 時的預設落點 → 設 production domain。
- **Redirect URLs** allow list = 所有允許的 `redirectTo`。**沒加進去登入就會失敗**（官方：「The redirect URL must be added to your project's Site URL or redirect configuration」）。

Glob 語法（官方表格逐字）：

| Pattern | Behavior |
|---|---|
| `*` | matches any sequence of non-separator characters |
| `**` | matches any sequence of characters |
| `?` | matches any single non-separator character |
| `[!{range}]` | matches any sequence of characters not in the range |
| `\c` | escapes character c |

分隔字元是 `.` 和 `/`。所以 `http://localhost:3000/*` **只**匹配單層，要匹配巢狀路徑得用 `/**`。

Vercel preview 部署的官方建議：
```
Site URL:       https://filmnote.tw
Redirect URLs:  http://localhost:3000/**
                https://filmnote.tw/**
                https://*-<your-vercel-team-slug>.vercel.app/**
```
官方也提醒：**production 盡量用精確路徑而非 wildcard**。

**c) Authentication → JWT Keys**：啟用 **JWT signing keys**（非對稱）。這是 v2 的前提，並且直接決定 SSR 效能（見第 4 節）。

**d) API Keys**：改用 `sb_publishable_...` / `sb_secret_...`。官方時程（<https://supabase.com/blog/jwt-signing-keys>）：2025-10-01 起既有專案自動遷移至 signing keys 系統；**Late 2026（TBC）所有專案必須停用 `anon` / `service_role` key**。filmnote 是新專案，直接用新 key 就好。

### 2.3 Nuxt 端

**`.env`**
```bash
NUXT_PUBLIC_SUPABASE_URL="https://<project-ref>.supabase.co"
NUXT_PUBLIC_SUPABASE_KEY="sb_publishable_xxx"
NUXT_SUPABASE_SECRET_KEY="sb_secret_xxx"   # 只在 server side 用，絕不進 public
```

**`nuxt.config.ts`**（filmnote 建議設定，逐項有理由）
```ts
export default defineNuxtConfig({
  modules: ['@nuxtjs/supabase'],
  supabase: {
    redirect: true,
    redirectOptions: {
      login: '/login',
      callback: '/confirm',      // ← 絕不要設成 '/'，見 gotcha
      include: ['/settings', '/settings/*', '/new', '/records/*/edit'],
      exclude: [],
      saveRedirectToCookie: true,
    },
    cookieOptions: {
      maxAge: 60 * 60 * 24 * 365,               // 預設只有 8 小時
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production', // Safari + localhost
    },
    types: '~/types/database.types.ts',          // Nuxt 4：實體檔在 app/types/
  },
})
```

**產生型別**
```bash
npx supabase gen types typescript --project-id "$PROJECT_REF" --schema public > app/types/database.types.ts
```
（`--project-id` 形式來自 <https://supabase.com/docs/guides/api/rest/generating-types>；`app/` 前綴是因為 Nuxt 4 的 `~` 指向 srcDir=`app/`，見 issue #608。）

**`app/pages/login.vue`**
```vue
<script setup lang="ts">
const supabase = useSupabaseClient()
const user = useSupabaseUser()
const config = useRuntimeConfig()

watchEffect(() => { if (user.value) navigateTo('/') })

async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // 必須是絕對 URL，且已列入 Supabase 的 Redirect URLs allow list
      redirectTo: `${window.location.origin}/confirm`,
    },
  })
  if (error) console.error(error)
}
</script>
```

filmnote **不需要** `queryParams: { access_type: 'offline', prompt: 'consent' }` — 那是為了拿 Google 自己的 `provider_refresh_token` 去呼叫 Google API；filmnote 只是要身分，不碰 Google 服務。

**`app/pages/confirm.vue`**（照官方 playground）
```vue
<script setup lang="ts">
const user = useSupabaseUser()
const redirectInfo = useSupabaseCookieRedirect()

watch(user, () => {
  if (user.value) {
    const path = redirectInfo.pluck()   // 取出並清空 cookie
    return navigateTo(path || '/')
  }
}, { immediate: true })
</script>

<template><div>登入中…</div></template>
```

**PKCE 是自動的，不需要自己寫 exchangeCodeForSession。** 我核對 `@supabase/ssr` 原始碼（`src/createBrowserClient.ts`）：

```ts
auth: {
  ...options?.auth,
  flowType: 'pkce',                                          // 硬寫，覆蓋使用者設定
  autoRefreshToken: options?.auth?.autoRefreshToken ?? isBrowser(),
  detectSessionInUrl: options?.auth?.detectSessionInUrl ?? isBrowser(),
  persistSession: options?.auth?.persistSession ?? true,
  storage,
}
```

`detectSessionInUrl: true` → browser client 在 `/confirm` 自動把 `?code=` 換成 session 並寫 cookie。這也是模組會 **自動** 對 callback 路徑加 `{ ssr: false }` route rule 的原因（見第 3 節）。

---

## 3. 公開頁 SSR 但不需登入 — `exclude` / `include` 的正確用法

### 3.1 機制（原始碼實查，文件沒寫清楚）

`dist/runtime/plugins/auth-redirect.js`（v2.0.10）**完整**：

```js
function matchesAnyPattern(path, patterns) {
  return patterns.some((pattern) => {
    if (!pattern) return false;
    const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
    return regex.test(path);
  });
}

export default defineNuxtPlugin({
  name: "auth-redirect",
  setup() {
    addRouteMiddleware("global-auth", defineNuxtRouteMiddleware((to) => {
      const config = useRuntimeConfig().public.supabase;
      const { login, callback, include, exclude, cookieRedirect, saveRedirectToCookie } = config.redirectOptions;

      if (include && include.length > 0) {
        if (!matchesAnyPattern(to.path, include)) return;   // ① 不在白名單 → 完全放行
      }
      const excludePatterns = [login, callback, ...exclude ?? []];
      if (matchesAnyPattern(to.path, excludePatterns)) return;  // ② 在排除清單 → 放行

      const session = useSupabaseSession();
      if (!session.value) {                                  // ③ 沒 session → 導 login
        if (cookieRedirect || saveRedirectToCookie) {
          useSupabaseCookieRedirect().path.value = to.fullPath;
        }
        return navigateTo(login);
      }
    }), { global: true });
  }
});
```

**必須知道的四件事：**

1. **`include` 優先於 `exclude`**，且是「白名單」。`include` 有值時，不匹配的路徑直接 return，`exclude` 根本不會執行。
2. **pattern 是 `^...$` 全字串錨定的 regex**，只把 `*` 換成 `.*`。所以：
   - `'/movie'` **不會** 匹配 `/movie/123`
   - `'/u/*'` 會匹配 `/u/david` **也會** 匹配 `/u/david/2026`（因為 `.*` 吃得下 `/`）
   - `'/'` 只匹配首頁本身
   - `*` 和 `**` 在這裡**行為完全相同**（跟 Supabase Dashboard 的 glob 語法不一樣！別搞混）
   - pattern 比對的是 `to.path`（不含 query string）
3. `login` 與 `callback` **自動被加進 exclude**，不必手動列。
4. 中介層檢查的是 **`useSupabaseSession()`（client 端 session，未經驗證）**，不是 `serverSupabaseUser()`。**這是 UX 導引，不是安全邊界。** 真正的授權必須靠 RLS + server route 的 `serverSupabaseUser()`。

### 3.2 filmnote 該怎麼設

filmnote 是「大部分頁面公開、少數需登入」，**用 `include` 白名單，而不是 `exclude` 黑名單**：

```ts
redirectOptions: {
  login: '/login',
  callback: '/confirm',
  include: [
    '/settings', '/settings/*',   // 個人設定（show_cost 開關）
    '/new',                       // 新增紀錄
    '/records/*/edit',            // 編輯紀錄
  ],
  saveRedirectToCookie: true,
}
```

好處：`/`、`/u/{username}`、`/film/{id}`、`/venue/{taxId}`、`/about`、`/terms`、`/dmca` 全都天然公開，**新增公開頁不必回頭改設定**——這對 SEO 導向的產品是對的預設。

黑名單版本（如果堅持用 `exclude`）長這樣，而且**每加一個公開頁就要改一次**：
```ts
exclude: ['/', '/u/*', '/film/*', '/venue/*', '/about', '/terms', '/privacy', '/dmca', '/stats/*']
```

**另一個選項**：`redirect: false` 完全關掉全域中介層，改在需要登入的頁面自己寫 `definePageMeta({ middleware: 'auth' })`。這樣最明確，但要自己處理 `saveRedirectToCookie` 的邏輯。以 filmnote 的規模，`include` 白名單已經夠。

### 3.3 SSR 訪客的成本（重要，文件沒寫）

`dist/runtime/plugins/supabase.server.js` 的結尾：

```js
if (useSsrCookies) {
  const [session, user] = await Promise.all([
    serverSupabaseSession(event).catch(() => null),
    serverSupabaseUser(event).catch(() => null),
  ]);
  useSupabaseSession().value = session;
  useSupabaseUser().value = user;
}
```

也就是說 **每一次 SSR 請求**（包含公開頁）都會跑 `getSession()` + `getClaims()`。我核對了 `auth-js` 的 `GoTrueClient.getClaims()`：

```ts
let token = jwt
if (!token) {
  const { data, error } = await this.getSession()
  if (error || !data.session) {
    return { data: null, error }        // ← 沒 session 就直接返回，零網路呼叫
  }
  token = data.session.access_token
}
```

**結論：未登入訪客的 SSR 成本 ≈ 0**（只解析 cookie）。已登入訪客則視 JWT 演算法：

```ts
const signingKey =
  !header.alg || header.alg.startsWith('HS') || !header.kid || !('crypto' in globalThis && 'subtle' in globalThis.crypto)
    ? null
    : await this.fetchJwk(header.kid, ...)

if (!signingKey) {
  const { error } = await this.getUser(token)   // ← HS256 fallback：每次請求打一次 Auth server
  ...
}
```

**啟用 JWT signing keys（ES256/RS256）→ 用 JWKS 本機驗簽，JWKS 有快取，不打網路。留在 HS256 → 每個 SSR 請求多一次 Auth server 往返。** 對 Vercel Hobby 上的 SSR 頁面，這是必做的設定。

---

## 4. Server route 三者的差異與適用時機

來源：<https://supabase.nuxtjs.org/services/*>（四頁全查），加上 v2.0.10 dist 原始碼核對。

| | `serverSupabaseClient(event)` | `serverSupabaseUser(event)` | `serverSupabaseServiceRole(event)` | `serverSupabaseSession(event)` |
|---|---|---|---|---|
| 回傳 | `Promise<SupabaseClient<Database>>` | `Promise<JwtPayload \| null>` | `SupabaseClient`（**非** Promise） | `Promise<Session \| null>`（已 `delete session.user`） |
| 身分 | 使用者身分（cookie 內的 JWT）| — | **service_role / secret key** | — |
| RLS | **套用** | — | **完全繞過** | — |
| 底層 | `@supabase/ssr` `createServerClient` | 對 client 呼叫 `auth.getClaims()` | `@supabase/supabase-js` `createClient(url, secretKey)` | `auth.getSession()` |
| 快取 | `event.context._supabaseClient` | 無（但共用上面的 client）| `event.context._supabaseServiceRole` | 無 |
| 可信度 | 可信（RLS 在 DB 端把關）| **可信**（驗簽/驗證過）| 可信但無限權 | **不可信** |

### 各自適用時機（對應 filmnote）

**`serverSupabaseClient`** — 預設就用這個。所有代表使用者操作的 DB 讀寫，RLS 自動生效。
```ts
// server/api/records/index.post.ts
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'
import type { Database } from '~~/app/types/database.types'

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user) throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })

  const client = await serverSupabaseClient<Database>(event)
  const body = await readBody(event)
  const { data, error } = await client
    .from('watch_records')
    .insert({ ...body, user_id: user.sub })   // ← 注意是 sub 不是 id
    .select()
    .single()
  if (error) throw createError({ statusMessage: error.message })
  return data
})
```
**RLS policy 必須寫成 `auth.uid() = user_id`，而不是信任 body 傳來的 `user_id`。** `serverSupabaseClient` 帶著使用者 JWT，`auth.uid()` 在 DB 端會解析出真實 `sub`。

**`serverSupabaseUser`** — 只在需要「這個請求到底是誰／有沒有登入」時呼叫。回傳的是 JWT claims：`sub`、`email`、`role`、`aal`、`session_id`、`is_anonymous`、`exp`、`iat`、`iss`、`aud`，另有 optional 的 `app_metadata` / `user_metadata` / `amr`（<https://supabase.com/docs/guides/auth/jwt-fields>）。

需要 `identities`、`last_sign_in_at`、`email_confirmed_at` 這類欄位時，得**額外**呼叫 `(await serverSupabaseClient(event)).auth.getUser()`。

**`serverSupabaseServiceRole`** — 繞過 RLS 的超級權限。filmnote 的正當用途：
- seed 腳本把 `.data/films.json` / `certificates.json` / `venues.json` 灌進 Supabase
- 管理者審核 UGC 作品（`films.status: pending → approved`）、合併重複作品
- 使用者名稱改名後寫入 `username_history`（301 轉向表）—— 需要跨使用者的唯一性檢查
- 全站統計 / 排行的匯總（要跳過 `visibility = 'private'` 以外的個別 RLS 判斷時）

**每一次使用都必須自己先做授權判斷**，`serverSupabaseServiceRole` 本身完全不檢查身分：
```ts
// server/api/admin/films/[id]/approve.post.ts
const user = await serverSupabaseUser(event)
if (!user) throw createError({ statusCode: 401 })

// 授權判斷用「使用者身分的 client」查，不能用 service role 查完就信
const client = await serverSupabaseClient<Database>(event)
const { data: me } = await client.from('profiles').select('is_admin').eq('id', user.sub).single()
if (!me?.is_admin) throw createError({ statusCode: 403 })

const admin = serverSupabaseServiceRole<Database>(event)   // ← 無 await
await admin.from('films').update({ status: 'approved' }).eq('id', getRouterParam(event, 'id'))
```

注意 `serverSupabaseServiceRole` **不是 async**，前面加 `await` 雖然無害但誤導。

**`serverSupabaseSession`** — 官方文件明確警告：

> 「`serverSupabaseSession` carries security risks, as the session originates from the client and can be modified by users. For checking if the user is logged in, always use `serverSupabaseUser`。」

filmnote **不應該**用它做任何判斷。它唯一的用途是拿 `provider_token` / `expires_at` 之類的 session 層資料，而 filmnote 不需要。

### 補充：SSR 中呼叫自家 API 一定要轉發 cookie

四頁文件都重複強調這一點：
```ts
const { data } = await useFetch('/api/me', {
  headers: useRequestHeaders(['cookie']),
})
```
漏掉 `useRequestHeaders(['cookie'])` → server 端拿不到 JWT → `serverSupabaseUser` 回 `null` → SSR 時看起來像未登入。這是最常見的踩雷。

---

## 5. 首次登入建立 profile 列：Trigger vs 應用層 upsert

### 官方立場

<https://supabase.com/docs/guides/auth/managing-user-data>（官方唯一的建議做法，逐字節錄）：

```sql
create table public.profiles (
  id uuid not null references auth.users on delete cascade,
  first_name text,
  last_name text,
  primary key (id)
);

GRANT SELECT ON public.profiles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;

alter table public.profiles enable row level security;
```

> 「To update your `public.profiles` table every time a user signs up, set up a trigger. **If the trigger fails, it could block signups, so test your code thoroughly.**」

```sql
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, first_name, last_name)
  values (new.id, new.raw_user_meta_data ->> 'first_name', new.raw_user_meta_data ->> 'last_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

另一則 caution（同頁）：

> 「Only use primary keys as foreign key references for schemas and tables like `auth.users` which are managed by Supabase... Columns, indices, constraints or other database objects managed by Supabase **may change at any time**。」

→ 只能 `references auth.users(id)`，不能 `references auth.users(email)`。

### 兩種做法的取捨

| | **Postgres trigger on `auth.users`** | **應用層 upsert（`/confirm` 或 server route）** |
|---|---|---|
| 原子性 | 與 `auth.users` insert 同一 transaction，**不可能有無 profile 的 user** | 有窗口：使用者建立成功但 profile 沒建（網路斷、使用者關頁面） |
| 涵蓋範圍 | 所有進入管道（OAuth、CLI seed、Dashboard 手動建、`auth.admin.createUser`）**一律**觸發 | 只有走過你的前端流程的才會建 |
| 失敗代價 | **註冊整個失敗**，使用者看到 `Database error saving new user`，且錯誤訊息不透明、極難 debug | 只是這次沒建成，下次登入可重試 |
| 唯一性衝突 | username 唯一鍵撞了 → 整個註冊回滾 | 可以在應用層 retry / 加 suffix / 讓使用者自選 |
| 可改性 | 改邏輯要 migration；本機 `supabase db reset` 才能測 | 一般程式碼，可測、可日誌、可 feature flag |
| 顯示可觀測 | trigger 內錯誤不進應用 log | 錯誤進 Nitro log / Sentry |
| Free tier 可用 | 是（純 SQL） | 是 |

### 對 filmnote 的具體建議：**混合，以 trigger 為主**

filmnote 的 username 規則是「預設取 email `@` 前綴、可修改、且必須全站唯一」——**唯一性衝突是必然會發生的**（`david@gmail.com` 和 `david@outlook.com`）。純 trigger 遇到衝突會讓註冊直接失敗，這不能接受。

正確做法是 **trigger 保證列一定存在、且自己解決衝突**：

```sql
-- profiles
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    citext not null unique,
  display_name text,
  avatar_url  text,
  show_cost   boolean not null default false,   -- SPEC：票價預設隱藏
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.username_history (           -- SPEC：改名後舊網址 301
  old_username citext primary key,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  changed_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.username_history enable row level security;

grant select on public.profiles to anon;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.profiles to service_role;
grant select on public.username_history to anon;

-- 公開讀
create policy "profiles are publicly readable"
  on public.profiles for select to anon, authenticated using (true);
-- 只能改自己
create policy "users can update own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
```

```sql
-- trigger：永不失敗
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  base_name text;
  candidate text;
  n int := 0;
begin
  -- email 的 @ 前綴，清掉不合法字元
  base_name := lower(regexp_replace(split_part(coalesce(new.email, ''), '@', 1), '[^a-z0-9_-]', '', 'gi'));
  if base_name = '' or base_name is null then
    base_name := 'user';
  end if;
  base_name := left(base_name, 24);

  candidate := base_name;
  -- 撞名就加序號，最多試 50 次，再不行就用 uuid 尾碼
  while exists (select 1 from public.profiles p where p.username = candidate) and n < 50 loop
    n := n + 1;
    candidate := base_name || n::text;
  end loop;
  if n >= 50 then
    candidate := base_name || '-' || left(replace(new.id::text, '-', ''), 8);
  end if;

  insert into public.profiles (id, username, display_name, avatar_url)
  values (
    new.id,
    candidate,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', candidate),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;   -- 冪等，重跑不炸

  return new;
exception when others then
  -- 關鍵：絕不讓 profile 建立失敗擋住註冊
  raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

再加一層應用層的**自癒**（成本極低、覆蓋 trigger 萬一失敗的情況）：

```ts
// server/api/me.get.ts —— 登入後前端第一次呼叫
import { serverSupabaseUser, serverSupabaseServiceRole } from '#supabase/server'

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user) throw createError({ statusCode: 401 })

  const admin = serverSupabaseServiceRole<Database>(event)
  const { data } = await admin.from('profiles').select('*').eq('id', user.sub).maybeSingle()
  if (data) return data

  // trigger 沒建成 → 補建（唯一的 service_role 正當用途：需要跨使用者查 username 唯一性）
  return await createProfileWithUniqueUsername(admin, user.sub, user.email)
})
```

**為什麼不用純應用層？** 因為 seed 腳本、Dashboard 手動建帳號、未來可能加的 magic link，都不會經過你的前端。trigger 是唯一能保證「`auth.users` 有列 → `profiles` 就有列」的地方，而 filmnote 的 `/u/{username}` 是公開 SSR 頁，profile 缺列會直接 500。

**`security definer set search_path = ''` 兩個都不能省**：`security definer` 讓函式以 owner 權限跑（否則 `auth.users` 的 trigger 沒權限寫 `public.profiles`）；`set search_path = ''` 防 search_path 注入（所以函式內所有表都必須寫完整的 `public.xxx`）。

---

## 附：filmnote 的完整 nuxt.config 建議

```ts
export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  modules: ['@nuxtjs/supabase', '@nuxt/ui'],

  routeRules: {
    // 公開頁：SSR + 適度快取（SEO / OG）
    '/':              { ssr: true },
    '/u/**':          { ssr: true },
    '/film/**':       { ssr: true },
    '/venue/**':      { ssr: true },
    // 登入後：SPA
    '/settings/**':   { ssr: false },
    '/new':           { ssr: false },
    // '/confirm' 不用寫 —— 模組會自動加 { ssr: false }
  },

  supabase: {
    redirect: true,
    redirectOptions: {
      login: '/login',
      callback: '/confirm',
      include: ['/settings', '/settings/*', '/new', '/records/*/edit'],
      saveRedirectToCookie: true,
    },
    cookieOptions: {
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
    types: '~/types/database.types.ts',
  },
})
```

---

## 來源清單（全部 2026-09-05 擷取）

- <https://supabase.nuxtjs.org/getting-started/introduction>
- <https://supabase.nuxtjs.org/getting-started/authentication>
- <https://supabase.nuxtjs.org/getting-started/migration>
- <https://supabase.nuxtjs.org/services/serverSupabaseClient>
- <https://supabase.nuxtjs.org/services/serverSupabaseUser>
- <https://supabase.nuxtjs.org/services/serverSupabaseServiceRole>
- <https://supabase.nuxtjs.org/services/serverSupabaseSession>
- <https://supabase.com/docs/guides/auth/social-login/auth-google>（+ raw mdx `apps/docs/content/guides/auth/social-login/auth-google.mdx`）
- <https://supabase.com/docs/guides/auth/redirect-urls>
- <https://supabase.com/docs/guides/auth/managing-user-data>（+ raw mdx）
- <https://supabase.com/docs/guides/auth/jwt-fields>
- <https://supabase.com/docs/reference/javascript/auth-getclaims>
- <https://supabase.com/blog/jwt-signing-keys>
- <https://supabase.com/docs/guides/api/rest/generating-types>
- npm registry：`@nuxtjs/supabase` 2.0.10 tarball（`dist/module.mjs`、`dist/module.d.mts`、`dist/runtime/**` 全部實讀）、`@supabase/ssr` 0.12.6、`nuxt` 4.5.2
- GitHub `nuxt-modules/supabase`：CHANGELOG.md、`playground/**`、`demo/**`、issues #545 #561 #582 #605 #606 #608 #611 #635
- GitHub `supabase/ssr`：`src/createBrowserClient.ts`、`src/createServerClient.ts`
- GitHub `supabase/auth-js`：`src/GoTrueClient.ts`（`getClaims` 實作）

本機暫存的核對檔案在 `/private/tmp/claude-501/-Users-david-Documents-Github-log/942964bf-1e2d-4766-a3d3-9ed624fa14bb/scratchpad/sbpkg/package/`。

## 踩雷點

- v2 破壞性變更：useSupabaseUser() / serverSupabaseUser() 回傳的是 JWT claims (JwtPayload) 而不是 User 物件。user.id 不存在，必須改用 user.sub。舊教學、舊 StackOverflow 答案幾乎全是 v1 寫法。identities / last_sign_in_at / email_confirmed_at 也不再直接可得，要另外呼叫 auth.getUser()。（來源：官方 migration 頁 + dist/runtime/server/services/serverSupabaseUser.js + demo/server/api/tasks.ts 用 user!.sub）
- redirectOptions.callback 千萬不要設成 '/'。模組在 setup 裡會無條件對 callback 路徑加 nitro routeRules { ssr: false }：`routeRules[mergedOptions.redirectOptions.callback] = { ssr: false }`。設成 '/' 等於把首頁的 SSR 關掉，filmnote 的 SEO 直接報廢。（issue #582；module.mjs 原始碼）
- redirectOptions 的 exclude/include pattern 不是 glob，是 `new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')`。全字串錨定、且 * 會吃掉斜線。所以 '/movie' 不會匹配 '/movie/123'（必須寫 '/movie/*'），而 '/u/*' 會同時匹配 '/u/david' 和 '/u/david/2026'。'*' 和 '**' 行為完全相同。這跟 Supabase Dashboard 的 Redirect URLs glob 語法（* 不跨 /、** 跨 /）**不一樣**，很容易搞混。
- include 若有值，會完全短路 exclude —— 不在 include 白名單的路徑直接放行，exclude 那段程式碼根本跑不到。兩者不是「先白名單再黑名單」的疊加關係。
- 全域 auth 中介層檢查的是 useSupabaseSession()（未經驗證、來自 client 的 session），不是驗簽過的 user。它是 UX 導引不是安全邊界。任何真正的授權都必須靠 RLS + server route 的 serverSupabaseUser()。同理 serverSupabaseSession 官方明文警告不可用來判斷是否登入。
- Google Cloud Console 的 Authorized redirect URIs 要填 Supabase 的 https://<project-ref>.supabase.co/auth/v1/callback，不是你自己的 /confirm。你的 /confirm 是填在 Supabase Dashboard 的 Redirect URLs allow list。這兩層搞混是最常見的 OAuth 設定失敗原因。
- signInWithOAuth 的 redirectTo 必須是已列入 Supabase Redirect URLs allow list 的絕對 URL，否則登入會靜默落回 Site URL。Vercel preview 部署要另外加 https://*-<team-slug>.vercel.app/** 這條 wildcard。
- cookieOptions.secure 預設 true，Safari 不接受 http://localhost 的 Secure cookie → 本機用 Safari 開發時 session 完全不持久（Chrome 正常，所以很難察覺）。修法：secure: process.env.NODE_ENV === 'production'。（issue #545 作者自己確認的結論，指向 #300）
- cookieOptions.maxAge 預設只有 60*60*8 = 8 小時。使用者八小時沒回來就被登出。對觀影紀錄這種低頻使用的產品體驗很差，應該調成一年。（module.mjs defaults 實讀）
- 必須用 @nuxtjs/supabase >= 2.0.9。2.0.0～2.0.8 在 ssr: false 的路由上 hard-refresh 會把已登入使用者踢回 /login（client plugin 的守衛寫成 if (!useSsrCookies) 而非 if (!currentSession.value)）。filmnote 打算對登入後路由下 routeRules ssr: false，正中這個 bug。（issues #605 / #611，2.0.9 修）
- 開放中的安全性問題 #635（2.0.10 仍未修）：dist/runtime/utils/fetch-retry.js 第三次重試失敗時會 console.error(..., safeInit)，safeInit 只 destructure 掉 headers 沒掉 body。/auth/v1/token?grant_type=refresh_token 的 body 含 refresh token，會被寫進 Vercel log / Sentry breadcrumb。refresh token 外洩等同 live session。上線前要麼 patch（pnpm patch 加一行 body: _body），要麼確保 log drain 有存取控制。
- 沒啟用 JWT signing keys（留在 HS256）時，getClaims() 會 fallback 成 getUser() 打 Auth server。而 supabase.server.js plugin 對「每一次 SSR 請求」都跑 getSession + getClaims → 每個已登入使用者的 SSR 頁面都多一次跨網路往返。務必在 Dashboard 啟用非對稱 signing keys 走 JWKS 本機驗簽。（未登入訪客不受影響：getClaims 在無 session 時直接 return，零網路。）
- types 選項預設 '~/types/database.types.ts'，Nuxt 4 的 ~ 指向 srcDir 也就是 app/，所以檔案實體位置是 app/types/database.types.ts。用 `supabase gen types ... > types/database.types.ts` 會產在專案根目錄、模組讀不到，型別靜默退化成 `Database = unknown`（只會有一行 logger.warn）。（issue #608）
- handle_new_user trigger 失敗會讓整個註冊失敗，使用者看到不透明的 'Database error saving new user'。filmnote 的 username 取 email @ 前綴且必須唯一 → 撞名是必然事件 → trigger 內必須自己處理衝突並包 exception when others then return new，絕不能讓它拋出。
- security definer set search_path = '' 兩者都不能省，而且加了 search_path='' 之後函式內每一個表都必須寫成 public.xxx 全名，否則會 relation does not exist。
- 公開頁 SSR 中呼叫自家 /api/** 時漏掉 headers: useRequestHeaders(['cookie'])，server 端就拿不到 JWT，serverSupabaseUser 回 null，SSR 出來的畫面像未登入、hydration 後才跳成登入態。四頁官方 service 文件都在強調這件事。
- serverSupabaseServiceRole 不是 async（直接回傳 client，不回 Promise），而且完全不做任何身分檢查。每次使用前必須自己用 serverSupabaseUser + serverSupabaseClient 先驗證呼叫者身分與權限。
- @supabase/ssr 的 createBrowserClient 把 flowType: 'pkce' 硬寫在 ...options?.auth 之後，所以 clientOptions.auth.flowType 設 'implicit' 是無效的（useSsrCookies: true 時）。

## 未能驗證

- 沒有實際 scaffold 一個 Nuxt 4.5.2 + @nuxtjs/supabase 2.0.10 專案跑起來驗證。所有結論來自官方文件、npm tarball 的 dist 原始碼、GitHub issues 與 playground/demo 原始碼的交叉比對，不是執行結果。
- 沒有實際到 Google Cloud Console 與 Supabase Dashboard 走一遍設定流程（需要真實帳號與專案）。Dashboard UI 的實際選單位置可能與文件描述有出入。
- issue #606（page:start 每次導航都 await getClaims()，JWKS 卡住就整個導航掛住）被回報者宣稱在 2.0.9 修好，但我核對 2.0.10 的 dist/runtime/plugins/supabase.client.js，`nuxtApp.hook('page:start', async () => { const { data } = await client.auth.getClaims(); ... })` 這段程式碼**仍然存在且仍然 await**。實務上 JWKS 有 in-memory 快取所以通常無感，但「JWKS 端點不可達時導航是否會 hang」我無法在不實跑的情況下確認。
- @nuxtjs/supabase 官方文件站沒有任何一頁講「hybrid rendering（逐路由 SSR/SPA 混合）」的建議設定，也沒有 SPA/CSR-only 章節（issue #605 明確指出這個文件缺口）。本報告中 routeRules 與 redirectOptions 的搭配方式是我從原始碼推導出來的，不是官方背書的做法。
- cookieOptions.maxAge 的實際續期行為（每次 token refresh 是否重寫 cookie 而延長 8 小時窗口）我只從 @supabase/ssr 的 setAll → h3 setCookie 路徑推測，沒有實測。保守假設是「8 小時未活動即登出」。
- Supabase 對 auth.users trigger 的效能上限、以及 Free tier 上大量並發註冊時 trigger 的行為，官方文件沒有數據，我也沒有實測。
- Vercel Hobby 上 SSR function 的冷啟動對 JWKS 快取的影響（每個 cold start 是否都要重抓一次 JWKS）沒有官方說明，也未實測。若冷啟動頻繁，已登入使用者的首個 SSR 請求仍可能多一次網路往返。
- filmnote SPEC 提到的「改名後舊網址 301 轉向」在 Supabase/Nuxt 層沒有現成機制，本報告只給了 username_history 表的建議 schema，沒有查證 Nuxt 端做 301（sendRedirect with 301 in server middleware vs route rules redirect）的最佳做法。
- 沒有查證 TypeScript 5.9.x 固定版本與 @nuxtjs/supabase 2.0.10 的相容性。值得注意的是模組自己的 repo devDependencies 用 typescript 6.0.3，但那是模組開發環境，不影響消費端；消費端固定 5.9.x 應該沒問題，但未驗證 dist/*.d.mts 是否用到 5.9 不支援的語法。
- issue #635 的 refresh token 洩漏問題我確認了 2.0.10 dist 的程式碼確實如 issue 所述，但沒有實際觸發三次失敗來觀察 log 輸出內容。
