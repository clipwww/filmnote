# 交接筆記 — frontend

> 負責 `app/**`（除 `app/types/database.types.ts`）：頁面、元件、composable、layout、樣式。
> 假設你讀得到 `docs/SPEC.md`、`docs/BUILD_PLAN.md` 與 `git log`，所以這裡**不重複**那些。
> 只寫關掉 session 就會消失的東西。

---

## 1. 現況：哪些畫面是真的，哪些是骨架

| 路由 | 狀態 |
|---|---|
| `/` | 可用。站台介紹，沒有「近期公開紀錄」（§3 說要，還沒做） |
| `/search` | 可用。雙欄搜尋成立 |
| `/film/[slug]` | 可用 |
| `/film` | 302 → `/search`（見 §3 的取捨） |
| `/u/[username]` | 可用。年份分組 + 漸進式載入 |
| `/login`、`/confirm` | 可用 |
| `/app` | **骨架**。見下方 |
| `/app/records`、`/app/records/new`、`/app/records/[id]/edit` | 可用，實機走過 |
| `/app/settings` | 寫完但**沒有人用瀏覽器操作過**。改名／`show_cost`／匯出三個功能的資料層各自驗過，UI 沒驗 |
| `/app/films/new` | **不存在**。`/search` 與 `new.vue` 的「找不到片」都連過去，會 404 |
| `/app/import` | **不存在**。匯入目前只有 CLI（backend 做的） |
| `/venue/[id]` | **不存在**，但 `nuxt.config.ts` 已有它的 routeRule |
| `/legal/**` | **不存在**。§6 的四要件頁面，Phase 1 法遵要求 |
| `/admin/**` | **不存在** |

### `/app` 是最該先修的一個

它還停在 Step 1 的最小骨架：標題「我的紀錄」、一段裸露的 JSON debug 區塊（印出
使用者 UUID 與 email）、一個登出按鈕。**那是登入後看到的第一個畫面**，而使用者的
174 筆紀錄一筆都沒出現在上面。

UUID 與 email 只有本人看得到（該路由 `ssr: false` 且需登入），不是外洩，但那是
debug 殘留不是設計。修它不需要等任何人——`/app/records` 已經有列表邏輯可以借。

---

## 2. 踩過但**還沒寫進 BUILD_PLAN §7** 的坑

§7 已經有 #1–#79。以下是我踩到但沒進去的，都是「看起來會動但其實不會」那一類。

### 2.1 Vue 的 whitespace 'condense' 會吃掉插值之間的空白

```vue
{{ date }}<span v-if="t"> {{ t }}</span>   <!-- render 成 2026-07-2616:00 -->
```

分隔符必須在**字串裡**就組好。這就是 `app/utils/format-datetime.ts` 存在的理由
（`dateTimeText()` / `metaLine()`）。任何「用相鄰元素加空白做分隔」的寫法都會中招，
而且 curl 掃 HTML 也看不出來——你得真的 render 才會發現兩個數字黏在一起。

### 2.2 `USelectMenu` 的 `v-model` 型別是 `T | undefined`，不是 `T | null`

用 `ref<X | null>(null)` 綁上去，`nuxt typecheck` 會報
`Type 'null' is not assignable to type 'X | undefined'`。三個選單欄位
（film / venueId / formatCode）都得用 `undefined`，寫入 DB 前再 `?? null`。

### 2.3 Nuxt UI 4.11 有 `UInputTime`，不只 `UInputDate`

踩雷 #53 只提到 `UInputDate granularity="minute"`。實際上還有獨立的 `UInputTime`。
兩者的 `modelValue` 都是 **`@internationalized/date` 的物件**（`DateValue` /
`TimeValue`），不是字串——換過去要寫轉換層（`parseDate` / `parseTime` / `today`
都在該套件裡，約 20 行）。`UCalendar` 確實沒有時間 UI，#53 那半是對的。

### 2.4 `spaLoadingTemplate` 的值是「字面」接在 srcDir 後面

§2.3 寫 `'app/spa-loading-template.html'` → 解析成 `app/app/…`；官方文件的
`'~/spa-loading-template.html'` → `app/~/…`。**別名不解析**，只能寫裸檔名
`'spa-loading-template.html'`。檔案放 `app/` 底下是對的。

