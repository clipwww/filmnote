# Nuxt SaaS 技術選型調研：oxlint / UI / DB / 部署 / Auth 🧱

> 調研日期：**2026-09-05**　｜　調研對象：以 Nuxt 打造個人 + 少數使用者的桌面型 SaaS 儀表板（大量圖表與資料表格），需 Google OAuth 登入與使用者上傳圖片儲存
> 所有版本號、條款與定價均以**當日擷取之官方一手來源**為準（官方文件、官方 changelog、GitHub repo/issues、npm registry、官方定價與條款頁）。
> 部分結論另以「解壓 npm tarball 讀原始 LICENSE / 規則清單 / 型別定義」直接驗證。
> 本文所有「已驗證」項目皆附來源 URL；無法取得者一律標示「**未能驗證**」並說明查證過程。
> ⚠️ 條款與定價變動頻繁，**實作或上線營利前請重新確認**。

---

## 1. TL;DR

1. **oxlint + Vue 有坑，而且是結構性的坑。** oxlint 能 lint `.vue`，但**只讀 `<script>`，完全不看 `<template>`** —— 官方相容性頁把 Vue 標為 Partial 並註明「No template linting yet」，而且它為了避免誤報**直接在 `.vue` 停用 `no-unused-vars`**。`vue/no-unused-components`、`vue/multi-word-component-names`、`vue/require-v-for-key` 全都缺席（實作 46 條 vs `eslint-plugin-vue` 的 252 條），template a11y 是 0 覆蓋。維護者已明說 eslint-plugin-vue「無法完全相容」，而 template 支援的 RFC 已從 2026 Q3 被延後、連實作排程都還沒定。
2. **部署平台的商業使用限制是第二個大雷：Vercel Hobby 與 Zeabur Free 都「明文禁止」營利。** Vercel 的定義寬到「放 AdSense」「接受捐款」「只是宣傳一個未來要收費的產品」「程式碼是有支薪的人寫的」都算商業用途，違規會被人員直接暫停帳號，而且 Hobby 的內容還會被拿去訓練 AI；Zeabur Free 違規更是**立即終止、無寬限期**。相對地 **Cloudflare 與 Netlify 都查無商業禁令**。
3. **技術棧的好消息很多**：Nuxt 最新穩定版是 **4.5.2**（沒有 Nuxt 5，Nuxt 3 已於 2026-07-31 EOL），而 **Nuxt UI v4 已把原本要價 $249–999 的 Pro 全部併入 MIT 免費開源**（125+ 元件、Tailwind v4 + Reka UI、Table 基於 TanStack Table v8 且內建虛擬捲動），對「大量圖表 + 資料表格」的儀表板是現成解。
4. **反過來 PrimeVue 5 從 MIT 轉成了閉源商業授權**（需 license key、不得反編譯），免費 Community License 有「年營收 < $1M 且開發者 < 5 人且員工 < 10 人」的門檻且需每年重新確認，否則每位開發者 $599–799 —— **這是選型前必須先做的法務決定**。
5. **最省事的組合**：DB/儲存用 **Supabase Free**（唯一單一平台同時給 Google OAuth + 圖片儲存 + Postgres，但**閒置 7 天會暫停**）；想省錢且圖片流量大就用 **Cloudflare Workers Paid $5/月 + D1 + R2**（**R2 egress 免費**是決定性優勢，但 Auth 要自建）；Auth 自建首選 **`nuxt-auth-utils`（務必 pin `>=0.5.30`，以下版本有 login CSRF 漏洞）**，並**避開 `@sidebase/nuxt-auth`**（Nuxt 4 支援 issue 開了 13 個月未解、卡死在 NextAuth v4.21.1）。

---

## 2. 快速決策表

### A. Lint 策略

| 方案 | Vue template 規則 | a11y | 速度 | 設定成本 | 推薦度 |
|---|---|---|---|---|---|
| **只用 `@nuxt/eslint`（+ 現有 antfu config）** | ✅ 完整 | ✅ 有 | 普通 | 低 | ⭐⭐⭐⭐⭐ **本專案規模的正解** |
| oxlint + ESLint 雙層（`eslint-plugin-oxlint` 去重） | ✅ 完整（ESLint 端） | ✅ | 快 | **高**（兩套設定、兩個指令） | ⭐⭐⭐ 檔案數 >500 再考慮 |
| **只用 oxlint** | ❌ **完全沒有** | ❌ **0 覆蓋** | 最快 | 低 | ⭐ **不要這樣做** |

### B. UI Framework（桌面型儀表板）

| 方案 | 版本 | 授權 | DataTable 虛擬捲動 | Nuxt 整合 | 推薦度 |
|---|---|---|---|---|---|
| **Nuxt UI** | 4.11.0 | ✅ **MIT 全免** | ✅ TanStack Table v8 | 官方本體 | ⭐⭐⭐⭐⭐ **首選** |
| **Vuetify** | 4.2.0 | ✅ MIT | ✅ `VDataTableVirtual` | ⚠️ module 仍 **RC** | ⭐⭐⭐⭐ 次選 |
| Element Plus | 2.14.5 | ✅ MIT | ✅ `el-table-v2`（另一套 API） | 官方 module（7 個月未發版） | ⭐⭐⭐ |
| shadcn-vue | 2.8.2 | ✅ MIT | ⚠️ 需自接 | 官方 `shadcn-nuxt` | ⭐⭐⭐ 無現成後台版型 |
| **PrimeVue** | 5.0.1 | ⚠️ **商業授權** | ✅ 最完整 | 官方 module（亦商業） | ⭐⭐ **先做法務判斷** |
| Naive UI | 2.45.3 | ✅ MIT | ✅ 含橫向虛擬化 | ❌ **無官方 module** | ⭐⭐ SSR 有風險 |

### C. DB / BaaS

| 方案 | 內建 Google OAuth | 內建圖片儲存 | 免費 DB | 最大陷阱 | 推薦度 |
|---|---|---|---|---|---|
| **Supabase Free** | ✅ | ✅ 1 GB | 500 MB/專案 | **7 天閒置即暫停**；egress 僅 5 GB | ⭐⭐⭐⭐⭐ **最省事** |
| **Cloudflare D1+R2** | ❌ 自建 | ✅ 10 GB，**egress 免費** | 5 GB | Free 僅 **10 ms CPU/次**，SSR 須升 $5/月 | ⭐⭐⭐⭐⭐ **最划算** |
| Neon | ⚠️ Beta | ❌ 無 | 0.5 GB/專案 | 無物件儲存；Auth 仍 Beta | ⭐⭐⭐ |
| Turso | ❌ | ❌ | 5 GB / 500M reads | 公司重心轉向 DB 引擎 | ⭐⭐ |
| PlanetScale | ❌ | ❌ | **已無免費方案** | 最低 $5/月只有 1/16 vCPU | ⭐ 出局 |

### D. 部署平台（**假設此 SaaS 會營利**）

| 方案 | 免費方案可營利 | 營利月成本 | 帳單風險 | 推薦度 |
|---|---|---|---|---|
| **Cloudflare Workers** | ✅ | **$5** | 極低（固定日配額） | ⭐⭐⭐⭐⭐ |
| **Zeabur Dev** | ❌ Free 禁止 | **$5** | 極低 | ⭐⭐⭐⭐⭐ **最貼合 Nuxt SSR** |
| Netlify | ✅ | $0–20 | 低（新制硬上限停站） | ⭐⭐⭐ 300 credits ≈ 15 GB 太小 |
| Vercel | ❌ **Hobby 禁止** | **$20/人** | 中（Spend Mgmt 非即時） | ⭐⭐⭐ DX 最好但最貴 |
| Render | ✅ | $7 | 中 | ⭐⭐ **免費層封鎖 SMTP** |
| **Fly.io** | ✅ | 用量計費 | ⚠️ **最高（官方明說無上限、無警示）** | ⭐ 不建議 |

### E. Google OAuth

| 方案 | 版本 | Nuxt 4 | 適合自建 DB | 推薦度 |
|---|---|---|---|---|
| **`nuxt-auth-utils`** | **0.5.30** | ✅ | ✅ 完全自己控 | ⭐⭐⭐⭐⭐ **首選（務必 ≥0.5.30）** |
| **Better Auth** | 1.7.2 | ✅ e2e 釘 4.5.2 | ✅ 有 adapter + migration | ⭐⭐⭐⭐ 要擴充時選 |
| `@nuxtjs/supabase` | 2.0.10 | ✅ | ⚠️ 綁 Supabase | ⭐⭐⭐⭐ 用 Supabase 時最省事 |
| `@sidebase/nuxt-auth` | 1.3.1 | ❌ **未支援** | — | ⭐ **避免** |

---

## 3. oxlint 對 Vue 的支援現況（最重要）

> 擷取日期：2026-09-05。oxlint 版本 **1.81.0**（npm `latest`，發布於 2026-09-01）。

### 3.1 一句話結論

**有坑，而且是結構性的坑。** oxlint 可以 lint `.vue` 檔，但**只讀 `<script>` / `<script setup>` 區塊，完全不看 `<template>`**。這代表 Vue 專案最常抓到 bug 的那一類規則（template 內的 `v-for` 沒 key、用了不存在的變數、component import 了沒用到）oxlint **一條都跑不了**，而且短期內也不會有。

### 3.2 官方明文：Vue 是 "Partial"

oxc 官方相容性頁把 Vue 與 Nuxt 都標為 **Partial**，並附註腳：

> "Vue, Svelte, Angular, Ember, Nuxt, Astro, SvelteKit, and Analog: **No template linting yet**"

