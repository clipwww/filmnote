時要監聽 `useColorMode()` 並重新 `setOption()`（圖表色是 JS 端算的，CSS 的 `.dark` 切換管不到 canvas 裡面）。

**怎麼確認它對了**
- `/u/{別人}` 的統計不含私密紀錄；`spend_is_partial` 為 `true` 時 UI 顯示「部分票價未公開」而非直接呈現總額。
- 未登入者打 `POST /rest/v1/rpc/user_year_stats` 拿到的 `totals.spend` 只涵蓋已開放的票價（`SECURITY INVOKER` 生效）。
- 手機寬度（375px）下貢獻圖與熱力圖仍可讀（US-43）。
- 切換 dark mode，圖表軸線/文字顏色跟著變，且**滑過長條圖不會整條變空白**（oklch 陷阱的實測驗收）。
- `UModal` 內的圖表開關兩次仍正常（`unmount-on-hide` 預設 true，安全；若改成 false 必須手動 `chart.resize()`）。

---

### Step 7 — UGC 作品與管理審核

**做**
1. `/app/films/new`：只填片名 + 年份（US-14），海報選填上傳到 `ugc-poster-pending/{uid}/{film_id}.{ext}`。
2. `server/api/admin/films/[id]/approve.post.ts` —— **這是提案 1 沒做完的那一步，必須實作**：

```ts
// server/api/admin/films/[id]/approve.post.ts
import { serverSupabaseClient, serverSupabaseServiceRole, serverSupabaseUser } from '#supabase/server'

export default defineEventHandler(async (event) => {
  const user = await serverSupabaseUser(event)
  if (!user) throw createError({ statusCode: 401 })

  const filmId = getRouterParam(event, 'id')!
  const { slug } = await readBody<{ slug?: string }>(event)
  const admin = serverSupabaseServiceRole(event)

  // 授權判斷交給 RPC 內的 app.is_admin()；這裡先讀資料
  const { data: film } = await admin
    .from('film').select('id, poster_source, poster_path').eq('id', filmId).single()
  if (!film) throw createError({ statusCode: 404 })

  // ① 海報從 pending 搬到公開 bucket（RPC 不做這件事，漏了會 404）
  let publicPath: string | null = null
  if (film.poster_source === 'ugc' && film.poster_path) {
    const { error: copyErr } = await admin.storage
      .from('ugc-poster-pending')
      .copy(film.poster_path, film.poster_path, { destinationBucket: 'ugc-poster' })
    if (copyErr) throw createError({ statusCode: 500, statusMessage: copyErr.message })
    publicPath = film.poster_path
    await admin.storage.from('ugc-poster-pending').remove([film.poster_path])
  }

  // ② 以「使用者身分」的 client 呼叫 RPC —— is_admin() 才有正確的 auth.uid()
  const client = await serverSupabaseClient(event)
  const { error } = await client.rpc('admin_approve_film', { p_film: filmId, p_slug: slug ?? null })
  if (error) throw createError({ statusCode: 403, statusMessage: error.message })

  if (publicPath) await admin.from('film').update({ poster_path: publicPath }).eq('id', filmId)
  return { ok: true }
})
```

3. `/admin` 審核佇列用 `UTable`（`virtualize` 需給容器確定高度）。
4. `/admin/films/merge` 呼叫 `admin_merge_film`。

**怎麼確認它對了**
- 建立 UGC 作品後：**無痕視窗看不到**、自己看得到、可立刻用於記錄（US-16/17）。
- 未審核作品的海報：`GET https://<ref>.supabase.co/storage/v1/object/public/ugc-poster/{uid}/{id}.jpg` → 404 / 403（不得可取）。
- `curl "$URL/rest/v1/film_identity?select=key" -H "apikey: $ANON" | grep -c '<你的私有片名切片>'` → 0（slug 不外洩片名）。
- 審核通過後：作品進公共片庫、海報改由 `ugc-poster` 公開 bucket 供應且**不在 pending bucket**、`slug` 已指派、`film_identity` 多一筆 `slug:`。
- 合併兩部作品後：`viewing_record` 一列都沒少、敗方的 `gov:` 鍵指向存活者；**再跑一次 `pnpm seed` 不會復活出重複列**。
- 非 admin 帳號呼叫 `admin_approve_film` → 42501。

---

### Step 8 — 法遵頁面與 DMCA 流程

**做**（詳見第 5 節的落點表）建立四類頁面與兩支 API，並在 `legal_document` 塞入第一版條款（含 `content_sha256`），`app/layouts/default.vue` 的頁尾加上顯名聲明。

**怎麼確認它對了**
- `/legal/copyright` 上有可讀的聯繫窗口（`copyright@filmnote.tw`）與完整的通知/取下/回復流程說明。
- 未登入者可提交侵權通知：
  ```bash
  curl -X POST "$URL/rest/v1/dmca_notice" -H "apikey: $ANON" \
    -H "Prefer: return=minimal" -d '{...}'    # → 201
  curl "$URL/rest/v1/dmca_notice?select=*" -H "apikey: $ANON"   # → 401/[]（只寫不讀）
  ```
  **不帶 `Prefer: return=minimal` 會失敗**——這是刻意的（沒有 SELECT policy 就拿不到 RETURNING），確保這張表在 API 層是單向的。
- `admin_takedown` 後：該紀錄/作品在公開頁**立即**消失（US-52），且該作品所有引用它的公開紀錄與票價也一併消失。
- `admin_add_strike` 第三次後：`profile.status = 'suspended'`，該使用者的個人頁與所有公開紀錄立即不可讀。
- `admin_restore` 後：內容回復、`visibility` 一併還原（不是「沉默的半回復」）、該次三振被 `voided`。
- `dmca_counter_notice` 填 `forwarded_at` 後，`litigation_proof_due_at` 與 `restore_due_at` 自動算出（10 / 14 個工作日）。

---

### Step 9 — TMDB 六個月刷新排程

