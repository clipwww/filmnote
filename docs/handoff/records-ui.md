# 派工簡報 — records-ui（`/app/records` 六項改造）

> 號段 **#330–#349**（`BUILD_PLAN §7`，`836a378` 配發）。用完跟主 session 要下一段，
> **不要借用 `records` 的 #185–#204**——那條線已收線，§7 的規則是寧可跳號不要混用。
>
> 前一棒的交接是 `docs/handoff/records.md`，**整份仍然有效**，尤其 §2「三個看起來像壞掉
> 其實是對的」與 §5「沒做、沒驗到的事」。這份只寫新的。

---

## 1. David 2026-09-21 的六條 → 驗收條件（一條對一條）

| # | David 的原話 | 驗收條件（可操作） |
|---|---|---|
| 1 | 改成點編輯開 Drawer，不使用換頁，這樣不用處理返回上一頁狀態都被清掉 | 在列表點編輯 → **列表元件不卸載**；儲存後 Drawer 關閉、那一列原地更新，而**年份／影城／版本／票價篩選／頁碼／捲動位置全部沒變**。瀏覽器「上一頁」把 Drawer 關掉、回到同一份列表狀態 |
| 2 | 可以更改作品，如果選錯作品不用刪掉重建 | Drawer 裡能搜尋並換掉作品；存檔後那一列的作品名變了，**紀錄總數不變**（不是刪掉重建）|
| 3 | Table 增加關鍵字搜尋 | 輸入框即時過濾**作品名／影城／影廳／備註**四欄；清空還原。與既有三個篩選器**可疊加** |
| 4a | 年份變成篩選選項之一，預設全部 | 年份離開現在的 tab 列、變成篩選器列裡的一個 `USelect`；**首次進頁面顯示全部 174 筆**（現在是最近一年的 8 筆）|
| 4b | Table 分頁用頁碼組件，不使用無限加載 | `UPagination`；換頁**不重新請求**（資料早就全在客端）；改篩選或搜尋時頁碼回到第 1 頁 |
| 5 | 其他細節不需要用風琴收納，直接顯示就好 | `new.vue` 不再有 `UCollapsible`，票數／票價／影廳／版本／備註／公開開關**直接顯示** |

⚠️ **恰好六條，不要多做。** 表格的欄位、日期格式、備註對話框、操作欄釘右都**不在這一輪**。

---

## 2. 現況（主 session 查過，附行號，不要再用推的）

### 2.1 編輯是一個獨立頁面，而它就是 David 抱怨的成因
- `app/pages/app/records/[id]/edit.vue`（172 行）是獨立路由。
- 成因在兩處：存檔後 `await navigateTo('/app/records')`、取消是 `<UButton to="/app/records">`
  ⇒ **整個列表元件重新掛載**，`selectedYear`／`venue`／`format`／`cost`／`shown` 全是
  `ref` 的區域狀態 ⇒ 一律回到初始值。
- **連向 edit 的入口有兩處，都在 `index.vue`**：`:423`（操作欄）與 `:473`（備註對話框裡的編輯鈕）。
  兩處都要改，漏第二處就是一個活著的舊連結。
  ✅ 主 session 用全 repo grep 覆核過（`grep -rn 'records/' app server tests scripts`）：
  **`index.vue` 以外沒有任何地方連向 `edit`**，所以「兩處」是查過的、不是抽樣的。

- `edit.vue` 目前**沒有**風琴，欄位本來就直接顯示。但它**漏了「版本」欄位**：
  `state.formatCode` 有載入、`toRecordRow` 有送出，**template 裡沒有對應的 `USelectMenu`**
  ⇒ 版本現在改不了（值會原樣存回，不會被清掉）。
  ⇒ 重建表單時**順手補上**。**那是補回一個本來就該在的欄位，不是第七條需求**，
  不要因此擴大範圍。

