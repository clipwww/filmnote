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
| 2 | 可以更改作品，如果選錯作品不用刪掉重建 | Drawer 裡能搜尋並換掉作品；存檔前後 `select id, created_at, film_id from viewing_record where id='<那筆>'` ⇒ **`id` 與 `created_at` 不變、只有 `film_id` 變**，且原有的 `viewing_record_cost` 那一列還在。⚠️ **不可以只驗「總數不變」**——刪掉再新增也是 -1+1、總數一樣，分辨不出來 |
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
  ⚠️ **改成 `UPagination` 時，這條 watch 的監看對象要換成「篩選／搜尋的輸入值」
  （`year`／`venue`／`format`／`cost`／`q`），不要繼續監看 `filtered`。**
  `refresh()` 會換掉 `filtered` 的 identity ⇒ 繼續監看它會讓**存檔後頁碼跳回第 1 頁**，
  那直接違反 §1 第 1 條「頁碼沒變」。
  ⇒ §1 第 4b 條的「改篩選或搜尋時頁碼回到第 1 頁」**不包含** `refresh()` 造成的資料更新。

### 2.4 搜尋：不存在
`index.vue` 全檔沒有任何關鍵字搜尋。四個篩選維度是年份／影城／版本／有無票價。

### 2.5 改作品：三層都要看
`edit.vue` 有 `select(… film_id)`（`:45`）但**只用來查片名**（`:63`），從不寫回。
`film_id` 在 UI 上完全不可改。

**主 session 讀 migration 檔的結論是「不需要 migration」**（查過的依據）：
`0001_init.sql:827-830` 的 `record_update` policy，`with check` 只要求
`user_id = auth.uid() and moderation_state='visible' and film_usable_by(film_id, auth.uid())`
——**沒有把 `film_id` 釘成常數**（對照 `:782-787` 的 `film_update_own_ugc`，那個才是把管制欄位
釘成常數的寫法）；`9999_grants.sql:76` 是**表級** `grant insert, update, delete on
public.viewing_record to authenticated`，全 repo migration 裡沒有 `viewing_record` 的欄位級
grant，也沒有 `film_id` 的 guard trigger（`0001:489` 是 `touch_updated_at`、`:499` 是
`watched_on` 日期守門、`:323-324` 的 `film_identity_sync` 掛在 `film` 表不是 `viewing_record`）。

⚠️ **但以上全部是讀檔得到的、未讀活體** ⇒ **你必須自己用 `pnpm db:sql` 讀活體覆核**
（理由見 §4.1，踩雷 #189）。**不要把上面那段當成已驗證。**
⚠️ 如果活體顯示真的需要 migration，那是卡點——`supabase/migrations/**` 是**另一條線的地盤**，
你不要自己加。

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

**硬條件只有一條**：Drawer 的開關要能被瀏覽器「上一頁」關掉、而且列表狀態不被清掉
⇒ 用 `?edit=<id>` 或等效做法，例如 `/app/records?edit=<id>`。

**篩選／頁碼要不要也放進 URL 由你判斷**，做了寫進回報。
⚠️ 那不在 David 的六條裡（主 session 第一版把它寫成要求，是過度指定 ⇒ 收回）。
它的好處是重新整理不會回到初始狀態；`/app` 需要登入所以「連結可以分享」這個理由不成立。

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

### 4.2 `useMyRecords.ts` 是共用的（而 `#251` 的早退**不在**這個檔裡）
- `/app` 儀表板（海報牆）與這一頁**共用** `useMyRecords()`（同一個 `useAsyncData` key
  `'my-records'`）⇒ **動它的公開介面會撞到別人**。它的介面是 `{ records, status, refresh }`；
  改作品／換頁需要重新載入就走 **`refresh()`**。
- ⚠️ **更正主 session 的第一版**：踩雷 `#251` 的 `ensureAllRecords()` 與 `loadedAll`
  **不在 `useMyRecords.ts` 裡**（那個檔完全沒有這兩個東西）——它們在
  **`app/pages/u/[username].vue:134-135`**，那是公開分享頁，
  **不在你的足跡裡、不要碰**。