**做**
1. `server/api/cron/tmdb-refresh.get.ts`：驗 `Authorization: Bearer ${cronSecret}` → 取 `film_tmdb_snapshot where state <> 'gone' and next_refresh_at <= now()` 前 N 筆 → 打 TMDB → 寫回 `state='fresh'`、`fetched_at=now()`、`expires_at=now()+180d`、`next_refresh_at=now()+150d`；失敗則 `attempts+1`、`next_refresh_at` 指數退避。
2. 刷新後只覆寫 `title_zh_source='tmdb'` 或空字串的 `film` 欄位（政府核准片名不得被洗掉）。
3. `server/api/cron/tmdb-purge.get.ts` → `purge_expired_tmdb_cache()`。
4. `vercel.json`：
```json
{ "crons": [
  { "path": "/api/cron/tmdb-refresh", "schedule": "0 */6 * * *" },
  { "path": "/api/cron/tmdb-purge",   "schedule": "17 3 * * *" }
] }
```

**怎麼確認它對了**
- 手動把某列 `expires_at` 設成過去 → 重整 `/film/{slug}` → **海報與簡介變成 NULL（退回文字卡片），而不是繼續供應逾期快取**。這證明合規靠的是讀取端 view 的把關，不是「cron 一定會跑」。
- 跑一次 refresh → 該列 `state='fresh'`、`expires_at` 往後推；**政府核准的 `title_zh` 沒有被 TMDB 的中文標題覆蓋**。
- TMDB 被節流（429）時 job 不會整批失敗，只推遲 `next_refresh_at`。

---

### Step 10 — 舊 log 資料匯入（US-56/57/58）

**做**：`/app/import` 上傳 CSV/JSON → 走接縫 A 的比對器 → 產生預覽（已比對 / 未比對）→ 確認後以 `import_key` 寫入 `viewing_record`（`unique (user_id, import_key)` 保證重跑冪等）。

**怎麼確認它對了**：同一份檔案匯入兩次，紀錄總數不變；未比對到的片明列出來並可一鍵建 UGC 作品。

---

### Step 11 — 部署 Vercel

**做**
1. Vercel 專案 Framework Preset = Nuxt.js（自動偵測），Build Command 保持預設 `nuxt build`（**絕不改成 `nuxt generate`**）。
2. **不要設 `NITRO_PRESET`**。
3. Node.js Version 設 22.x 或 24.x（`nuxt@4.5.2` engines 是 `^22.19.0 || ^24.11.0 || >=26.0.0`，停在 20.x 會裝不起來）。
4. 環境變數照 2.7 設；`NUXT_PUBLIC_SITE_URL` 改成正式網域。
5. Supabase Redirect URLs 補上 `https://*-<team-slug>.vercel.app/**`。

**怎麼確認它對了**
- 正式站 Google 登入完整走通。
- `curl -I https://filmnote.tw/app` → 有 `x-robots-tag: noindex, nofollow`。
- `curl -I https://filmnote.tw/film/{slug}` → 第二次有 `x-vercel-cache: HIT`。
- `curl -I https://filmnote.tw/u/{username}` → **沒有** `x-vercel-cache`。
- 重跑 Step 4 的「票價 SSR 洩漏測試」，這次打正式站。
- `/legal/terms` 與 `/` 是靜態（build 時已產生）。

---

# 5. 法遵要件的落點

## 5.1 ISP 避風港四要件（著作權法 §90-4）

| 要件 | 落點 | 具體內容 |
|---|---|---|
| **① 服務條款告知著作權保護措施，並確實履行** | `app/pages/legal/terms.vue`（prerender）<br>`public.legal_document` (kind='terms')<br>`public.legal_acceptance` | 條款正文含「著作權保護措施」專章。**版本與 `content_sha256` 寫進 `legal_document`**，使用者首次登入後在 `/app` 顯示一次性同意，寫入 `legal_acceptance`。<br>沒有這兩張表，日後無從舉證「已於侵權發生時告知」。 |
| **② 三振條款（三次侵權終止服務）** | `app/pages/legal/terms.vue` 明文條列<br>`public.copyright_strike` + `app.tg_apply_strike()` + `profile.status`<br>`app/pages/app/notices.vue` | 條款須明白寫出「三次涉有侵權情事應終止全部或部分服務」。<br>技術落點：`admin_add_strike()` → 第 2 次 `status='limited'`、第 3 次 `status='suspended'`。停權後 `profile_select` 與 `viewing_record_select` 都檢查 `status`，其公開內容**立即**消失，不需要另一支批次工作。 |
| **③ 公告接收侵權通知的聯繫窗口** | `app/pages/legal/copyright.vue`（prerender）<br>`app/layouts/default.vue` 頁尾常駐連結 | 頁面須載明：窗口電子郵件 `copyright@filmnote.tw`、聯絡地址、受理程序、所需記載事項（§90-6 及施行辦法）。**必須是全站每一頁都能到達的連結**。 |
| **④ 通知／取下／回復通知流程** | 通知表單：`app/pages/legal/copyright/notice.vue` + `server/api/legal/notice.post.ts` → `public.dmca_notice`<br>取下：`public.admin_takedown()`（`moderation_state='removed'`，**不是 DELETE**）<br>通知使用者：`dmca_notice.notified_user_at` + `app/pages/app/notices.vue`<br>回復通知：`app/pages/legal/copyright/counter/[id].vue` → `public.dmca_counter_notice`<br>期限計算：`app.business_days_after()` trigger<br>回復：`public.admin_restore()` | **取下一律是狀態不是 DELETE** —— 刪掉就永遠無法履行 §90-9 的回復義務，這是 schema 層事後補不回來的錯誤。<br>`forwarded_at` 一填，trigger 自動算出 `litigation_proof_due_at`（+10 工作日）與 `restore_due_at`（+14 工作日），各處實作不會漂移。<br>`admin_restore()` 同時回復內容、還原 `visibility`、撤銷該次三振。 |

