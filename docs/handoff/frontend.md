# 交接筆記 — frontend（第三棒）

> 這一棒的範圍在中途被重新切過兩次。**先看第 1 節的所有權**，不然你會去改別人的檔。
> 假設你讀得到 `docs/SPEC.md`、`docs/BUILD_PLAN.md`、`docs/design/**` 與 `git log`，
> 所以這裡**不重複**那些。只寫關掉 session 就會消失的東西。
>
> 前兩棒的筆記在 git 歷史裡（`cfcfe49`、`fee23ed` 之前那一版）。
> **第二棒 §3「刻意沒做的取捨」整節仍然有效**，除了一條：`/app/records` 的票根卡
> 列表已經換成表格（見 §3）。它的 §6「驗證方法」也仍然有效，我在 §6 補了三條。

---

## 1. 所有權（2026-09-06 兩次調整後的狀態）

**我的**：
`app/layouts/**`、`app/assets/**`、`app/schemas/**`、`app/composables/**`（除下列）、
`app/components/**`（**除圖表那一批**）、
`app/pages/legal/**`、`app/pages/search.vue`、`app/pages/film/**`、
`app/pages/app/records/**`、`app/pages/app/settings.vue`、`app/pages/app/films/**`

**不是我的**（動了會互相覆蓋）：
- **圖表整批 → adminui**：`app/components/{BaseChart,ChartBand,AttendanceCalendar,HourHeatmap,MonthlyTrend,DistributionBars,YearStrip}.vue`、`app/utils/{chart-theme,stats}.ts`、`app/composables/useYearStats.ts`、**`app/pages/app/index.vue`**
- **adminui**：`app/pages/admin/**`、`app/pages/app/import.vue`、`app/pages/index.vue`、`app/pages/u/[username].vue`
- 一律不碰：`server/**`、`supabase/**`、`scripts/**`、`src/**`、`app/types/database.types.ts`
- **共用、動之前先問主 session**：`nuxt.config.ts`、`package.json`

⚠️ adminui 會**使用**我的 `TicketCard`（抽屜裡列的是票根卡），但不修改它。
反過來也一樣——需要改對方的東西一律透過主 session。

⏱ **這張表的時效（2026-09-08 補）**：上面那張表描述的是 **2026-09-06 那一種編組**
——frontend／adminui／backend 三條線各有一個 session 同時在寫，所以 `src/**`、`server/**`、
`supabase/**`、`scripts/**` 對「我」而言是「一律不碰」。
⚠️ **那不是這幾個目錄的永久屬性，是「當時有別人正在寫它們」。**
2026-09-07 David 那十二項的那一波就**沒有獨立的 backend 線**，協調者逐項重新指派，
`src/gov/cinema.ts` 與 `supabase/migrations/0015_venue_blank_name.sql` 都是由做那一項的人
自己改的（見 §5-9）。
⇒ **每一輪開工前先問協調者這一輪怎麼編組**。這張表回答的是「同一時間還有誰在寫這些檔、
誰的 commit 會把我的改動整包帶走」，不是「這些檔永遠歸誰所有」。

---

## 2. 這一棒做完的東西