⚠️ **`/app/records/new` 另外有六處外部入口**，不要把它跟 edit 搞混：
`AppNav.vue:95`、`app/pages/app/import.vue:828`、`app/pages/app/films/new.vue:77` 與 `:162`、
`app/pages/app/index.vue:123` 與 `:148`。
其中 `films/new.vue:162` 的 `navigateTo('/app/records/new')` 是
**「記到一半發現片庫沒這部片 → 去新增作品 → 回來接著記」**那條交棒
（草稿在 `useRecordDraft`，理由寫在 `useRecordDraft.ts:4` 與 `films/new.vue:157`）。
⇒ **這就是為什麼 `new.vue` 這一輪只改風琴那一處**（§1 第 5 條）：
把它改成 Drawer 會打斷那條交棒，而那不在 David 的六條裡。

### 2.2 年份現在是 tab，「全部」已經存在，只是不是預設
- `index.vue:36` `years`、`:37` `selectedYear = ref<string|null>(null)`、
  `:39` `activeYear = selectedYear ?? years[0] ?? ''`
- 註解原文：`null 代表「還沒選過」⇒ 用最近的一年；'' 代表使用者選了「全部」`
- tab 列在 `:246–268`，「全部（174）」那顆已經有了（`:262`）。
  ⇒ **第 4a 條大部分是把預設從 `years[0]` 改成 `''`，再把選擇器搬進 `:270` 那一排 `USelect`。**

⚠️ **這一改會連帶改變另外三個篩選器的選項來源。** `:48` 的註解寫著
「選項只從**當年**的紀錄長出來：選了就 0 筆的選項比沒有選項更難用」，
而 `venueOptions`／`formatOptions` 吃的是 `byYear`（`:53–54`）。
預設變成「全部」之後，那兩個選單第一次打開會列出**全部年份**的影城與版本。
⇒ 這是第 4a 條的真實代價，**不是 bug**。把它做出來、量出選項筆數、寫進回報，
**不要自己決定要不要改回去**——要不要為此加限制是 David 的事。

⚠️ `:69` 的 `watch(activeYear, …)` 會在年份變動時重設其餘三個篩選器。
預設變成「全部」之後，使用者第一次選年份仍然會清掉篩選——**行為沒變，但現在更容易遇到**。
一併回報，不要順手改掉（那條 watch 有它的理由，寫在 `:68`）。

### 2.3 分頁現在是「再顯示 N 筆」
- `:63` `PAGE = 24`、`:64` `shown = ref(PAGE)`、`:96` `visible = filtered.slice(0, shown)`、
  `:97` `hasMore`、`:451` 按鈕 `@click="shown += PAGE"`
- `:93` `watch(filtered, () => shown.value = PAGE)` ⇒ 換篩選就回到第一批。
  **改成 `UPagination` 之後這條 watch 要改成把頁碼設回 1，不要刪掉。**

### 2.4 搜尋：不存在
`index.vue` 全檔沒有任何關鍵字搜尋。四個篩選維度是年份／影城／版本／有無票價。

### 2.5 改作品：三層都要看
`edit.vue` 有 `select(… film_id)`（`:45`）但**只用來查片名**（`:63`），從不寫回。
`film_id` 在 UI 上完全不可改。**資料庫與 RLS 允不允許 UPDATE `film_id`，你要自己查**——
查法見 §5.2，**不要讀 migration 檔就下結論**（理由見 §4.1）。

✅ **好消息：`MyRecord` 已經有 `filmId`**（`useMyRecords.ts:15`，型別註解說明「抽屜只能靠它
對回紀錄——片名會撞」）⇒ Drawer 要顯示「現在是哪一部」**不需要動 `useMyRecords.ts`**，
避開了 §6.2 的不要寫。

選作品的 UI **有現成的可以參考**：`app/pages/app/records/new.vue` 的作品選擇、
以及 `app/pages/app/films/new.vue`。先讀它們再決定要不要抽成共用元件。

### 2.6 風琴只有一處
`grep -rn "UCollapsible\|UAccordion\|<details" app/pages/app/records` ⇒
**只有 `new.vue:244`**，`</UCollapsible>` 在 `:287`。按鈕字面是「其他細節（選填）」，
與 David 的原話一字對應。收納的是票數／票價／影廳／版本／備註／公開開關六項。
⇒ **第 5 條的落點就是 `new.vue`，只有這一處。**

