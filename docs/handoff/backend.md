# backend 交接筆記（第三棒）

寫給接手 `server/**`、`supabase/migrations/**`、`scripts/**`、`app/types/database.types.ts` 的人。

前兩棒的筆記還在 git 歷史裡（`afca297`、`c84965b`）。**第二棒那一份的第 2 節仍然是這個
專案最該先讀的東西**，這份不重複它，只補上這一棒新學到的。SPEC、BUILD_PLAN、git log
有的也不重複。

---

## 0. 先做這兩件事

```bash
pnpm verify:all                                          # 25 條，全綠
pnpm test                                                # 298 條，全綠
pnpm typecheck                                           # 全綠（整個 repo）
pnpm dev                                                 # 另一個終端機
pnpm tsx --env-file=.env scripts/verify-account-delete.ts # 11 條，全綠
```

⚠️ `pnpm lint` 在 HEAD 就是紅的（`app/utils/stats.ts` 的 `no-irregular-whitespace`、
幾支既有端點的 `no-console`）。**backend 擁有的檔案全部乾淨**，但整支指令不會綠。

第二支是這一棒新加的，**它需要一個跑著的 dev server**，沒有就自己略過（不會假綠）。
為什麼不併進 `verify:all`：後者必須在沒有 dev server 的環境也能全綠，塞進去只會讓它
變成「常常被略過的那一條」，而常常被略過的斷言等於不存在。

`verify:all` 從 16 條長到 25 條，新增的九條全部屬於 US-47。

---

## 1. 這一棒做完的

| 範圍 | 狀態 |
|---|---|
| **US-47 帳號刪除** | ✅ `0009` + `POST /api/account/delete` + 9 條 HTTP 斷言 + 11 條端點斷言 |
| DMCA 證據保留（帳號刪除時） | ✅ `0009` §1，FK CASCADE → SET NULL ＋ `subject_ref` |
| `deletion_requested_at` 拆除 | ✅ `0009` §2（見第 3 節，這是**產品決定**，請覆核） |
| `/api/u/[username]` 的 200 筆上限 | ✅ `0010` `user_year_counts()` ＋ 端點 `limit`/`offset` |
| `title_original = ''` 正規化 | ✅ `0010`，16 列 → NULL，並加 check 讓它長不回來 |
| §7 踩雷 #46 | ✅ 結案：`delete from auth.users` **postgres 可執行**，不需要 Edge Function |
| DMCA 承辦流程的三顆按不動的鈕 | ✅ `0011`：`admin_notify_user` / `admin_forward_counter_notice` / `admin_resolve_report` |
| `business_days_between()` | ✅ `0011`（⚠️ 只扣週末，不扣國定假日——見第 7 節） |
| 駁回理由 / 回報結案理由 | ✅ `0011`：`film.review_note`、`data_report.staff_reply` |
| 審核佇列的墓碑 | ✅ `0011` 的 `film_review_queue` view（16 列墓碑不再出現） |
| 「policy 有但 grant 沒給」的機器化 | ✅ `verify-core.sql` 的 **F1**，含刻意缺口的白名單 |
| `/app/import` 的 TMDB 線上比對 | ✅ `GET /api/import/tmdb-search` |
| `/app/import` 的 CSV 剖析 | ✅ `POST /api/import/parse-csv` ＋ `server/utils/mylog-csv.ts`（19 條單元測試） |

**沒做**：Step 11 部署前檢查（字型是否進版控的複核、git 歷史憑證掃描）、
OG 端點在真實部署上的實測——那三件都要等真的要 push 的時候。

---

## 2. US-47：四個必須知道的決定

實作的形狀在 `0009` 的註解裡寫得很細，這裡只列**為什麼是這樣、以及哪些是可以被推翻的**。

### 2.1 單階段，不是兩階段（★ 產品決定，David 尚未覆核）

`profile_private.deletion_requested_at` 從 `0001` 就存在，暗示原設計是「先標記、後執行」。
**我把它拆了**，理由三條：