| 路由／區塊 | 狀態 |
|---|---|
| `/legal/terms`、`/legal/privacy`、`/legal/copyright` | 完成。內容從 `legal_document` 讀，自己剖析 markdown |
| `/legal/dmca` | 完成。表單不是文件，寫進 `takedown_notice` |
| 顯名標示頁尾 `AttributionFooter` | 完成。掛在 layout，每一個公開頁都有 |
| 右上功能選單 `AppNav` | 完成。含明暗切換三態、staff 才有的 `/admin`。2026-09-07 觸發鈕加上 **Google 頭像**（`#leading` 裡一顆 `UAvatar`，`size="2xs"`、`referrerpolicy="no-referrer"`）：值由 `app/composables/useMyAvatar.ts` 從 GoTrue 的 `user_metadata` **現場**取（`avatar_url` → `picture`，只收 `https://` 開頭的字串），**刻意不寫進 `public.profile.avatar_url`**——那一欄 anon 讀得到、`server/api/u/[username].get.ts` 的白名單也**已經** select 了它 ⇒ 落地等於把 Google 頭像變成公開資料，而 `v-if` 從來不是隱私控制。載不出來（Google 換網址、使用者拿掉大頭貼）由 `UAvatar` 自己的 `@error` 退回 `:text` 的**使用者名稱首字（不轉大寫）**——不用 `UAvatar` 內建的 fallback，那個是 `alt.split(' ')` 取英文姓名縮寫。`<ClientOnly>` 那層與 `aria-label` 都沒動。取值的純函式 `pickAvatarUrl()` 有 `tests/my-avatar.test.ts` 釘住（16 條斷言）|
| 頂部導覽列（`app/layouts/default.vue` 的 `<header>`） | 2026-09-07 改成 sticky：`sticky top-0 z-30 border-b border-default bg-default`，內層 `h-14`＝56px（＋`border-b` 1px ⇒ 總高 57px）、**不透明**、不做毛玻璃、不做 auto-hide。連帶在 `app/app.config.ts` 建立**全站 z 階**（導覽 30 ／ 覆蓋層 50 ／ toast 100）——Nuxt UI 4 的九個覆蓋層主題原生**零 z-index**，不建這一階，sticky 之後導覽列會畫在遮罩與對話框**之上**（遮罩蓋住全頁、導覽列浮在遮罩上還亮著，而功能全部正常，只有「看起來不對」）。`LegalDocumentView.vue` 桌機目錄偏移跟著改成 `md:top-18`（72px；舊值 `md:top-4` 會讓目錄上緣 41px 藏在導覽列後面）。規格見 `SCREENS §0.1`，z 階見 `DS §10` |
| `/app/settings` | 三個既有功能**首次以瀏覽器驗過**；新增三振區塊與帳號刪除 |
| `/app/records` | 改成 Table + 四個篩選 |
| 日期帶 | 月與星期改英文縮寫、場次時間搬到日期下面 |

⚠️ **`app.config.ts` 在 `app/app.config.ts`**——Nuxt 4 的 `srcDir` 是 `app/`
（`nuxt.config.ts` 的 `future: { compatibilityVersion: 4 }`）。放在 repo 根的 `app.config.ts`
**不會被載入**，也在 `.nuxt/ui.css` 的 `@source` 之外 ⇒ **兩重靜默失效、零錯誤訊息、
`pnpm build` 照樣 exit 0**。這一輪的計畫在這個路徑上寫錯了兩次。

⚠️ z 階那一份**刻意列了「今天還沒用到」的覆蓋層**（popover / tooltip / slideover /
contextMenu），不要因為「repo 裡搜不到」就刪掉一行——漏掉的成本是「下一個加 UTooltip 的人
要記得回來補」，而不 render 的元件不產生任何 CSS，留著的成本是零。
（2026-09-08 覆核：全站覆蓋層實例已經是 **23 處**——`grep -roh '<U\(Modal\|Drawer\|Slideover\|DropdownMenu\|ContextMenu\|SelectMenu\|Select\|Popover\|Tooltip\)\b' app/ | wc -l`
——這個數字每一波都在動，別把它抄進斷言裡。同一次覆核也發現
`app/pages/app/records/index.vue` 已經有一個 `UTooltip`，而 `app/app.config.ts` 註解裡
「tooltip 尚未使用」那句已經過期，下次動那個檔的人請順手改掉。）

---

## 3. 這一棒推翻的一個舊決定

**`/app/records` 從票根卡列表改成表格**（David 指定）。

⚠️ **這不是 `TicketCard` 退場**：`/u/`、`/film/` 的「誰看過」、匯入預覽、
以及**這一頁自己的刪除確認框**都還在用它。兩種呈現各自對的地方：

- 票根卡是**一筆一筆看**——公開頁、單筆分享、確認框。要確認「刪的是哪一筆」時，
  一張看得出是什麼的卡片比一列對齊的欄位好。
- 表格是**橫著比**——「我在哪家戲院花最多」「哪些沒填票價」要對齊欄位才看得出來。

篩選維度（年份／影城／版本／有無票價）的選項**只從當年的紀錄取相異值**。
不從全部取：否則會出現一堆選了就 0 筆的選項，而使用者無從得知為什麼。
換年份時其餘篩選一併重設，理由同上。

不用 `UTable` 的 `virtualize`（要求容器有確定高度，踩雷 #54），沿用分批載入。

---

## 4. 三個帶數字的決定（不要在沒有量之前推翻）

### 4.1 Toggle 關閉態「被吞掉」的病灶是**邊界對比**，不是顏色不好看

David 的描述是症狀，量出來的是這個：