### 2.7 元件全部現成，不要加依賴
`@nuxt/ui@4.11.0` 已裝，`node_modules` 裡實測有
`Drawer.vue`／`Slideover.vue`／`Pagination.vue`／`Input.vue`／`Select.vue`／`SelectMenu.vue`。
⇒ **這一輪不需要新依賴。** 若你認為需要，那是卡點，先回報（理由見 §4.4）。

---

## 3. 一定要做對的一件事：狀態放進 URL

David 的抱怨字面是「不用處理返回上一頁狀態都被清掉」。
**只把 `<UDrawer>` 塞進 `index.vue` 不會自動解決它**——那只解決了「換頁」，
沒解決「重新整理／分享／上一頁」。

要求：**Drawer 的開關與列表的篩選狀態都走 URL query**，例如
`/app/records?year=2024&q=IMAX&page=2&edit=<id>`。這樣三件事同時成立：
① 上一頁關掉 Drawer 並回到同一份列表；② 重新整理不會回到初始狀態；③ 連結可以分享。

**既有先例可以照抄**：`3792b6a` 的 `/u/` `?view=wall`。讀那個檔的實際寫法再決定
用 `useRoute().query` + `navigateTo({ query })` 還是別的，**不要憑印象寫**。

`UDrawer` 還是 `USlideover` 由你決定（David 說的是「Drawer」，兩個都在）。
唯一的硬條件：**375 寬要能把整張表單填完**，而且日期／時間／下拉打開時不被虛擬鍵盤蓋掉。
選了哪個、為什麼，寫進回報。

---

## 4. 硬性約束——碰到會壞，或已經被裁決過

### 4.1 ★ 讀 migration 檔 ≠ 讀 DB 裡活著的定義（踩雷 #189）
`supabase/migrations/0008` 與 `0010` 會在**執行時** `pg_get_functiondef()` 讀出函式原始碼、
`replace()` 換掉一段、再 `execute` 回去。所以 `0001_init.sql` 裡的函式文字**只是歷史**。
⇒ 要確認任何 SQL 函式／RLS policy 現在到底長什麼樣，**唯一可靠的方法是讀活體**：
```sql
select pg_get_functiondef(p.oid) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = '<函式名>';
```
⚠️ 這一條的代價是**靜默的**：拿舊定義推論，猜錯時不會有任何訊息、不會有任何測試變紅。

### 4.2 `useMyRecords.ts` 是共用的，`#251` 的早退不可以拿掉
- `/app` 儀表板（海報牆）與這一頁**共用** `useMyRecords()`。動它的公開介面會撞到別人。
- 踩雷 `#251`：`ensureAllRecords()` 的 `if (loadedAll.value) return` 早退**不可以拿掉**。
  同一個 tick 內連點兩列會順序反轉，**要修得用序號守 `picked`，不是拿掉早退**。
  改作品／換頁如果需要重新載入，走 `refresh()`，不要改早退。

### 4.3 三件已裁決、不要重開
- **踩雷 #188：靜止時備註被固定欄蓋住 93px 是被接受的代價。** 三條路（截欄寬／
  容器尾端補 padding／改釘左緣）**都走過、都量過、都被否決**，理由在 `records.md §2-3`。
  不要因為你在改這張表就順手重開這個案子。`columnPinning = { right: ['actions'] }`（`:194`）保持。
- **踩雷 #54：不用 `UTable` 的 `virtualize`**（它要容器有確定高度，這裡的容器隨內容長）。
  改成頁碼分頁之後仍然不要開 virtualize。
- **備註門檻 `MEMO_INLINE_MAX = 16`**（`:133`）刻意不因欄寬下修，`records.md §2` 有原因。

### 4.4 `pnpm-lock.yaml` 與 `package.json`（F1）
本機的 install／dev／build／test／verify:all **沒有任何一個**會比對這兩個檔，
而 Vercel 的 `--frozen-lockfile` 會直接死在 install。
⇒ **這一輪預期不需要改 `package.json`**（§2.7）。真的要改就**必須連 lockfile 一起進版控**，
而且**先回報**——另一條線（tmdb-import）同時在跑，兩邊都改會衝突。

