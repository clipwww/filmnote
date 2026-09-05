# 交接筆記 — 設計 session

> 寫給沒有我脈絡的下一位。SPEC、BUILD_PLAN、git log 你都讀得到，這裡不重複。
> 只寫我腦子裡、關掉就消失的東西。
>
> 我的產出：`docs/design/DESIGN_SYSTEM.md`、`docs/design/SCREENS.md`、`docs/design/mockups/*.html`。
> 我**沒有寫任何產品程式碼**，`app/**`、`server/**`、`nuxt.config.ts`、`package.json` 一行都沒動。

---

## 1. 做到哪裡，下一步做什麼

設計規劃完成，實作零。四份 mockup 是**審查用的說明物**，不是要移植的程式碼——除了一個例外（見 §5）。

下一步，照這個順序：

1. **把 `DESIGN_SYSTEM.md §1.6` 的 CSS 貼進 `app/assets/css/main.css`，並建 `app/app.config.ts`。**
   這是所有視覺工作的前置，十分鐘的事，但不做的話後面每一頁都要重畫。
   做完立刻驗收：做一頁把 `UCard` / `UModal` / `UDropdownMenu` / `UPopover` / `UToast` / `UInput` 各 variant 並排，亮暗兩版截圖，**數還有幾處露出純白 `#fff`**。overlay 類元件常直接吃 `bg-default`，這是最容易漏的地方。
2. **`/app` 目前是骨架，那是登入後的第一個畫面**——見 §6，這是現在最該修的東西。
3. **`TicketCard` 元件**（`DESIGN_SYSTEM §4.3`）。它是全站主要物件，`/u/`、`/app/records`、`/film/` 的「誰看過」、匯入預覽全部共用。先做這個，後面四頁都省事。
4. **`YearStrip`**（`SCREENS §2.1`）。純 SVG／CSS grid，不需要圖表庫。`profile.html` 裡那份可以近乎照抄。
5. 四張 ECharts 圖。`DESIGN_SYSTEM §5.3` 那九條硬限制**每一條都是我實測踩到的**，不是文件抄來的，照做可以省下數小時。

---

## 2. 踩過的坑，還沒進 BUILD_PLAN §7

**全部都是「看起來會動但其實不會」那一類。** 這是這份筆記最值錢的部分。

### 2.1 沉默失敗（不報錯，但東西是壞的）

| 坑 | 症狀 | 真相 |
|---|---|---|
| **cdnjs 的版本索引 ≠ 實際託管** | `echarts/5.5.1/echarts.min.js` 回 404，七張圖全部沒渲染 | `api.cdnjs.com` 的 `versions` 陣列**列出** 5.5.1，但那個版本一個檔案都沒託管。5.6.0 / 6.0.0 / 6.1.0 才是 200。**列在索引上不等於抓得到**，用前要真的 curl 一次 |
| **`hidden` 屬性被任何作者端 `display` 打敗** | drawer 開在載入時蓋住整頁，**console 零錯誤** | `hidden` 只是 UA 樣式的 `display:none`，特異性最低。`.drawer{display:flex}` 直接蓋掉。全站需要一條 `[hidden]{display:none!important}`。我在四份 mockup 都補了。這條沒補，任何用 `hidden` 切換的元件都會是壞的而且不會有人發現 |
| **Nuxt UI 的 `--ui-bg` 硬寫死 `#fff`** | 改了 `app.config.ts` 的 `neutral`，文字與邊框確實變暖了，於是你以為成功了 | 但頁面底色還是純白。`node_modules/@nuxt/ui/dist/runtime/index.css` 裡 light 的 `--ui-bg`、`--ui-text-inverted` 與 dark 的 `--ui-text-highlighted` 都是常數。**必須在 main.css 額外覆寫這三個**（§1.6 已寫好） |
| **ECharts calendar 同時設 `right`／`width`** | 格子靜默變形成 6.9×14 的長條，不是正方形 | `cellSize` 的寬度分量被覆蓋。**只能設 `left` 與 `top`**。不會有任何警告 |
| **ECharts cartesian2d heatmap 不畫空格** | 熱點圖出現一塊塊破洞，看起來像渲染 bug | 缺值整格跳過（`if (isNaN) continue`）。7×N 全格必須明確餵 `value: 0`。calendar 座標系剛好相反，會自動畫底色格——**兩者行為不同，很容易混淆** |
| **`tabular-nums` 在中文字型上是空操作** | 你在 review 時看到數字對齊，以為生效了 | Noto Sans TC 的 GSUB 根本沒有 `tnum`。它對齊只是因為它的 ASCII 數字**碰巧**都是 521/1000 等寬。**換一支中文字型就會壞，而且壞得很難查**。數字必須由排在 stack 第一位的拉丁字型（Inter）供應 |
| **Google Fonts 要第二個字重會靜默換成 variable** | `wght@400;700` 看起來只是多一個字重 | 實測 105 個 unique URL 不變，但總量從 2.14 MB 漲到 3.99 MB——等於把 100–900 全吃下來。首屏從 675 KB 變 1,272 KB |
| **`USelectMenu` 開 `virtualize` 會攤平分組** | 為了「效能」順手打開，縣市分組無聲消失 | Reka UI 的限制（unovue/reka-ui#1885）。111 筆影城**不要開**，一般 `max-height` + 捲動就夠 |