### 2.5 `tsx` 讀「最近的 tsconfig.json」解析路徑別名

根目錄那份是 Nuxt 的 solution file，`paths` 必須留在裡面，否則 `src/` 內以 `~/`
匯入的模組在 `pnpm run ingest:*` 執行期會 `Cannot find package '~'`——**而 tsc
與 vitest 全綠**。測試與正式執行走不同解析路徑，全綠不代表 CLI 能跑。
（`tsconfig.json` 裡有註解說明；`~/*` 是過渡條目，等 `src/import/**` 與
`tests/import.test.ts` 轉完就能刪。）

### 2.6 `pnpm run x -- file` 會把 `--` 原樣傳進腳本

npm 會吃掉，pnpm 不會。吃 argv 的腳本要自己濾掉 bare `--`。

### 2.7 48px 寬的容器放不下中文片名

`FilmPoster` 的文字 fallback 原本是 `p-4` + `break-all`，在列表的 `w-12` 容器裡
只剩 16px 可用，每行一個字再被截斷，變成「卡哇人」這種直式擠壓。
**`break-all` 全站不要用**——它會在任意字元間斷行。現在改成 `variant`：
小尺寸用字標（取片名首字），大尺寸才放全名配 `line-clamp`。

字標取「第一個**有意義**的字」：片名常以 `《「【（` 開頭，直接取 `[0]` 只會拿到引號。

### 2.8 文字 fallback 目前是全站常態，不是 10% 的邊角

`film_tmdb_snapshot` 的 2,401 筆快照要等 Step 9 的刷新排程才有 `poster_path`。
在那之前**每一列**都走文字卡片。設計這個 fallback 時請照「這是主要外觀」來想，
不是照「偶爾才出現的降級」。

### 2.9 zrender 6.1.0 看不懂的色彩語法（實測）

```
#10b981                       ✅
rgba(16, 185, 129, 1)         ✅
rgb(16,185,129)               ✅
rgb(16 185 129)               ❌ undefined   ← 現代空白分隔語法
oklch(0.7 0.15 160)           ❌ undefined
color(display-p3 0.1 0.7 0.5) ❌ undefined   ← Canvas fillStyle fallback 也救不了
```

最後一行順帶否掉了 §8.2 第 22 項那個「用 Canvas 把 oklch 正規化成 hex」的構想——
超出 sRGB 時它回的正是 `color(display-p3 …)`，zrender 一樣不吃。

---

## 3. 刻意沒做的取捨（不要重做一次相同的決定）

| 決定 | 理由 |
|---|---|
| **日期時間維持原生 `<input type="date">` / `type="time"`** | `UInputDate` 是**分段文字欄位**不是選擇器，手機上叫出文字鍵盤。核心情境是「散場走出影廳用手機三十秒記完」，原生 input 叫出 OS 滾輪選擇器，這一局原生贏得明確。附帶好處是零轉換層——原生給的就是 `YYYY-MM-DD` / `HH:mm`，正好是 DB 的 `date` / `time` 要的形狀。**若 design session 要求視覺一致性，隨時可換**，成本約 20 行 |
| **`/search` 用 `UInput` + 結果格線，不是 §5 Step 3 寫的 `USelectMenu`** | 那是公開**頁面**不是表單欄位。`USelectMenu` + `ignore-filter` 的規範用在 `/app/records/new` 的片名選擇（已照做） |
| **`/film` 導向 `/search`，不建瀏覽索引頁** | 索引頁是新功能、要等設計定案。移除死路的成本是一行 |
| **圖表色票定義在 TS，不用 `@theme static` + `getComputedStyle`** | 後者要賭 Tailwind 不會把 hex 正規化成 oklch，賭錯的症狀是「靜態填色正常、一 hover 就整條變空白」。定義在 TS 則 ECharts 拿到的必然是 hex |
| **不裝 `nuxt-echarts`** | 建立在 experimental 的 `<NuxtIsland>` 上，且 ECharts SSR 強制固定 width/height，與響應式圖表衝突 |
| **個人頁是 client 端分頁** | 真正的 server 端分頁需要 `/api/u/[username]` 支援 `offset`/`limit`，那支在 backend 手上 |
| **票價 schema 不給 `.default(0)`** | `null`（沒資料）與 `0`（招待票）是兩件事。把「沒資料」寫成 0 會稀釋平均票價 |

