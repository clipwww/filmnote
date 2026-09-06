# 交接筆記 — frontend（第二棒）

> 負責 `app/**`（除 `app/types/database.types.ts`）。
> 假設你讀得到 `docs/SPEC.md`、`docs/BUILD_PLAN.md`、`docs/design/**` 與 `git log`，
> 所以這裡**不重複**那些。只寫關掉 session 就會消失的東西。
>
> **前一棒那份在 git 歷史裡（`cfcfe49`），它的 §3「刻意沒做的取捨」整節仍然有效**
> ——原生 `<input type="date">`、`/search` 用 `UInput` 不用 `USelectMenu`、
> 票價 schema 不給 `.default(0)`、圖表色票定義在 TS、不裝 `nuxt-echarts`、
> 個人頁 client 端分頁。那六條我這一棒都沒有推翻，理由也都還成立。
> 它的 §2.1（whitespace condense）、§2.2（`USelectMenu` 的 `T | undefined`）、
> §2.7（`break-all` 全站不用）也仍然有效，且已經進 §7。

---

## 1. 現況：哪些畫面是真的，哪些不存在

| 路由 | 狀態（相對於前一棒的變化） |
|---|---|
| `/` | 可用。仍然沒有「近期公開紀錄」 |
| `/search` | 可用。**IME 已修**；「手動新增這部片」現在帶 `?title=&from=search` |
| `/film/[slug]` | 可用 |
| `/u/[username]` | 可用。**加了年表**（同時是年份篩選器）、改用 `TicketCard`、統計改 `StatLine` |
| `/login`、`/confirm` | 可用 |
| `/app` | **已完成**。七條圖表 band + 點格子開底部抽屜。不再有紀錄列表 |
| `/app/records` | 可用。改用 `TicketCard` + 年份切換 + 刪除二次確認 |
| `/app/records/new`、`/edit` | 可用。**IME 已修**、表單草稿會在去新增作品時保存 |
| `/app/films/new` | **已完成**。含海報上傳（縮圖 → private bucket → 寫回 `ugc_poster_path`） |
| `/app/settings` | 程式寫完，**仍然沒有人用瀏覽器操作過**（前一棒就是這樣，我沒動它） |
| `/app/import` | **不存在**。匯入目前只有 CLI |
| `/venue/[id]` | **不存在**，但 `nuxt.config.ts` 已有它的 routeRule |
| `/legal/**` | **不存在**。`SCREENS §15` 的規格已經就緒，視覺稿也有了。這是最該接的下一件 |
| `/admin/**` | **不存在**。backend 的 `approve_film` / `merge_films` 端點已經在了，缺的是介面 |

---

## 2. 踩過的坑

**#82–#90 已經進 `BUILD_PLAN §7`**（IME 兩條、ECharts 多層 canvas、visualMap 吃掉
所有 series、`fontFamily: 'inherit'`、SSR 的 colorMode hydration、`*_public` view 漏掉
自己的東西、UGC slug 的 404）。以下是**沒進 §7**、比較零碎但一樣會咬人的：

### 2.1 `eslint --fix` 會把 `Array.from` 改寫成推論不出型別的形式

```ts
Array.from({ length: N }, () => 0)   // number[]
// --fix 之後 ↓
Array.from({ length: N }).fill(0)    // unknown[]  ← typecheck 紅
```
兩個工具各自有理，但合起來會讓你在 lint 與 typecheck 之間來回。
需要固定長度的數字陣列就手寫迴圈，別跟它拉扯。

### 2.2 vitest 的 `~` 別名指向 `src/`，不是 `app/`

`vitest.config.ts` 的 alias 是給管線那一側用的。`app/utils/*` 之間互相 import
**要用相對路徑**（`./chart-theme`），寫 `~/utils/chart-theme` 的話 Nuxt 跑得動、
單元測試 resolve 不到。

### 2.3 `USelectMenu` 的搜尋框在 portal 裡，attrs 到不了

`$attrs` 綁在 trigger 上，不是那個搜尋 `<input>`。要把東西掛到搜尋框只能走
`:search-input="{...}"`（會經 `defu` 再 v-bind 到內部的 `UInput`）。
**這一棒最後沒有用到**——reka-ui 的 `ListboxFilter` 自己有 `useComposing()`，
IME 那一題不需要從外面補。但下次要掛別的東西時這是唯一的路。

### 2.4 CDP 的 `Input.dispatchKeyEvent` 只送 `rawKeyDown` 不會產生 keypress

而瀏覽器的 implicit form submission 掛在 keypress 上。少了 `text: '\r'`
會得到「表單永遠不會送出」的假結論——我第一次驗 Enter 誤送就踩到，
對照組跟實驗組同時是 0，看起來像沒問題。