| | 關閉態軌道 vs 底 | 滑塊 vs 軌道 | 開啟態 vs 底 |
|---|---|---|---|
| 亮 | paper-200 對台紙 **1.36:1** | **1.50:1** | amber-600 **4.68:1** ✅ |
| 暗 | paper-700 對台紙 **1.77:1** | 9.62:1 | amber-400 **7.64:1** ✅ |

WCAG 1.4.11 對非文字 UI 元件要求 **3:1**，關閉態兩層都不到 ⇒ 整顆元件對背景幾乎不存在。

⚠️ **解法是給邊框上色，不是把軌道加深。** 軌道換 paper-400 能到 3.03:1，
但在亮色下會讀成「已填滿」＝「已開啟」——那是拿一個對比問題換一個**無聲的語意錯誤**，
而這個開關管的是「要不要把票價公開給所有人」。
落點：`--fn-switch-off-border`（亮 paper-400 / 暗 paper-500），
`app.config.ts` 只在 `data-[state=unchecked]` 把 Nuxt UI 本來就有的那圈透明邊框染色，
**尺寸與版面完全不動**。詳見 `DESIGN_SYSTEM §1.6` 我補的那一段。

### 4.2 日期帶的星期為什麼也改成英文

David 只說「月改英文縮寫」。星期那一格**我決定一起改成 `Sun`**，理由不是統一風格：

> 月份變成 `Jul` 之後，帶子上出現 `Jul / 26 / 日`，而「日」在中文裡同時是
> 「星期日」與「日期的單位」——緊貼在一個拉丁月份與一個兩位數後面，**它會被讀成後者**。

`Sun` 沒有這個歧義，整條帶子也只剩一套字型與一組度量（`Jul`/`Sun`/`16:00` 全部由
Inter 供應，而 `tabular-nums` 本來就只能由 Inter 提供 ⇒ 多張卡的數字真的對得齊）。
**代價**：這是全站唯一以英文呈現星期的地方。要改回中文的話**連月份一起改回去**，
不要只改一半——混排的那一版正是被這一條換掉的。

⚠️ 縮寫**寫死成陣列**不用 `Intl.DateTimeFormat('en', { month: 'short' })`：
後者的輸出隨 ICU 版本而異（`Sept` 與 `Sep` 在不同 Node／瀏覽器上都出現過），
而這三個字母要在每一張卡上等寬對齊。有一條測試釘住「九月是 Sep 不是 Sept」。

⚠️ 場次時間搬到日期帶之後，**從 `detailSegment()` 拿掉了**。兩邊都印就是同一個值
出現兩次，而讀的人會以為那是兩個不同的時間。要改回來的話兩邊一起改（有測試釘住）。

### 4.3 明暗切換與 ISR 快取：查過了，這條路是乾淨的

`/` 與 `/film/**` 走 ISR，Vercel 以「路徑」為單位快取（踩雷 #1）⇒
任何隨使用者而異的東西進了 SSR 輸出，就會被第一個訪客的版本烤進 CDN。
主題偏好正是這一類，而且症狀比登入外洩更難察覺——**使用者會看到「別人的主題」
而不是壞掉的畫面**。

**實測 2026-09-06**：把 `nuxt-color-mode` cookie 設成 `dark` / `light` / 不帶，
抹掉 payload 裡的 SSR 時戳之後三份 HTML **逐位元組相同**，
`$scolor-mode` 三種情況都是 `"system"`。偏好只在瀏覽器端套用。

⚠️ **這是現在的結論，不是永久保證**：哪天有人在 SSR 期間讀 `colorMode.value`
去挑顏色（踩雷 #88 那條），這個保證就沒了。
驗法：`curl -H 'Cookie: nuxt-color-mode=dark' …` 對照無 cookie 版本，
**記得先用 `sed -E 's/,1[0-9]{12},/,TS,/g'` 抹掉 `timeSsrStart`**——
我第一次沒抹，得到「兩者不同」的結論，差點去修一個不存在的 bug。

---

## 5. 懷疑但沒驗證的事（最容易失傳，也最有價值）

1. **帳號刪除的「最後那一按」沒有驗過。** 預覽（唯讀）與確認字串守衛都驗了，
   但真的送出 `POST /api/account/delete` 沒有——這個環境**建不出第二個能登入
   瀏覽器的帳號**（只有 Google OAuth、Playwright 啟動的瀏覽器被 Google 擋、
   鑄 session 注入被分類器擋，而最後一條被擋是對的，不要想辦法繞）。
   API 層由 backend 的 `http/account-delete` 覆蓋，**UI 層那一按未驗證**。