---

## 4. 懷疑但沒驗證的事（最容易失傳）

1. **中文注音 IME 在 `USelectMenu` 搜尋框的行為，從來沒有用實體鍵盤測過。**
   主 session 用 CDP 模擬過，沒重現「選單被組字中間態清空」，但模擬不等於實機。
   `useIMEGuard` 存在於 Nuxt UI v4，但實測整包 runtime 只有 `ChatPrompt.vue` 用它。
   **這是繁中產品的高風險點。** 另外表單改用 `<UForm>` 之後送出時機從
   `@submit.prevent` 換成 UForm 的 `@submit`，**注音選字中按 Enter 會不會誤觸送出**
   也沒測過。

2. **`BaseChart` 從來沒有帶著真實資料 render 過。** 只用一個假 option 驗過
   SSR 不炸、`ClientOnly` fallback 有出現、高度用 inline style 生效。
   **visualMap 的漸層、hover emphasis、dark mode 切換後是否重繪，全部沒看過。**
   dark mode 我用 `:key` 強制重建元件，那是最不會漏的做法，但也最粗暴——
   可能有閃爍或動畫重播的問題，得真的切一次才知道。

3. **`UserSpendSummary` 只驗到資料層。** `show_cost=true` 時它的 embed 查詢
   （`viewing_record_cost` join `viewing_record!inner(user_id)`）沒有透過 UI 跑過。
   `spend_is_partial` 的「部分票價未公開」提示也沒在畫面上看過。

4. **`server/middleware/strip-auth-on-cacheable.ts` 的路由清單必須與
   `nuxt.config.ts` 的 `isr` / `prerender` routeRules 保持一致，但沒有任何測試強制它。**
   新增可快取路由時漏掉同步，會靜默地把來訪者的 access_token 寫進 CDN 快取
   （踩雷 #79）。這是我認為目前最危險的一條**隱性耦合**。
   建議加一個測試：讀 `nuxt.config` 的 routeRules，斷言每條有 `isr`/`prerender`
   的路由都被該 middleware 的 `isCacheable()` 命中。
   （那支 middleware 在 `server/**`，屬 backend；但耦合的另一端在 `nuxt.config.ts`。）

5. **`/api/u/[username]` 一次回最多 200 筆，超過的使用者會缺資料而且無聲無息。**
   David 現在 174 筆還沒踩到。這是會隨時間爆的。

6. **`useScreeningFormats()` 在 SSR 的個人頁上會多一次資料庫往返。**
   那張表只有 9 列且對 anon 全開，理論上很便宜，但沒量過。若成為問題，
   正解是請 backend 在 `/api/u/[username]` 直接 join `screening_format.label`。

---

## 5. 半成品，明確標示

- **`app/pages/app/index.vue`** — Step 1 的骨架，含 debug JSON 區塊。見 §1。
- **`app/components/BaseChart.vue` + `app/utils/chart-theme.ts`** — 結構完成、SSR 安全性驗過，
  但**沒有任何頁面在用它**（build 時會被 tree-shake 掉，所以 client bundle 裡看不到 echarts）。
  `user_year_stats` RPC 已由 backend 在 `585357a` 做出來，型別應該已在
  `app/types/database.types.ts` 裡，可以直接接。
- **`app/pages/app/settings.vue`** — 程式寫完，UI 沒有人操作過。

---

## 6. 開發時的實用資訊

- **真實瀏覽器驗證**：我借用主 session 的 `playwright-core`（在
  `/private/tmp/.../-Users-david-Documents-Github-log/.../scratchpad/browser/`），
  用 `chromium.launch({ channel: 'chrome' })` 跑。**Google OAuth 會擋 Playwright
  啟動的瀏覽器**，要測登入後畫面得用 CDP 附著到 David 自己開的 Chrome。
- **每個有畫面的 Step，交出去之前自己先跑一輪截圖。** 我前五個 Step 都只驗資料與
  安全，結果第一個用眼睛看的人一次找出六個問題（版面錯誤、17,481px 的頁面、
  日期黏連、未中文化、title 重複）。curl 掃 HTML 驗不到「長什麼樣子」。
- 我的截圖放在 session scratchpad 的 `shots/`，session 關掉就沒了。