### 2.5 macOS 上 `Control+A` 不是全選

驗證腳本裡用 `Control+A` + `Backspace` 清空輸入框會清不掉（那是「移到行首」），
於是得到「清空後空狀態沒有重設」的假陽性。用 `Meta+A` 或連按 Backspace。

### 2.6 `supabase-js` v2 的 `storage.upload()` 沒有進度事件

視覺稿畫了「62% + 取消」，做不出來——除非自己用 XHR 打 storage 的 REST。
目前是結構性骨架 + 「上傳中…」，**沒有百分比也沒有取消**。這是刻意的：
假的百分比比沒有百分比更糟。

---

## 3. 刻意沒做的取捨（不要重做一次相同的決定）

| 決定 | 理由 |
|---|---|
| **年表 `YearStrip` 與分布長條 `DistributionBars` 不用圖表庫** | 前者每一列要能被鍵盤走到、被螢幕閱讀器讀到，canvas 給不了；後者是「名稱自己一行、條在下面一行」的排版，那是 HTML 不是圖表，而且長中文影城名在 375px 下才不會被截斷。design 已認可 |
| **時段熱點圖限寬 420px** | 桌機 band 有 830px，7 欄攤開會讓每格變成 110×22 的長條，方格語彙消失。舊專案的節距是 15px 方塊，桌機把寬度收回來比把圖拉滿更接近那個比例 |
| **圖說在樣本 < 20 筆時不下「最」的斷言** | 「你最常在週六 10:00 進場，共 2 場」是從雜訊長出來的斷言，比不給洞察更糟。門檻與文案規則見 `SCREENS §9c.3` |
| **`/app` 與 `/app/records` 分工而不是合併** | `/app` 是統計門面（SPEC 的第四個價值主張，Letterboxd 把它鎖在付費層），紀錄透過點格子開抽屜出現；`/app/records` 才是可以動手改的地方 |
| **國別用原生 `<datalist>` 不用選單元件** | 必須可以自由輸入（片庫裡沒有的國家不該被擋），但也必須跟既有資料一致。建議清單從片庫的相異值長出來，天生一致也會自己成長。不建 ISO 對照表——政府資料用的是中文國名不是 ISO 碼 |
| **`TicketCard` 的網格模式（`§4.3` 後半）沒做** | 四個呼叫端目前都是列表。要做時是加一個 `variant="grid"`，不是另開一個元件 |
| **`BaseChart` 不用 ECharts 的 `setTheme()`，改 `:key` 重建** | `§5.3-10` 說 `setTheme()` 不會重算 `visualMap.pieces` 與顯式的 `itemStyle.color`，而我們每個顏色都是顯式的 ⇒ 整份 option 本來就得重來 |
| **海報只在 `<640px` 隱藏，不是永遠不顯示** | `§4.3` 算的 277px 可用寬是「沒有海報也沒有操作鈕」的乾淨卡片；`/app/records` 多了兩顆鈕，375px 下內容欄只剩 133px。`SCREENS §2.3` 本來就允許小尺寸不顯示海報 |

---

## 4. 懷疑但沒驗證的事（最容易失傳，也最有價值）

1. **未登入從 `/search` 進 `/app/films/new` 的 `?next=` 行為完全沒驗過。**
   要驗必須登出 David 的 session，我沒有動。`redirectOptions.saveRedirectToCookie: true`
   理論上會保住整個路徑含 query，登入後回到這一頁且片名還在——**但那是推論不是實測**。
   `SCREENS §11` 明文要求這個行為（「把人丟回搜尋首頁等於要他重打一次」）。
   有測試帳號之後第一個該驗的就是它。

2. **海報的「被拒」狀態（`§11` 四態的第 ④ 態）從來沒有真的發生過。**
   沒有 `/admin` 介面，`approve_film(false)` 的駁回路徑沒有人走過。
   現在畫面上那個「沒有存成功」分支是**上傳失敗**時的樣子，不是**被審核駁回**時的樣子——
   後者需要一個地方把駁回理由存起來並讀回來，而 schema 裡目前沒有那個欄位。

3. **上傳失敗的兩個分支（`retryPoster` / `continueWithoutPoster`）沒有被真的觸發過。**
   程式路徑寫了，但我沒有製造過一次真的上傳失敗。

4. **拖曳上傳沒測過。** 只測了 `setInputFiles`（等同點擊選檔）。
   `@drop` 的 handler 寫了但沒有人真的拖過一個檔案進去。