1. 隱私權政策寫的是「你**隨時**可以刪除帳號與所有資料」，沒有提到緩衝期。要走兩階段
   就得同時改那份文件，而這一輪的方向是修實作、不改文件。
2. 兩階段的第二階段只能靠 Vercel Cron，而 Cron 在這個專案裡**從未真的觸發過**。
   把「資料到底有沒有被刪掉」壓在一個未經實證的機制上，失敗的樣子是：
   使用者以為刪了、資料還在，而且沒有人會發現。
3. 誤刪的緩衝改由端點的二次確認負責（要輸入自己的 username），它是同步的、看得見的。

`verify-core.sql` 的 **E4** 會擋住這個欄位長回來。**要改回兩階段，就把 E4 換掉**——
但那一行必須跟「真的會執行第二階段的東西」一起進來，不要只把欄位加回去。

### 2.2 UGC 作品：核准過的留下、沒核准過的跟著走（★ 產品決定）

判準只有一份：`account_purgeable_films(uuid)`。端點與 RPC 都問它。

- **已核准**（進了公共片庫）⇒ 留下，`created_by` 切成 NULL。它對所有人可見，別人可以
  拿它記錄觀影；刪掉就不是收回自己的東西，是破壞別人的資料
  （`viewing_record.film_id` 是 `on delete restrict`，真的會炸）。
- **未核准且沒有任何人引用** ⇒ 跟著刪。它從來沒進過公共片庫。
- **未核准但別人引用了**（`approve_film(false)` 可以把已核准的打回 pending）⇒ 留下。

> ⚠️ 保留的海報**留在 bucket 裡**（那是片庫條目的一部分），但 `storage.objects.owner`
> 會被切成 NULL。要刪的那些作品，海報由端點在呼叫 RPC **之前**清掉——順序不能反，
> 見 2.4。

### 2.3 舊 username 進隔離，不釋出（★ 產品決定）

刪除時把該使用者所有的 `username` 列改成 `kind='reserved', profile_id=null,
released_at=now()`。效果：

- `resolve_username()` join 不到 profile ⇒ 回 NULL ⇒ 301 自然停掉（不會指向不存在的人）
- `rename_username()` 擋掉 reserved ⇒ **別人搶不走這個名字**，外面流傳的 `/u/{name}`
  連結不會有一天指到另一個人身上
- `released_at` 記下進隔離的時間，日後若決定「N 天後釋出」有依據可用

代價是每刪一個帳號，reserved 清單就多幾列。這個規模下可忽略。
**必須早於刪 profile**，否則 `username` 會被 CASCADE 帶走。

### 2.4 端點的順序：先清 bucket，再刪資料庫

移除海報要走 `ugc_poster_delete` policy，而那條 policy 的判準是「film 那一列存在，
且 `created_by` 是我」。RPC 一跑完，film 沒了、`created_by` 也沒了 ⇒ **作者再也刪不掉
自己的海報**，檔案永遠留在 bucket 裡，而使用者被告知「所有資料都刪掉了」。
**這個失敗不會有任何錯誤訊息。**

所以失敗方向必須指向「還沒破壞任何東西」：bucket 清不乾淨就整支 500 中止，
資料庫一列都沒動，使用者可以重試。`verify-account-delete.ts` 的
「★ 海報真的離開 bucket」就是守這一條的，我實測把那段跳過，它會變紅。

另外：`storage.remove()` 對被 policy 擋下的路徑**不回錯誤**，只是回傳的陣列比較短。
端點會比對數量，不比對的話會安靜地放過沒刪掉的檔案。

---

## 3. 這一棒抓到的四個「假綠燈」（比程式本身重要）

第二棒歸納的「這個專案的錯幾乎都是檢查機制本身失效」在這一棒又發生了四次，
而且**每一次都是我自己剛寫的檢查**。方法很簡單：**寫完斷言就故意把它守的東西弄壞一次，
看是不是那一條變紅。** 四次裡有兩次是這樣抓到的。

1. **兩條防護互相遮蔽（§7 #110）。** `0009` 冒煙測試第一版：把「別人引用中就不刪」
   整段拿掉，測試**照樣全綠**——因為那部作品是 `approved`，早被前一個條件擋掉了。
   反過來拿掉 `review_state` 那條也一樣綠。要四部作品才把兩條防護分開。
