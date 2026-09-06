# 交接筆記 — 圖表與對外頁面

> ⚠️ **這一棒的 session 名字叫 `adminui`，那是歷史遺留，不要照名字猜範圍。**
> 那個名字對應的是 `/admin/**` 與 `/app/import`，交接在 **`docs/handoff/adminui.md`**
> （仍然有效，只是不再是這一棒的範圍）。

## 0. 現在的範圍

**擁有**：
- 圖表元件：`BaseChart` / `ChartBand` / `AttendanceCalendar` / `HourHeatmap` /
  `MonthlyTrend` / `DistributionBars` / `YearStrip`
- `app/utils/chart-theme.ts`、`app/utils/stats.ts`、`app/composables/useYearStats.ts`
- `app/pages/app/index.vue`（儀表板）、`app/pages/index.vue`（首頁）、
  `app/pages/u/[username].vue`（分享頁）

**不是我的**（只用不改）：`TicketCard` / `FilmPoster` / `StatLine`、
`app/layouts/**` 與導覽、`/app/records/**`、`/app/settings`、`/app/films/new`、
`/legal/**`、`server/**`、`supabase/**`、`src/**`。

`BUILD_PLAN §7` 的號段是 **#130–#144**，已用到 **#135**。

---

## 1. 主題切換：壓測做過了，結論是乾淨的（不用再做一次）

`BaseChart` 換主題靠 `:key` 強制**整份 option 重建**（`setTheme()` 不會重算
`visualMap.pieces` 與顯式的 `itemStyle.color`）。前一棒把它標記為
「可能有閃爍或動畫重播，得真的切一次才知道」，而**切換器做出來之前沒有人切過**。

2026-09-06 用 `useNuxtApp().$colorMode.preference` 驅動真正的切換路徑，
在 `/app` 上**切換期間**每 60ms 取樣一次，連續 16 次：

| 觀察項 | 結果 |
|---|---|
| canvas 數量 | 全程 6，**沒有一刻掉到 0**（沒有 unmount 空窗） |
| 0×0 尺寸的 canvas | 全程 0（踩雷 #49 那一族沒有復發） |
| `ClientOnly` 的骨架 | 全程 0——**重建時 fallback 不會回來**，所以不會閃出一排跳動骨架 |
| `scrollY` / `scrollHeight` | 1200 / 2883 完全不動，**沒有版面跳動** |
| console 錯誤 | 0 |

**沒有進場動畫重播**，因為 `baseChartOption()` 全站設 `animation: false`
（`DS §6`：除了存檔那一刻沒有進場動畫），三支 ECharts 圖都 spread 了它。

⚠️ **順帶更正一個常見誤解**：`/app` 有七條 band，但**只有三張是 ECharts**
（出席圖、時段熱點圖、月度趨勢）。`YearStrip` 是 SVG／CSS grid、
`DistributionBars` 是 HTML 排版、`RepeatList` 是清單。所以「切主題會不會七張圖
一起重播」這個問題的前提本來就不成立——會重建的只有三張。
（6 個 canvas 是因為 ECharts 每張圖有多層 canvas。）

### `visualMap.pieces` 在重建後仍然正確——但測試原本沒守到

`heatPieces(dark, max)` 與 `attendancePieces(dark)` 是 `(dark, max)` 的**純函式**，
重建就是換個參數重算，沒有任何有狀態的路徑。**但覆蓋率測試原本只傳 `false`**，
而重建走的正是 `dark = true` 那條。色票是兩組獨立的陣列，暗色那組只要長度或值
有一個不對，症狀就是「亮色好好的、切到暗色某些格子不見」，而 console 零錯誤。

已把那幾條改成 `it.each([light, dark])`，並補一條「每一段的顏色都不是 undefined」。
實作本來就是對的，現在是釘住的。

執行期也對過帳（像素，不是眼睛）：出席圖三階在**兩個主題**都畫得出來，
且 `att1`／`att2` 的像素數跨主題**完全相同**（6474／3696）——同樣的格子、不同的墨。
`att2` 是「2 場以上」＝雙片連映，正是邊界值掉進 pieces 縫裡時會靜默消失的那一格。

---

## 2. 量對比不能只看 CSS 往上找背景色（首頁踩到的）

首頁的海報牆與遮罩是前景文字的**兄弟節點，不是祖先**。所以
「往上走找第一個不透明背景」這種常見寫法會量到乾淨的紙底，
得到一個**好看但假的**數字。實測差距：**假 4.99:1 vs 真實 4.11:1**（低於 AA）。