### 2.2 zrender 的顏色解析（最陰險的一個）

zrender 不支援 `oklch()` / `var()` / `color-mix()`，而 Nuxt UI 4 的 token 正是 oklch。

陰險的地方在於**它有時候會動**：連續型 visualMap 需要內插，會印 `"'var(--c-lo)' is an illegal color, fallback to '#000000'"` 然後真的渲染成黑色；但 piecewise 不需要內插，會把字串**原樣輸出**到 SVG，於是在 SVG renderer 下居然是對的。

結論寫在 `DESIGN_SYSTEM §5.3-1`：**不要記哪些能哪些不能，一律在 JS 端先解析成 hex 再傳進去。** 這也是為什麼圖表色階在設計系統裡是 hex 而不是 oklch token——那是刻意的，不要「順手統一」進 token 系統。

### 2.3 色階相鄰階不可讀（我自己犯的錯）

第一版年表把 0/1/2 對到 `heat-0 / heat-2 / heat-4`，數學上合理，實際上**暗色模式下「沒去」與「1 場」對比只有 1.64:1**，整張圖在螢幕上幾乎看不見。截圖看才發現的。

規則已寫進 `DESIGN_SYSTEM §1.3`：**少於 7 階時要在色階上拉開取值，不要取相鄰階。** 改成 `heat-0 / heat-4 / heat-6` 後是 4.55:1。

**這類錯誤只有截圖才抓得到，算對比數字抓不到**（因為每一階本身都合規，是「取哪幾階」錯了）。做完視覺一定要真的看一眼。

---

## 3. 刻意沒做的取捨（不要重做一次）

| 決定 | 理由 | 什麼情況下該推翻 |
|---|---|---|
| **中文不用 webfont，走平台系統字型** | Google Fonts 首屏 675 KB；自架子集 393 KB 但**會讓 UGC 破字**——David 169 筆用到 599 個字，其中 30 個不在片庫的 3,120 字彙內（`🎉`、`斎`、`猗窩座`、`儸`、`殞`），正好落在備註與找不到的片名，也就是產品的情感核心 | 若找到能 runtime 動態子集的方案（見 §4） |
| **貢獻圖用「週」不用「日」** | 169 筆散在 12 年，日層級填滿率 6%，一張 7×53 的年格子 96% 是空的，讀起來是「荒涼」不是「密度」。收成週跳到 22% | 若使用者觀影頻率遠高於 David（每週 3+ 場） |
| **出席圖只有三階** | 實測 165 個有紀錄的日子：161 天 1 場、4 天 2 場、**0 天 ≥3 場**。五階裡有三階永遠不會被畫出來 | 資料分布改變時重算，不要憑感覺加階 |
| **單色相墨階，不用彩色色階** | ECharts heatmap 不支援 decal，單色相明度階是唯一可存取的序列色方案；且分級章五色亮度非單調（0.364→0.320→0.678→0.242→0.164），是類別色不是序列色 | 不建議推翻，這是可存取性的硬需求 |
| **不用圓餅圖** | 分布極度傾斜（林口威秀 68%、日本+美國 97%），一個 68% 的扇形不傳達任何東西；且 375px 下每個標籤只分到 90px，長片名會被截爛 | — |
| **週日起始** | 台灣慣例，且沿用舊 `log` 專案 | 週一起始能讓熱點圖的週五六日三列相鄰、洞察更明顯。已做成 `--week-start` token，改一行。**這是我留給 David 的取捨，不是定論** |
| **不畫「票根」的齒孔／虛線／紙紋** | 票根是結構隱喻（欄位網格 + 左側日期帶），不是材質模仿。畫齒孔會變成 skeuomorph kitsch | — |
| **只寫文件不寫程式** | `app/**` 屬於 nuxt session，三個 session 同時動同一批檔案會互相覆蓋 | — |