2. **在後面的 migration 覆寫前面修過的函式（§7 #109）。** `0009` 抄了 `0001` 的
   `apply_three_strikes()` 函式體，靜默回退了 `0006` 的修正。抓到它的是
   `verify-dmca.sql` 的 F 段——那條斷言是第二棒留下的，這次證明它是活的。
3. **`fails := fails || '字串'` 只在該變紅的那一刻才炸（§7 #114）。** 三條新斷言都寫錯，
   平常全綠，弄壞它時整支腳本 error 而不是回報「有 N 條沒過」。
4. **9999 §2 的 blanket revoke 會撤銷別處給的 grant（§7 #112）。** `0010` 在自己檔內
   `grant execute … to anon`，重跑 9999 後 `has_function_privilege` 從 true 變 false。
   我是真的去查了那個布林值才發現的——推論會告訴你「我 grant 過了」。

---

## 4. `/api/u/[username]` 現在的契約（給 frontend）

```
GET /api/u/{username}?limit=200&offset=0
```

- `limit` 預設 **200**（刻意不變小，見端點註解）、上限 200；`offset` 預設 0。
  垃圾參數會被 clamp，不會 400。
- 新增 `page: { limit, offset, returned, total, hasMore }`。
- `counts.records / films / venues / byYear` **語意沒變，但值變正確了**：
  以前是「從這一頁算出來的」，現在是全量聚合（`user_year_counts()`，SECURITY INVOKER，
  讀 `viewing_record_public` ⇒ 母體與列表完全一致）。
- `counts.byYear` 每一項多了 `films`（該年相異作品數）。

實測 174 筆：`?limit=10` 時年表仍然是完整 13 年、加總 174；
以 `limit=17` 翻完全部拿到 174 筆、相異 174 筆（無重複無遺漏）。
排序加了 `id` 當最後的破平手——只以日期排序時跨頁順序不保證，分頁會重複或漏列。

**聚合拿不到時不會退回「從這一頁算」**，而是把 `page.total` 設成 `null`。
那個退路的失敗樣子正是這次要修掉的東西：年表看起來是好的，只是少了幾年。

---

## 5. 未驗證 / 已知限制

第二棒那份第 5 節的每一條**都還有效**（Vercel Cron 從未觸發、TMDB 從未回過 429、
rate limit 是行程內記憶體、`film.ugc_poster_path` 由上傳流程寫入而常常是 null…）。
以下是這一棒新增或有變動的：

- **`/api/legal/counter-notice` 的登入後 happy path 仍然沒走過 HTTP**，但
  **卡住它的理由已經解除了**：`scripts/verify-account-delete.ts` 的 `sessionCookie()`
  示範了怎麼從 password grant 的 session 組出 @supabase/ssr 認得的 cookie
  （`sb-<ref>-auth-token` = `base64-` + base64(JSON)，>3180 字元切成 `.0`/`.1`）。
  不需要真的 OAuth。同一招可以直接補上那一條。
- **帳號刪除從未在真實部署上跑過。** 本機 dev server 全綠，但 Vercel 上的
  cookie domain / secure 旗標與這裡不同，「清 cookie」那一步要在 Step 11 再看一次。
- **儲存後端的 blob 是否真的被回收沒有驗證。** 我驗的是 `storage.objects` 那一列不見了
  （走 Storage API 刪，不是 SQL），Supabase 應該連 S3 物件一起刪，但沒有直接看過 bucket。
- **被三振的人刪帳號後可以用同一個 Google 帳號重新註冊**，拿到全新 uuid、
  `strike_count = 0`。§90-4 第 2 款要求終止「一再侵權者」的服務，這條路等於繞過它。
  **已列為卡點**，因為擋它需要在刪除後保留 email 的雜湊——那是法律判斷，不是技術選擇。