2. **三振區塊（`StrikeStatus`）沒有畫面證據。** 要造一次三振就得寫
   `copyright_strike`，而 `apply_three_strikes()` 只有 insert/update 觸發、
   **沒有 delete 觸發** ⇒ 清不乾淨會在 David 的真實帳號上留一個假的計數。
   `strike_count = 0` 時整區不出現這一半驗過了。
3. **未登入的選單內容沒有在瀏覽器裡看過。** 未登入可達是用不帶 cookie 的 curl
   與匿名 POST 證的；`AppNav` 未登入那一組項目（登入／搜尋／外觀／條款）
   只有程式邏輯。同 1 的理由。
4. **`/legal/dmca` 的 rate limit（同 IP 5 次/小時）沒撞過。**
5. **「複製副本」的剪貼簿失敗分支沒觸發過。**
6. **歷史版本只有一個版本**，所以條款頁的「切到舊版 + 警告橫幅 + 回到現行版本」
   只有程式邏輯，沒有畫面證據。
7. **`/app/records` 的表格在真的觸控裝置上沒測過**，只有 CDP 的 375px。
   表格在自己的容器裡橫向捲（頁面 body 不捲，已量過），但慣性捲動沒人看過。
8. **`/legal/dmca/counter/[noticeId]`（`SCREENS §15.4`）與被取下內容的降級態沒做。**
   端點 `server/api/legal/counter-notice.post.ts` 已經在了，入口依規格**不在 `/legal`**，
   在使用者自己的紀錄上（票根卡保留位置 + 申訴連結）。
9. **`/venue/[id]` 仍然不存在**，`nuxt.config.ts` 的 routeRule 已經在了
   （`'/venue/**': { ssr: true, isr: … }`，2026-09-08 覆核仍在）。

   ⚠️ **開工時直接用 `venue.name`，不要再寫 `name || company_name`。**
   `SCREENS §6` 那條 `displayName = name || companyName` **沒有被推翻——它的落點被搬了**：
   從 2026-09-07 起改成在**資料層**一次收斂，不再由各頁的顯示層各補一次。
   兩層落點：`src/gov/cinema.ts` 的上游 fallback（`const name = govName || companyName`，
   兩欄同時空由 `assertNameUsable()` 在 parse 階段就炸掉）＋
   `supabase/migrations/0015_venue_blank_name.sql`（人工正名進 `curated_fields`、
   另兩列以公司全銜保底、加 `venue_name_not_blank` CHECK）。
   為什麼搬：同一個病灶有七個消費面（記錄選單、匯入選單、`app/utils/ticket.ts` 的
   `venueSegment()`、`useMyRecords`、`/app` 與 `/u/` 兩支圖表、OG 端點），
   **在任何單一層補都只補得到一個**；而 `venue_option` 這個 view **沒有 `company_name` 欄**
   （2026-09-08 讀 `information_schema.columns` 覆核：只有 id / kind / name / city /
   hall_count / sort_weight）⇒ 想在顯示層補 fallback，得先改 view 再重跑 `pnpm db:types`。

   ⚠️ **但「`venue.name` 保證非空白」現在還不成立——0015 尚未套用。**
   2026-09-08 讀活體：`venue` 共 114 列，`btrim(name) = ''` 仍有 **3 列**，
   `pg_constraint` 裡查不到 `venue_name_not_blank`。**migration 檔存在 ≠ 已套用**——
   這跟 `BUILD_PLAN §7 #189`（讀 migration 檔不等於讀 DB 裡活著的定義）是同一個道理。
   ⇒ 這一頁動工前**自己再查一次**，若那時仍未套用，`/venue/[id]` 會有三筆標題是空的：
   `pnpm db:sql -- --query "select count(*) from public.venue where btrim(name) = ''"`。

   ⚠️ 同理，`app/pages/app/index.vue` 與 `app/pages/u/[username].vue` 那兩行
   `v.name ?? '（場所不明）'` **維持原狀即可**——`??` 只接得住 null/undefined，
   本來就抓不到 `''`，資料層修好之後也不需要抓。
   （2026-09-08 重新 grep：分別在 `app/pages/app/index.vue:150` 與
   `app/pages/u/[username].vue:302`；**行號會漂，用 `grep -rn '場所不明' app/` 找**，
   改動請求寫的 147／272 已經不對了。）
   這兩個檔在 2026-09-07 那一波被別的項目動過 ⇒ 誰要改那兩行，
   先讀 `BUILD_PLAN §7` 踩雷表**「選單裡的城市名是算繪出來的」**那一條
   （症狀在算繪層、病灶在資料層；拿螢幕上的字面去 DB 裡 `name ~ '(市|縣|區)$'` 查
   會得到「資料沒問題」這個完全相反的結論）。⚠️ **編號以 BUILD_PLAN 現況為準**：
   實作者提議 #190，同一波另有一項也提議 #190，最終號碼由協調者配——按標題找，不要按號碼找。