正確的算法是把整疊合成起來再對海報像素取兩端：

```
eff = α_scrim·paper + (1−α_scrim)·(α_poster·P + (1−α_poster)·paper)
對 P = 0 與 P = 255 各算一次，取比值的下界
```

腳本留在 scratchpad 的 `contrast-worst.mjs`。**任何「文字疊在圖片／影片上」的
版面都要這樣量**，這個專案之後只要再做一次 hero 就會再遇到。

順帶：`text-muted` 對 `bg-default` 本來就只有 **4.56:1**（亮色），
它沒有餘裕承受任何背景干擾。海報牆底下的次要文字一律升一階用 `text-default`
——那是對背景的回應，不是改共用色票。

**最後的版面決定**：海報牆 55% + 文字坐在**不透明紙面板**上（方角、無陰影、
無圓角 SaaS 卡片語彙）。第一版「全幅牆 + 88% 遮罩」兩邊都做不好：
為了救對比得把海報壓到幾乎看不見。

---

## 3. 首頁的 ISR 安全：兩道防線，兩道都要在

`/` 是 `isr: 300`，以**路徑**為快取單位。

1. `server/middleware/strip-auth-on-cacheable.ts` 依 `getRouteRules()` 判定可快取
   就拔掉 session cookie ⇒ SSR 期間 `useSupabaseUser()` 本來就是 null。
2. **但不要只依賴那一支。** CTA 包在 `<ClientOnly>` 裡，`#fallback` 給的是
   **未登入那一顆**。第①道哪天失效，被烤進 CDN 的也只會是「未登入」。

實測（帶 David 真實 session 打 `/`）：HTML 裡 `access_token` / `refresh_token`
皆無，CTA 是「用 Google 登入開始記錄」，hydration 後才變成「進入我的紀錄」。
唯一的 email 是頁尾的 `copyright@filmnote.tw`（§90-4 要求公告的窗口，不是身分）。

**主題也不會被烤進去**：帶 `nuxt-color-mode=dark` cookie 打 `/`，兩份 HTML
除了 devtools 的時間戳完全相同，payload 兩邊都是
`color-mode: {preference:"system", value:"system"}`——theme 由 `<head>` 裡的
inline script 在 client 端決定。**切換器上線後這條仍然成立，但值得再驗一次。**

⚠️ **`scripts/verify-ssr-payload.ts` 不存在。** `strip-auth-on-cacheable.ts` 的註解
宣稱有這支在守踩雷 #79（訪客 token 被寫進 CDN），實際上 `verify-all.ts` 沒有引用它，
檔案也不在。已回報，主 session 已請 backend 補。**在補上之前，那條不變量只有手動驗過。**

---

## 4. 月度趨勢的平均線

定義**精確地**是：`該日曆月份的全期總場次 ÷ 年份數`，12 點的序列，虛線。
不是「當年度的月平均」（那是水平線，也回答不了「十月是不是我的旺季」）。
來源是視覺稿 `dashboard.html:1670`，圖例「2014–2026 每月平均」。

⚠️ **資料一律取自 `user_year_stats(username, null)` 的 `monthly`，不要在前端拿
紀錄列表就地算。** `/u/` 上別人拿得到的紀錄集合與本人不同（RLS 依觀看者而異），
就地算會讓同一個人的「歷年平均」因為誰在看而不一樣。

年份數不明時 `monthlyAverageSeries()` 回 **null**，那條線就不畫——
寧可少一條線，也不要畫一條除以錯的數字的線。

實測對帳：13 年、十月 24 場 → tooltip 顯示 **1.85 場**，與 DB 算出來的一致。
三條單元測試釘住定義。

**同一張圖順手修掉的**：還沒到的月份原本畫成 0，讓折線在年中墜到底，
讀起來像「他七月就不看電影了」。改成斷點（`DS §5.3-8`）。

### 全期統計有兩種「每個月」，backend 兩種都給了

- `monthly` —— 十三年的**同月份加總**，12 格。回答「我幾月比較常看片」。
- `monthly_series` —— **156 個月的時間序列**。回答「我這些年看片量的走勢」。

`user_year_stats(username, null)` 兩個都回（給了年份時 `monthly_series` 是空陣列）。
平均線用的是前者。**`MonthlyTrend` 只吃得下 12 格**——要畫 156 點的走勢需要另一支
元件，而且 375px 下 156 個點只有 2.2px 一個，畫之前先想清楚它回答什麼問題
（`YearStrip` 已經以「週」的解析度回答了同一件事）。

---

## 5. 還沒做的