— [oxc.rs/compatibility](https://oxc.rs/compatibility)（2026-09-05 擷取）

oxlint 會處理的副檔名包含 `.vue`、`.astro`、`.svelte`，但官方文件說明只涵蓋這些檔案裡的 `<script>` 區塊：

> "It supports JavaScript, TypeScript, JSX, and TSX, plus the `<script>` blocks inside `.vue`, `.svelte`, and `.astro` files."

— [oxc.rs/docs/guide/usage/linter](https://oxc.rs/docs/guide/usage/linter)

### 3.3 致命細節：`.vue` 裡的 `no-unused-vars` 被關掉

因為 oxlint 看不到 template，它無法知道某個變數/元件是不是「只在 template 裡用到」。為了避免大量誤報，**oxlint 在 `.vue` 的 script 區塊直接停用 `no-unused-vars`**：

> "Plain oxlint reads `<script>` but not `<template>`, and disables `no-unused-vars` there to avoid false positives. So a component used only in the template looks unused, and nothing inside `{{ }}` is checked at all."

— [github.com/vad1ym/oxlint-vue](https://github.com/vad1ym/oxlint-vue) README（2026-09-05 擷取）

**實務衝擊**：你在 `.vue` 檔裡留下一個沒用到的 `import`、沒用到的 `ref`、沒用到的型別，oxlint **不會報**。這是 Vue 專案裡最常見的清理項目之一，直接失守。

### 3.4 規則覆蓋率：46 / 252，且全是 script-only

oxlint 確實有內建 `vue` plugin。我直接解開 `eslint-plugin-oxlint@1.81.0` 的產出檔清點，**oxlint 目前實作 46 條 `vue/*` 規則**；對照 `eslint-plugin-vue@10.10.0` 的 `dist/rules/` 目錄共 **252 個規則檔**。

**oxlint 已實作的 46 條（全部是 `<script>` 內可判斷的）**，代表性的有：
`vue/no-dupe-keys`、`vue/no-side-effects-in-computed-properties`、`vue/no-async-in-computed-properties`、`vue/require-default-prop`、`vue/require-prop-types`、`vue/prop-name-casing`、`vue/no-expose-after-await`、`vue/no-lifecycle-after-await`、`vue/no-watch-after-await`、`vue/valid-define-props`、`vue/valid-define-emits`、`vue/valid-define-options`、`vue/define-props-destructuring`、`vue/no-import-compiler-macros`、`vue/require-typed-ref`、`vue/no-deprecated-*` 系列等。

**確認「缺席」的重要規則**（我逐條比對 `eslint-plugin-oxlint@1.81.0` 的規則清單，以下皆 **不存在**）：

| 缺少的規則 | 為什麼重要 |
|---|---|
| `vue/no-unused-components` | 你點名的規則。**沒有**。import 了元件卻沒在 template 用到 → 抓不到 |
| `vue/multi-word-component-names` | 你點名的規則。**沒有**。Vue 官方 style guide 的 essential 規則 |
| `vue/no-unused-vars` | template 內宣告的變數（`v-for` 的 item）沒用到 → 抓不到 |
| `vue/require-v-for-key` | **essential 等級**，少了 `:key` 是真 bug 來源 |
| `vue/valid-v-for` | essential 等級 |
| `vue/no-use-v-if-with-v-for` | essential 等級，效能與正確性問題 |
| `vue/no-mutating-props` | essential 等級，直接改 prop 是常見 bug |
| `vue/require-explicit-emits` | strongly-recommended |
| `vue/no-v-html` | **XSS 安全性**相關 |
| `vue/attribute-hyphenation`、`vue/component-name-in-template-casing` | template 風格一致性 |
| `vue/no-template-shadow` | template 變數遮蔽 |

**a11y 檢查更是完全沒有**：oxlint 有 `jsx-a11y` plugin（給 React 用），但**沒有 `vuejs-accessibility` plugin**。Vue template 的無障礙檢查在 oxlint 是 0 覆蓋。

> 佐證：[oxc.rs 規則總覽](https://oxc.rs/docs/guide/usage/linter/rules.html) 列出的 plugin 為 eslint / import / jest / jsdoc / jsx-a11y / nextjs / node / oxc / promise / react / react-perf / typescript / unicorn / vitest / **vue**，共 870 條規則，其中沒有 `vuejs-accessibility`。

### 3.5 官方 roadmap：template linting 不在近期

這不是「還沒排到」，而是**架構上的難題**，官方講得很清楚。

**Issue #2575「linter: eslint-plugin-vue」→ 已 closed as not planned**（2024-03-02 開）。
— [github.com/oxc-project/oxc/issues/2575](https://github.com/oxc-project/oxc/issues/2575)

**Issue #15761「oxlint: better vue support」（2025-11-17 開，milestone Oxlint Q2，仍 open）** 維護者說明根本原因：

> "eslint-plugin-vue cannot be made fully compatible because it relies on its own compiler, which produces a modified AST for ESLint to traverse."

並且明講：因為 template 內的 JS binding 沒有支援，**unused variables 這類規則「無法實作」**。計畫是自己寫一個 Vue parser 把 template 裡的 JS 片段抽出來掛到 `<script>` 的 AST 上，而**不是**追求 eslint-plugin-vue 相容。
— [github.com/oxc-project/oxc/issues/15761](https://github.com/oxc-project/oxc/issues/15761)

**Issue #10005「script-only rules from eslint-plugin-vue」→ 已 closed**，作者原文承認 "a built-in vue template parser isn't planned currently"。這就是目前那 46 條規則的來源。
— [github.com/oxc-project/oxc/issues/10005](https://github.com/oxc-project/oxc/issues/10005)

**RFC #21936「Embedded Framework Support for Oxlint (Language Plugins)」**（2026-04-29 由 oxc collaborator @camc314 提出）是目前最有希望的路線：引入 "language plugins"，由 plugin 把框架 AST 轉成 virtual JS/TS 源碼再送進既有 pipeline。**但狀態是討論中，且已從 2026 Q3 延後**（issue #23976）。
— [github.com/oxc-project/oxc/discussions/21936](https://github.com/oxc-project/oxc/discussions/21936)

> **判讀**：2026-09 的時間點，「oxlint 原生支援 Vue template lint」連實作排程都還沒定。不要把專案品質守門押在它身上。

### 3.6 官方確實建議「oxlint + ESLint 並用」

有官方整合方案，而且就是這個用法。

**`eslint-plugin-oxlint`**（**官方**，repo 在 `oxc-project` org 底下，版本 **1.81.0**，與 oxlint 同步發布 2026-09-01）：
作用是「**關掉所有 oxlint 已經涵蓋的 ESLint 規則**」，讓兩者不重複跑。官方 README 建議的用法就是：

```json
{ "scripts": { "lint": "oxlint && eslint" } }
```

— [github.com/oxc-project/eslint-plugin-oxlint](https://github.com/oxc-project/eslint-plugin-oxlint)

官方遷移文件也寫明：大型專案的建議是用 `eslint-plugin-oxlint` 關掉重疊規則，**先跑 oxlint 再跑 ESLint**，以取得較快的回饋迴圈。
— [oxc.rs/docs/guide/usage/linter/migrate-from-eslint](https://oxc.rs/docs/guide/usage/linter/migrate-from-eslint)

**重要且對你有利的一點**：我實測解包 `eslint-plugin-oxlint@1.81.0`，它的 generated 規則表**有包含那 46 條 `vue/*`**。也就是說它會幫你把 ESLint 端重複的那 46 條 vue 規則關掉，**保留 eslint-plugin-vue 剩下的 ~200 條（含全部 template 規則）繼續由 ESLint 跑**。這正是你要的分工。

**type-aware**：oxlint 的 type-aware 由 `oxlint-tsgolint`（Go + typescript-go）提供，目前覆蓋 typescript-eslint 61 條 type-aware 規則中的 **59 條**，用 `oxlint --type-aware` 啟用。
— [oxc.rs/docs/guide/usage/linter/type-aware](https://oxc.rs/docs/guide/usage/linter/type-aware.html)

### 3.7 Nuxt 官方對 oxlint 的態度：**沒有官方 module，官方仍推 ESLint**

**（a）Nuxt 官方文件完全沒提 oxlint。**
[Nuxt 4.x Code Style 文件](https://nuxt.com/docs/4.x/guide/concepts/code-style) 唯一的建議是：

> "The recommended approach for Nuxt is to enable ESLint support using the `@nuxt/eslint` module"

`@nuxt/eslint` 目前版本 **1.17.0**（npm，2026-08-06 更新）。[eslint.nuxt.com](https://eslint.nuxt.com/) 的 FAQ 也**完全沒有提到 oxlint 或 Biome**。

**（b）Nuxt 核心團隊試過 oxlint，然後否決了。**
PR [nuxt/nuxt#32049](https://github.com/nuxt/nuxt/pull/32049)（作者 TheAlexLichter，2025-05-08 開，**2025-06-02 closed 未合併**）嘗試把 Nuxt repo 導入 oxlint。Daniel Roe 的結論原文：

> "stylistic lint plugins are important to us... currently it seems it's not possible to configure oxlint to perform formatting, nor is there any replacement in the oxc ecosystem... running a two-stage process is not necessarily worth it."

團隊偏好「單一指令完成 lint（含 stylistic）」，最後只 cherry-pick oxlint 找到的 bug 修正，**把 oxlint 當一次性 bug 掃描工具，而非取代方案**。效能實測：未快取快約 24%，但**有快取時反而慢 15~27%**（config 解析開銷）。

**（c）沒有官方 Nuxt oxlint module。**
- npm 上的 `nuxt-oxlint` 是 **0.0.0 空殼包**（2024-04-01 之後未更新），**不要裝**。
- 實際可用的是第三方 **`oxc-nuxt`**（作者 porfirioribeiro，GitHub 僅 **15 stars**、32 commits）。它的價值是**自動把 Nuxt auto-imports 註冊為 globals**。
  ⚠️ npm 最新版 **0.1.5，最後發布 2026-02-09 —— 已 7 個月未更新**，而 oxlint 同期從 1.x 一路更新到 1.81.0。**不建議作為正式專案依賴。**
  — [github.com/porfirioribeiro/oxc-nuxt](https://github.com/porfirioribeiro/oxc-nuxt)
- `@nuxt/oxlint` 目前只是社群討論中的構想，**不存在**。

### 3.8 額外的 Nuxt 專屬坑：auto-imports

oxlint **不認得 Nuxt 的 auto-imports 與路徑別名**。討論 [oxc#17987](https://github.com/oxc-project/oxc/discussions/17987)（2026-01-14）回報兩類錯誤：

1. `Cannot find module '~~/xxx'`（Nuxt 預設別名解析不到）
2. `defineEventHandler` / `computed` / `defineProps` 等 auto-import composable 被判為 undefined

目前**沒有官方解**，變通做法是在 `.oxlintrc.json` 手動列 `globals`：

```json
{ "globals": { "computed": "readonly", "defineProps": "readonly", "onMounted": "readonly" } }
```

該討論到擷取日仍**未有官方回覆**。裝 `oxc-nuxt` 可以自動處理這件事，但那是 15 star 的第三方套件。

### 3.9 社群補丁方案（謹慎評估）

| 方案 | 說明 | 成熟度 |
|---|---|---|
| **`oxlint-vue`** ([repo](https://github.com/vad1ym/oxlint-vue)) | drop-in 包裝，把 template 轉成等長 virtual file 讓規則能進 `<template>`，額外提供 18 條 Vue template 規則（`require-v-for-key`、`no-mutating-props`、`no-dupe-v-else-if` 等） | **v0.1.5、GitHub 2 stars、14 commits**。太早期，**不建議用在正式專案** |
| **`oxlint-plugin-vize`** ([vizejs.dev](https://vizejs.dev/guide/oxlint/)) | 讓 Vize 在同一次 oxlint run 貢獻 Vue 診斷 | 2026-03 才發 alpha，未驗證成熟度 |

### 3.9b 順帶一提：oxfmt 的 Vue 支援也是 "Partial"

如果你打算連格式化也換成 oxc 生態：
- [oxc.rs/compatibility](https://oxc.rs/compatibility) 把 Vue / Nuxt 的 **Oxfmt 欄位也標為 Partial**。
- VoidZero 2026-03 月報提到 oxfmt「改善了 Vue SFC 支援」。— [voidzero.dev](https://voidzero.dev/posts/whats-new-mar-2026)
- 已知未解問題：
  - [oxc#19268](https://github.com/oxc-project/oxc/issues/19268)：`// oxfmt-ignore` 在 `.vue` 的 `<script setup>` 內**被靜默忽略**（在 `.ts` 檔正常）。
  - [oxc#17741](https://github.com/oxc-project/oxc/issues/17741)：不支援 Prettier 的 `vueIndentScriptAndStyle`，會把 `<script>` / `<style>` 內的縮排整個拔掉 → **全 codebase 巨大 diff**。

從 Prettier 遷移到 oxfmt 的 Vue 專案要預期會撞到這些。

### 3.10 對本專案的建議

**不要用 oxlint 取代 ESLint。用「oxlint 前哨 + `@nuxt/eslint` 主力」的雙層架構，或乾脆只用 ESLint。**

務實的兩個選項：

**選項 A（推薦・雙層）**
```
oxlint            → 快速跑 TS/JS 檔 + .vue 的 script 區塊（毫秒級，適合 pre-commit / watch）
@nuxt/eslint      → 跑 eslint-plugin-vue 全套（template 規則、a11y）+ type-aware
eslint-plugin-oxlint → 關掉兩者重疊的規則
```
成本：兩套設定檔、兩個指令、CI 兩段。Nuxt 團隊自己評估後認為「不一定值得」。

**選項 B（最省事）**
只用 `@nuxt/eslint`。專案規模在數百個檔案以內時，ESLint 的速度根本不是瓶頸，oxlint 省下的幾秒換不回雙套設定的維護成本。**對「個人 + 少數人的小型 SaaS」，這是我實際會選的。**

**判斷分水嶺**：檔案數 < ~500 或 lint 時間 < 10s → 選 B。真的痛了再加 oxlint。

**好消息：你現有的設定可以直接接過去。** 本 repo 目前用 `@antfu/eslint-config`（`^9.2.0`，npm latest 為 **9.5.1**，2026-09-02）+ ESLint 10。`@nuxt/eslint` 官方文件明確提供與它組合的寫法：

```js
// eslint.config.mjs
import antfu from '@antfu/eslint-config'
import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
  antfu({ /* options */ }),
)
```

並可用 `standalone: false` 讓 `@nuxt/eslint` 只產生 Nuxt 專屬規則，避免與 antfu preset 的 JS/TS/Vue 規則重複：
> "By default, this module installs the JS, TS and Vue plugins with their recommended rules. This might already be covered by your config presets, so in that case you can disable the default setup by setting the `standalone` option to `false`."
— [eslint.nuxt.com/packages/module](https://eslint.nuxt.com/packages/module)

另外 `@antfu/eslint-config` 9.x 的 optional peer 已包含 **`eslint-plugin-vuejs-accessibility@^2.4.1`**，也就是 template a11y 檢查在 ESLint 這條路上是現成的 —— 這正是 oxlint 完全沒有的部分。

---

## 4. Nuxt 生態現況

> 版本號皆查自 npm registry API / GitHub API / 官方文件，擷取日期 **2026-09-05**。

### 4.1 Nuxt：最新穩定版 **4.5.2**，**沒有 Nuxt 5**

| 項目 | 值 |
|---|---|
| npm `latest` | **4.5.2** |
| 發布時間 | **2026-08-05** |
| `3x` dist-tag | 3.21.11（2026-08-05） |
| **Nuxt 3 EOL** | **2026-07-31 已結束** |
| Node 需求 | **22.x 以上**（建議偶數版） |

**Nuxt 5 尚不存在** —— npm 沒有 5.x，沒有 `next` dist-tag，[nuxt.com/blog](https://nuxt.com/blog) 也沒有發布文。[v4.5 公告](https://nuxt.com/blog/v4-5)只說為 Nuxt 5 做了鋪路，可用 `future.compatibilityVersion: 5` 提前測試破壞性變更。

**`npx nuxi init` / `npm create nuxt@latest` 的預設就是 Nuxt 4.5.2**（直接驗證 [nuxt/starter 的 package.json](https://raw.githubusercontent.com/nuxt/starter/main/package.json)：`"nuxt": "^4.5.2"`, `"vue": "^3.5.42"`, `"vue-router": "^5.3.0"`）。官方推薦指令已改為 `npm create nuxt@latest <name>`。

> ⚠️ **CLI 版號與框架版號脫鉤**：`create-nuxt` / `nuxi` / `@nuxt/cli` 的 latest 都是 **3.37.0**（2026-07-14）。`nuxi` 3.x 會裝 Nuxt 4.x，不要被版號嚇到。

Nuxt 4.5 重點：Vite 8、Rspack 2（改走 Rsbuild）、實驗性 SSR streaming、`useLayout`、具名視圖 `name@view.vue`、unhead v3。

### 4.2 Nitro：穩定線仍是 **v2**（`nitropack` 2.13.4），v3 還在 beta

| 套件 | 版本 | 日期 |
|---|---|---|
| `nitropack`（v2 穩定） | **2.13.4** | 2026-04-29 |
| `nitro`（v3 新套件名） | **3.0.260903-beta** | 2026-09-03 |

v3 時間軸：`v3.0.1-alpha.0`（2025-10-11, Vite Conf）→ 首個 beta `v3.0.260311-beta`（2026-03-11）→ 最新 2026-09-03。**v3 stable 沒有公布日期（未能驗證）**。

**關鍵**：Nuxt 4.5.2 依賴的不是 `nitropack`，而是 `@nuxt/nitro-server@4.5.2`，它再依賴 `nitropack ^2.13.4` + `h3 ^1.15.11`。

> **所以「現在用 Nuxt 4」= 仍跑 Nitro v2 + H3 v1。** Nitro 官方明說「Nuxt v5 will ship with Nitro v3 and H3 v2 at its core」。**別把架構押在未公布時程的 Nitro v3 / H3 v2 上。**

### 4.3 Nuxt UI：**4.11.0**，**Pro 已完全併入 MIT，現在全部免費**

| 項目 | 值 |
|---|---|
| `@nuxt/ui` latest | **4.11.0**（2026-08-21） |
| License | **MIT** |
| v4.0.0 發布日 | **2025-09-23** |
| `@nuxt/ui-pro` latest | 3.3.7（**2025-10-23 後停止發布**） |

**「Pro 合併進 MIT」是真的，不是傳聞。** [ui.nuxt.com](https://ui.nuxt.com/) 原文：

> "Nuxt UI v4 marks a major milestone: Nuxt UI and Nuxt UI Pro are now unified into a single, fully open-source and free library of **125+ production-ready components**"

FAQ：「completely free and open source under the MIT license. All 125+ components are available to everyone」。

**`ui.nuxt.com/pro/pricing` 已不存在**（redirect 到文件頁）。**現在沒有任何付費層級。**

**技術底層（直接讀 `@nuxt/ui@4.11.0` 的 dependencies 驗證）**：
- ✅ **Tailwind CSS v4**：`tailwindcss ^4.3.3` + `@tailwindcss/vite ^4.3.3`
- ✅ **Reka UI**：`reka-ui 2.10.3`（pinned）
- 另含 `@tanstack/vue-table ^8.21.3`、`@tanstack/vue-virtual ^3.13.35`、`motion-v`、`tiptap v3`、`embla-carousel`、`vaul-vue`、`@vueuse/core ^14.4.0`

> **歷史價格（信心中等，未能一手驗證）**：v4 之前 Nuxt UI Pro 為一次性買斷 Solo $249 / Startup $499(5 devs) / Organization $999(20 devs)。舊頁已抓不到價格表。**不影響決策——現在是 0 元。**

---

## 5. UI Framework 候選（Vue/Nuxt 生態，2026 現況）

> 版本號與日期皆查自 npm registry API / GitHub API，部分經解壓 tarball 讀原始 LICENSE 與型別定義驗證。

### 5.1 總覽

| 框架 | 最新穩定版 | 發布日 | License | Nuxt 整合 | Stars | 活躍度 | 儀表板適配 |
|---|---|---|---|---|---|---|---|
| **Nuxt UI** | 4.11.0 | 2026-08-21 | **MIT** | 官方本體 | 6,878 | 極活躍（月更） | ⭐⭐⭐⭐⭐ |
| **Vuetify** | 4.2.0 | 2026-09-02 | **MIT** | `vuetify-nuxt-module` **1.0.0-rc.5** | 41,038 | 極活躍 | ⭐⭐⭐⭐ |
| **Element Plus** | 2.14.5 | 2026-08-21 | **MIT** | `@element-plus/nuxt` 1.1.5 | 27,732 | 極活躍 | ⭐⭐⭐ |
| **shadcn-vue** | 2.8.2 | 2026-08-08 | **MIT** | `shadcn-nuxt` 2.8.2 官方 | 10,555 | 活躍 | ⭐⭐⭐ |
| **PrimeVue** | 5.0.1 | 2026-08-13 | ⚠️ **商業授權** | `@primevue/nuxt-module` 5.0.1 | 14,460 | OSS repo 已凍結 | ⭐⭐⭐（授權有雷） |
| **Naive UI** | 2.45.3 | 2026-08-27 | **MIT** | **無官方 module** | 18,531 | 活躍但斷續 | ⭐⭐ |

### 5.2 Nuxt UI 4.11.0（官方）— **本專案首選**

**Table 基於 TanStack Table v8。** [官方文件](https://ui.nuxt.com/docs/components/table)原文：

> "The Table component is built on top of **TanStack Table v8** and is powered by the `useVueTable` composable... supports sorting, filtering, pagination, row selection, expansion, grouping, pinning and **virtualization**"

已驗證支援：排序、全域/單欄篩選、client + server 分頁、多選、列展開、列釘選、分組聚合、**虛擬捲動**（`@tanstack/vue-virtual ^3.13.35` 佐證）、欄位釘選、欄位顯示切換。

> ⚠️ **小提醒**：TanStack Table **v9 已於 2026-08-04 發布**（`@tanstack/vue-table` 最新 **9.2.4** / 2026-08-28），Nuxt UI 仍在 v8，已有 [nuxt/ui#6799](https://github.com/nuxt/ui/issues/6799) 追蹤升級。目前不影響使用。

**優點**：MIT 全免費、Tailwind v4 原生、Reka UI（無障礙基礎好）、與 Nuxt 4.5 零摩擦、125+ 元件含**原 Pro 的 Dashboard / Page 版型**（現在免費）。
**弱點**：Table 是 headless 組裝路線，複雜 data grid 要多寫程式碼；**圖表需另接**。

> 💡 **對本專案特別有用的一點**：`@nuxt/ui` v4 **不限於 Nuxt，官方支援純 Vue + Vite**（[安裝文件](https://ui.nuxt.com/docs/getting-started/installation/vue)：`pnpm add @nuxt/ui tailwindcss` + Vite plugin + Vue plugin）。
> 本 repo 目前是 **Vite 8 + Vue 3.5 + Tailwind 4**，peer 需求 `tailwindcss: ^4.0.0` 已滿足 —— **可以先在現有專案裡試用 Nuxt UI，不必先遷移到 Nuxt**。
> 兩個注意事項：(1) Toast / Tooltip / 程式化 overlay 需要用 `UApp` 包住 app；(2) 型別宣告檔在 Vite 執行時才產生，clean checkout 直接 type-check 會出現 `Cannot find name 'useToast'`，**要在 build 之後才跑 type-check**。

### 5.3 Vuetify 4.2.0 — 次選

- **已進 v4**：v4.0.0（代號 "Revisionist"）於 **2026-02-23** 發布；最新 4.2.0（2026-09-02）。v3 線仍維護（3.13.3 / 2026-09-01）
- **License：MIT**
- ⚠️ **Nuxt module 仍是 RC**：`vuetify-nuxt-module` **1.0.0-rc.5**（2026-08-22），尚未 1.0 正式版。正面訊號是 repo 已從個人帳號 `userquin` 移交至官方組織 **`vuetifyjs/nuxt-module`**，peerDeps 已支援 `vuetify: ^3.4.0 || ^4.0.0`
- **DataTable（解壓 tarball 驗證）**：`VDataTable`、`VDataTableServer`（伺服端分頁）、**`VDataTableVirtual`（虛擬捲動）** 三種變體，外加獨立 `VVirtualScroll`

**三種 DataTable 變體正好對應「大量資料表格」。** 弱點：Nuxt module 仍 RC；MD3 視覺風格強勢、客製成本高於 Tailwind 系；bundle 較重。

### 5.4 PrimeVue 5 — ⚠️ **重大授權變更，本節最重要的雷**

**PrimeVue 已不再是開源專案。**

- npm `latest` = **5.0.1**（2026-08-13）；`v4-stable` = **4.5.5**（2026-04-08），這是**最後的 MIT 版本**
- v5 的 npm license 欄位由 `MIT` 改為 `SEE LICENSE IN LICENSE.md`
- 解壓 `primevue@5.0.1` tarball 讀 LICENSE.md 實際內容：
  - 屬於 **PrimeUI**「a family of **commercial** UI libraries by PrimeTek Informatics」
  - **需要 license key**：「A valid license key is required to use this software」（離線驗證、無 telemetry，但無效/過期會顯示 license notice）
  - **以編譯後形式散布**：「You may not reverse-engineer, decompile, or extract its source code」
- [GitHub README](https://github.com/primefaces/primevue) 已掛警告：
  > "**This repository is no longer under active development and receives security fixes only.** PrimeVue continues as part of PrimeUI. Issues here are read-only."

  既有 MIT 版本「remain MIT, forever」，但**新功能全部移往商業版**。

**價格**（[primeui.dev/pricing](https://primeui.dev/pricing) 實查）：

| 授權 | 價格 | 條件 |
|---|---|---|
| **Community（免費）** | $0 | 需**同時**滿足：年營收 < $1M USD、開發者 < 5 人、員工 < 10 人、外部募資 < $3M USD。個人 / 學生 / 非營利 / 非商業開源亦符合。功能完整（非閹割版），最多 4 位開發者，**需每年重新確認資格續期** |
| **Commercial（Per Developer）** | **$799，優惠 $599（至 2026-12-31）** | **每位開發者、永久買斷、含 1 年更新**，續約選擇性 |
| **Site License** | 需報價 | 無座位上限 |

`@primevue/nuxt-module` 5.0.1 亦為商業授權（4.4.0 仍 MIT）。

**DataTable 是本次候選中最完整的**：Virtual Scroll、Lazy Load、單/多欄排序、基本+進階篩選+全域搜尋、分頁、Row Group（subheader / rowspan / expandable）、欄寬調整、欄與列拖曳排序、**CSV 匯出**、Cell/Row 行內編輯、凍結欄位。

> **判讀**：對「個人 + 少數人的小型 SaaS」，你**很可能符合 Community License**（年營收 < $1M、開發者 < 5、員工 < 10）。但這是**每年要重新確認資格**的授權，而且一旦專案長大就要逐人付 $599–799。**選型前必須先做這個法務決定**，不要寫了半年才發現。想完全避開，只能鎖在 PrimeVue 4.5.5（MIT，僅安全性修補）。

### 5.5 shadcn-vue 2.8.2

- **Tailwind v4：是**（CLI 依賴 `tailwindcss ^4.3.2`，用 `@tailwindcss/vite`）；底層同樣是 `reka-ui ^2.10.1`
- **Nuxt 整合**：官方 `shadcn-nuxt` module，版本與本體同步（2.8.2 / 2026-08-08），`nuxi module add shadcn-nuxt`
- **DataTable 基於 TanStack Table v9**（文件原文「This guide uses TanStack Table v9」）。示範含排序、篩選、分頁、列選取、欄位顯示切換
- ⚠️ **虛擬捲動：文件未提供**，需自行接 `@tanstack/vue-virtual`

copy-paste 模式 = 程式碼完全自有、客製無上限，但**沒有現成 dashboard 版型，前期工作量最大**。與 Nuxt UI 底層技術棧幾乎相同（Reka UI + Tailwind v4），**兩者擇一即可，沒有理由都裝**。

### 5.6 Naive UI 2.45.3

- MIT，18,531 stars，**維護活躍但節奏斷續**：2.44.1（2026-03-08）之後空窗約 5 個月，2.45.0 才於 2026-08-16 發布，接著 2.45.1/2/3 密集更新至 2026-08-27
- 不發 GitHub Releases，只打 tag
- ⚠️ **無官方 Nuxt module**（明確查證）：
  - `nuxtjs-naive-ui` 1.0.2 — **2024-05-05 後未更新**
  - `@huntersofbook/naive-ui-nuxt` 1.2.0 — **2023-08-29，已死**
  - `@bg-dev/nuxt-naiveui` 2.0.0（2025-10-01）— 社群維護，相對最新但非官方
  - 實務上多半手動設定，**SSR 需處理 CSS-in-JS hydration，是已知痛點**
- **DataTable**：`n-data-table` 具 `virtualScroll`、**`virtualScrollX`（橫向虛擬化，候選中少見）**、`virtualScrollHeader`

元件本身對後台很對味（TS 完備、主題可調），但 **Nuxt SSR 整合是最大風險**。**不建議用於 Nuxt 專案。**

### 5.7 Element Plus 2.14.5

- MIT，27,732 stars，**維護最穩定**：2.14.0(05-08) → 2.14.5(2026-08-21) 幾乎月更，repo pushed 2026-09-04。仍在 2.x，無 v3 計畫跡象
- **Nuxt module**：`@element-plus/nuxt` **1.1.5**（2026-02-05），官方組織維護，repo pushed 2026-08-17（有活動但 **npm 已 7 個月未發版**）
- **DataTable**：`el-table`（功能完整但大量資料吃力）+ **`el-table-v2` / `TableV2`（虛擬化表格，專為大資料集設計）**

生態成熟、**中文資料最多**。弱點：Table V2 與 Table 是**兩套 API 且功能不對等**（V2 缺少部分 v1 特性）、設計語言偏舊、open issues 1,151 為候選最高。

### 5.8 圖表：UI framework 都不含，需另外選

本專案已在用 **Chart.js 4 + chartjs-plugin-datalabels + d3 7 + Leaflet**。搬到 Nuxt 時的選項：

| 方案 | 說明 | 備註 |
|---|---|---|
| **沿用 Chart.js / d3** | 都是框架無關的，Nuxt 下需注意 SSR（用 `<ClientOnly>` 或 `.client.vue`） | **遷移成本最低，建議沿用** |
| **Apache ECharts**（`nuxt-echarts` module） | 雙渲染引擎（Canvas 可撐 10 萬+ 點 / SVG 銳利縮放），儀表板功能最全 | 資料量真的大時的最佳解 |
| **Unovis**（`@unovis/vue`） | 模組化、TS 佳、用 CSS variables 調樣式 | 與 Tailwind 系搭配好 |
| **Nuxt Charts / `vue-chrts`** | 基於 Unovis、Tremor 風格，MIT，有 `nuxt-charts` module | ⚠️ **維護者非 Nuxt 官方團隊**（作者 HugoRCD，fork 自 dennisadriaans），repo star 數極低，**不建議作為核心依賴** |

### 5.9 桌面型 SaaS 儀表板的建議

1. **首選 Nuxt UI 4.11.0** —— 官方框架、MIT 全免、Tailwind v4 + Reka UI、Table 直接是 TanStack Table v8 且內建虛擬捲動 / grouping / pinning，原 Pro 的 dashboard 版型現在免費。與 Nuxt 4.5 零整合成本。**圖表沿用你熟的 Chart.js，或改用 ECharts。**
2. **次選 Vuetify 4.2.0** —— 偏好開箱即用的 Material 後台、不排斥重量級時，`VDataTableVirtual` + `VDataTableServer` 直接覆蓋需求。唯一保留是 Nuxt module 仍 RC。
3. **PrimeVue 5 只在「DataTable 功能真的不夠用」時考慮**，且**先做授權判斷**。
4. **不建議 Naive UI**（Nuxt SSR 無官方支援）；**shadcn-vue 除非有充足前端工時**（無現成後台版型）。

---

## 6. DB / BaaS 方案：免費額度與陷阱

> 所有數字擷取日期：**2026-09-05**，皆來自官方 pricing / docs 頁。

### 6.0 快速對照

| 方案 | 內建 Auth (Google) | 內建圖片儲存 | 免費 DB | 最大陷阱 |
|---|---|---|---|---|
| **Supabase** | ✅ 內建 | ✅ 1 GB | 500 MB/專案 | **7 天閒置即暫停**；egress 只有 5 GB |
| **Cloudflare D1+R2** | ❌ 要自建 | ✅ 10 GB，**egress 免費** | 5 GB / 5M reads·天 | Free 方案 **10 ms CPU/次**，SSR 幾乎必須升 $5/月 |
| **Neon** | ⚠️ Beta | ❌ 無 | 0.5 GB/專案 | 沒有物件儲存；Auth 仍 Beta |
| **Turso** | ❌ 無 | ❌ 無 | 5 GB / 500M reads | 公司重心轉向資料庫引擎；平台功能縮減 |
| **PlanetScale** | ❌ 無 | ❌ 無 | **已無免費方案** | 最低 $5/月只有 1/16 vCPU 單節點 |

---

### 6.1 Supabase

**Free tier 額度** — [supabase.com/pricing](https://supabase.com/pricing)

| 項目 | Free | Pro ($25/月起) |
|---|---|---|
| 資料庫大小 | **500 MB**（每個 active project 各自計算） | 8 GB disk 起，超出 $0.125/GB |
| Egress | **5 GB** | 250 GB，超出 $0.09/GB |
| File Storage | **1 GB** | 100 GB，超出 $0.0213/GB |
| MAU | **50,000** | 100,000 |
| 專案數 | **2 個 active projects**（跨所有你擔任 Owner/Admin 的 org 合計） | 無上限 |
| 單檔上傳上限 | **50 MB** | 可設到 500 GB |
| 超額 | **不會扣款**，直接受限 | pay-as-you-grow，**spend cap 預設開啟** |

500 MB 為 per-project 是 2025-01-27 的變更（原本是整個帳號共用 0.5 GB）。
— [changelog](https://supabase.com/changelog/33121-relaxing-database-size-limit-on-free-plan-0-5-gb-database-size-per-project)

**Google OAuth：✅ 支援，Free 方案可用。**
> "Supabase Auth supports Sign in with Google for the web, native applications (Android, macOS and iOS), and Chrome extensions."
— [docs](https://supabase.com/docs/guides/auth/social-login/auth-google)。文件中沒有任何方案層級限制。

**⚠️ 閒置暫停（最大陷阱）** — [docs](https://supabase.com/docs/guides/platform/free-project-pausing)
> "A Free plan project is considered inactive if it does not receive sufficient user database activity over the past week."

- **條件**：約 **7 天**無足夠資料庫活動
- **恢復**：Dashboard → 選專案 → **Resume project**，自助即可
- **資料**：**保留**。"The project will return to its previous state, including data and configurations."
- **恢復期限**：現行 docs 寫 **1 年**

> ⚠️ **官方內容有衝突**：2024-06-24 的 [changelog](https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days) 寫 **90 天**，但現行 [troubleshooting 頁](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause) 與 docs 寫 **1 年**。研判政策已放寬，但**請以 Dashboard 實際顯示為準，不要押在期限邊緣**。

**規避 pause 的做法**：接個 cron / uptime 監控定期打一次 DB query。注意這是規避，不是官方支持的用法。

**其他陷阱**：1 GB Storage + 5 GB egress 對圖片型應用偏緊。5 GB/月 egress ≈ 每月約 10,000 次 500 KB 圖片讀取（無 CDN 快取的情況）。

---

### 6.2 Neon

**Free plan** — [neon.com/pricing](https://neon.com/pricing)、[docs/introduction/plans](https://neon.com/docs/introduction/plans)

| 項目 | Free |
|---|---|
| 儲存 | **0.5 GB / project**（超過後**寫入直接失敗**，非降速） |
| Compute | **100 CU-hours / project**（官方換算 0.25 CU ≈ 400 小時/月） |
| 專案數 | **100 / organization** |
| 分支數 | 10 / project |
| 網路傳輸 | 5 GB/月/project |
| Managed Auth | 最高 60,000 MAU |

付費：Launch $0.106/CU-hour + $0.35/GB-month；Scale $0.222/CU-hour + $0.35/GB-month。**皆 pay-as-you-go，無月最低消費。**

**Scale-to-zero：✅** — [docs](https://neon.com/docs/introduction/scale-to-zero)
- 閒置 **5 分鐘**自動縮到零，**Free 方案無法關閉此行為**
- 冷啟動官方宣稱：「reactivates automatically **within a few hundred milliseconds**」（**官方宣稱值，非獨立實測**）

**Neon Auth** — [docs](https://neon.com/docs/neon-auth/overview)
- 底層是 **Managed Better Auth**，**支援 Google OAuth**
- 所有方案都含，Free 上限 60,000 MAU
- ⚠️ **狀態為 Beta**：「The Managed Better Auth is in Beta.」

**Databricks 收購**：**【二手來源】** Databricks 於 2025 年以約 $10 億美元收購 Neon（官方公告原文未查到）。**收購後的現行數字均已在官方頁面確認**；「收購前的舊數字」（50 CU-hours、10 projects、$1.75/GB）僅有二手整理，未能驗證。

**⚠️ 最大缺口：Neon 沒有物件儲存。** 圖片上傳必須另接 S3 / R2 / Cloudflare Images。

---

### 6.3 Turso

**免費額度現況** — [turso.tech/pricing](https://turso.tech/pricing)

| 方案 | 價格 | 資料庫數 | 儲存 | Rows Read/月 | Rows Written/月 |
|---|---|---|---|---|---|
| **Free** | $0 | **100** | **5 GB** | **500 M** | **10 M** |
| Developer | $4.99/月 | 無限 | 9 GB | 2.5 B | 25 M |
| Scaler | $24.92/月 | 無限 | 24 GB | 100 B | 100 M |
| Pro | $416.58/月 | 無限 | 50 GB | 250 B | 250 M |

Free 另含 3 GB/月 sync、PITR 保留 1 天。無需信用卡。

**2025–2026 平台變更：確有重大轉向，但沒有 sunset 公告。**

官方 blog 2025-01-21〈Upcoming changes to the Turso Platform and Roadmap〉— [連結](https://turso.tech/blog/upcoming-changes-to-the-turso-platform-and-roadmap)
- 對新用戶**移除 Edge replicas**、**移除 Multi-DB schemas 與 `ATTACH`**
- 全面遷移到 AWS；專案由 "Limbo" 更名為 "Turso"
- **伺服器端實作轉為 closed-source**，client 端維持開源
- 對既有付費客戶：「your existing production workloads will continue running exactly as they do today」

**產品線澄清**（常見混淆來源）：
- **libSQL** = SQLite 的 C fork，開源，**目前實際驅動 Turso Cloud 的引擎**，production-ready
- **Turso Database**（原代號 Limbo）= Rust 從零重寫的 SQLite 相容 DB，**仍在 beta**
- **Turso Cloud** = 託管服務，兩種引擎都可部署

[docs.turso.tech/introduction](https://docs.turso.tech/introduction) **沒有任何 deprecation / sunset banner**。

**【二手來源】** The Register 2026-07-29：Turso 完成 SQLite 的 Rust 重寫後，本月啟動 **Postgres 相容實作**。公司仍在積極開發，但**工程重心明顯轉向資料庫核心引擎，而非託管雲平台**（此為判讀，非官方陳述）。
— [連結](https://www.theregister.com/databases/2026/07/29/after-rewriting-sqlite-in-rust-turso-turns-its-sights-on-postgres/5279835)

**⚠️ Turso 沒有內建 Auth，也沒有物件儲存。**

---

### 6.4 Cloudflare D1 + R2 + Workers

**D1** — [docs](https://developers.cloudflare.com/d1/platform/pricing/)

| 項目 | Workers Free | Workers Paid |
|---|---|---|
| Rows read | **5 M / 天** | 首 25 B/月含，超出 $0.001/M |
| Rows written | **100,000 / 天** | 首 50 M/月含，超出 $1.00/M |
| Storage | **5 GB 總計** | 首 5 GB 含，超出 $0.75/GB-mo |

每日額度於 **00:00 UTC** 重置。**Egress 不收費。**

**R2** — [docs](https://developers.cloudflare.com/r2/pricing/)

| 項目 | 免費/月 | 付費 (Standard) |
|---|---|---|
| Storage | **10 GB-month** | $0.015/GB-month |
| Class A（寫入類） | **1 M requests** | $4.50/M |
| Class B（讀取類） | **10 M requests** | $0.36/M |
| **Egress** | **免費** | **免費** |

> "Egressing directly from R2...does not incur data transfer (egress) charges and is free."

⚠️ 免費額度**僅適用 Standard storage**。Infrequent Access 級別操作費更高且**額外收 retrieval $0.01/GB**。

**Workers** — [docs](https://developers.cloudflare.com/workers/platform/pricing/)

| 項目 | Free | Paid ($5/月起) |
|---|---|---|
| 請求數 | **100,000 / 天** | 1,000 萬/月含，超出 $0.30/M |
| **CPU 時間** | **10 ms / invocation** | 3,000 萬 CPU ms/月含；單次上限 5 分鐘 |
| Workers KV | 10 萬讀/天、1,000 寫刪/天、1 GB | 1,000 萬讀/月 |

> ⚠️ **最大陷阱：Free 方案每次呼叫只有 10 ms CPU 時間。** 純 I/O 等待不計入，但 **SSR render、圖片處理、密碼雜湊（bcrypt/argon2）很容易超標**。做 Nuxt SSR 幾乎一定要升到 Paid **$5/月**。

**與 Nuxt / Nitro 的整合成熟度：成熟，但 preset 選擇有已知混亂。**
- Nuxt 官方部署頁：[nuxt.com/deploy/cloudflare](https://nuxt.com/deploy/cloudflare)
- Cloudflare 官方 Nuxt 指南：[framework-guides/.../nuxt](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/nuxt/) —— `wrangler` 可自動偵測 Nuxt 並部署
- Nitro 有 `cloudflare` 與 `cloudflare_module` 等多個 preset
- ⚠️ Nitro repo 有專門討論串 [Confused about which Cloudflare preset to use](https://github.com/nitrojs/nitro/discussions/2876)，preset 名稱相近、文件分散是常見踩雷點

**Pages vs Workers**：**【二手引述】** Cloudflare Developer Week 2025 官方說法為「you should start with Workers... going forward, all of our investment... will be dedicated to improving Workers」。→ **新專案直接用 Workers，不要用 Pages。**（未直接擷取原始 blog）

**NuxtHub** — [hub.nuxt.com](https://hub.nuxt.com/docs/getting-started/installation)：整合 R2 blob storage、KV 等，目前 **v0.10**，有持續更新的 changelog，**無 deprecation 公告**。⚠️ 版本仍是 **0.x，尚未 1.0**。

**⚠️ 最大缺口：Cloudflare 完全沒有內建 Auth。** Google OAuth 必須自建（`nuxt-auth-utils` 或 `better-auth` + D1 存 session/user），比 Supabase 的「開一個開關」多出可觀工作量。

---

### 6.5 PlanetScale

**是否仍有免費方案：❌ 沒有。** — [planetscale.com/pricing](https://planetscale.com/pricing)（2026-09-05 擷取）

官方 pricing 頁上**只有付費 SKU 價格表，完全沒有 free tier、free trial、新用戶 credits 或 "Hobby" 方案**。

| 方案 | 起跳價 |
|---|---|
| **Postgres EBS non-HA（單節點）** | **$5/月**（PS-5，1/16 vCPU、512 MiB RAM，AWS us-east-1） |
| Postgres EBS HA（3 節點） | $15/月 |
| **Postgres Metal**（3 節點 + 本機 NVMe） | **$50/月** |
| Vitess non-metal（3 節點） | $39/月 |
| Vitess Metal | $609/月 |

**「PlanetScale Metal 是新免費方案」是誤解** —— Metal 是本機 NVMe 的高效能**付費**層級，$50/月起跳。

**【二手來源】** 2024 年 4 月取消 Hobby 免費方案後，至 2026 年 9 月免費方案**並未回歸**；改以 2025 年底推出的 $5/月 PS-5 作為低價替代。
— [The Register (2024-03-11)](https://www.theregister.com/2024/03/11/planetscale_lays_off_staff_and/)

**結論：對本情境已完全出局。** 最低 $5/月只買到 1/16 vCPU 單節點無 HA，且不含 Auth 與物件儲存。

---

## 7. 部署平台的**授權陷阱**（本報告第二重要）

> 條款原文皆為 **2026-09-05 擷取**。條款會變，**上線營利前請重新確認**。

### 7.1 一張表看完商業使用限制

| 平台 | 免費方案可否商業營利 | 依據 | 營利需升到 | 價格 |
|---|---|---|---|---|
| **Vercel Hobby** | ❌ **明文禁止** | ToS §4 + Fair Use Guidelines（兩處） | **Pro** | **$20 / 使用者 / 月** |
| **Zeabur Free** | ❌ **明文禁止** | Fair Use Guidelines | **Dev** | **$5 / 月** |
| **Cloudflare Workers/Pages** | ✅ **無商業禁令** | 逐字檢視 ToS 與 Service-Specific Terms，Developer Platform 章節無 commercial 字眼 | —（可留免費） | Workers Paid **$5 / 月**起 |
| **Netlify Free** | ✅ **允許** | 訂閱協議中「commercial」出現 **0 次** + 官方員工三度確認 | —（額度需求才升） | Pro **$20 / 月**起 |
| Railway / Render / Fly.io | ✅ 無商業禁令 | — | — | 見 7.6 |

> **全場唯二的法律紅線：Vercel Hobby 與 Zeabur Free。** 其餘平台的限制都是技術性與額度性的，不是法律性的。

**兩個最容易誤判的細節**：
1. **Vercel 說捐款「算」商業用途，Zeabur 說捐款「不算」。** 兩家判定相反。
2. **Cloudflare 的「Section 2.8 非 HTML 內容禁令」早在 2023 年就已廢除。** 現行條款只限制 CDN，且明確允許用 Developer Platform 承載大檔案。還在引用舊條款的文章都是過期資訊。

---

### 7.2 Vercel Hobby — ❌ **明文禁止商業用途（兩份文件都寫）**

#### （a）Fair Use Guidelines 原文

> ⚠️ 注意：`vercel.com/docs/limits/fair-use-policy` 已轉址至 **`/docs/limits/fair-use-guidelines`**（頁面 metadata `last_updated: 2026-07-29`）。

來源：[vercel.com/docs/limits/fair-use-guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage)

> ### Commercial usage
>
> **Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan.**
>
> Commercial usage is defined as any Deployment that is used for the purpose of **financial gain of anyone involved in any part of the production** of the project, **including a paid employee or consultant writing the code**. Examples of this include, but are not limited to, the following:
>
> - Any method of **requesting or processing payment** from visitors of the site
> - **Advertising the sale of a product or service**
> - **Receiving payment to create, update, or host the site**
> - **Affiliate linking** is the primary purpose of the site
> - The inclusion of **advertisements**, including but not limited to online advertising platforms like Google AdSense

> **Note: Asking for Donations fall under commercial usage.**

#### （b）法律服務條款 §4 獨立寫明

來源：[vercel.com/legal/terms](https://vercel.com/legal/terms)

> "You shall only use the Services under a Hobby plan for your **personal or non-commercial use**."

[Hobby 方案文件](https://vercel.com/docs/plans/hobby)（`last_updated: 2026-08-31`）第三度複述：
> "As stated in the fair use guidelines, the Hobby plan restricts users to non-commercial, personal use only."

#### 這個定義有多寬？—— 比多數人以為的更早觸發

- ⚠️ **連放 Google AdSense 都算**
- ⚠️ **連接受捐款都算**（官方 Note 明寫）
- ⚠️ **「宣傳一個產品或服務的銷售」就算** → 一個還沒開始收費、只是預告未來要收費的 SaaS landing page，**第一天就已經是商業用途**
- ⚠️ **最容易踩到的一條**：「financial gain of **anyone** involved in **any part of the production**, including a paid employee or consultant writing the code」→ **只要是有支薪的員工或外包寫的程式碼，就已構成商業用途**，即使網站本身不賺錢

**對本專案的意義**：只要你打算收費、放廣告、或甚至只是掛個「贊助我」按鈕，**Vercel Hobby 就不能用**。

#### 🚨 另一個少有人注意的 Hobby 條款：你的內容會被拿去訓練 AI

Vercel ToS §3 規定：**Hobby 與 trial Pro 方案**「we may use Your Content to train our artificial intelligence」；**付費 Pro 則預設不啟用模型訓練**。

> 對放私有商業程式碼的專案，這本身就是不該用 Hobby 的另一個理由。

#### 違規的實際後果

[官方 KB](https://vercel.com/kb/guide/why-is-my-account-deployment-blocked) 列出帳號/部署被暫停的四個原因：Spend Management / Usage limits or quotas / **A policy violation（違反 ToS 或 Fair Use，由 Vercel 人員暫停）** / A platform incident。該頁並重申：「Hobby teams are for non-commercial personal use only.」

→ **這不是沒有牙齒的條款，官方有暫停機制且會執行。**

#### 升級價格與超額計費

- **Pro：$20 / 使用者 / 月**（「Developer seats cost **$20 per user / month**, while Viewer seats are free」），含 **$20 monthly credit**。單人專案即 $20/月。
- **Pro on-demand 費率**：Active CPU「Starting at $0.128 per hour」、Provisioned Memory「Starting at $0.0106 per GB-hr」、Function Invocations「$0.60 per 1M」、Image transformations「$0.05 per 1K」、cache reads「$0.40 per 1M」、cache writes「$4.00 per 1M」；Fast Data / Origin Transfer 為[區域定價](https://vercel.com/docs/pricing/regional-pricing)。
- **Hobby 用量參考值**（fair use 指引，非硬性額度）：Fast Data Transfer 100 GB、Fast Origin Transfer 10 GB、Active CPU 4 CPU-hrs、Provisioned Memory 360 GB-hrs、Function Invocations 1M、Image transformations 5K/月、cache reads 300K/月、writes 100K/月。
- 其他差異：Projects 200 / 無限；Deployments per day 100 / 6,000；Build vCPUs 2 / 4（可到 30）；函式最長 300s / 可設到 800s（beta 1800s）。

#### 帳單爆炸風險：Hobby 安全，Pro 才是風險所在

**Hobby 結構上不會產生帳單**（[官方](https://vercel.com/docs/plans/hobby)）：
> "As the Hobby plan is a free tier there are no billing cycles. In most cases, if you exceed your usage limits on the Hobby plan, you will have to wait until 30 days have passed before you can use the feature again."

超量的後果是**暫停服務（503）**，不是收錢。

**Pro 的 Spend Management 現況**：
- 2025-09-09 changelog：「Spend Management is now enabled for **new Pro teams**, and will be enabled by default for existing teams when they switch to the new pricing model.」→ 現在新 Pro team **預設開啟**
- ⚠️ **設定金額本身不會停止用量**：「Setting a spend amount does not automatically stop usage. If you want to pause all your projects at a certain amount, you must enable the option.」
- ⚠️ **不是即時硬上限**，官方自己警告：
  > "Because these checks are not continuous, notifications, webhooks, and project pausing can trigger **several minutes after** you cross your spend amount. Plan for this delay if you are relying on Spend Management to cap usage, and **consider setting your spend amount below the absolute maximum you are willing to spend**."
  >
  > "Pausing is not instantaneous... projects can keep serving traffic and accruing usage for several minutes after you cross the spend amount."
- 暫停後訪客看到 `503 DEPLOYMENT_PAUSED`，且**必須逐一手動恢復**：「Projects won't automatically unpause if you increase the spend amount, you must resume each project manually.」
- 涵蓋範圍**不含**席位、Marketplace 整合與 add-ons

> **【二手來源，未能從官方頁面驗證】** 網路流傳 DDoS 導致 $23,000 帳單、學生收到 $3,200 帳單等案例。金額無法證實，僅供風險參考。**可確認的官方事實**是：Pro 採用量計費，Spend Management 有數分鐘延遲、非即時硬上限。

---

### 7.3 Zeabur（台灣團隊）— ❌ **Free 同樣明文禁止營利，且違規無寬限期**

#### 營運現況：正常

Fair Use Guidelines 標示「Last updated on **May 8, 2026**」，Terms of Service 標示「Last updated on **July 14, 2026**」，頁尾「2026 © Zeabur Inc.」。文件持續更新（含從 Heroku / Railway / Vercel / Fly.io 遷移、從 Replit / Lovable / Bolt 匯入等新內容）。

#### 定價（[zeabur.com/pricing](https://zeabur.com/pricing)）

| 方案 | 價格 |
|---|---|
| Free | US$0 / 月 |
| **Dev** | **US$5 / 月**（14 天免費試用）— 含 monitoring & backups |
| Pro | US$19 / 月（14 天免費試用，官方標示 recommended for production） |
| Team | US$79 / 月（含 3 seats，+US$24/seat） |
| Enterprise | 客製 |

Free 資源：1 台自管伺服器、2C4G build CI 規格、48h log 保留、單檔上傳 50 MB。

#### 商業使用限制（原文）

來源：[zeabur.com/docs/en-US/compliance/fair-use-guidelines](https://zeabur.com/docs/en-US/compliance/fair-use-guidelines)

> **"Serverless plans are restricted to non-commercial use only. All commercial usage requires a Developer or Team plan."**
>
> Commercial usage is defined as any usage that is intended for commercial purposes, including but not limited to:
> - Requesting payment for access to your services.
> - Advertising or promoting a product or service.
> - Receving payment for the service development and maintenance.
> - With a primary purpose of affiliate marketing.
>
> **"Donations are not considered commercial usage."**

#### 🚨 違規處置：免費方案是**立即終止、無寬限期**

> For **Serverless plan** users, since you're not getting verified with a paid plan, if we've detected that your usage is not fair, we will **terminate your services immediately**, and if you keep violating the guidelines, we will **suspend your account permanently**.
>
> For **Developer plan and Team plan** users, we will notify you first via email... and there will be a **3-day grace period** for you to adjust your usage.

> **這是選擇付費方案的實際理由之一** —— $5/月買到的不只是合法性，還有「被通知而不是被直接砍掉」。

#### ⚠️ 條款用語與定價頁不一致（需注意）

Fair Use 頁用的是舊方案名「Serverless plan / Developer plan / Team plan」，但目前定價頁是 Free / Dev / Pro / Team。合理推斷「Serverless」對應現在的 **Free**、「Developer」對應 **Dev**，但**官方未同步更新用語，這屬推斷而非條款明文**。有疑慮建議去信確認。

另：Zeabur 的 **Terms of Service 全文（2026-07-14 版）完全沒有出現 "commercial" 這個字**，商業限制只存在於 Fair Use Guidelines。（部分二手摘要聲稱 ToS 含「internal, personal, non-commercial purposes」字樣，在實際頁面全文中**無法驗證**，判定為錯誤摘要。）

#### Free 方案的其他限制（[官方 Free Plan 頁](https://zeabur.com/docs/en-US/pricing/free-plan)）

> "The Free Plan is Zeabur's free tier, designed for **personal exploration and learning**. No credit card required."
> - "Services on the Free Plan **automatically sleep** after a period of inactivity. They wake up on the next incoming request, which may cause a few seconds of **cold-start latency**."
> - "**No SLA** — The Free Plan does not include a Service Level Agreement"
> - "**No Zeabur Email** — Sending email through Zeabur Email is not available on the Free Plan"
> - 無自動資料庫備份/匯入、無 log forwarding（這些從 Dev Plan 起才有）

#### 是否適合 Nuxt SSR

✅ **架構上很適合。** Zeabur 是**容器 / 長駐服務模型**（有 auto-sleep、volumes、replicas、health checks、private networking），本質上比 serverless function 模型更貼近 Nuxt SSR 的需求 —— **沒有 Cloudflare Workers 那種 CPU 時間限制**。官方有 [Nuxt 專頁](https://zeabur.com/docs/en-US/guides/nodejs/nuxt)，支援 GitHub 連動部署（pnpm 使用者需在 `.npmrc` 設 `shamefully-hoist=true`）。

⚠️ **未能驗證**：官方 Nuxt 頁**沒有明確描述 SSR 模式的設定或支援聲明**，只描述一般部署流程。建議先用 Dev Plan 的 14 天試用實測 `nuxt build` + `node .output/server/index.mjs`。

⚠️ 其他保留：規模與資源遠小於 Vercel/Cloudflare，長期營運穩定性需自行評估。

---

### 7.4 Cloudflare Workers / Pages — ✅ **無商業使用限制**

#### （a）Section 2.8 現況：**已廢除，並限縮到只管 CDN**

舊的 Self-Serve Subscription Agreement §2.8「Limitation on Serving Non-HTML Content」**已於 2023 年 5 月改版移除**。現行 [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/)（Last Updated **September 12, 2025**）只有 §1–§20，§2 底下是 2.1–2.7，**沒有 2.8**。

限制搬到了 [Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/)（Last updated **June 02, 2026**），章節改名為「**Content Delivery Network (Free, Pro, or Business)**」：

> "Cloudflare's content delivery network (the "CDN") Service can be used to cache and serve web pages and websites. Unless you are an Enterprise customer, **Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN.** Cloudflare **reserves the right to disable or limit** your access to or use of the CDN... if you use or are suspected of using the CDN **without such Paid Services** to serve video or a disproportionate percentage of pictures, audio files, or other large files. We will use reasonable efforts to provide you with notice of such action."

> ✅ **關鍵差異**：舊條款是「HTML vs 非 HTML」的**內容型態禁令**；新條款改成「**只要你用 Cloudflare 自家的付費服務（Developer Platform / Images / Stream）承載，就可以正常提供影片和大檔案**」。
>
> 而 **Workers / Pages / R2 本身就被列為 "Developer Platform"**，正是條款點名的**合法途徑**。
>
> **對「使用者上傳圖片」的 SaaS 的結論：把圖片放 R2 是完全合規的正解**，不是打擦邊球。

#### （b）Developer Platform 章節：**沒有任何商業限制**

Service-Specific Terms 的「Cloudflare Developer Platform (Cloudflare Workers; Cloudflare Pages; Workers KV; D1; Durable Objects; Vectorize; Hyperdrive; Cloudflare Queues; R2; Containers; and Workers for Platforms)」章節經逐字檢視，**沒有任何 commercial / non-commercial 字眼，也沒有內容型態限制**。唯一的用量條文是：

> "Cloudflare may temporarily limit your storage and/or the number of requests you can make or receive using the Developer Platform if processing such requests would put an **undue burden** on the Cloudflare network..."

#### （c）⚠️ 唯一與收費 SaaS 直接相關的限制：免費服務不得處理信用卡

[Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/) **§2.2.1(h)**：

> "Unless otherwise expressly permitted in writing by Cloudflare, you will not and you have no right to: … (h) **process or collect personal or business credit card information on any web property that is receiving Free Services**"

**實務解讀（分析，非官方明文）**：若你的 SaaS 直接在自架付款表單上收集卡號，而該網域走 Cloudflare 免費方案，就會踩到這條。改用 **Stripe Checkout / Paddle 這類導向站外託管付款頁**的做法，卡號在 Stripe 網域上收集，理論上不落在「receiving Free Services 的 web property」上。但這條的邊界官方沒有進一步說明，**營收規模上來後建議直接付費或去信確認**。

其他相關禁令：§2.2.1(a) 不得轉售存取權；§2.2.1(j) 不得提供 VPN 或類似 proxy 服務。

#### （d）價格與額度

- **Workers Paid：「a minimum charge of $5 USD per month for an account」**
- **Workers Free**：requests 100,000/天、CPU time **10 ms** per invocation、subrequests 50/request、memory 128 MB
- **Workers Paid**：requests 無上限、CPU time **5 min**（HTTP 請求預設 30 秒）、subrequests 10,000/request（可擴充至 10M）、memory 128 MB
- ✅ **Pages 靜態資源**：「On both free and paid plans, requests to static assets are **free and unlimited**」← **對小型 SaaS 最大的成本優勢**
- **Pages Free 其他限制**：500 builds/月、1 concurrent build、100 projects/帳號、20,000 files/site、單檔最大 25 MiB、100 custom domains/project。Pages Functions 的請求數併入 Workers 的 100,000/日 免費額度。

**帳單風險：最低。** 額度是固定日配額而非計費，靜態資源免費且無上限。

---

### 7.5 Netlify — ✅ **允許商業使用**，但新制是「用完停站」

#### （a）商業使用：允許

**條款面（消極確認）**：Netlify 服務受 [Self-Serve Subscription Agreement](https://www.netlify.com/legal/self-serve-subscription-agreement/) 規範。全文逐字檢索，**「commercial」一詞出現次數為 0**，**不存在**任何商業用途禁令。（`netlify.com/legal/terms-of-use/` 只是網站使用條款。）

**官方員工三度確認**（Netlify 官方支援論壇，屬官方人員發言但非條款文字）：
> hrishikesh（Netlify Staff），2021-07-27：「Yes, you can use the free plan for commercial projects. What ToS means that you can't resell it..., but you can definitely charge your customers for your services in building, and maintaining their websites.」
>
> SamO（Netlify Staff），2024-01-04：「You are welcome to use the free tier for commercial purpose.」
>
> hrishikesh，2025-05-27 再次確認：「Yes, it's still correct.」

— [answers.netlify.com](https://answers.netlify.com/t/can-we-use-netlify-free-plan-for-commercial-purposes/41545)

**唯一紅線：不得轉售 Netlify 託管服務本身。**

#### （b）⚠️ 但免費層有「隨時砍站」與「保留超額收費權」兩條

訂閱協議原文：

> "the Free Usage Tier is offered at Netlify's **sole discretion**... we reserve the right to **disable or remove any website project on Netlify's Free Usage Tier without notice at our sole discretion**. Free Usage Tier website projects will reside in a common build environment shared by all Free Usage Tier users with **no service level commitments**."

> "For Free Usage Tier Customers, the Services may be terminated by either Netlify or Customer, **without cause, immediately upon notice**."

Section 5 (Fees) —— **這條對「是否會自動收費」很關鍵**：

> "For Free Usage Tier Customers, if use exceeds the Services capacity applicable to the Free Usage Tier, **Customer will incur and agrees to pay additional fees that reflect actual usage**..."

⚠️ **訂閱協議在法律文字上仍保留對免費層超額收費的權利。** 這正是 2024 年 $104K 事件的條款基礎。

另一條容易忽略的：「Netlify Managed DNS or Netlify functions are strictly for use with sites deployed to Netlify.」→ **不能把 Netlify Functions 當作獨立 API 給外部站台呼叫。**

#### （c）新制 credits：硬上限，不會自動扣款

**重大變更**：Netlify 自 **2025-09-04** 起對新帳號改用 **credit-based plans**；之前建立的帳號沿用 legacy plans。

**Free 方案（新制）**：
- **300 credits / 月，credit hard limit，無 auto recharge 選項**
- 1 concurrent build、3 databases、20 active branches、7 天備份保留、1 Team Owner
- 換算率：**頻寬 20 credits/GB**、**production deploy 每次固定 15 credits**（build minutes 已不再單獨計算）、**運算 10 credits per GB-hour**（函式不按呼叫次數計費）、Web Requests 2 credits/10,000 次。Deploy Preview / Branch Deploy 與 Form Submissions 為 0 credits
- → **300 credits 若全用於頻寬 ≈ 15 GB/月**。比舊制的 100 GB 大幅縮水，對圖片型 SaaS 相當吃緊

**用完會發生什麼**（[官方文件](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)）：
> "Once your credit balance is completely used up, **all of your web projects (sites/apps) are paused** and visitors to your web projects will find a `Site not available` page at each of your web project's URLs."

> "Unused monthly credits **do not roll over**, except on Pro plans with 5,000 or more monthly credits."

→ **是「停站」而不是「自動扣款」。** Auto recharge 僅開放 Personal（500 credits / $5）與 Pro（1,500 credits / $10），Free 沒有這選項。這實質上解決了免費層帳單爆炸問題 —— ⚠️ **但僅限新制帳號；legacy 帳號行為可能不同，需個別確認**。

**Pro 價格**：「Starts at **$20/month for 3,000 credits**」，級距 5,000 credits ($33/mo)、10,000 ($63/mo)、15,000 ($95/mo)、20,000 ($126/mo)。**Pro 為 flat $20/月、成員不限**（不分席位計價，與 Vercel 的 per-seat 模式不同）。

> **【二手來源，未能從官方頁面驗證】** 2024 年 2 月一名開發者在免費層收到約 $104,000 帳單（單一 3.44MB MP3 被下載約 5,500 萬次 ≈ 190TB egress），Netlify 先減免至 $5,225，後由 CEO 全額免除。**可確認的官方事實**是：現行新制 Free 已改為 hard limit + 停站，不再有超額自動計費的路徑。

---

### 7.6 其他平台（補充）

#### ⚠️ Fly.io —— **本次調查中帳單爆炸風險最高的一家**

[fly.io/docs/about/cost-management](https://fly.io/docs/about/cost-management/) 官方原文：

> "**Free allowances don't cap your bill.** We may give you free credits and usage allowances... But **there's no soft ceiling. If you go over, we'll bill you. We don't support billing alerts (yet), so budget accordingly.**"

> **Fly.io 既沒有 spend limit，也沒有 billing alert，且強制綁卡**（"adding a card **ends** the free trial"；試用機器「automatically stop after running for 5 minutes」）。這是本次所有平台中**唯一官方承認「無任何自動花費上限機制」**的一家。對可能遭遇流量尖峰或 DDoS 的營利 SaaS，**風險最高，不建議**。

#### ⚠️ Render —— 免費層**封鎖 SMTP 連接埠**，對 SaaS 是硬傷

[render.com/docs/free](https://render.com/docs/free) 官方原文：

> "Free web services can't send outbound network traffic on **ports 25, 465, or 587**, commonly used for SMTP."

小型 SaaS 幾乎必然需要寄驗證信、密碼重設信。解法是改用 HTTP API 型郵件服務（Resend / SendGrid / Postmark 的 REST API），或升級付費。**這比休眠、冷啟動更容易在上線前才踩到。**

另兩條容易誤判的條款：
> "Render may **suspend** a Free web service that initiates an uncommonly high volume of traffic over the public internet."

> "**Upgrading your workspace plan does not remove limitations on Free instances.**"

⚠️ **第二條很重要**：把 workspace 升到 Pro $25/月**不會**解除 Free instance 的休眠與時數限制，必須另外升級該 service 的 compute plan（**Starter $7/月**起）。所以 Render 跑一個正式服務的實際起跳是 **$0（Hobby workspace）+ $7（Starter instance）**，不是 $25。

✅ 正面：Render 的 **Static Sites「Always free to deploy」**。

#### Railway

[docs.railway.com/reference/pricing/free-trial](https://docs.railway.com/reference/pricing/free-trial) 原文：
> "The trial gives access to basic features for up to 30 days and includes a one-time grant of $5. After 30 days passes or $5 is spent, the free trial **reverts to the Free plan, which provides $1 of free credit per month. The credit does not roll over** month to month."

- 資料保留：Free / Trial 方案「**30 days after expiry**」
- ⚠️ 未驗證帳號有網路限制：「services on the Limited Trial have **restricted outbound network access and only a limited set of ports are available**」
- 「Bring Back the Free Plan」官方部落格發布日為 **2025-08-27**

---

### 7.7 帳單爆炸風險排序（高 → 低）

1. **Fly.io** —— 官方明文無花費上限、無帳單警示，且強制綁卡
2. **Vercel Pro** —— 有 Spend Management 且新 team 預設開啟，但官方自承檢查間隔數分鐘、暫停非即時
3. **Railway / Render 付費層** —— 用量計費，但有方案內含額度作為緩衝
4. **Netlify Free（新制）** —— 300 credits 硬上限，用盡即**停站**（帳單安全、可用性不安全）。⚠️ legacy 帳號另計
5. **Cloudflare Workers/Pages** —— 固定日額度，靜態資源免費且無上限
6. **Vercel Hobby / Zeabur Free / Railway Free** —— 結構上不產生帳單，超量只會暫停或休眠

### 7.8 對本專案的部署建議

**若這個 SaaS 會收費、放廣告，或只是掛個贊助按鈕：**

| 排名 | 方案 | 月成本 | 理由 |
|---|---|---|---|
| 🥇 | **Cloudflare Workers Paid** | **$5** | 條款無商業禁令、R2 egress 免費且圖片走 Developer Platform 完全合規、靜態資源免費無上限、額度是固定日配額不會爆帳單 |
| 🥈 | **Zeabur Dev** | **$5** | 合法營利門檻最低、容器長駐最貼合 Nuxt SSR（無 CPU 時間限制）、台灣團隊中文支援、亞洲節點延遲低 |
| 🥉 | Vercel Pro | $20 | DX 最好，但**單人就要 $20/月**、usage-based 且 Spend Management 非即時 |

**⛔ 絕對不要做的事**：把一個會收費／放廣告／接受捐款的 SaaS 部署在 **Vercel Hobby** 或 **Zeabur Free** 上。
- Vercel 的定義寬到「只是宣傳一個未來要收費的產品」「程式碼是有支薪的人寫的」就已觸發，且 Hobby 內容還會被拿去訓練 AI。
- Zeabur Free 違規是**立即終止服務、無寬限期**，累犯永久停權。

---

## 8. Nuxt 的 Google OAuth 方案

> 版本號查自 npm registry / GitHub API，擷取日期 **2026-09-05**。

### 8.0 快速結論

> **最簡單** → `@nuxtjs/supabase`（若已決定用 Supabase）或 `nuxt-auth-utils`（若自建 DB）
> **最有彈性** → Better Auth
> **要避免** → `@sidebase/nuxt-auth`

| 方案 | 版本 | 最近發版 | Stars | 週下載 | Nuxt 4 支援 | 判定 |
|---|---|---|---|---|---|---|
| `nuxt-auth-utils` | **0.5.30** | 2026-08-04 | 1,593 | **110,801** | ✅ 依賴 `@nuxt/kit ^4.3.1` | 🥇 首選 |
| **Better Auth** | **1.7.2** | 2026-08-26 | **29,827** | **7,455,030** | ✅ e2e 釘 `nuxt 4.5.2` | 🥈 次選 |
| `@nuxtjs/supabase` | **2.0.10** | 2026-08-10 | 934 | 56,614 | ✅ README 明寫 | 🥉 綁 Supabase 時選 |
| `@sidebase/nuxt-auth` | 1.3.1 | 2026-06-30 | 1,549 | 43,752 | ❌ 仍 `@nuxt/kit ^3.20.2` | ❌ 避免 |

---

### 8.1 `nuxt-auth-utils` — 首選

**Google OAuth：✅ 完整支援。** `defineOAuthGoogleEventHandler` 位於 `src/runtime/server/lib/oauth/google.ts`，共 **48 個 provider**。
- 預設 scope `['email', 'profile']`
- 設定 `NUXT_OAUTH_GOOGLE_CLIENT_ID` / `NUXT_OAUTH_GOOGLE_CLIENT_SECRET`
- Callback URL = handler 的 route 路徑（`server/routes/auth/google.get.ts` → `<domain>/auth/google`），可用 `NUXT_OAUTH_GOOGLE_REDIRECT_URL` 覆寫
- 支援 `authorizationParams`（可傳 `access_type=offline` 拿 refresh token）

#### 🚨 必看：0.5.30 是安全修補版

**GHSA-xc49-mgwh-9pjv**（2026-08-04，severity: medium）：
> OAuth `state` parameter not validated in most providers (**login CSRF**)

大多數 provider 在 authorization callback 沒驗證 `state`，攻擊者可讓受害者瀏覽器執行 `onSuccess` → 強制登入或非預期的帳號連結。

> **任何低於 0.5.30 的版本都有此漏洞，務必 pin `>=0.5.30`。**
— [security advisory](https://github.com/atinux/nuxt-auth-utils/security/advisories/GHSA-xc49-mgwh-9pjv)

#### Session 機制：sealed cookie

基於 h3 的 `useSession`，資料**加密後直接存 cookie**，伺服器不存 state。需 `NUXT_SESSION_PASSWORD`（≥32 字元，dev 自動生成）。

> ⚠️ **硬限制 4096 bytes**。README 原文：「Since we encrypt and store session data in cookies, we're constrained by the 4096-byte cookie size limit」。issue #354 仍 open。`secure` 區塊雖只有 server 可讀，**仍佔用同一個 4KB 額度**。

#### 搭配自建 DB：✅ 適合，但要自己寫

**沒有 DB adapter，user upsert 完全自己寫**（這是設計取向，不是缺陷）：

```ts
// server/routes/auth/google.get.ts
export default defineOAuthGoogleEventHandler({
  async onSuccess(event, { user, tokens }) {
    // 這裡自己 upsert 到 Postgres / SQLite
    await setUserSession(event, { user: { id: dbUser.id } })
    return sendRedirect(event, '/')
  },
})
```

**繞過 4KB 的標準解法**：cookie 只存 `userId`，其餘用 `sessionHooks.hook('fetch', ...)`（放在 `server/plugins/session.ts`）在每次讀 session 時回 DB 補資料。

#### ⚠️ 「Nuxt 官方生態」的細微差別

- ✅ 作者確實是 **Sébastien Chopin (atinux)**，Nuxt 共同創辦人 / NuxtLabs
- ⚠️ 但 repo 在**個人帳號**下（`atinux/`，不是 `nuxt/` 或 `nuxt-modules/`）
- ⚠️ Nuxt 官方 module registry 標為 **`3rd-party`**，不是 `official` 也不是 `community`（對比 `@nuxtjs/supabase` 是 `community`、`@nuxt/ui` 是 `official`）

> 正確說法：**由 Nuxt 核心成員個人維護，但不是官方模組。**

#### 已知限制

1. **必須有 server**：README 明寫只能 `nuxt build`，**不能 `nuxt generate`**
2. **Prerender 抓不到 session**（有 `loadStrategy: 'client-only'` 選項）
3. **4096 bytes cookie 上限**
4. **沒有內建 refresh token 機制**：issue #91（2024-05 開，25 留言）、#356 皆仍 open
5. ⚠️ **release 節奏不穩**：0.5.29（2026-02-17）→ 0.5.30（2026-08-04）**中間空了近 6 個月**，且 0.5.30 是被安全通報逼出來的
6. 仍在 **0.x**（無 SemVer 穩定保證）；仍用 h3 v1
7. 其他 open issue：#533 `replaceUserSession` 沒真的 replace、#431 `getUserSession` 在 `cachedEventHandler` 內回傳不完整、#520 production 強制 Secure cookie 導致內網部署失敗

---

### 8.2 Better Auth 1.7.2 — 次選，最有彈性

**官方 Nuxt 支援：✅ 有**（比一般認知更明確）。在 better-auth 主 repo 查到：
1. 官方整合文件 `docs/content/docs/integrations/nuxt.mdx`
2. **完整 e2e 測試套件** `e2e/integration/nuxt/`，含 Playwright `session-hydration.spec.ts`
3. **e2e 的 `package.json` 釘死 `"nuxt": "4.5.2"`** ← 即最新 Nuxt，CI 持續驗證
4. 有針對 Nuxt 的專門修正 changeset

⚠️ **但沒有 `@better-auth/nuxt` npm 套件**，整合是手動的：

```ts
// server/api/auth/[...all].ts
import { auth } from '~~/lib/auth'
export default defineEventHandler(event => auth.handler(toWebRequest(event)))

// lib/auth-client.ts
import { createAuthClient } from 'better-auth/vue'
export const authClient = createAuthClient()

// app/pages/index.vue
const { data: session } = await authClient.useSession(useFetch) // 必須傳 useFetch 才能 SSR
```

**Google**：`socialProviders: { google: { clientId, clientSecret } }`，callback `/api/auth/callback/google`。⚠️ 文件警告**必須設 `baseURL`（或 `BETTER_AUTH_URL`）**，否則 production 會 `redirect_uri_mismatch`。

**DB**：原生支援 SQLite / PostgreSQL / MySQL，官方 adapter 有 drizzle / prisma / kysely / mongo / memory（皆 1.7.2）。也支援 stateless（無 DB）模式。

> ⚠️ **已知 SSR 陷阱（官方文件自己標注）**：除了 `useSession(useFetch)` 之外，其他 `authClient` action 在 SSR 時**預設不會轉發 cookie，會回傳「未登入」**。
> 解法：(A) 用 `<ClientOnly>` / `import.meta.client` 只在 client 呼叫；(B) 自己包 request-scoped client 用 `useRequestHeaders(['cookie'])` 轉發。

**社群 module `nuxt-better-auth` v0.6.1**（2026-08-26）：⚠️ **只有 3 stars、283 週下載，不要在正式專案依賴。**

**何時該選它而非 nuxt-auth-utils**：未來要加 magic link / 2FA / passkey / organization / Stripe 訂閱 / API key（都是官方 plugin）；想要現成 schema + migration CLI，不想手刻 users/accounts/sessions 三張表。

---

### 8.3 `@nuxtjs/supabase` 2.0.10 — 維護最健康

- README Features 第一條就是「**Nuxt 3 and 4 ready**」，`src/module.ts` 宣告 `compatibility: { nuxt: '>=3.0.0' }`
- Nuxt registry 標為 **`community`**（`nuxt-modules` 官方社群 org），維護者含 Baptiste Leproux、Sébastien Chopin、Scott Robertson
- **Open issues 僅 15 個，三者中最少**；release 節奏穩定
- 依賴 `@supabase/ssr ^0.12.4`、`@supabase/supabase-js ^2.112.2`

**Google OAuth 整合難度：三者中最低。** 模組本身不做 OAuth，全交給 Supabase：
1. Dashboard → `Authentication → Providers` 開 Google，貼 client id/secret
2. Dashboard → `URL Configuration → Redirect URLs` 加上你的 `/confirm`
3. 前端 `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: '.../confirm' } })`
4. 建 `pages/login.vue` + `pages/confirm.vue`（PKCE flow 需要）

**你不用碰任何 server route、不用管 token exchange、不用自己存 user。**

#### ⚠️ 已知限制（全部出自官方文件）

1. **SSR cookie 有硬性取捨**：當 `useSsrCookies: true` 時，`flowType` / `autoRefreshToken` / `detectSessionInUrl` / `persistSession` / `storage` **不能自訂**。要自訂就得設 `useSsrCookies: false`，而這會**關掉 SSR 支援**。
2. **強制的兩頁 redirect 流程**：預設未登入者訪問任何頁都被導向 `/login`，**公開頁必須手動列進 `exclude`**（或用 `include` 白名單）。要「登入後回原頁」需開 `saveRedirectToCookie` + `useSupabaseCookieRedirect()`。
3. **cookie 壽命 ≠ session 壽命**：預設 `maxAge: 60*60*8`，文件特別提醒這裡設的 lifetime **不決定** Supabase session lifetime。容易踩坑。
4. ⚠️ **v1 → v2 是 breaking change**（JWT signing keys）：`useSupabaseUser` 現在回傳 **JWT claims**（`auth.getClaims()`）而非完整 User object。**消失的欄位**：`identities`、`last_sign_in_at`、`confirmed_at`、`email_confirmed_at`。
5. 其他 open issue：#386 `Invalid Refresh Token`、#369 i18n 路由 redirect、#339 已登入者仍能進 login 頁
6. **綁定 Supabase**：帳號在 Supabase 的 `auth.users`，與自建 DB 是兩套（但 Supabase 本身就是 Postgres，可用 FK + RLS 串起來）

---

### 8.4 `@sidebase/nuxt-auth` — ❌ 避免

**不是「死掉」了**（2026-09-04 還有 bugfix commit，維護者 `phoenix-ru` 持續回覆），但**對一個 2026 年才開的 Nuxt 4 新專案，沒有任何理由選它**。三個獨立紅旗同時成立：

**🚩 1. Nuxt 4 支援 issue 開了 13 個月未解**
[issue #1043「Add support for Nuxt 4」](https://github.com/sidebase/nuxt-auth/issues/1043) 建立於 **2025-07-28，至今 open**，最後更新 2026-08-14（社群「Bump this」）。`package.json` 仍是 **`@nuxt/kit ^3.20.2`**，官方文件只說「Nuxt 3+ applications」，**未提及 Nuxt 4**。

**🚩 2. 卡死在 NextAuth v4.21.1**
`peerDependencies: { "next-auth": "~4.21.1" }`。官方文件承認 **NextAuth 4.22+ 改了 package exports，導致 NuxtAuth 使用者無法升級**，且「new features that are Auth.js only are not guaranteed to work」。

**🚩 3. 底層的 Auth.js 已被 Better Auth 接手**
2025-09-22 Better Auth 官方部落格宣布：
> "Auth.js, formerly known as NextAuth.js, is now being maintained and overseen by Better Auth team."

Better Auth 團隊承諾處理 security patch，但**明確建議新專案改用 Better Auth**。
— [better-auth.com/blog/authjs-joins-better-auth](https://www.better-auth.com/blog/authjs-joins-better-auth)

而 sidebase 自己的兩條遷移路線都卡住：
- [#673「Migration to authjs」](https://github.com/sidebase/nuxt-auth/issues/673) 2024-02-23 開，**至今 open**，2026-02 有人留言「Is there still hope of seeing this done? 🤣」
- [#1058「Migration to BetterAuth」](https://github.com/sidebase/nuxt-auth/issues/1058) 2025-09-27 開，仍 open

**其他痛點（open issue，按留言數）**：#732 Refreshing a page removes the cookie（61 留言）、#973 Recursion detected at /session（47 留言）、#851 無法對 authCookie 使用 httpOnly（11 留言）。

---

### 8.5 其他方案（免費額度對照）

| 方案 | Nuxt module | 免費額度 | 付費起跳 | 備註 |
|---|---|---|---|---|
| **Clerk** | `@clerk/nuxt` **3.1.0**（2026-09-02，活躍） | **50,000 MRU / app** | Pro **$25/mo**（年繳 $20）；超額 $0.02/user/mo | ⚠️ 單位是 **MRU**（monthly *retained* user）不是 MAU |
| **Logto** | `@logto/nuxt` 1.2.10（⚠️ 2026-04-08，5 個月未更新） | **50,000 MAU + 50K tokens**，但**免費版只有 1 個 social connector** | 從 **$24/mo**（改 token 計費） | 可自架（開源）。Google-only 剛好夠用 |
| **Auth0** | ⚠️ **沒有官方 `@auth0/nuxt`** | **25,000 MAU** | B2C Essentials **$35/mo**（500 MAU 起） | 只能走通用 OIDC SDK 自己接 |
| `nuxt-oidc-auth` | 1.0.0-beta.12（2026-08-25） | — | — | 純 OIDC，仍 beta |
| `@nuxtjs/kinde` | 0.4.0（⚠️ 2025-09-17，快一年未更新） | — | — | 不建議 |

> ⚠️ Clerk 的「MRU 需註冊後 24 小時回訪才計數」這個解釋**來自第三方**，未在 Clerk 官方頁面直接證實。

---

### 8.6 針對本情境的取捨建議

**情境：Nuxt 4.5.x + Google OAuth + 自建 Postgres/SQLite + 小流量個人 SaaS**

#### 🥇 首選：`nuxt-auth-utils@^0.5.30`

- 你的需求正是它的甜蜜點：單一 OAuth provider + 自己管 user 表 + 小流量
- **程式碼量最少**：一個 `server/routes/auth/google.get.ts` + `onSuccess` 裡的 DB upsert，約 20 行
- Sealed cookie 完全無狀態，**不需要 session table、不需要 Redis**，小流量下零運維成本
- 純 UnJS 依賴，跟 Nuxt 4 / Nitro 貼合度最高
- 使用量三者最高（110K/week）

**必須接受的條件**：
1. **務必 pin `>=0.5.30`**（login CSRF）
2. **cookie 只放 `userId`**，其餘用 `sessionHooks.hook('fetch')` 回 DB 撈
3. 沒有內建 refresh token 輪替，Google refresh token 要自己存 DB
4. 不能 `nuxt generate`
5. 心理準備：release 會有數個月空窗

#### 🥈 次選：Better Auth 1.7.x（手動整合）
未來要擴充（2FA / passkey / organization / Stripe）就選它。它是 Auth.js 的實質繼承者，29.8K stars、每天有 commit、官方對 Nuxt 4.5.2 有 e2e 測試。

#### 🥉 `@nuxtjs/supabase`：**只在「已決定用 Supabase 當主 DB」時選**
它不符合「自建 DB」的前提 —— 選它等於選 Supabase 平台。但若你願意讓 Supabase 當你的 Postgres，Google OAuth 整合難度是三者最低。

#### ❌ 避免：`@sidebase/nuxt-auth`（見 8.4）

---

## 9. 「未能驗證」清單

以下項目**沒有**取得可靠的一手來源，或官方內容彼此衝突。決策時請自行再確認，**不要當作已確認事實使用**。

### 9.1 官方內容互相衝突

| 項目 | 衝突內容 | 建議做法 |
|---|---|---|
| **Supabase 暫停專案的恢復期限** | 現行 [docs](https://supabase.com/docs/guides/platform/free-project-pausing) 與 [troubleshooting 頁](https://supabase.com/docs/guides/troubleshooting/restore-project-after-90-days-pause) 寫 **1 年**；2024-06-24 的 [changelog](https://supabase.com/changelog/27497-paused-free-plan-projects-are-restorable-for-90-days) 寫 **90 天** | 研判政策已放寬至 1 年，但**以 Dashboard 實際顯示為準**，不要押在期限邊緣 |
| **Zeabur 方案名稱** | Fair Use Guidelines 用舊名「Serverless / Developer / Team」，定價頁是「Free / Dev / Pro / Team」 | 「Serverless = Free、Developer = Dev」屬**推斷非明文**。有疑慮請去信 Zeabur 確認 |

### 9.2 僅有二手來源，官方頁面無法驗證

- **Databricks 收購 Neon**（2025 年、約 $10 億美元）—— 官方公告原文未查到。但 **Neon 現行的免費額度與付費費率均已在官方頁面逐項確認**。
- **Neon 收購前的舊數字**（50 CU-hours、10 projects、$1.75/GB-month）—— 僅有第三方整理。
- **Turso 2025-03-31 Free tier 縮減的官方 blog 原文**未直接擷取，但**調整後的數字與現行官方 pricing 頁完全一致**，可視為已確認的現值。
- **Cloudflare 2025 Developer Week 關於「新專案應用 Workers 而非 Pages」的宣告** —— 為二手引述，未直接擷取原始 blog。
- **Netlify 2026-04-14 取消 per-seat、Pro 改 flat $20/月** —— 二手來源；但官方定價頁的「$20/month with unlimited members」與之一致。
- **Netlify 免費方案允許商業使用** —— 訂閱協議中「commercial」出現 **0 次**（消極確認），加上官方員工在支援論壇三度確認（2021 / 2024 / 2025-05-27 再確認）。⚠️ **這是「查無禁令 + 員工發言」，不是條款明文允許。** 若要用於正式營利專案，建議直接向 Netlify 書面確認。
- **PrimeVue 4 之前 Nuxt UI Pro 的歷史價格**（Solo $249 / Startup $499 / Organization $999）—— 舊頁已抓不到價格表。**不影響決策，現在是 0 元。**
- **Clerk 的 MRU 精確定義**（「註冊後 24 小時回訪才計數」）—— 來自第三方，未在 Clerk 官方頁面證實。官方只寫「50,000 MRU (monthly retained user) limit per app」。
- **帳單爆炸案例金額** —— Vercel 的 $23,000 DDoS / $3,200 學生帳單、Netlify 的 $104,000 事件，均來自新聞報導與社群貼文，**無法從官方頁面證實金額與經過**。可確認的官方事實只有計費模型本身。

### 9.3 官方未公布

- **Nitro v3 stable 的發布日期** —— 官方未公布。目前最新是 `3.0.260903-beta`（2026-09-03）。
- **Nuxt 5 的發布時程** —— 官方未公布。僅知會搭配 Nitro v3 + H3 v2。**不要把架構押在這個未公布的時間點上。**
- **oxlint 原生 Vue template lint 的排程** —— RFC [#21936](https://github.com/oxc-project/oxc/discussions/21936) 仍在討論，且已從 2026 Q3 延後（issue #23976）。**連實作排程都還沒定。**
- **PrimeVue $599 優惠價在 2026-12-31 後是否確定回到 $799** —— 頁面如此標示，但屬未來事件。

### 9.4 未實測，僅依文件與原始碼判斷

- **`nuxt-auth-utils` 在 Nuxt 3 上是否仍能運作** —— registry 寫 `>=3.0.0`，但依賴已升到 `@nuxt/kit ^4.3.1`，且 `module.ts` 未宣告 `compatibility`。（用 Nuxt 4 則無影響。）
- **`@sidebase/nuxt-auth` 在 Nuxt 4 上實際跑不跑得起來** —— 只確認「官方未宣告支援 + issue 未解 + kit 仍為 v3」，**沒有實測**。
- **Zeabur 對 Nuxt SSR 的支援程度** —— 官方有 Nuxt 專頁，但**沒有明確描述 SSR 模式的設定或支援聲明**。建議先用 Dev Plan 的 14 天試用實測 `nuxt build` + `node .output/server/index.mjs`。
- **Cloudflare §2.2.1(h)「免費服務不得處理信用卡」的實際邊界** —— 「用 Stripe Checkout 導向站外即可規避」是**本報告的解讀，非官方明文**。營收上來後建議直接付費或去信確認。
- **Neon 冷啟動「數百毫秒」** —— 官方宣稱值，非獨立實測。
- **本報告所有結論皆來自原始碼、官方文件、GitHub / npm API 讀取與 npm tarball 解壓，沒有實際跑過任何一個組合的可運行專案。**

### 9.5 統計口徑差異（非錯誤，但要注意）

- GitHub repo API 的 `open_issues_count` **包含 PR**，Search API 的純 issue 數不含。例：`nuxt-auth-utils` 142（含 PR）vs 107（純 issue）；`@sidebase/nuxt-auth` 81 vs 76。本報告採用純 issue 數。
- oxlint 的 `vue` 規則數：官方文件頁列出 37 條，但解壓 `eslint-plugin-oxlint@1.81.0` 的 generated 規則表為 **46 條**。本報告採用 46（以套件實際產出為準，文件頁可能略有落後）。

---

## 10. 一頁式建議總結

**如果我來做這個專案，我會這樣選：**

| 面向 | 選擇 | 一句話理由 |
|---|---|---|
| **框架** | Nuxt **4.5.2** | 沒有 Nuxt 5；Nuxt 3 已 EOL |
| **Lint** | 只用 `@nuxt/eslint` + 現有 `@antfu/eslint-config` | oxlint 的 Vue template 覆蓋率是 0，雙層設定成本換不回幾秒 |
| **UI** | **Nuxt UI 4.11.0** | MIT 全免（Pro 已併入）、Table 有虛擬捲動、原 Pro dashboard 版型免費 |
| **圖表** | 沿用 **Chart.js**（或改 ECharts） | 遷移成本最低；Nuxt 下記得 `<ClientOnly>` |
| **DB + 儲存** | **Supabase Free** 起步 | 唯一單一平台同時給 OAuth + Storage + Postgres |
| **Auth** | **Supabase Auth**（若用 Supabase）或 **`nuxt-auth-utils@^0.5.30`**（若自建 DB） | 前者點一點就好；後者約 20 行 |
| **部署** | **Zeabur Dev $5/月** 或 **Cloudflare Workers Paid $5/月** | 合法營利門檻最低；Zeabur 容器模型最貼合 Nuxt SSR |

**上線前必做的三件事**：
1. 確認部署平台方案**允許商業使用**（Vercel Hobby / Zeabur Free 都不行）
2. `nuxt-auth-utils` **pin `>=0.5.30`**
3. 若用 Supabase Free，接一個 cron 定期打 DB **避免 7 天閒置暫停**

---

> 本報告由自動化調研產生，所有事實均附一手來源。**條款與定價變動頻繁，實作前請重新確認。**