**關於整體調性**：我選的是「冷結構 + 暖火花」——版面／字體／間距是資料化的紀律，單一重點色是琥珀（hue 45–47，刻意離陶土色 15° 與 Letterboxd 橘 30° 各 15° 以上）。**David 當時還沒拍板**，另兩個選項是純冷冽數據感（琥珀只留在 focus ring）與更重的溫暖收藏感。這是換一組 token 的事，不要當成既成事實。

---

## 4. 懷疑但沒空驗證（最容易失傳）

1. **`@nuxt/fonts` 0.14.0 已經隨 `@nuxt/ui` 裝好並自動註冊**（`node_modules/@nuxt/ui/dist/module.mjs:39`）。我的字型成本估算是拿「Google Fonts 託管 vs 自架子集」二分法算的，但實際交付可能走第三條路（build 期下載自架、改寫 `@font-face`、產 fallback metrics）。**675 KB / 393 KB 這兩個數字都可能要重算。**
   驗法：在 main.css 指定一個 Google 字型 → `pnpm build` → 數 `.output/public/_fonts/` 的檔案數與總位元組，跟估算對帳。

2. **繁體字形回退沒在真實 Windows / Android 上測過。** Chromium issue 41188235 與 noto-cjk README 佐證了機制（缺語言提示時 Chromium 在 Windows 上一律用簡體字型），`nuxt.config.ts` 的 `lang="zh-Hant-TW"` 也到位了，但「§2.2 那個 stack 在實機上真的渲染出繁體字形」只有截圖能證明。**「说、这、来、录」是最好的檢查字。**

3. **OG 圖與「不用中文 webfont」的決定衝突，我沒解掉。** OG 圖是伺服器端算圖，伺服器上沒有蘋方，需要**字型 buffer**。這是全站唯一需要打包中文字型檔的地方（`SCREENS §4`）。可以用片庫字彙子集化，但**片名以外的 UGC 內容仍會破字**。這題還沒有答案。

4. **emfont（`font.emtech.cc`）沒查證。** 台灣團隊、宣稱 90+ 支開源中文字型免費。這是唯一可能同時解決「免費」與「首屏預算」的第三方選項，但我沒能確認它的機制（unicode-range 切片？DOM 掃描後動態子集？）、頻寬上限或 SLA。**若要重新考慮中文 webfont，從這裡開始查。**

5. **「1 場 vs 2 場」那一階是 2.71:1，低於 WCAG 1.4.11 的 3:1。** 我接受了，理由是主要區分（有去／沒去）是 4.55:1 且合規，次要區分只影響 165 天裡的 4 天。**沒有做過使用者測試。** 若要修，得把墨階本身拉開，那會連動整套。

6. **`text-spacing-trim` 對《》的實際視覺效果沒看過。** 只從 MDN 確認 Noto Sans TC 有所需的 `halt` feature、Chrome 123+ 支援。我的建議是 UI 上直接不顯示《》（資料層保留），這樣就不依賴它——但如果有人想留，需要真的截圖比對 Chrome / Safari 兩種樣子。

7. **注音輸入法的組字中間態會不會清空搜尋選單，未知。** 主 session 用 CDP 模擬沒重現，**但模擬不等於實機沒事**。片名搜尋是這個產品最高頻的互動，這題值得拿真的注音鍵盤測一次。`UCommandPalette` 的 `searchDelay` debounce 與 `compositionstart`／`compositionend` 的互動是最可疑的地方。