10. **`/legal/**` 的 `AttributionFooter` 份量規則只在這台機器量過。**
    字標已改成 SVG 路徑（分母因此是常數），但 58.3% / 22.8% 是這裡的實量。

---

## 6. 這一棒學到的驗證方法（比結論更值得留）

### 6.1 ★ 顏色只能在 production 產物上驗，dev 的截圖證不了

踩雷 #99：`--ui-color-neutral-*` 在 production build 裡**一個都沒有被定義**
（引用 10 次、定義 0 次），因為 Tailwind v4 的 `@theme` 會 tree-shake 沒被
**utility** 用到的變數，而那一串只被另一個自訂屬性讀。**dev 不 tree-shake。**
症狀是整站 `text-muted` 退回黑色、soft 的中性按鈕連背景都沒有，
而 `pnpm build` 是 exit 0、零警告。

⇒ 驗顏色的流程是：
```bash
pnpm build && PORT=3100 node --env-file=.env .output/server/index.mjs
# 然後對 :3100 量，不要對 :3000（dev）量
```

### 6.2 ★ 只連單一分頁的裸 CDP（踩雷 #97）

`chromium.connectOverCDP()` 會列舉瀏覽器裡的**每一個** target，
只要有人開著一個 `file://` 分頁就整個逾時 30 秒。
而 Node 22 的 `fetch()` 打 `http://127.0.0.1:9222/json/list` **永遠掛著不回**
（同一個 URL `curl` 是 0.9ms 回 200）——症狀是腳本一行輸出都沒有。

解法是 `node:http`（`agent: false`）取 `/json/list`，再對**那一個** target 的
`webSocketDebuggerUrl` 開 WebSocket 發 `Runtime.evaluate` / `Page.captureScreenshot`。
不需要 Playwright，也不會被別人的分頁影響。
**要自己的分頁不打擾別人**：`curl -X PUT '…/json/new?<url>'`。

### 6.3 ★ 背景分頁沒有指標命中測試——用 `element.click()` 不要用座標

實測：`Input.dispatchMouseEvent` 對 `UDropdownMenu` 的觸發鈕**完全沒反應**
（選單不開），對 `USelect` 的選項則有效。原因是被 CDP 驅動的那個分頁不是
David 瀏覽器裡的作用中分頁，Chrome 對背景分頁不跑同一條輸入管線。

**症狀很惡劣**：我先得到「點了沒反應」，再得到「點 A 卻套用了 B 的效果」
（座標是舊的一次開啟量到的），一度以為是 off-by-one 的產品 bug。

⇒ 規則：
- **選單／下拉的項目一律用 `el.click()`**（純 DOM，永遠有效）。
- `USelect` 的**選項**要用真的指標事件（reka-ui 的 Select 聽 pointerup），
  但**觸發鈕**要用 `el.click()`——同一個元件，兩半不一樣。
- 鍵盤走選單要看 `[data-highlighted]`，**不是 `document.activeElement`**
  （reka-ui 是 roving focus，activeElement 停在容器上）。

### 6.4 匿名曝險用 `fetch` 直接打 PostgREST，不要靠畫面判斷

這一棒用它關掉了一條前一棒標為「需要第二個帳號」的未知：
`show_cost` 開啟後別人視角看得到什麼。開 → 匿名讀得到 **169 列票價／合計 5x,xxx**；
關 → **0 列**。**不需要第二個帳號**，`node --env-file=.env` 直接打就證得了。

### 6.5 第二棒的「每一頁的固定三問」仍然有效

`documentElement.scrollWidth > innerWidth`（橫向溢出）、掃全部元素找
`rgb(255,255,255)`（暗色漏純白）、`scrollHeight`（有沒有變成一萬 px 的頁面）。
亮暗兩版都要跑。⚠️ 掃純白時要**排除 `#vue-tracer-overlay`**，那是 dev 的東西。
⚠️ 切主題**不要手動加 `.dark` class**——`@nuxtjs/color-mode` 會把它改回去，
量到的是切換過程中的中間態。用 `Emulation.setEmulatedMedia` 的
`prefers-color-scheme` 再 reload。