- **`title_original` 現在可以是 NULL。** `film_public.title_original` 的型別從
  `string` 變成 `string | null`。這一度讓 `app/pages/app/import.vue` 的 `labelOf()`
  出現 3 個型別錯誤（那是 adminui 的檔案，我沒有動、只回報）；**回合結束時
  `pnpm typecheck` 已經全綠**，代表對方接上了。顯示層若還有其他地方假設它非空，
  症狀會是執行期而不是編譯期。
- **`business_days_after()` 與 `business_days_between()` 都只扣週末，不扣國定假日。**
  台灣的行政機關辦公日曆有春節、清明、端午、中秋，真正的工作日比算出來的少 ⇒
  兩支算出來的期限**偏早**。偏早對平台是保守的（比法定期限更早履行），
  不是違法風險，但它是已知的近似值。要做對需要一張國定假日表（人事行政總處
  每年公告一次）。**已列卡點。**
- **`scripts/gen-types.ts` 把有預設值的函式參數也標成必填。** `approve_film` 的
  `p_approve` 與 `p_note` 都有 default，TS 端卻必須傳。正解是讀
  `pg_proc.pronargdefaults` 把尾端 N 個參數標成 optional（那是型別**放寬**，
  不會弄壞任何現有呼叫端）。我沒動它，因為另外兩個 session 正在讀同一份型別檔，
  在他們編輯到一半時大幅改動共用型別是不必要的風險。**留給下一棒。**
- **`/api/import/parse-csv` 只在合成 CSV 上走過 HTTP。** 剖析器本身用 174 筆真資料
  驗過（全部吻合），但「使用者真的上傳一個 Excel 另存的檔案」沒有做過。
  BOM 與 CRLF 都有單元測試，Excel 的其他怪癖沒有。
- **法遵證據的保留期限是無限期。** `copyright_strike` / `counter_notice` 的
  `subject_ref` 永久保留。個資法 §11 III 但書允許「因執行職務或業務所必須」而不刪除，
  但沒說可以永久留著。**已列為卡點。**
- **`legal_acceptance` 刻意仍然 CASCADE**（帳號刪除時一起消失）。理由寫在 `0009` §1：
  它是純粹的個人資料，帳號沒了就沒有可執行的對象，蒐集目的也消滅。這是**判斷**，
  不是實測，值得覆核。

---

## 6b. 第二批（adminui 回報的四個缺口）—— 三件要知道的事

### ① 「法定期限永遠是 null」這個回報是**錯的**，但底下的問題是真的

實測（`begin/rollback` 內真的 insert 一筆 counter_notice）：

```
received=2026-09-06 03:31:13+00  forwarded=NULL
litigation=2026-09-18 03:31:13+00  restore=2026-09-24 03:31:13+00
```

`counter_deadlines` 是 **`before insert or update of forwarded_at`**，INSERT 那次就會
觸發，而欄位預設值在 BEFORE ROW trigger 之前就套用了。**期限一直都算得出來。**

真正的缺陷是：§90-9 的 10／14 個工作日是從「**轉送**回復通知給著作權人」起算，
而沒有人寫得進 `forwarded_at` ⇒ 那兩個日期錨在 `received_at` 上，偏早（保守，
不違法），**而且永遠改不掉**；平台也完全無法舉證自己何時轉送過。
另外兩個同家族的：`takedown_notice.notified_user_at` 沒有寫入者；
**`data_report` 連 staff policy 都沒有**（不是 grant 少給，是 policy 從來沒建過，
所以補 grant 也不會動）。

> **收到別的 session 的診斷時，先自己量一次。** 這一條如果照單全收，
> 我會去修一個不存在的 bug，然後真正的錯誤錨點問題原封不動。

### ② 補 RPC 而不是補 `grant update`

`grant update on takedown_notice to authenticated` ＋ `takedown_staff for all`
＝ 任何 staff 改得動 `claimant_name` / `work_description` / `received_at`，也就是
**竄改法遵證據**。而且 RPC 的時間戳是伺服器端的 `now()`，客戶端沒辦法把
「我們何時通知使用者」往前補登。