## 5.2 其他法遵落點

| 項目 | 落點 |
|---|---|
| **海報一律熱連結 `image.tmdb.org`，不自行轉存** | `app/components/FilmPoster.vue` 是**唯一**組出海報 URL 的地方：`poster_source='tmdb'` → `https://image.tmdb.org/t/p/{size}{path}`；`'ugc'` → Supabase public bucket；`'none'` → 文字卡片。<br>**不要用 `nuxt-og-image` 把 TMDB 海報 pipe 進自己的 OG 生成器**——那等同轉存。OG 圖只用純文字卡片或 TMDB 原圖直連。 |
| **海報顯示不得置於付費牆之後**（§90-7 第 2 款） | 本階段**不建立任何 subscription / entitlement 表**。`film_public` view 與 `ugc-poster` bucket 一律 `GRANT SELECT TO anon` / `public: true`。<br>日後若加付費牆，必須撤銷 anon 的 grant——那是一次顯眼、需要 migration、會被 review 看到的決定，不會是誰隨手加個判斷就發生。 |
| **政府開放資料顯名聲明** | `app/layouts/default.vue` 頁尾（`UFooter` / `UFooterColumns`）：<br>「本站部分資料採用文化部影視及流行音樂產業局『電影片分級及相關資訊』與『全國電影院資料』開放資料，依政府資料開放授權條款第 1 版提供。」<br>⚠️ **未盡顯名標示義務者視為自始未取得授權**——這行不可省。 |
| **TMDB attribution** | 同頁尾：TMDB logo（**須 less prominent than 本站標誌**）+ 「This product uses the TMDB API but is not endorsed or certified by TMDB.」 |
| **Vercel Hobby 商業使用禁令** | 本階段站上**不得**宣傳未來收費、不得放贊助/捐款管道（Hobby 的定義涵蓋「宣傳未來要收費的產品」與「接受捐款」）。收費時同步升級 Vercel Pro + TMDB 商業訂閱。 |
| **TMDB 快取 ≤ 6 個月** | `film_tmdb_snapshot.expires_at` 預設 180 天（< 6 個月，留安全邊際）；`film_public` view 讀取時以 `case when s.expires_at > now()` 把關；`purge_expired_tmdb_cache()` 為第二道防線。 |
| **DMCA 表單防濫發** | `server/api/legal/notice.post.ts` 必須加 Turnstile 或 rate limit —— `anon` 可 INSERT `dmca_notice` 是法定義務，但**資料庫層完全沒有防護**。 |
| **`memo` 為使用者自由文字且預設公開** | schema 只做長度限制（2000 字），內容審核不在資料庫層；靠 §90-4 的通知/取下流程處理。 |

---

# 6. 已知踩雷點

## 6.1 Nuxt / 算繪

| # | 踩雷點 | 來源 |
|---|---|---|
| 1 | **`/u/**` 絕不可加 `isr` / `swr`。** Nitro v2 快取「all incoming request headers are dropped when handling cached responses」，cache key 只由 `group:name:getKey` 組成，cookie 不在 key 裡；Vercel ISR 也以「路徑」為單位。同一個 `/u/{username}` 對作者與路人會 render 出不同 HTML → 作者先造訪就把含票價的 HTML 寫進 CDN | `v2.nitro.build/guide/cache`、`vercel.com/docs/incremental-static-regeneration` |
| 2 | **`nuxt generate` 不能用。** 官方原文：「Hybrid Rendering is not available when using `nuxt generate`」；Vercel 比較表也標明它不支援 SSR、不支援 ISR。Build command 必須維持 `nuxt build` | `nuxt.com/docs/4.x/guide/concepts/rendering`、`vercel.com/docs/frameworks/full-stack/nuxt` |
| 3 | **`ssr: false` 路由的 `<meta name="robots">` 只在 hydration 後存在**，爬蟲第一次抓到的是空殼。必須用 HTTP header `x-robots-tag` | 同上 |
| 4 | **`app/spa-loading-template.html` 不在專案根目錄。** 文件寫 `~/spa-loading-template.html`，而 Nuxt 4 的 `~` = `<rootDir>/app`（srcDir 預設 `"app"`）。放錯位置 → `ssr:false` 路由是純白畫面直到 JS 下載完 | `nuxt.com/docs/4.x/api/nuxt-config` |
| 5 | **算繪模式無法寫在頁面元件裡。** `definePageMeta` 的 `PageMeta` 介面沒有 `ssr`；Vercel 也明講「there is no way to configure route deployment options within your page components」。重構搬檔案時很容易忘了同步更新 `routeRules` 的 pattern | `nuxt.com/docs/4.x/api/utils/define-page-meta` |
| 6 | **`useServerSeoMeta` 已 deprecated**，且在 `future.compatibilityVersion: 5` 之下 auto-import 會被移除。新程式一律寫 `if (import.meta.server) { useSeoMeta({...}) }` | `nuxt.com/docs/4.x/api/composables/use-server-seo-meta` |
| 7 | **`useSeoMeta` 的反應式值必須用 getter 語法 `() => value`。** 直接傳 `film.value.title_zh` 只抓到 render 當下的快照 | `nuxt.com/docs/4.x/api/composables/use-seo-meta` |
| 8 | **`isr` 的 `allowQuery` 留 undefined 會快取爆炸。** 每個不同 query string 值都產生一份獨立快取 → 被人用 `?a=1&a=2…` 打就吃光 Hobby 的 ISR write 額度。`/film/**` 必須明確設 `allowQuery: []` | `v2.nitro.build/deploy/providers/vercel` |
| 9 | **Vercel 明確要求 Nuxt 用 `isr` 而非 `swr`**：「The `isr` option enables Nuxt to use Vercel's Cache」。寫成 `swr` 會退化成只有 Cache-Control header | `vercel.com/docs/frameworks/full-stack/nuxt` |
| 10 | **使用 `isr`/`swr` 的路由會額外產生 `_payload.json`**，內容是 `useAsyncData`/`useFetch` 的序列化結果。SSR 時若把票價塞進 payload，就算 HTML 沒顯示，`_payload.json` 也會被快取並公開可讀。**RLS 必須在資料層擋掉，不能只在 template 用 `v-if` 隱藏** | `nuxt.com/docs/4.x/getting-started/prerendering` |
| 11 | **`vercel_edge` preset 已 deprecated。** 不要為了效能設 `NITRO_PRESET=vercel-edge` | `v2.nitro.build/deploy/providers/vercel` |
| 12 | **Node 版本要對齊。** `nuxt@4.5.2` engines `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`；Vercel 專案停在 20.x 會裝不起來 | npm registry |