5. **出席圖的橫向捲動沒在真的觸控裝置上測過。** 只有 CDP 的 375px viewport。
   「預先捲到最右」在桌機模擬下成立，慣性捲動與 `overflow-x` 在 iOS Safari 上的
   行為沒有人看過。`§9.4` 還要求兩側加漸層遮罩表示還有內容，**那個遮罩沒做**。

6. **UGC 海報在 `/u/` 公開頁不會顯示。** `useMyRecords()` 會批次簽 signed URL，
   但 `/u/` 走 `server/api/u/[username].get.ts`（backend 的檔），那一側回的仍是路徑。
   已回報給主 session 派給 backend。

7. **圖表在 1–19 筆的中間態沒有真的看過。** David 有 174 筆，`showCharts` 門檻是 10，
   `INSIGHT_MIN` 是 20。我用「暫時讓查詢回空陣列」驗過 0 筆的空狀態，
   但 1–9（只有年表與列表）與 10–19（有圖沒有斷言）兩段只有程式邏輯，沒有畫面證據。

8. **`/api/u/[username]` 一次回最多 200 筆**（前一棒就寫過，仍然成立）。
   現在多了一個後果：**`/u/` 的年表是從那 200 筆算出來的**，超過 200 筆的使用者
   年表會缺格子，而且不會有任何提示。

9. **熱點圖在觸控裝置上點一格會不會同時觸發 tooltip 與抽屜，沒測過。**
   `emphasis: { disabled: true }` 關掉了 hover 換色，但 tooltip 還在。

10. **`ugc-poster` bucket 的 2 MiB 上限沒有被真的撞到過。**
    縮圖之後 700×1050 的 PNG 變成 333×500 的 JPEG（幾十 KB），
    理論上不可能超標，但沒有人拿一張 8000×12000 的圖試過
    ——`createImageBitmap` 在超大圖上可能先爆掉。

---

## 5. 半成品，明確標示

- **`BaseChart` 仍然註冊了沒人用的元件**：`LegendComponent`、`TitleComponent`
  （圖例是自己用 HTML 畫的，標題在 `ChartBand` 上）。留著不會壞，但會進 bundle。
- **`/app/films/new` 沒有「已比對到 TMDB 就不出現海報欄」的情境**：
  這一頁只建 UGC 作品（`tmdb_id` 必為 null），所以海報欄永遠出現。
  `§11` 第 4 節那個版面要等到有「編輯既有作品」的頁面才會用到。
- **`app/components/UserSpendSummary.vue` 的 UI 仍然只在 `/u/` 上看過一次**，
  `show_cost` 開啟後別人視角的樣子沒有人看過（需要第二個帳號）。

---

## 6. 這一棒學到的驗證方法（比結論更值得留）

- **真實瀏覽器附著**：`chromium.connectOverCDP('http://127.0.0.1:9222')` 附到 David
  自己開的 Chrome。**絕對不要 `browser.close()`**（會關掉他的瀏覽器），斷開用
  `process.exit(0)`。Google 會擋 Playwright 啟動的 Chrome，所以登入後的畫面只能這樣測。
- **每一頁的固定三問**：`documentElement.scrollWidth > innerWidth`（橫向溢出）、
  掃全部元素找 `rgb(255,255,255)`（暗色漏純白）、`scrollHeight`（有沒有變成一萬 px 的頁面）。
  這三個查詢抓到的問題比任何功能測試都多。**亮暗兩版都要跑。**
- **圖表要用像素對帳，不要用眼睛。** 合成所有 canvas 層、先填底色、再數特定顏色的
  像素數量。我就是這樣證明「雙片連映的小點沒有被畫出來」，也是這樣證明修好了。
- **IME 可以用 CDP 模擬**：`Input.imeSetComposition` 建組字中間態、
  `Input.insertText` 上屏。不需要實體鍵盤。
- **匿名曝險用 `fetch` 直接打 PostgREST 與 storage**，不要靠畫面判斷。
  `node --env-file=.env` 可以直接讀專案的 key。

---

## 7. 給下一棒的建議順序

1. **`/legal/**`** —— 規格（`SCREENS §15`）與視覺稿都就緒，而且它是 Phase 1 的法遵要件
   （「未盡顯名標示義務者視為自始未取得授權」）。四個路由但只有三個是文件。
2. **`/admin/**`** —— backend 的端點已經在了，缺介面。做完之後海報的「被拒」狀態
   才有辦法驗（見 §4-2）。
3. **`/app/settings` 的瀏覽器驗證** —— 它從第一棒到現在都沒有人操作過。
4. **`/venue/[id]`** —— routeRule 已經在了，頁面不存在。