### 4.5 `tests/page-root.test.ts` 會掃你改的每一個頁面
它斷言 `app/pages/**` 每個 `.vue` 的 `<template>` **只有一個根節點**，
而且**「`<template>` 的直接子註解自己就是一個根節點」** ⇒ 說明註解只能寫在根元素**裡面**。
⚠️ 把 `<UDrawer>` 加到 `index.vue` 時，它必須在**根元素之內**，不能當根的兄弟節點。
這條測試釘住的是 `app.pageTransition`，而 `v-if` 當根時 **Vue 完全不會警告**。

### 4.6 註解慣例（`docs/CODE_STYLE.md`，32 行）
每則 ≤3 行，寫「為什麼」與「改了會怎樣」。
⚠️ **兩種不可以蒸發**：量過的數字、以及「改了 X 會壞 Y」。
你要刪掉的 `index.vue` 舊註解裡有好幾則屬於這兩種（93px 的算術、174 筆的分布、
`UTooltip` 在觸控不會開的理由）——**搬到這份交接或 `docs/`，不要蒸發**。
⚠️ 刪改註解讓測試變紅有兩種解釋且長得一樣（踩雷 #166），**不可以改測試讓它綠**。

---

## 5. 驗證

### 5.1 四關 + verify:all
`pnpm typecheck`（= `typecheck:app` + `typecheck:pipeline`）、`pnpm lint`、
`pnpm test`、`pnpm build`、`pnpm verify:all`。
⚠️ **四關全綠看不到 client-only 的 runtime 錯誤**，而這一輪改的全部是 client 行為
⇒ 四關只是門檻，不是驗收。

### 5.2 查 DB 一律走 `pnpm db:sql`（踩雷 #253）
**不要自己開 pg client**：node-postgres 預設把 `date`／`timestamp` 解析成 JS `Date`，
`console.table` 再以 UTC 印 ⇒ `2016-09-28` 印成 `2016-09-27T16:00:00.000Z`，
上一輪差點據此回報「日期跟簡報對不上」。`scripts/db.ts:15-22` 的註解就是為這件事寫的。

### 5.3 指定 David 的資料用 `.env` 的 `IMPORT_TARGET_EMAIL`
**不要用 git 署名的那個信箱**（`david.chien@athena.com.tw`）——那是 commit 署名，
跟登入信箱是不同的兩個，拿它去查會得到 **0 筆而不是錯誤**。
所有腳本都用 `--env-file=.env`；**值不要寫進版控**（repo 是 public）。

### 5.4 造測試資料一律 `zz` 前綴，驗完立刻刪，刪後複查基準
基準是 **174 筆、全部 public、全部有 `watched_time`**
⇒「無時間」與「私密」兩種呈現**在真實資料上看不到，要驗必須自己造**。

⚠️ **第 2 條（改作品）只能拿 `zz` 前綴的紀錄來驗，不要挑 David 真的一筆來試。**
那 174 筆是他的真實資料，改錯了 `film_id` 就是把一筆真紀錄接到別部片上，
而多刷排行是以 `film_id` 分組的（`BUILD_PLAN §8.3` 第 31 條）⇒ 他的統計會跟著變。
驗完立刻刪，刪後複查 **174／全 public／全有時間**。

### 5.5 ★ 瀏覽器實測，而且要在 375 逐一點過（踩雷 #250）
`/app` 需要登入 ⇒ **只能用 CDP 附著 David 已登入的 Chrome**，不要另開無痕。
⚠️ 踩雷 `#250` 是「桌機驗收 100% 綠、手機少一半入口」：圖表標籤在 375 下被 ECharts
悄悄丟掉一半，**沒有任何錯誤、沒有 console 訊息**。
⇒ 頁碼組件、搜尋框、年份選單、Drawer 這四樣**都必須在 375 逐一點過**，不是看設定。
⚠️ 驗備註與長文要**先切到 2024**（長備註 8 顆都在那年，2026 只有 8 筆且一顆都沒有）
——否則會得到「做了但沒生效」的假結論。

### 5.6 ★★ 先讀 `BUILD_PLAN §7.6`「檢查機制本身會失效」整節（#230–#244）
那一節收的就是「斷言存在、名字也對，但**它守的不是它宣稱要守的東西**」那一類，
而**你這一輪要寫的每一條驗收都在它的射程內**。不要只讀我下面挑的幾條，整節讀。