---

## 7. 刻意沒做的取捨（不要重做一次相同的決定）

| 決定 | 理由 |
|---|---|
| **法律文件自己寫 markdown 剖析器，不裝套件** | 三份條款用到的語法是封閉集合（h1–h3、段落、引言、清單、表格、粗體、行內碼）。更重要的是回傳**結構化區塊**由 Vue 以文字節點算繪，`v-html` 那條路一開始就不存在。`SCREENS §15.1` 又禁用 Nuxt UI 的 prose ⇒ 樣式本來就要自己寫 |
| **中文軟換行接合時不補空格** | 一般 markdown 用空格接合軟換行，對中文會多出一個看得見的空隙。規則：接縫兩側只要有一邊是 CJK 就直接相接。中英之間的間距交給 `text-autospace: normal` |
| **`/legal/**` 的行長是 `34em` 不是 `34ch`** | DS §2.4 寫「`34ch`（≈560px）」，兩個數字對不起來。`ch` 是「0」的推進寬度（Inter ≈0.6em、蘋方半形 0.5em）⇒ `34ch` 實測 272–330px、一行 17–20 個漢字。漢字是 1em 全形，「34 個字」寫成 CSS 就是 `34em`＝544px。踩雷 #94 |
| **`/legal/dmca` 送出後不顯示受理編號、不說「已寄確認信」** | 端點刻意不回 id（「呼叫者讀不到這張表，給了 id 也沒有用途」），而 David 已裁定寄信服務擱置、專案裡沒有任何寄信能力。改成把**副本留在使用者手上**（可複製）。做不到的承諾寫在法遵頁的入口上，跟隱私權政策寫「你隨時可以刪除帳號」但沒有實作是同一類錯誤 |
| **網址回顯只認 `/film/{slug}`** | 跟 `server/api/legal/notice.post.ts` 的 `resolveTargetFilm()` **逐字相同**。畫面上回顯的東西必須跟 `target_film_id` 真正會填進去的東西是同一個判斷——回顯認得出、伺服器認不出，使用者會以為我們已經定位到那一筆，而 admin 打開來是空的 |
| **`AppNav` 的法遵四頁做成子選單** | 它們每一頁的頁尾都連得到（那是 §90-4 的落點），選單裡是第二條路不是唯一那條。攤平會讓登入後的選單多出四列 |
| **帳號刪除先給 `account_deletion_preview()` 再要求打字確認** | 「會刪掉什麼」在這個資料模型裡不是顯而易見的。⚠️ 那一列的措辭要涵蓋**四種**理由（已核准／被別人引用／已合併／在合併紀錄裡）——實測 David 的 16 部**全部**落在「已被合併」，只寫「被別人引用」對他就是一句錯的話 |
| **`StrikeStatus` 的計數只讀 DB 欄位、`getCachedData` 回 undefined** | `admin_restore()` 會 `revoked_at` 掉三振、`strike_count` 由 trigger 重算。使用者在意的正是「我申訴成功了沒」，快取一個舊計數就是答錯那一題。拿列表 `length` 當計數也不行——那是第二份判斷 |

---

## 8. 下一棒建議的順序

1. **`/legal/dmca` 被駁回作品的三件**（主 session 已裁決，尚未動工）：
   ① `filmLabel()`（`app/composables/useFilmSearch.ts`）要標記 `rejected` 態，
   比照現有的「審核中」，**文案要讓人看得懂後果**（用它記的紀錄永遠不會公開）；
   ② `review_note` 目前**沒有任何畫面讀它**，審核者被強制填的理由寫進去就消失了；
   ③ `SCREENS §11` 第 ④ 態（被拒）沒有落點頁面。
   ⚠️ 這一態的性質跟「上傳失敗」不同：那是技術錯誤、重試就好；被駁回是**人做的決定**，
   使用者需要知道理由並且可能要改資料再送一次。**畫面語彙不該共用。**
2. **`/legal/dmca/counter/[noticeId]`** 與被取下內容的降級態（§5-8）。
3. **`/venue/[id]`**（routeRule 已在、頁面不存在）。
   ⚠️ **動工前先讀 §5-9**：名字的 fallback 已經從顯示層搬到資料層，這一頁**直接用
   `venue.name`**；但那個保證要等 `0015` 套用才成立，§5-9 有一行查法。
4. **`/app/settings` 的刪除帳號**：等有第二個測試帳號時把最後那一按驗掉（§5-1）。