1. **line / bar 的點擊展開紀錄清單**（David 要的）。現在只有出席圖與時段熱點圖有。
   - ⚠️ **抽屜裡的 `TicketCard` 一定要傳 `show-year`。** 2026-09-06 David 回報
     「開啟 drawer records 時看不出觀影年份」，主 session 修在 `0bee605`。
     病灶是**抽屜的標題有兩種**：出席圖點一格是「2024/03/15 (週五)」有年，
     時段圖點一格是「週四 21:00」**沒有年**——而那一格橫跨 2020 與 2019 兩年。
     同一個抽屜元件、兩種標題 ⇒ **不能靠標題補年份，只能靠卡片自己帶**。
     月度趨勢與分布長條的抽屜跨的年份**更多**，所以這條對接下來要做的四支更重要。
     （`TicketCard` 的 `showYear` prop 早就存在但一直沒有呼叫端在用，
     `0bee605` 是它第一次被真的用到；52px 的日期帶塞五行後比例仍然穩，已看過畫面。）
   - `MonthlyTrend` 是 ECharts ⇒ 走 `BaseChart` 已經有的 `@pick`。
   - **`DistributionBars` 不是圖表庫畫的，是 HTML 排版** ⇒ 加 `<button>` 語意，
     **不要**為了統一而把它改回 canvas（長中文影城名在 375px 下會被截斷，
     而且鍵盤與螢幕閱讀器會拿不到）。
   - ⚠️ **每一個資料點都要有東西可展開。** 平均線上的點不對應任何紀錄，
     所以那條 series 已經設 `silent: true`——**點了沒反應的圖表比不能點更糟**。
   - ⚠️ 觸控裝置上點一格會不會同時觸發 tooltip 與抽屜，**到現在還是沒測過**
     （前一棒對熱點圖標記過，範圍現在擴大到 line 與 bar）。有 CDP，用 375px
     觸控模擬實際點一次。
2. **`/u/` 的圖表**。分享頁目前有年表、列表、花費摘要，**一張圖都沒有**，
   比自己看的 `/app` 少一大截——而分享才是這個產品唯一的擴散機制。
   - ⚠️ 票價因觀看者而異（本人 vs `show_cost=true`），`spend_is_partial` 要正確呈現。
   - ⚠️ `/u/**` 是 `cache-control: private, no-store` 且**永遠不加 isr/swr**（踩雷 #1）。
   - ⚠️ 抽屜的清單**必須用不帶 cookie 的請求實際驗一次**，不要只相信 RLS。
3. **首頁的「剛剛有人看了」**。`SCREENS §1` 明文要求（而且說「不做行銷式 hero，
   最有說服力的是台灣人剛剛看了什麼」），但 David 的新方向是海報牆 + 說明 + 登入鈕。
   **兩者沒有互斥，但誰在上面是設計決定，我沒有自己決定。** 目前沒做。

---

## 6. 環境

- **`connectOverCDP` 卡住時，兇手是「某個 renderer 死掉的分頁」**，不一定是
  `file://`（踩雷 #135 修正了 #97 ①）。用裸 CDP 逐 target
  `Target.attachToTarget` + `Runtime.evaluate` 探測找出來，不要重試也不要重開瀏覽器。
  自己的腳本一定要把 `page.close()` 放進 `finally`（**永遠不要 `browser.close()`**，
  那會關掉 David 的瀏覽器）。helper 在 scratchpad 的 `cdp.mjs`。
- **要驅動主題切換**：`useNuxtApp().$colorMode.preference = 'dark'`。
  `window.$nuxt` 不存在，但 `window.useNuxtApp` 是函式。
  ⚠️ **不要用 `classList.add('dark')` 自己加 class**——`@nuxtjs/color-mode` 會把它
  改回去，量到的可能是切換過程中的中間態（frontend 交接 §6.5）。
  我早期幾支驗證腳本用的是 classList，事後回頭確認過那幾次 class 確實生效
  （`getComputedStyle(body).backgroundColor` 亮暗真的不同：`[248,237,220]` vs
  `[29,22,16]`），所以那批結論仍然成立——但**新腳本一律走 `$colorMode.preference`**，
  它是真正的切換路徑，也順便測到 `:key` 重建。
- **四個 session 共用一個工作樹**，別人 migration 改到一半會讓 `verify:all` 變紅，
  而它看起來像你自己的迴歸。**第一件事是確認 David 的真實資料完好**
  （174 筆紀錄 / 1 個 profile / 1 個 auth user），再看 `git status` 有沒有
  未提交的 `supabase/migrations/**`。