與你直接相關的五條：

- **#242** `document.elementFromPoint()` 對**視窗外**的座標回 `null`，而 `null` 會讓
  「這個點上是不是我要的元素」一律判成 false ⇒ **「被別的東西蓋住」與「根本不在視窗裡」
  回傳同一個答案。** 這一條就是量 `/app/records` 備註鈕時撞到的（鈕在 y=1014、視窗高 900）。
  ⇒ 你要逐一點過頁碼、搜尋框、年份選單、Drawer（§5.5）**一定會用到這個探針**，
  先把元素捲進視窗再量，並且分開回報「不可點」與「不在視窗裡」。
- **#238** `watch` 收合狀態時不可以看 `items.length`——**全期 15 家與 2016 年 7 家都是 6 列**，
  長度一模一樣。⇒ 你改分頁時若用長度變化當訊號，會在「筆數剛好相同」的篩選組合上靜默失效。
- **#234** 只驗長度的斷言擋不住「累加漏了」——JS 陣列會自己長。⇒ 頁碼分頁的斷言不要只驗
  `visible.length === PAGE`，要驗**內容**（第 2 頁的第一筆是不是全集的第 25 筆）。
- **#239** 時區相關的斷言，**在台灣的機器上測不出時區錯誤**。實測把 `timeZone: 'Asia/Taipei'`
  拿掉，`TZ=Asia/Taipei` 下 14 條測試全綠、`TZ=America/New_York` 下才紅 2 條。
  ⇒ 搜尋若碰到日期字串，斷言要跑 `TZ=America/New_York` 一次。
- **#236** 有四種 UI 量測**不開瀏覽器也做得到**（`@vue/compiler-dom` + `@vue/server-renderer`
  算出使用者看到的字面字串等）。⚠️ 那一條的前提寫得很清楚：**多條線共用一顆 Chrome，
  誰開誰污染** ⇒ 能靜態量的就靜態量，把 Chrome 留給真的只能點的那些。

⚠️ **另外：`grep -r` 在這個 shell 看不到 `.env`**（踩雷 #240，實測 `grep -rn` 回 4 個檔、
`.env` 不在裡面）⇒ 任何拿 `grep -r` 證明 `.env` 狀態的斷言都是假的。

### 5.7 ★ 每一支你寫的檢查器，先餵已知答案雙向自測（踩雷 #254／#260）
未改動 → 綠、故意改一行 → 紅。兩個方向都要跑過才可以引用它的輸出。
⚠️ `#254`：macOS 的 **BSD `sed` 不支援 `\b`**，上一輪「故意弄壞」根本沒改到檔、測試照樣綠，
差一點被讀成「這條斷言是假的」。每個弄壞法都要附一個「改完之後確實變成什麼樣」的數字。
⚠️ `#260`：上一輪連用四支壞掉的檢查器才答對一個問題。**檢查法本身要先證明它真的在檢查。**

---

## 6. 足跡與共用 checkout

### 6.1 你的
```
app/pages/app/records/index.vue
app/pages/app/records/new.vue
app/pages/app/records/[id]/edit.vue      ← 改寫成 Drawer 後這個檔可能要刪
app/composables/useRecordDraft.ts
app/composables/useRecordOptions.ts
app/schemas/record.ts                     ← 若改作品需要新欄位
app/components/**                         ← 要抽 Drawer 內容成元件的話
docs/handoff/records-ui.md                ← 這份，收工時你自己更新
docs/BUILD_PLAN.md                        ← 只讀。新踩雷交給主 session 合併（§7 第 2 點）
```

### 6.2 要讀、但**不要寫**
`app/composables/useMyRecords.ts`（與 `/app` 共用，見 §4.2）、
`app/utils/ticket.ts`、`app/utils/format-datetime.ts`、
`nuxt.config.ts`、`package.json`、`pnpm-lock.yaml`、`scripts/verify-all.ts`、
`app/components/AppNav.vue`、`eslint.config.*`、`.omc/project-memory.json`
⇒ 真的必須動其中任何一個：**先回報，不要自己決定**。