## 6.2 Supabase / Auth

| # | 踩雷點 | 來源 |
|---|---|---|
| 13 | **v2 破壞性變更：`useSupabaseUser()` / `serverSupabaseUser()` 回傳的是 JWT claims，不是 User 物件。`user.id` 不存在，必須用 `user.sub`。** 舊教學與 StackOverflow 答案幾乎全是 v1 寫法。`identities` / `last_sign_in_at` / `email_confirmed_at` 也不再直接可得 | 官方 migration 頁；`dist/runtime/server/services/serverSupabaseUser.js`；issue #561 |
| 14 | **`redirectOptions.callback` 千萬不要設成 `'/'`。** 模組在 setup 裡會無條件對 callback 路徑加 `routeRules[callback] = { ssr: false }`，設成 `'/'` 等於把首頁 SSR 關掉 | issue #582；`dist/module.mjs` |
| 15 | **`include`/`exclude` pattern 不是 glob，是 `new RegExp('^' + pattern.replace(/\*/g,'.*') + '$')`。** `'/app'` 不會匹配 `/app/new`；`'*'` 和 `'**'` 行為完全相同；**這跟 Supabase Dashboard 的 Redirect URLs glob 語法（`*` 不跨 `/`、`**` 跨 `/`）不一樣** | `dist/runtime/plugins/auth-redirect.js` |
| 16 | **`include` 有值時會完全短路 `exclude`** —— 不在白名單的路徑直接放行，`exclude` 那段程式碼根本跑不到。兩者不是疊加關係 | 同上 |
| 17 | **全域 auth 中介層檢查的是 `useSupabaseSession()`（未經驗證、來自 client），不是驗簽過的 user。它是 UX 導引不是安全邊界。** 真正的授權必須靠 RLS + `serverSupabaseUser()` | 同上；官方 `serverSupabaseSession` 文件的警告 |
| 18 | **Google Console 的 Authorized redirect URIs 要填 `https://<ref>.supabase.co/auth/v1/callback`，不是你自己的 `/confirm`。** 你的 `/confirm` 是填在 Supabase Dashboard 的 Redirect URLs allow list。這兩層搞混是最常見的 OAuth 失敗原因 | `supabase.com/docs/guides/auth/social-login/auth-google` |
| 19 | **`cookieOptions.secure` 預設 `true`，Safari 不接受 `http://localhost` 的 Secure cookie** → 本機用 Safari 開發 session 完全不持久（Chrome 正常，所以很難察覺） | issue #545 |
| 20 | **`cookieOptions.maxAge` 預設只有 8 小時。** 對觀影紀錄這種低頻產品體驗很差 | `dist/module.mjs` defaults |
| 21 | **必須用 `@nuxtjs/supabase >= 2.0.9。** 2.0.0–2.0.8 在 `ssr: false` 路由上 hard-refresh 會把已登入使用者踢回 `/login`。本專案對 `/app/**` 下 `ssr:false`，正中這個 bug | issues #605 / #611 |
| 22 | **開放中的安全性問題 #635（2.0.10 仍未修）**：`dist/runtime/utils/fetch-retry.js` 第三次重試失敗時 `console.error(..., safeInit)`，`safeInit` 只 destructure 掉 `headers` 沒掉 `body`。`/auth/v1/token?grant_type=refresh_token` 的 body 含 refresh token，會被寫進 Vercel log / Sentry。**上線前要麼 patch（`pnpm patch` 加一行 `body: _body`），要麼確保 log drain 有存取控制** | GitHub issue #635（實核 2.0.10 dist） |
| 23 | **沒啟用 JWT signing keys（留在 HS256）時，`getClaims()` 會 fallback 成 `getUser()` 打 Auth server**，而 server plugin 對每一次 SSR 請求都跑 `getSession + getClaims` | `auth-js` `GoTrueClient.getClaims()` 實作 |
| 24 | **`types` 預設 `'~/types/database.types.ts'`，Nuxt 4 的 `~` = `app/`**。用 `> types/database.types.ts` 會產在根目錄、模組讀不到，型別靜默退化成 `Database = unknown`（只有一行 `logger.warn`） | issue #608 |
| 25 | **SSR 中呼叫自家 `/api/**` 漏掉 `headers: useRequestHeaders(['cookie'])`** → server 拿不到 JWT → `serverSupabaseUser` 回 null → SSR 畫面像未登入，hydration 後才跳。四頁官方 service 文件都在強調 | `supabase.nuxtjs.org/services/*` |
| 26 | **`serverSupabaseServiceRole` 不是 async**（直接回 client），而且**完全不做任何身分檢查**。每次使用前必須自己驗證呼叫者身分 | 官方文件 |
| 27 | **`handle_new_user` trigger 失敗會讓整個註冊失敗**，使用者看到不透明的 `Database error saving new user`。username 撞名是必然事件（`david@gmail.com` vs `david@outlook.com`），trigger 內必須自己處理衝突並包 `exception when others then return new` | `supabase.com/docs/guides/auth/managing-user-data`（官方 caution） |
| 28 | **`security definer` + `set search_path = ''` 兩者都不能省**，且加了 `search_path=''` 之後函式內每個表都必須寫 `public.xxx` 全名，否則 `relation does not exist` | 同上 |

## 6.3 資料庫 / RLS（本次評審實際找到的）

| # | 踩雷點 | 來源 |
|---|---|---|
| 29 | **`alter default privileges ... revoke execute on functions from anon, authenticated` 是無效的。** Postgres 新函式的預設 EXECUTE 授予的是 **PUBLIC**。寫錯對象 → 下一次 migration 新增的任何 public schema RPC 預設就是 anon 可呼叫 | 評審 leak 視角，提案 1 §0.1 |
| 30 | **絕不用 `auth.uid() is null` 當「service_role 直連，放行」的判準。** anon 的 `auth.uid()` 同樣是 NULL —— 這個條件把守門邏輯對未登入者整組關掉。提案 3 因此讓 anon 可呼叫 `link_film_to_tmdb` → `merge_films` 做未認證的破壞性寫入 | 評審 leak 視角 |
| 31 | **也不能用 `current_user` 判斷特權情境。** 所有 SECURITY DEFINER 函式的 owner 都是 postgres → 任何日後新增的 definer 寫入函式會讓 guard 觸發器整組跳過。用 `session_user` + 顯式 transaction-local 旗標 | 評審 leak 視角 |
| 32 | **Postgres 的 view 預設以「擁有者」權限執行 = 完全繞過 RLS。** 在 public 建一個忘了 `security_invoker=true` 的 view，就是把整張底表經 PostgREST 全站公開 | PG 文件；提案 1 §6 |
| 33 | **絕不對 SELECT 做欄位級 `revoke`。** 一旦 `revoke select (cost)`，PostgREST 預設的 `select=*` 直接 `permission denied`，而且錯誤訊息沒有任何上下文 | 評審 practical 視角（提案 2 的正確判斷） |
| 34 | **RLS 的 `WITH CHECK` 只看得到 NEW，看不到 OLD**，因此無法表達「這個欄位不准被改」。必須靠 BEFORE 觸發器補上 | 評審 leak 視角 |
| 35 | **`film.tmdb_id` 的 UNIQUE 是存在性 oracle。** 若允許使用者填寫，即使目標列是私有的，唯一鍵衝突仍會照樣回報 →「這部 TMDB 電影在不在庫裡」的查詢器，並可搶佔尚未匯入的 id | 提案 1 rationale |
| 36 | **確定性字串鍵不可當 PK。** `tmdb:<id>` / `gov:<zh>:<orig>` 是可猜測的字串；當 PK 時 FK 檢查（繞過 RLS）就成了私有作品的存在性探測器 | 提案 1 rationale |
| 37 | **slug 會外洩片名。** `slugify(title)` 寫進 `film_identity` 後，若該表 `using (true)`，一次查詢就倒出全部未審核私有作品的片名切片 | 評審 leak 視角（提案 3 的缺陷） |
| 38 | **`ugc-poster` 設 `public: true` + anon 可 select `storage.objects` → 未審核海報全網可列舉。** Supabase 的物件列舉走 `storage.objects` 的 RLS | 評審 leak 視角 |
| 39 | **policy 裡的 STABLE 函式呼叫必須包成 `(select f())`。** 直接寫 `auth.uid()` 是逐列求值 —— 幾百列的年度查詢就是幾百次 `request.jwt.claims` 的 JSON 解析。包成純量子查詢後 planner 提成 InitPlan 只求值一次 | 提案 2 rationale |
| 40 | **`create type` 不可全部擠在同一個 `DO ... exception when duplicate_object` block。** 第一個 duplicate 就會 abort 整個 block，後面的型別全部不會建立，而且是靜默的 | 評審 practical 視角 |
| 41 | **Materialized view 無法套用 RLS**（沒有 `ALTER MATERIALIZED VIEW ... ENABLE RLS`）。本計畫因此完全不用 MV；若日後要加，必須放進不掛進 PostgREST `db-schemas` 的 schema，且來源只取公開列 | 提案 2 rationale |
| 42 | **聚合是推論通道不是安全邊界。** 一支 `SECURITY DEFINER` 的 `sum(cost)` 會把 RLS 擋下的資料以總額形式漏光。統計 / 匯出 RPC 一律 `SECURITY INVOKER` | 提案 1 rationale |
| 43 | **`timestamptz AT TIME ZONE 'Asia/Taipei'` 是 STABLE**（IANA tzdata 會改版），不能用於 generated column 或索引運算式；`AT TIME ZONE INTERVAL '8 hours'` 才是 IMMUTABLE。本計畫用 `date` + `time` 避開整個問題 | 提案 2 rationale（volatility 對照表） |
| 44 | **`permit_no` 不能當主鍵。** 110–112 年 CSV 無系列前綴，四系列各自從 001 編號而大量撞號（128/143/157 筆） | SPEC |
| 45 | **`create policy ... on storage.objects` 需要 `storage.objects` 的擁有權。** Supabase SQL Editor 通常可以，CLI migration 偶爾需要 `supabase_admin` | 提案 1 自陳風險 |
| 46 | **`delete from auth.users` 是否為 postgres 角色可執行需實測。** 若否，帳號刪除須改走 Edge Function + Admin API | 同上 |

## 6.4 Nuxt UI / ECharts

| # | 踩雷點 | 來源 |
|---|---|---|
| 47 | **ECharts 完全看不懂 oklch。** Tailwind 4.3.3 與 Nuxt UI 的所有 token 都是 `oklch()`，而 `zrender@6.1.0` 的 `parse()` switch 只有 rgba/rgb/hsla/hsl 四個 case，其餘 `default: return;`。症狀極隱蔽：靜態填色因瀏覽器原生支援看起來正常，一旦走到 hover emphasis / LinearGradient / **visualMap** / 色彩動畫就整條變空白。貢獻圖與熱力圖必用 `VisualMapComponent`，它就是走插值路徑 | `apache/echarts#20757`（2025-02-13 開，仍 open）；解 tarball 實讀 `zrender/lib/tool/color.js` |
| 48 | **`zrender` 的 `parse()` 先 `replace(/ /g,'')` 再 `.split(',')`** → 連 `rgb(0 0 0)` / `hsl(229deg 73% 50%)` 這類現代空白分隔語法都解析失敗。傳給 ECharts 的顏色一律 hex 或舊式 `rgba(r, g, b, a)` | `apache/echarts#19604`（仍 open） |
| 49 | **Tailwind 4 的 cascade layer 造成優先權行為反轉：未分層 CSS 必勝所有 `@layer utilities`，無視 specificity 與順序。** Vue SFC 的 `<style scoped>` 經 Vite 處理後是未分層的 → `.chart{height:100%}` 靜靜蓋掉 `h-[400px]` → 容器 0 高 → ECharts 初始化成 0×0 空白圖 | Tailwind compatibility 頁 + CSS Cascade Layers 規範 |
| 50 | **`USelectMenu` / `UInputMenu` / `UListbox` 的搜尋不是 fuse.js**，是 reka-ui 的 `useFilter`（`Intl.Collator`, `sensitivity:'base'`），子字串比對而非模糊比對。3,000+ 筆片庫且要同時比中文／原文的搜尋務必設 `ignore-filter` + `v-model:search-term` | 解 tarball 實讀 `dist/runtime/composables/useFilter.js` |
| 51 | **`USelectMenu` 預設把整個 item 物件綁進 v-model**，要綁單一欄位必須顯式加 `value-key`。`filter-fields` 預設只有 `[labelKey]` | `ui.nuxt.com/docs/components/select-menu` |
| 52 | **`UInputDate` / `UInputTime` / `UCalendar` 的 `locale` prop 在 v4.2.0 被拿掉，v4.8.2 才修回來。** pin 在 4.2.0–4.8.1 之間繁中日期格式會壞掉。用 `^4.11.0` | Release notes #5432 / #6546 |
| 53 | **`UCalendar` 本身沒有時間選擇 UI。** `watched_time` 需要日期＋時間，正解是 `UInputDate granularity="minute"`（v4.2.0 才有的新元件），不是舊教學的 `UPopover` + `UCalendar` | `ui.nuxt.com/docs/components/input-date` |
| 54 | **`UTable` 啟用 `virtualize` 時必須給容器確定高度**（官方原文：「A height constraint is required」），且啟用後**不支援 row pinning** | `ui.nuxt.com/docs/components/table` |
| 55 | **`@nuxt/fonts` / `@nuxt/icon` / `@nuxtjs/color-mode` 是 `@nuxt/ui` 的 bundled dependency 並自動註冊**，另外裝或加進 modules 會衝突 | 解 tarball 實讀 |
| 56 | **`tailwindcss` 同時列在 `@nuxt/ui` 的 dependencies 與 peerDependencies**，官方安裝指令明確要求裝成直接相依，不能只靠 bundled 那份 | `ui.nuxt.com/docs/getting-started/installation/nuxt` |
| 57 | **SSR 頁面上的 color mode 切換器會 hydration mismatch**，官方範例把它包在 `<ClientOnly>` + fallback div 裡 | `ui.nuxt.com/docs/getting-started/color-mode/nuxt` |
| 58 | **程式化開 Modal / Slideover（`useOverlay()`）、Toast、Tooltip 都需要 `app.vue` 有 `<UApp>`。** 漏掉不會有錯誤訊息，只是不動 | `ui.nuxt.com/docs/components/modal` |
| 59 | **`USidebar` / `UDashboardPanel` 收合時 window 尺寸沒變，`window.resize` 不會觸發。** 用 `vue-echarts` 的 `autoresize` prop（底層 ResizeObserver） | `github.com/ecomfe/vue-echarts` README |
| 60 | **`.client.vue` 只在 auto-import 或從 `#components` import 時才生效。** 用真實路徑 explicit import 會**靜默**變成 SSR 元件然後 canvas 在 Node 裡爆掉——很難 debug 的失效模式。SSR 頁一律用 `<ClientOnly>` | `nuxt.com/docs/4.x/directory-structure/app/components` |
| 61 | **`<ClientOnly>` 的 default slot 內容會從 server build 被 tree-shake**，官方註明「any CSS used by components within it may not be inlined」→ 圖表容器樣式可能晚一拍才套上。務必用 `#fallback` 給固定高度骨架 | `nuxt.com/docs/4.x/api/components/client-only` |
| 62 | **Nuxt UI 的 locale 具名匯出是底線 `zh_tw`**，不是 `'zh-tw'` | 解 tarball 實讀 `dist/runtime/locale/` |
| 63 | **v3→v4 已改名**：`ButtonGroup` → `FieldGroup`、`PageMarquee` → `Marquee`、`PageAccordion` 移除；`UForm` 的 `nullify` → `nullable`，巢狀 form 現在必須顯式加 `nested` 與 `name`。抄 2025 年的部落格範例會踩到 | `ui.nuxt.com/docs/getting-started/migration` |
| 64 | **`UForm` 不內建任何驗證函式庫**（官方明確警告）。`zod` peer 範圍 `^3.24.0 \|\| ^4.0.0`，要自己裝 | `ui.nuxt.com/docs/components/form` |

## 6.5 資料匯入（來自 SPEC 實測）

| # | 踩雷點 |
|---|---|
| 65 | 包裝 JSON 與 CSV **皆為 UTF-8 with BOM**，直接 `JSON.parse` 會失敗 |
| 66 | 包裝 JSON 的 `FileName` 欄位是陷阱：只指向**最舊**的年度；真正的逐年 CSV 藏在 `相關檔案` 欄位的 `名稱(URL);…` 字串 |
| 67 | CSV **必須以陣列模式解析並偵測欄數**，用 `columns: true` 會靜默錯位（《劇場版IDOLiSH7》原文片名含逗號未被引號包住） |
| 68 | 年份**不可作硬篩**（《紅豬》核准 113 年、TMDB 1992），只加分不懲罰 |
| 69 | TMDB 的 `original_title` 常為母語而非英文（政府給 `Porco Rosso`、TMDB 存 `紅の豚`）→ 必須雙查詢 |
| 70 | **缺少片長交叉驗證會產生假陽性**（《一屍到底》配到 `Making Of One Cut of the Dead`、《貓的報恩》配到 `Batman Returns`） |
| 71 | **TMDB 免費 key 在規模化匯入時會被節流**（實測後跑的批次慢約 6 倍）。管線必須可中斷可續跑 |
| 72 | **Supabase 免費專案閒置 7 天會自動暫停。** 上線前須以排程 ping 維持活躍 |

---

# 7. 未能驗證事項（執行者必須自行確認）

## 7.1 資料庫（最高優先）

1. **本文件的 SQL 未在真實 Postgres 上執行過。** 第一件事就是 `supabase db reset` 對本機專案跑一次，逐檔確認。特別留意：
   - `create policy ... on storage.objects` 是否需要 `supabase_admin`（CLI migration 偶爾會權限不足）。
   - `delete from auth.users` 是否為 postgres 可執行；若否，`delete_my_account()` 必須改走 Edge Function + Admin API。
   - `app.tg_apply_strike()` 內對 `public.profile` 的 UPDATE 會觸發 `tg_profile_guard`；本計畫已在該函式開頭 `set_config('app.guard_bypass','on',true)`，但需實測確認 transaction-local 旗標在 AFTER trigger 情境下確實生效。
2. **`app.is_privileged_context()` 的三個判準需逐一實測**：
   - PostgREST + service_role key → `current_user` 是否確實為 `'service_role'`。
   - PostgREST + user JWT 呼叫 SECURITY DEFINER 函式 → `session_user` 是否確實為 `'authenticator'`（而非 postgres）。
   - `supabase db reset` / seed 腳本 → `session_user` 是否為 `'postgres'`。
   若任一不符，guard 觸發器會在錯誤的方向失效（要麼擋住 seed，要麼放行使用者）。
3. **Vercel ISR 是否會把 cookie 納入快取 key，官方文件從未明文說明。** 「`/u/**` 不可快取」的結論是綜合 Nitro v2 cache 文件與 Vercel ISR 文件推導出來的工程判斷。**上線前務必實測**：登入後造訪 `/u/{自己}`，再用無痕視窗打同一網址，確認拿不到含票價的 HTML。
4. **`viewing_record_select` 的 policy 內含 EXISTS 子查詢**（檢查 film 狀態）。在數千列規模應是 semi-join，但需以 `EXPLAIN (ANALYZE, BUFFERS)` 對真實資料量確認沒有退化成逐列求值。若成為瓶頸，備案是把 `film_public` 反正規化到 `viewing_record`——但那會引入一致性風險且**失敗方向指向外洩**（提案 2 的教訓），非不得已不做。
5. **`app.cost_visible_to_caller(uuid)` 對 anon 開放 EXECUTE 形成一個 oracle**（「這個 record_id 是否為公開且已開票價」）。record_id 是 UUID 實務上不可猜測，且 `app` schema 不在 PostgREST 曝露清單——但**這個保護只存在於 Supabase 專案設定（`db-schemas`），不在 SQL 裡**。需確認該設定確實只有 `public`（與 `graphql_public`）。
6. **未使用 `FORCE ROW LEVEL SECURITY`。** 所有 helper 都是 postgres 擁有的 SECURITY DEFINER，靠「表擁有者不受 RLS 約束」讀到真值；開了 FORCE 這些函式會失效。代價是：任何以 postgres 身分執行的 SQL 完全不受 RLS 保護。需確認這個取捨可接受。
7. **`username_claim` 的現用名對 anon 全可列舉**（公開個人頁的必然結果），可被用來建立全站使用者清單。爬蟲防護要在邊緣層做，schema 層無解。
8. **`resolve_username()` 的舊→新轉向本身就是揭露**——只要知道舊名就能得到新名。這是 US-25 的必然代價；緩解是不可列舉 + 使用者可關閉 + 180 天到期，不是消除。
9. **`grant select on public.film` 含 `created_by`**，公開已審核作品會揭露「誰新增了這部片」。若視為問題需改成逐欄 grant 排除該欄。
10. **`admin_*` RPC 對 `authenticated` 開放 EXECUTE、由函式內部自行 `is_admin()` 把關。** 斷言 ⑥ 已強制「`admin_` 前綴的 definer 函式原始碼必須含 `app.is_admin()`」，但字串比對不是語意檢查——仍需 code review。

## 7.2 Nuxt / 套件

11. **沒有實際 scaffold 過 Nuxt 4.5.2 + `@nuxtjs/supabase` 2.0.10 + `@nuxt/ui` 4.11.0 的組合。** 所有結論來自官方文件、npm tarball 的 dist 原始碼、GitHub issues 的交叉比對，不是執行結果。**是否有相依衝突（尤其 `@nuxt/kit` 版本）未實際跑過安裝驗證。**
12. **`@nuxtjs/supabase` 官方文件站沒有任何一頁講 hybrid rendering 的建議設定**（issue #605 明確指出這個文件缺口）。`routeRules` 與 `redirectOptions` 的搭配方式是從原始碼推導的，不是官方背書。
13. **`@nuxtjs/supabase` 的 redirect middleware 在 `ssr: false` 路由上的執行時機**未在官方文件找到針對 hybrid rendering 的說明。
14. **issue #606（`page:start` 每次導航都 `await getClaims()`）**：回報者宣稱 2.0.9 修好，但核對 2.0.10 的 dist，該段程式碼仍存在且仍 await。「JWKS 端點不可達時導航是否會 hang」未實測。
15. **`routeRules` 在 `nuxt.config` 參考文件中仍被標為「Experimental」**，雖然它已是 hybrid rendering 的唯一入口。
16. **`appMiddleware` route rule 的完整語義**未能驗證（只出現在 rendering.md 的清單裡，middleware 專章完全沒提，找不到官方範例）。若要用它控制 `/app/**` 的 auth middleware，先在本機驗證。
17. **`experimental.spaLoadingTemplateLocation` 在 Nuxt 4 是否還存在**未能從官方文件確認（`nuxt-config.md` 全文 grep 不到，只有 `spaLoadingTemplate`）。
18. **`@nuxt/ui` v4 與 `ssr: false` routeRules 的互動**（Tailwind 4 的 CSS 是否會因為頁面被踢出 server bundle 而漏掉某些 utility）完全未查證。
19. **`vue-echarts@8.2.0` 與 Nuxt 4 SSR 的整合細節**（是否需要 transpile、有沒有 ESM interop 問題）未實測，只驗證了 peer 相容。
20. **`UTable` 在 3,000+ 筆 × 實際欄位數下的真實 FPS 與記憶體用量沒有實測。** 官方虛擬化範例用的是 1,000 筆合成資料且欄位簡單。建議先做一次真實資料 profiling。
21. **中文 IME（注音／拼音）在 `USelectMenu` / `UInputMenu` 搜尋框的 composition 行為沒有實機驗證。** `useIMEGuard` composable 雖存在於 v4，但實測整包 runtime 只有 `ChatPrompt.vue` 用它。**這是繁中產品的高風險點，務必實機測。**
22. **Canvas 2D `fillStyle` 把 oklch 正規化成 hex 的 fallback 手法未實機驗證**（超出 sRGB 色域時可能回 `color(display-p3 …)`，zrender 一樣解析不了）。主方案請用 `@theme static` 的 hex 色票。
23. **Vercel Hobby 對 Nuxt 4 + Nuxt UI v4 的實際 build 時間與 Serverless Function 大小上限是否會踩到未實測**；`componentDetection` 的實際節省幅度也未量測。
24. **Vercel Hobby 上 SSR function 的冷啟動對 JWKS 快取的影響**沒有官方說明，也未實測。若冷啟動頻繁，已登入使用者的首個 SSR 請求仍可能多一次網路往返。

## 7.3 產品 / 法務

25. **付費牆與著作權法第 90 條之 7 第 2 款的關係需律師意見。** 無法從條文推斷。本計畫的處理是「Phase 1 完全不建付費結構」，把問題延後。
26. **`app.business_days_after()` 只扣週末，未含台灣國定假日與颱風假。** §90-9 的 10／14 個工作日會算得比實際早（對平台是保守方向，不至於違法），但正式營運前應補一張假日表。
27. **TMDB 商業方案的實際定價與自助訂閱可用性未核實**（$149/月僅來自論壇發言，訂閱頁需登入且實測 401）。本階段用免費 key 不阻塞。
28. **TMDB 演職員（cast / crew）的中文化程度未測**（已測項目僅涵蓋片名與簡介）。
29. **`apply_tmdb_snapshot` 會把 TMDB 的 runtime / release_year 回填進 `film` 本體，而 film 本體不受 6 個月 TTL 管制。** 片長與年份屬事實性資料（非受著作權保護的表達），實務上應無問題，但嚴格解讀 TMDB 條款時是灰色地帶，建議與付費牆法律意見一併確認。
30. **UGC 私有作品被使用者的公開紀錄引用時，該紀錄對外整筆不可見**（`viewing_record_select` 連動判斷 film）。使用者會看到「我設了公開卻沒人看得到」，schema 層無法解釋，**必須靠 UI 明示「待審核通過後才會公開」**。
31. **多刷排行以 `film_id` 分組。** 管理者合併重複作品後使用者的歷史統計會改變（技術上正確，但「我去年的多刷排行怎麼變了」是真實的使用者困惑）。
32. **`dmca_notice` 開放 anon INSERT 是垃圾訊息的靶。** 必須在 Nitro/Edge 端加 Turnstile 或速率限制；資料庫層沒有防護。
33. **`certificate.raw` 永久保留原始 JSON 會放大 DB 體積。** 政府資料可永久保存於法無礙，但 **Supabase 免費專案 500MB 上限**需留意（3,116 列的 raw 估計數 MB，應無問題，但需實測）。

---

## 附：本計畫刻意**不做**的事（避免日後重複評估）

| 項目 | 理由 |
|---|---|
| Materialized view + pg_cron 做個人統計 | 重度使用者一年 100–300 筆、二十年也只有數千列，走覆蓋索引是微秒級。MV 只換來刷新成本、過時資料，以及一個**沒有 RLS 的表**。免費專案閒置暫停期間 pg_cron 也不會執行 |
| `generated` 分桶欄位 + `INCLUDE` 覆蓋索引 | 同上；且 INCLUDE 欄位一旦要增減就得重建整條索引，統計面板加維度時會持續肥大 |
| 三個鏡射欄位（`film_public` / `public_listed` / `cost_public`） | 把「不可能外洩」降級成「只要觸發器一直正確就不外洩」，且 `default true` 讓失敗方向指向外洩 |
| 付費 / entitlement 表 | 理論純度不值那個成本；Phase 1 完全不建，海報路徑在結構上碰不到付費判斷 |
| `nuxt-echarts` 模組的 SSR 元件 | 建立在 experimental 的 `<NuxtIsland>` 之上，模組自己標了警語；且 ECharts SSR 強制固定 width/height，與響應式圖表天生衝突 |
| `nuxt-og-image` 生成含 TMDB 海報的 OG 圖 | 把 TMDB 海報 pipe 進自己的生成器等同轉存 |
| 影廳主檔（`venue_hall`） | 政府資料不提供影廳層級資訊，現在建空表只是徒增複雜度。演進路徑已預留（日後加 `hall_id uuid NULL` 回填即可） |
| 104–109 年分級資料 | schema 不同（中文與外文片名合併同欄），已列為 Out of Scope |