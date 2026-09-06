# backend 交接筆記（第三棒）

寫給接手 `server/**`、`supabase/migrations/**`、`scripts/**`、`app/types/database.types.ts` 的人。

前兩棒的筆記還在 git 歷史裡（`afca297`、`c84965b`）。**第二棒那一份的第 2 節仍然是這個
專案最該先讀的東西**，這份不重複它，只補上這一棒新學到的。SPEC、BUILD_PLAN、git log
有的也不重複。

---

## 0. 先做這兩件事

```bash
pnpm dev                                                 # 先開這個，verify:all 才會跑滿
pnpm verify:all                                          # 36 條（沒有 dev server 時 25 條 + 1 略過）
pnpm test                                                # 298 條，全綠
pnpm typecheck                                           # 全綠（整個 repo）
pnpm tsx --env-file=.env scripts/verify-account-delete.ts # 11 條，全綠（會真的刪帳號）
pnpm tsx --env-file=.env scripts/scan-git-secrets.ts      # push 前必跑
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
| `strip-auth-on-cacheable` 的隱性耦合 | ✅ 改成問 `getRouteRules(event)`，不再有第二份清單（§7 #117） |
| **`/api/og/**` 從來沒有真的跑起來過** | ✅ router param 的鍵是 `username.png`，兩支端點對每個請求都回 400（§7 #118） |
| SSR payload 與 OG 的 HTTP 驗收 | ✅ `scripts/verify-http.ts`，**已接進 `verify:all`**（11 條，含兩組對照） |
| Step 11 憑證掃描 | ✅ `scripts/scan-git-secrets.ts`（掃**全部** 943 個物件，含 13 個不可達 blob） |
| 「照著改」的覆蓋層 | ✅ `0012`：`admin_correct_film` / `admin_correct_venue` ＋ `seed_venues` RPC |
| 全期統計（不分年份） | ✅ `0003` 加 `by_year` ＋ `monthly_baseline`（那支**本來就支援**全期，§7 #122） |
| 月度＝季節性、平均線 | ✅ 主 session 裁決季節性；平均線的分母用**曝光數**（§7 #123） |
| 首頁海報牆 | ✅ `0013` `home_poster_wall()` ＋ `GET /api/posters` |

**Step 11 的兩件已做**（第三件 CRON_SECRET 是 David 的部署設定）：

- **14MB 字型進版控：確認維持。** 兩個檔都在版控裡（7,085,600 + 7,090,820 bytes），
  magic 是 `00010000`＝TrueType sfnt（不是 satori 吃不下的 `wOF2`）。全站沒有任何
  `fonts.googleapis` / `fonts.gstatic` 的執行期參照。**新發現**：Nitro 把
  `server/assets/**` **內聯成 base64 的 `.mjs`**——`.output/server/chunks/raw/
  NotoSansTC-{Regular,Bold}.mjs` 各 **9 MB**（base64 比原檔胖三分之一），
  這就是 `.output/server` 從 34 MB 長到 **40 MB** 的來源。`find .output -name '*.ttf'`
  **找不到任何東西**，那是正常的，不要因此以為字型沒進去。
- **git 歷史憑證掃描：乾淨。** 見第 6c 節。

**仍未做**：OG 端點在**真實部署**上的實測（本機 dev 已經全綠，但 Vercel 的
Node runtime 與 linux 原生模組仍未驗證，見 §7 #108）。

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

## 6c. Step 11 的兩件（已做）

### git 歷史憑證掃描 —— `scripts/scan-git-secrets.ts`

實測 2026-09-06：

```
物件總數 943（blob 421）
其中不可達 13 個 blob —— 只有 --batch-all-objects 掃得到
比對目前 .env 的 7 個憑證：✅ 全部沒有出現在任何物件裡
形狀比對：✅ 沒有命中
```

三件值得記住的：

1. **`git log -p | grep` 只看得到可達物件。** 這個 repo 可達 900、全部 943
   ——**43 個物件只有 `--batch-all-objects` 掃得到**。被 amend / rebase /
   reset 掉的 commit 仍躺在 `.git/objects` 裡，`git push` 不送它們，但 clone
   之後 `git fsck --lost-found` 撈得到，GitHub 也能直接以 SHA 取懸空物件。
2. **兩輪比對，形狀 + 身分。** 形狀比對（正則）會隨 Supabase 換 key 前綴而過期；
   身分比對（拿目前 `.env` 的值去 grep）不會。兩輪都要。
3. **它第一版噴了 27 筆假陽性**，原因是 `\s*=\s*` 讓比對跨過換行，把
   `NUXT_TMDB_API_KEY=`（空值）後面**下一行的變數名**當成了值——空值正是
   最該略過的情況，卻變成警報。改成 `[ \t]*=[ \t]*` 之後歸零。
   **一支每次都報 27 筆的掃描等於沒有掃描**（§7 #104 的同一個家族）。
4. 綠燈自己證明過：種一個**不可達**的假憑證 blob 進去（`git hash-object -w`
   只寫物件、不碰 ref），掃描以三條規則命中並標記 ⚠️不可達物件；移除後回綠。

## 6d. 覆蓋層（0012）—— 三件容易誤解的事

### ① 機制早就在了，缺的是安全的入口

`seed_films()` 的 **update 路徑**只碰三個欄位（`title_zh` 有 `title_zh_source='gov'`
的守門、`runtime_minutes` 是 `coalesce` 只補 NULL、`first_seen_roc_year` 是 `least`）；
`country` / `title_original` **只在 INSERT 那一支寫**。`apply_tmdb_snapshot()` 同理。

⇒ 直接 `update film set title_zh = …` 而忘了把 `title_zh_source` 一起改成 `'admin'`，
下一次重跑 seed 就洗掉了，**而且沒有任何錯誤訊息**。所以修正必須走
`admin_correct_film()`——它同時寫值與寫來源。

### ② venue 那一半比 film 糟，因為完全沒有保護

`seedVenues` 原本是 `db.from('venue').upsert(batch, { onConflict: 'id' })`
——**整列盲蓋**，涵蓋 name / company_name / hall_count / address / phone / city。
US-49/US-50 的影城更正一旦寫進去，下一次影城匯入就無聲消失，而回報者已經被
告知「已受理並修正」。

PostgREST 的 upsert **無法逐列決定要更新哪些欄位**，所以這個判斷必須在 SQL 裡。
已改成走 `seed_venues()` RPC，依 `venue.curated_fields`（人工接管的欄位名）逐欄位判斷。
⚠️ `status` / `selectable` / `sort_weight` / `closed_at` 本來就不在 upsert 的欄位
清單裡，所以「標記歇業」從來不會被洗掉——`curated_fields` 的 check 刻意只允許
那六個真的會被寫的欄位名，寫進 `status` 會讓人以為它受保護。

### ③ 那兩筆編碼損毀的修正**不會**跟覆蓋層打架

`利奧波德城（英國國家劇院現場）` 與 `Ｎ號棟鬧鬼` 的 `title_zh_source` 仍然是
`'gov'`（`fix-corrupted-titles.ts` 刻意保持，理由是「那真的是政府核准的片名，
我們只是把它修回來」）。看起來像是「下次 seed 會被洗回損毀字串」，**但不會**：
`c84965b` 之後 `src/gov/rating.ts` 在**解析階段**就套用人工對照表
（`isDefinitelyCorrupt ? (correction?.titleZh ?? '') : titleZhRawSource`），
所以重匯時流出來的本來就是修正後的片名；沒有對照的損毀則變成空字串，
`seed_films` 的 `nullif(…,'')` 讓它保留 DB 現值。兩條路都不會回退。

⚠️ 但如果日後有人用 `admin_correct_film()` 去改那兩筆，`title_zh_source` 會變成
`'admin'`，那一列就**永久脫離政府資料**。那是刻意的取捨，`admin_correct_film()`
的回傳值有 `detached_from_upstream` 讓 UI 可以把它講出來。

## 6e. 全期統計與平均線（0003）

### `user_year_stats` 本來就支援全期，不要另開一支

`p_year` 有 `default null`，`rec` 的條件是 `p_year is null or extract(year …) = p_year`。
實測全期：174 筆／133 部／250 張／13 年／全期多刷 19 部。
`by_year` 的加總與 `totals` 逐項吻合（174 筆、5x,xxx 元），而且與主 session 獨立
查到的年表數字（3/2/20/18/13/25/21/11/9/14/21/9/8）完全一致。

### 月度＝季節性（主 session 2026-09-06 裁決）

`/app` 與 `/u/` 一致。**不做 156 個月的時間序列**——走勢已經由年表在說，
而同一個名字的圖在兩頁有兩種語意會讓使用者以為資料錯了。

### 平均線：一個欄位餵兩個用途

`monthly_baseline` 是設計稿的「歷年每月平均」虛線，**不受 `p_year` 影響**
（來自未過濾的 `rec_all`）：

- 指定年份時 → 它是對照基準（「整年 N 場，比歷年平均的 X 場多／少」）
- 全期時 → 它與 `monthly` 同形狀，數值是平均

⚠️ **不要做成兩套計算。** 兩套一定會在某次修改後給出不一致的數字，而那種不一致
沒有人會發現——因為沒有人會把兩頁的數字擺在一起看。
`verify-core` 的 **H4** 就是釘這一條的（實測把基準線接到被 `p_year` 過濾的 `rec`
上會立刻紅）。

### 分母是**曝光數**，不是「有資料的年份數」（§7 #123）

從第一筆紀錄那個月到 `greatest(最後一筆, 今天)`，這個月份實際經歷過幾次。
David 實測：三月 13 次、一月 12 次（2014-01 在起點之前）、十月 12 次（2026-10 還沒到）。

⚠️ **這種錯誤守不住靠一致性斷言。** 驗 `avg = records / years_observed` 只驗到內部
一致——實測把分母一律改成 13，H1–H5 全綠而每個月的平均都偏。
守住它的是 **H6**：十二個月份的曝光加總必須等於觀測窗口的月份數（151），
分母寫成 13 會得到 156 而立刻紅。**這是一個與實作無關的不變量，不是實作的複本。**

### 效能：量過了

`explain (analyze, buffers)` 實測 2026-09-06（174 筆、片庫 2,764 部）：
**9.96 ms、shared hit 2,334**。`public.viewing_record` 在整支函式裡**只出現一次**
（`rec_all`），那 2,334 個 buffer 主要來自 countries／venues／repeats 對 `film` 的
join——那是**片庫大小**的函數，不是使用者紀錄數的函數。
⇒ 使用者長到一萬筆時這個數字不會跟著長十倍。
**改動時請維持「單一 rec_all、多次 group by」的形狀**；會爆掉的寫法是讓每組聚合
各自 join 回 `viewing_record`。

## 6f. verify:all 現在是 36 條，而且會自己吵

- **有 dev server：36 條全綠。沒有：25 條 + 1 略過（仍然綠）。**
  略過的那一行會寫明它守的是什麼（踩雷 #79），因為**被略過的斷言等於不存在**，
  不吵出來就會變成「常常被略過的那一條」。
- SSR payload 與 OG 的斷言住在 `scripts/verify-http.ts`，**兩個入口共用同一份**
  （`export runSsrAndOgChecks(reporter)`）。單獨跑那支仍然可以，它有
  `import.meta.url === pathToFileURL(process.argv[1]).href` 的入口守衛，
  被匯入時不會有副作用。
- **開頭會偵測 `supabase/migrations/**` 與 `scripts/**` 有沒有未提交的變更**，
  有就印一行警告。四個 session 共用一個工作樹，別人改到一半時這支會變紅，
  而紅的樣子跟自己造成的迴歸一模一樣——實測 adminui 就遇到過一次。
  刻意**不**阻止執行：那些變更多半無害，擋下驗收的成本比誤報高。

⚠️ **`verify-http.ts` 那一組守的是這個專案最貴的外洩**（踩雷 #79：@nuxtjs/supabase
把 session 寫進 useState、Nuxt 把 useState 序列化進 `__NUXT_DATA__`、ISR 以路徑
為單位快取 ⇒ 第一位登入者的 token 發給所有訪客）。它有一組**反向斷言**：
不快取的 `/u/**` 上**必須看得到** token——只驗「可快取路由沒有 token」的話，
中介層把所有路由都拔光也會全綠。

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