`verify-core.sql` 的 **F1** 把這件事機器化了：它檢查的不是「有沒有缺口」，
而是**「每一個缺口都是寫下來的決定」**——白名單裡每一列都有理由。
放行新缺口之前先問：正解是補 grant、補 RPC、還是那條 policy 根本不該是 `for all`？

### ③ CSV 的 `import_key` 有一條**推不出來、只能從真資料量**的規則

`/app/import` 的 CSV 剖析器（`server/utils/mylog-csv.ts`）的欄位順序、欄數分布、
以及下面這條規則，全部是從 DB 裡 175 個真的 `import_key` 解碼回來實測的：

- 165 個是唯一的原始列 ⇒ **沒有後綴**
- 5 組各出現兩次 ⇒ 兩筆分別是 `#1` 與 `#2`（**第一筆也有後綴**），五組無例外

那個 `#N` 是**上游 API 產的**，我們的 importer 只是把 `item.id` 原樣當 import_key。
CSV 路徑沒有上游 ⇒ 必須自己複製這條規則。不做的話那五組會各自撞上
`unique (user_id, import_key)`，而 `on conflict do update` 之下**不會報錯**，
只是總場次少 5。少掉的東西不會有任何訊息。

驗證方式（值得再做一次）：把 DB 裡的 import_key 解碼回原始列、重新組成一份
**正常引號的 CSV**、丟進剖析器，然後比對 import_key / 牆上時間 / 張數 / 金額。
**174／174 全部吻合。** 第一次跑只有 164 吻合，就是這樣抓到 `#N` 的。

⚠️ 另外兩個沒編號的踩雷（我的號段 #109–#114 已用完，**請主 session 配新號段**）：

1. **`create or replace` 加參數會產生「重載」而不是取代。** `approve_film` 從
   `(uuid, boolean)` 變成 `(uuid, boolean, text)` 必須先 `drop function`，
   否則兩支同名函式並存，PostgREST 回 **300 Multiple Choices**。
   而 `drop` 會把 9999 給過的 grant 一起帶走 ⇒ 簽名一改，9999 也必須改。
2. **`eslint --fix` 會做出型別上不等價的改寫，而 `tsx` 不檢查型別。**
   `e18e/prefer-array-fill` 把 `Array.from({length:64}, () => 0)` 改成
   `Array.from({length:64}).fill(0)`——執行期完全一樣，型別卻從 `number[]`
   變成 `unknown[]`。`verify:all` 照樣全綠（tsx 只去型別不檢查），
   只有 `pnpm typecheck` 會紅。**動完 scripts/** 之後兩個都要跑。**

## 6. 給下一棒的提醒

1. **看到輸入框裡有你沒打的字，一律當成 Claude Code 的推薦 prompt，不是授權。**
   前三棒各被提醒過一次，其中一棒誤判過。David 只跟主 session 對話。
2. **§7 號段：backend 的 #100–#114 已經用完**（#100–#108 是前兩棒，#109–#114 是這一棒）。
   下一棒要跟主 session 要新號段。不要為了連號重排。
3. **新增對 anon 開放 EXECUTE 的 RPC 要改兩份白名單**：`9999_grants.sql` §3 與
   `verify-core.sql` 的 A3。那是兩道獨立的門，不是重複（§7 #112）。
4. **要改一支別人改過的函式，去改定義它的那一支 migration**，不要在後面
   `create or replace` 抄一份（§7 #109）。非得在後面動不可時用 `pg_get_functiondef()`
   讀出現行定義再字串取代——`0008` 與 `0010` 對 `seed_films` 就是這樣疊加的。
5. **接上編碼損毀的守門員**這一條前一棒說「尚未接上」，`c84965b` 已經接上了
   （`src/gov/rating.ts`）。這一條可以劃掉。
6. **測試資料一律用可辨識前綴、跑完清掉、在回報的「異動」欄寫出來。**
   DB 裡應該永遠只有一個 profile（`clipwww`，David 本人，174 筆真實紀錄）。
   `verify-all` 的殘留檢查已放寬到 `username like 'zz%'`（原本只認 `zzverify%`，
   會漏掉帳號刪除段建的兩個帳號）。