---

## 5. 半成品，明確標示

**`docs/design/mockups/*.html` 是審查物，不是要移植的程式碼。** 它們用真實資料、通過 headless 驗證（1280/375px 無橫向捲動、零 console error、dashboard 10 個 canvas 全部有繪製），但它們是純 HTML/CSS/JS，不是 Vue。

例外：**`profile.html` 的 `YearStrip`**（純 SVG／CSS grid、鍵盤導覽、週解析度計算）值得近乎照抄成 Vue 元件。其餘請當規格讀，不要當程式碼抄。

明確的缺口：

- **沒有 mockup 的畫面**：`/app/import` 匯入對帳、`/admin/*` 三個佇列、`/venue/[id]`、`/u/[username]/[year]` 年度回顧、OG 分享圖。`SCREENS.md` 有文字規格，沒有視覺稿。
- **「影記」的 SVG 字標是佔位。** `profile.html` 裡那份是從 Noto Sans TC 的字形輪廓抽出來的，達成了「零位元組、跨平台一致」的目標，但**若要當品牌資產必須重畫**。
- **TMDB logo 是等比佔位方塊**（青底 + 字樣），不是官方素材。上線前必須換成真圖，且視覺份量要小於本站字標（TMDB 條款要求）。
- **mockup 裡的 ECharts 是 CDN 5.x/6.x**，正式站要走 tree-shaken 模組化 import（`echarts/core` + `echarts/charts` + `echarts/components`），bundle 結構不同。

---

## 6. `/app` 的現況與設計的落差 ⚠️

主 session 用 Playwright 附著到真實 Chrome（Google 會擋 Playwright 啟動的瀏覽器，但不擋 CDP 附著到使用者自己開的）實測登入後畫面，回報如下。**這不是我測的，我沒有登入環境**，但它直接關係到我設計的頁面，所以寫在這裡讓下一位知道：

**做得紮實的**（設計意圖已落地）：片名雙向搜尋成立、**「找不到片」確實是流程的一部分而非錯誤畫面**（這是硬約束 (1)，最重要的一條）、已歇業的日新威秀正確被 `venue_option` 過濾掉、影城帶縣市消歧義。

**還是骨架的**：`/app` 標題是「我的紀錄」，內容是**一段裸露的 JSON debug 區塊，印著使用者 UUID 與 email**，底下一個登出按鈕。**David 的 174 筆紀錄一筆都沒顯示。**

兩個問題，嚴重度不同：

1. **UUID 與 email 不該印在畫面上。** 這是安全與隱私問題，優先於任何視覺工作。
2. **`/app` 是登入後的第一個畫面**，`SCREENS.md §9` 給的是垂直長卷、一個 band 一張圖的儀表板。目前落差是 100%。

接手時建議的順序：先把 debug 區塊拿掉，再做 `TicketCard` 把 174 筆列出來（那已經比空白有價值），最後才是四張圖。**不要為了先做圖表而讓紀錄列表繼續空著**——SPEC 的四個價值主張裡有三個（片名、影城、票價）在列表就看得到，統計是第四個。

另外注意 `SCREENS.md §9.3`：全新帳號 0 筆紀錄時四張圖同時空是最尷尬的狀態，規格是**不畫空圖**，改成一個明確的下一步動作加一張淡化示意圖。David 有 174 筆看不到這個狀態，但新使用者第一眼就是它。

---

## 7. 兩份文件的關係

- `DESIGN_SYSTEM.md` — token 層的唯一真值。色彩、字體、間距、元件語彙、圖表限制、明暗模式。**改視覺先改這裡，不要在元件裡就地決定。**
- `SCREENS.md` — 逐畫面版面與互動，含手機／桌機差異。每一節對應 `BUILD_PLAN §3` 的一條路由。

`SCREENS.md §16` 有四條待決事項（`/search` 路由在 `nuxt.config.ts` 有但 `BUILD_PLAN §3` 沒有、影城人工對照介面沒有路由位置、週起始日、OG 圖字型），**那些需要 David 或 nuxt session 拍板，不要自己決定。**