- 與你有關的只有那條教訓本身：**同一個 tick 內連點兩列會順序反轉，
  要修得用序號守 `picked`，不是拿掉早退。** 你如果在 Drawer 上做類似的「點一列才載入詳情」，
  同一個陷阱會重演。

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
⇒ **這一輪 `package.json` 對你是唯讀**（§2.7 已確認不需要新依賴）。
真的需要新依賴就是卡點：由主 session 在兩條線都靜止時執行 `pnpm add`，
並把 `package.json` ＋ `pnpm-lock.yaml` 放在**同一個 commit**。
**不要自己跑 `pnpm add`**：兩邊同時跑會產生兩份互不相容的 lockfile，
而本機 install／dev／build／test／verify:all **沒有任何一關會發現**。

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
⚠️ 驗備註與長文要**先切到 2024**。長備註（會長出按鈕的那些）實測 **18 顆、分布在 7 個年份**，
2024 最多、有 8 顆；**2026 那 8 筆一顆都沒有** ⇒ 用預設年份驗會得到「做了但沒生效」的假結論
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
app/schemas/record.ts                     ← 若改作品需要新欄位（new 與 edit 唯一的共用檔）
app/components/**                         ← 要抽 Drawer 內容成元件的話
docs/design/SCREENS.md                    ← 做完後 :47、:620-630、:1210-1211、:1227-1229
                                             四處會變成事實錯誤，一起更正
docs/handoff/records-ui.md                ← 這份，收工時你自己更新
docs/BUILD_PLAN.md                        ← 只讀。新踩雷交給主 session 合併（§7 第 2 點）
```

### 6.2 要讀、但**不要寫**
`app/composables/useMyRecords.ts`（與 `/app` 共用，見 §4.2）、
`app/utils/ticket.ts`、`app/utils/format-datetime.ts`、
`nuxt.config.ts`、`package.json`、`pnpm-lock.yaml`、`scripts/verify-all.ts`、
`app/components/AppNav.vue`、`eslint.config.js`、`.omc/project-memory.json`
⇒ 真的必須動其中任何一個：**先回報，不要自己決定**。

⚠️ **deny 優先於 glob。** §6.1 給了你 `app/components/**`，但 `AppNav.vue` 在上面這張禁寫清單裡
⇒ 那個 glob **不包含它**。（實查 `AppNav.vue` 只有 `:94` `/app/records` 與 `:95`
`/app/records/new`，**沒有 edit 連結** ⇒ 這一輪本來就不需要動它。）

⚠️ **一個沒被指派、但你幾乎一定會碰到的共用檔**：`app/composables/useFilmSearch.ts`。
「改作品」的片名搜尋幾乎必然複用它，而它有**五個消費者**（`useRecordDraft.ts`、
`app/pages/app/import.vue`、`records/new.vue`、`films/new.vue`、`admin/films.vue`）
⇒ **改它的介面會讓兩個跟 records 無關的頁面 typecheck 變紅。**
判準：**可以讀、可以呼叫；要改它的公開介面就先回報。**

✅ **new 與 edit 沒有任何共用的表單元件**（查過：兩者唯一共用的是 `app/schemas/record.ts`）。
`app/components/` 的 24 個檔裡沒有任何 `Record*` 表單元件（只有 `RepeatList.vue`、
`TicketCard.vue`）⇒ Drawer 的表單是**新建**，不是重構既有元件。

### 6.3 ⚠️ 兩條線共用同一個 checkout
另一條線 **tmdb-import** 同時在跑（`src/tmdb/**`、`scripts/**`、`supabase/migrations/**`、
`server/api/**`）。上一輪有先例：`1004076 fix(import): 還原 bbf5617 被 eslint --fix 改掉的
兩個 NuxtLink`——**一條線的 `--fix` 掃到了另一條線的檔**。硬性條款：

- 只 `git add` §6.1 之內、而且你真的改過的檔。**禁 `git add -A`、禁 `git commit -a`。**
- **禁全 repo `pnpm lint:fix`。** 它是 `oxlint --fix . && eslint . --fix` **兩支**，
  要 autofix 就兩支都指定檔案：`pnpm exec oxlint --fix <你的檔> && pnpm exec eslint --fix <你的檔>`。
  ⚠️ `eslint.config.js` 的 ignores 實查涵蓋 `supabase/migrations/**`、`docs/**`、`.omc/**`、
  `app/types/database.types.ts` ⇒ 失手的 `lint:fix` **不會**改到 migration 與交接文件，
  但**會**改寫 `app/**`／`scripts/**`／`src/**`／`server/**` 的 `.vue`／`.ts` ⇒ 那正是對方的地盤。
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
3. `records.md §2`／`§5` 裡被你推翻或做掉的條目，**不要自己動那個檔**
   （它不在 §6.1 的足跡裡，動了會觸發 §6.3「足跡外的檔就停下來」）。
   把「原句 ＋ 該改成什麼」寫進**你自己這份交接**，**落點由主 session 放**。
   （姊妹簡報 `tmdb-import.md` 對 `BUILD_PLAN §8.3` 用的就是這個寫法。）

---

## 8. 這些不要自己決定，寫進「卡點」

1. **「全部」當預設之後，影城／版本選單要不要限制選項**（§2.2 的連帶代價）。
2. **搜尋要不要含日期字串**（例如打 `2024/07` 找那個月）。簡報只要求四個自由文字欄。
3. 任何需要改 `package.json`／`useMyRecords.ts`／`nuxt.config.ts`／
   `app/composables/useFilmSearch.ts` 公開介面的事。
4. **分頁如果你判斷應該下沉到伺服器端**（而不是在已載入的全集上做客端分頁）——
   那一定會動到 `useMyRecords.ts`，而它是 `/app` 共用的（§4.2）⇒ 先回報。
   簡報的預設是**客端分頁**：搜尋、篩選、排序反正都在客端，資料早就全在手上。

### 已經替你決定好的（不用問，照做）
- **`new.vue` 這一輪只改風琴那一處**，新增流程不動（理由在 §2.1 那條交棒）。
- **`[id]/edit.vue` 不必二選一。** 保留檔案、把它變成一個轉址
  （`navigateTo('/app/records?edit=<id>', { replace: true })`）⇒ 深連結活著、
  列表狀態也不會被清掉。這是建議選項，你有更好的做法就用你的，寫進回報。
- **`edit.vue` 漏掉的「版本」欄位（§2.1）** 在重建表單時順手補上。
  **那是補回一個本來就該在的欄位，不是第七條需求**，不要因此擴大範圍。

> 過度指定跟指定不足一樣會造成返工（F5.3）。上面沒寫死的地方就是留給你判斷的，
> 做了什麼、為什麼，寫進回報就好。

---

## 9. 第一棒做完的四件（#330–#349 號段，2026-09-21）

David 當回合的指示：額度剩約 2 小時 ⇒ **先做四件便宜且互相獨立的**（關鍵字搜尋、年份改
篩選器且預設全部、頁碼分頁、拿掉 `new.vue` 的風琴），Drawer 與改作品放後面。
⇒ **§1 的第 1、2 條（Drawer、改作品）這一棒沒有做**，`[id]/edit.vue` 原封不動、
`edit` 的兩個入口（`index.vue` 操作欄與備註對話框）**都還連向舊的獨立頁面**。

落地的 commit：`ec982cf`（第 5 條）、`6b57ab8`（第 3／4a／4b 條）。

### 9.1 量過的數字（都是查活體或實跑元件得到的，不是推的）

| 量的東西 | 數字 | 怎麼量的 |
|---|---|---|
| 全期紀錄 | **174 筆** | `db:sql` 查活體，與簡報一致 |
| 全期影城選項 | **15 家**（選單顯示 16 項，含「所有影城」）| 同上，`count(distinct nullif(btrim(venue.name),''))` |
| 全期版本選項 | **6 種**（選單 7 項）| 同上，走 `screening_format.label` |
| 舊預設年份 2026 | **8 筆 / 3 家影城 / 2 種版本**（選單 4／3 項）| 同上 |
| 8 頁時頁碼鈕最多幾顆 | **頁碼 5 顆 + 控制 4 顆 = 9 顆** | 直接 import `reka-ui` 的 `getRange()` 跑過 8 個頁碼 |

⚠️ **`showEdges` 預設是 `false`** ⇒ `UPagination` 走的是 `siblingCount*2+1` 那一支、
**根本不長省略號**。我第一版憑算術寫「預設 2 會排到 11 顆、375 會溢出」是錯的
（11 顆只有 `showEdges=true` 才會發生），所以那一版的 `:sibling-count="1"` 是在解一個
不存在的問題、代價是頁碼從 5 顆掉到 3 顆。**最後改回主題預設，不要再調小。**

### 9.2 「改了 X 會壞 Y」

1. **頁碼重設的 watch 監看 `filtered` ⇒ 每一次存檔都把使用者踢回第 1 頁。**
   `refresh()`（存檔、刪除後都會呼叫）會換掉 `filtered` 的 identity。現在監看的是
   **輸入值** `[year, venue, format, cost, q]`。`tests/records-list.test.ts` 有一條靜態斷言
   釘住這件事（`expect(script).not.toMatch(/watch\(\s*filtered\b/)`）。
2. **`pageCount` 的夾住不可以改成「回第 1 頁」。** 刪掉最後一頁唯一那筆時 `page` 會落在
   範圍外、表變成空的而且畫面沒有任何解釋 ⇒ 夾回**最後一頁**。改成回第 1 頁就等於
   第 1 點明文要避免的事。
3. **年份選項不可以走 `options()`。** 那支會 `.sort()` 成升冪 ⇒ 年份會變成舊的在最上面。
   `records` 本來就是新到舊、`Set` 保留插入序，所以年份選項另外組。
4. **搜尋是逐欄比對，不可以把欄位串起來比一次。** 串起來會讓「影城結尾＋備註開頭」這種
   跨欄巧合算成命中（測試裡 `信義座位`、`廳座位` 兩條就是釘這個）。
5. **頁碼那一排外面的 `-mx-4 overflow-x-auto px-4` 不要拿掉。** 它是從年份 tab 列搬過來的
   同一個容器，守的是「頁面 body 永遠不橫向捲」（§10 品質底線）。

### 9.3 ⚠️ 沒驗到的（不要當成驗過）

- **§5.5 的「375 逐一點過」整關沒跑。** David 當回合選擇不重開 Chrome（`/app` 需登入
  只能 CDP 附著他自己那顆）⇒ **頁碼組件、搜尋框、年份選單在 375 下的實際寬度與可點性
  一次都沒有實量過**。上面 9.1 的「9 顆」是元件層的顆數不是像素，`overflow-x-auto`
  是兜底不是量測。**這一關仍然欠著。**
- §5.5 的「先切到 2024 驗長備註」沒跑（同上，沒開瀏覽器）。
- §5.4 的 `zz` 前綴測試資料**完全沒造**——這一棒沒有寫入路徑（四件事全是讀與呈現），
  DB 也沒有被這一棒改過任何一列。
- §2.5 的「改作品需不需要 migration」**沒有查活體**：那是第 2 條的前置，而第 2 條沒做。
  ⇒ §2.5 那段仍然是「讀檔得到、未讀活體」，下一棒要自己覆核。

### 9.4 卡點／要 David 決定的

1. **「全部」當預設之後，影城／版本選單要不要限制選項**（§8 卡點 1）。實測代價已經量出來：
   兩個選單第一次打開從 **4／3 項變成 16／7 項**。做了、量了、**沒有自己改回去**。
2. **搜尋要不要含日期字串**（§8 卡點 2）。目前**不含**——打 `2024` 只比得到片名裡的 2024，
   不會去翻 `watched_on`。測試有一條釘住現況，要改的話那條要一起改。
3. **`watch(year)` 會清掉其餘三個篩選器**（§2.2 的第二個警告）。行為沒變，但預設改成
   「所有年份」之後**更容易遇到**：使用者的第一次選年份一定會走到這條，把他剛設好的
   影城／版本清掉。沒有順手改掉。

### 9.5 足跡外的新檔（先報備）

- `app/utils/record-list.ts`（新）：`matchesQuery()` 與 `pageSlice()`。抽出來的唯一理由是
  **測得到**——留在 SFC 的 computed 裡時四關全綠也看不見它們（`§5.1`、`§5.6 #236`）。
  `app/utils/` 不在 §6.1 的清單裡，但 §6.2 點名唯讀的是 `ticket.ts` 與 `format-datetime.ts`
  兩個檔、不是整個目錄，而新檔與 tmdb-import 那條線零交集。
- `tests/records-list.test.ts`（新）：14 條。搜尋逐欄／不跨欄／null 安全／不含日期；
  分頁**驗內容不只驗長度**（#234）；外加三條靜態斷言釘住頁碼重設的訊號來源。
- 兩支都依 §5.7 **雙向自測過**（用 python 改檔不用 BSD `sed`，避開 #254）：
  `watch([...]) → watch(filtered)` ⇒ 紅 2 條；`.some(includes) → .join('').includes` ⇒ 紅 1 條；
  `(page-1)*perPage → page*perPage` ⇒ 紅 3 條；三次還原後都回到 14 綠。

### 9.6 `docs/design/SCREENS.md`：四處中三處已更正，一處查過後判定不必改

§6.1 點名的四處，逐處看過：

| 位置 | 原本寫什麼 | 處置 |
|---|---|---|
| `:620` §8.4「收合區」 | 標題就叫「收合區」，內文 `▸ 票價、票數、影廳、版本` — `UCollapsible`。展開後：… | **已改**：標題改成「其他細節（原「收合區」）」，加註 2026-09-21 起不再收合。六項的個別規格保留（那是設計意圖，有些還沒做） |
| `:1210-1211` | 「走分批載入（一批 24 筆），單一年份大多在 30 筆以內」 | **已改**：改成頁碼分頁、8 頁、換頁不重新請求，並把「回第 1 頁的訊號不是 `filtered`」寫進去 |
| `:1227-1229` | 「篩選四個維度」「前三個的選項只從**當年**取」 | **已改**：年份改成篩選器之一且預設全部、補上關鍵字搜尋那一段、把 16／7 vs 4／3 的實測代價寫進去 |
| `:47` | scroll-padding 那條「兩個不要」，把 `/app/records/new` 列為長表單 | **不必改**。那條講的是 `scroll-mt-20` 與 `scroll-padding-top` 相加，跟風琴無關；`new.vue` 攤平後**更長**，只是讓那個已知代價更常遇到，敘述本身沒有變成錯的 |

### 9.6.1 `docs/handoff/records.md`：grep 過，沒有條目需要更正

`grep -n '再顯示\|shown\|hasMore\|selectedYear\|activeYear\|tab\|年份' docs/handoff/records.md`
四個命中全部仍然成立，沒有被這一棒推翻的：
- `:137-140` 「頁面預設年份是最近的一年（2026），而 2026 的 8 筆裡一顆備註鈕都沒有；
  驗收要先切到 2024」——⚠️ **前半句被這一棒改掉了**（預設現在是「所有年份」），
  但**結論反而更強**：預設全部之後第 1 頁是最新的 24 筆、仍然幾乎都在 2026–2025，
  長備註最多的 2024 還是要自己切過去。⇒ 建議主 session 把那一條的第一句改成
  「頁面預設是**所有年份**，但第 1 頁仍然是最新的那批」，其餘照舊。
- `:142` 「原本的第 4 條（備註展開狀態不會記憶）那個機制整個不存在了」——與這一棒無關。
- `:200` 講 `0001_init.sql` 的函式文字只是歷史——與這一棒無關。

### 9.7 新踩雷（號段 #330–#349，**落點由主 session 放進 `BUILD_PLAN §7.6`**）

- **#330 `port 3000 回 200` 不代表那是你開的站——也可能是同一個 repo 的另一顆 dev。**
  踩雷 #241 講的是「3000 上是別的專案」，這次是它的反面：3000 上**就是 filmnote**，
  但那是 **21:22 就起來的另一顆 `nuxt dev`**，我 22:48 起的那顆被擠到 3001。
  兩顆 `nuxt dev` 跑同一個 checkout 會**同時寫 `.nuxt/`**（§6.4 的共用產物），
  ⇒ 開 dev 前要看的是 `ps -o pid,lstart,command` **比對啟動時間**，不是 `curl` 看標題
  （標題兩顆一模一樣）。我的處理是收掉自己那顆、改用既有的 3000。
  ⚠️ 附帶：`curl 127.0.0.1:3000` 回**連線被拒**而 `curl localhost:3000` 回 200
  ——那顆站只綁 IPv6 的 `[::1]`。拿 IPv4 去探會得到「沒人在跑」的**錯誤**結論。
- **#331 `UPagination` 的 `showEdges` 預設 `false` ⇒ 省略號根本不會出現。**
  憑「頁碼組件大概長這樣」的印象去算寬度會算出 11 顆（那是 `showEdges=true` 的形狀），
  實際最多 9 顆。⇒ 要知道一個第三方元件會 render 幾顆，**直接 import 它自己的
  `getRange()` 跑一次**（`reka-ui/dist/Pagination/utils.js`），那比開瀏覽器便宜也比推論可靠。
- **#332 「四關全綠」對 client-only 的搜尋／分頁完全沒有意見，但它們是可以被抽出來測的。**
  把 `matchesQuery`／`pageSlice` 從 SFC 抽成純函式之後，`(page-1)*perPage` 少減一這種錯
  立刻紅 3 條；留在 computed 裡則四關全綠。⇒ **client 行為要先變成純函式才測得到**，
  這比「開瀏覽器點一遍」涵蓋得更穩定（瀏覽器那關仍然欠著，見 9.3）。