### 6.3 ⚠️ 兩條線共用同一個 checkout
另一條線 **tmdb-import** 同時在跑（`src/tmdb/**`、`scripts/**`、`supabase/migrations/**`、
`server/api/**`）。上一輪有先例：`1004076 fix(import): 還原 bbf5617 被 eslint --fix 改掉的
兩個 NuxtLink`——**一條線的 `--fix` 掃到了另一條線的檔**。硬性條款：

- 只 `git add` §6.1 之內、而且你真的改過的檔。**禁 `git add -A`、禁 `git commit -a`。**
- **禁全 repo `pnpm lint:fix`。** 要 autofix 就指定檔案：`pnpm exec eslint --fix <你的檔>`。
- **禁 `git stash`／`git checkout .`／`git reset --hard`／切分支。**
- `typecheck`／`lint` 在**不屬於你的檔**變紅 ⇒ **回報，不要修**。那大概是對方正在寫。
- commit 前跑 `git status --short`，出現你足跡外的檔就停下來。

### 6.4 ⚠️ `.nuxt/` 與 `.output/` 也是共用的，不只 git
兩條線同時跑 `pnpm typecheck` 或 `pnpm build` 會**互相覆寫產物**
⇒ 紅燈可能是假的，**綠燈也可能是假的**（你看到的產物是對方那次建的）。
⇒ 四關變紅時**先問對方是不是正在跑同一關**，不要立刻當成自己的 bug 去追。

**`pnpm dev` 這一輪只有你會開**（另一條線沒有前端工作）。
踩雷 `#241`：`127.0.0.1:3000` 回 200，但那是**另一個專案**的站
⇒ 開 dev 之前先確認那個 port 上的站真的是 filmnote，不要只看 HTTP 狀態碼。

---

## 7. 回報

每個回合結束（完成、卡住、需要決定皆然）用 `━━ 回報 ━━` 那個格式收尾
（你的 auto-memory 裡有 `session-report-protocol`，照那份寫）。
**不要報喜不報憂**：繞路、驗證沒過、發現簡報有誤都要寫進去。
不要報 Context %——那是終端 UI 畫的。

### 收工前
1. 把「量過的數字」與「改了 X 會壞 Y」寫進 `docs/handoff/records-ui.md`。
2. ⚠️ **新踩雷先寫在這份交接的最後一節，用你的 #330–#349 編號，但不要自己動
   `docs/BUILD_PLAN.md`。** 兩條線同時往 §7 的同一張表尾端加列**一定會 git 衝突**
   （§7.6 的表尾是兩邊都要加的地方）。⇒ **由主 session 合併**。
   號段是你的、編號由你決定，只是**落點由主 session 放**。
3. `records.md §2`／`§5` 裡被你推翻或做掉的條目，**回去更正那一份**
   （上一棒就是這樣處理 `coverWithinKnown` 那句錯的）。

---

## 8. 這些不要自己決定，寫進「卡點」

1. **「全部」當預設之後，影城／版本選單要不要限制選項**（§2.2 的連帶代價）。
2. **搜尋要不要含日期字串**（例如打 `2024/07` 找那個月）。簡報只要求四個自由文字欄。
3. 任何需要改 `package.json`／`useMyRecords.ts`／`nuxt.config.ts` 的事。

### 已經替你決定好的（不用問，照做）
- **`new.vue` 這一輪只改風琴那一處**，新增流程不動（理由在 §2.1 那條交棒）。
- **`[id]/edit.vue` 不必二選一。** 保留檔案、把它變成一個轉址
  （`navigateTo('/app/records?edit=<id>', { replace: true })`）⇒ 深連結活著、
  列表狀態也不會被清掉。這是建議選項，你有更好的做法就用你的，寫進回報。
- **`edit.vue` 漏掉的「版本」欄位（§2.1）** 在重建表單時順手補上。
  **那是補回一個本來就該在的欄位，不是第七條需求**，不要因此擴大範圍。

> 過度指定跟指定不足一樣會造成返工（F5.3）。上面沒寫死的地方就是留給你判斷的，
> 做了什麼、為什麼，寫進回報就好。
