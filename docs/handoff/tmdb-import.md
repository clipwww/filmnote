# 派工簡報 — tmdb-import（TMDB 直接匯入新上映作品）

> 號段 **#310–#329**（`BUILD_PLAN §7`，`836a378` 配發）。用完跟主 session 要下一段。
>
> ⚠️ **這一輪的權威來源是 `docs/BUILD_PLAN.md §8.3` 的「2026-09-20 David 的三則裁決」框
> （第 1 則）。先讀它的原文再讀這份。** 上一輪的派工簡報寫在 session 暫存區、已經消失；
> §8.3 那個框是**唯一倖存的那一份**，這份簡報只是把它展開成可執行的步驟。

---

## 0. ⚠️ 讀這份之前先搞清楚：有兩個叫「匯入」的東西

| | 是什麼 | 檔案 | 這一輪 |
|---|---|---|---|
| **個人紀錄匯入** | 使用者上傳自己的觀影紀錄（`6120d11`／`5ddbc97` 做了「限定本人」的閘門）| `/app/import`、`scripts/import-mylog.ts`、`src/import/**` | **完全不碰** |
| **TMDB 直接匯入新片** | 往**片庫**新增作品（seeding）| `src/tmdb/**`、`scripts/tmdb-new-releases.ts`、`seed_films()` | **就是這一輪** |

混掉會派錯工、也會誤讀 git log。你做的是**下面那一列**。

---

## 1. David 的裁決（§8.3 第 1 則，原文照抄要點）

TMDB 直接匯入新片時：
- `review_state` 一律 **`approved`**，不進審核佇列
- `origin` 必須是 **`'tmdb'`**
- `title_zh_source` 必須是 **`'tmdb'`**
- **並且要在 `seed_films()` 的 UPDATE 分支加一條**：政府資料日後帶著片名進來時，
  把 `title_zh` 與 `title_zh_source` **一起**翻成 `'gov'`

**代價 David 已經知道並接受**：片庫會出現**沒有在台灣上映過**的作品（TMDB 是全球片庫）。
⇒ 不要為此加審核、不要加「僅台灣」過濾，那是已裁決的取捨。

### 為什麼那一條「加在 UPDATE 分支」是整件事的關鍵
不加的話：`seed_films()` 的 `case when title_zh_source = 'gov'` 會讓官方片名**永遠寫不進去**，
而 `apply_tmdb_snapshot()` 每次快取更新還會把 TMDB 片名再寫一次
⇒ 那一列被**鎖死在群眾翻譯的名字上**，直接打穿產品的第一條價值主張（片名以官方核准名稱為準）。

---

## 2. 現況（主 session 查過，附行號，不要再用推的）

### 2.1 dry-run 已經做好了，這一輪是接著它做
`ac1e021` 已經交付「不動 DB 的那一半」：
- `scripts/tmdb-new-releases.ts`（146 行）、`src/tmdb/client.ts`（+30 行的挑片方法）
- **沒有任何 INSERT／UPDATE，連 service key 都不用**
- 跑法：**`pnpm tmdb:new-releases [--pages N]`**（主 session 已在派工前加好這個 script 名）
- 需要 `DATABASE_URL`（`:46-48`，直連 Postgres 抓片庫，缺了就 throw）與
  `NUXT_TMDB_API_KEY`／`TMDB_API_KEY`（`:68-70`）。⚠️ F1 說 `DATABASE_URL` 刻意只給本機腳本。

**首次實跑的數字（2026-09-20，`--pages 3`）**：
`now_playing` 60 ／ `upcoming` 34 ⇒ 去重後 **94 部**；
① 已收錄 **13** ② 疑似重複 **0** ③ 候選新增 **81**。

⚠️ **兩個會讓你看錯數字的地方**：`--pages` **預設是 5**（`:67`），上面那組數字是 `--pages 3` 的；
而 ③ 的清單**刻意只印前 40 筆**（`:136-139`）⇒ 首跑 ③ 是 81 部，**看畫面會以為只有 40 部**。

### 2.2 ★ 為什麼是三分類而不是「新／舊」兩分類
片庫有 **267 部 `origin='gov'` 的作品沒有 `tmdb_id`**（比對器沒配到，
例如《間諜家家酒》——片商用英文片名登記，見 `BUILD_PLAN §7 #F3` 那一段）。
⇒ **從 TMDB 盲目新增，那 267 部裡只要有一部也在清單裡就會變成重複作品。**

⚠️ ② 疑似重複實跑是 **0，而且從未有真實樣本走過那條路徑**（`ac1e021` 自己標了未驗證）。
那 267 部是 110–113 年的舊片，跟「現在上映中」本來就不重疊。
⇒ **不要把「② 是 0」讀成「那道檢查是對的」。** 跑 `upcoming` 更遠的日期、或加大 `--pages`
時它才會派上用場，而它**第一次真的命中就是第一次被驗證**。要它可信，得自己造一個已知樣本餵它。

### 2.3 TMDB 的 release_date 不是台灣上映日
清單端點回的是 TMDB 的**主要**上映日。台灣上映日要一部一次 `detail()`，
`ac1e021` 刻意不做、也刻意不把它印成「台灣上映日」。
⇒ 「台灣什麼時候算上映」這件事**政府核准資料才是權威**，不要在這一輪自己定義它。

### 2.4 `seed_films()` 的 UPDATE 分支現在長這樣
`supabase/migrations/0001_init.sql:612-616`：
```sql
update public.film set
  title_zh = case when title_zh_source = 'gov'
                  then coalesce(nullif(rec->>'titleZh',''), title_zh) else title_zh end,
  runtime_minutes     = coalesce(runtime_minutes, (rec->>'runtimeMinutes')::integer),
  first_seen_roc_year = least(coalesce(first_seen_roc_year, 9999), (rec->>'firstSeenRocYear')::smallint),
  updated_at = now() where id = fid;
```
INSERT 那一支（`:604-611`）已經用 `(coalesce(rec->>'source','gov'))::public.film_origin`
與 `'approved'`，而 `resolve_film('tmdb:' || tmdbId)` 去重也已經在（`:606`）。
⇒ **這條路在 schema 裡早就預留好了**（`film_origin` 列舉實測是 `('gov','tmdb','ugc')`，
`'tmdb'` 已存在，`0001_init.sql:19`）。

### 2.4.0 ★★ 裁決框要的 `title_zh_source='tmdb'`，現在的 INSERT 分支根本寫不出來
`seed_films()` 的 INSERT 欄位清單（`0001_init.sql:604-605`）是
`(tmdb_id, title_zh, title_original, country, runtime_minutes, first_seen_roc_year,
origin, review_state, visibility)` —— **`title_zh_source` 不在裡面。**
⇒ 它落回欄位預設值 **`'gov'`**（`0001_init.sql:252`）。

所以照現狀丟 `source='tmdb'` 進 `seed_films()`，結果是
**`origin='tmdb'` 但 `title_zh_source='gov'`** ——**與 §8.3 的裁決相反**，而且更糟：
① 群眾翻譯的片名從此被標記成「官方核准的」；
② UPDATE 分支那條 `case when title_zh_source = 'gov'` 變成**一直放行**。

⚠️ **裁決框只提了 UPDATE 分支那一條，這一條它沒提。** 兩條都要做。
**既有的正確寫法先例**：`scripts/import-mylog.ts:222-227` 的 `upsertTmdbFilm()`
顯式寫了 `'tmdb', …, 'tmdb', …, 'tmdb', 'approved', 'public'`。照它抄。

★ 順帶一個會誤導判斷的事實：**`origin='tmdb'` 分不出「TMDB 直接匯入的新片」與
「政府片配對成功」。** `src/pipeline/consolidate.ts:82` 寫的是
`source: outcome.matched ? 'tmdb' : 'gov'` ⇒ 只要政府核准的片配對到 TMDB，
`origin` 就已經是 `'tmdb'`。
⇒ **任何「只對 TMDB 直接匯入的片生效」的條件都不能只看 `origin`。**

★ `review_state='approved'` 其實不是選擇而是**唯一合法值**：表級 CHECK
`film_ugc_review`（`0001_init.sql:274`）是 `check (origin = 'ugc' or review_state = 'approved')`，
而 INSERT 已經寫死 `'approved', 'public'`（`:609`）⇒ §8.3 的這一半**早就成立**，不用做。

### 2.4.1 ★★ 那個 `case` 是 source-blind 的——它會讓 TMDB 蓋掉官方片名
看清楚 `case when title_zh_source = 'gov'` 檢查的是**那一列的**來源，
**不是進來的 `rec` 的來源**。INSERT 分支讀了 `rec->>'source'`，**UPDATE 分支完全沒讀。**

⇒ 推論一次：① 已收錄那 13 部是**已經有 `tmdb_id` 的 gov 作品**，
`resolve_film('tmdb:' || tmdbId)` 找得到它們 ⇒ 走 UPDATE 分支。
它們的 `title_zh_source` 正是 `'gov'` ⇒ **`case` 成立** ⇒
`coalesce(nullif(rec->>'titleZh',''), title_zh)` 把 **TMDB 片名寫進官方片名的位置**，
而且 **`title_zh_source` 還留著 `'gov'`** ⇒ 被蓋掉的值從此被標記成「官方的」。

⚠️ **這是 §8.3 要防的事情的反方向，而 §8.3 只講了其中一半。**
「政府片名進來時翻回 gov」是一半；另一半是「**TMDB 片名進來時不可以碰 gov 的片名**」。
兩半都要做，只做前者仍然會打穿第一條價值主張——而且**沒有任何錯誤訊息**。

### 2.4.2 ⚠️⚠️ 但**不可以**拿 `rec->>'source'` 當判別子——它的語意不是你以為的那個
最自然的修法是「看 `rec->>'source'` 是不是 `'tmdb'`」。**那是錯的，而且會造成更大的災難。**

`src/pipeline/consolidate.ts:82` 的原文是 `source: outcome.matched ? 'tmdb' : 'gov'`
⇒ `source` 的語意是「**比對器有沒有配到 TMDB**」，**不是「這筆片名是誰的」**。
政府管線送進 `seed_films()` 的**政府片名**，只要那部片配對成功，`source` 就是 `'tmdb'`
（活體約 2,401 列如此）。

⇒ 拿它當「是不是 TMDB 送來的」判準，**會把政府片名的更新路徑整條關掉**——
下一次 `pnpm seed` 會靜默停止更新那 2,401 部的官方片名。
⚠️ **而 §3.1 第一條斷言「`title_zh_source='gov'` 的列 `title_zh` 零差異」在那個壞法下正好是綠的**
（片名沒被蓋掉，因為根本沒被寫）⇒ **假綠燈**。這是 F5.4 的教科書案例。

⇒ **正確做法**：匯入路徑要自己帶一個**新的、明示的** payload 欄位
（例如 `titleZhSource: 'tmdb'`），新分支看**那個欄位 ＋ `title_zh_source`**。
沒有那個欄位時**必須維持現行行為**（政府片名照樣寫得進去）。
⚠️ payload 的契約是手寫 interface（`scripts/seed-supabase.ts:15-25`）⇒ **interface ＋ SQL 兩邊都要改**。

⇒ 你要先回答的問題：**你的匯入路徑會不會讓 ① 那 13 部走進 UPDATE 分支？**
（如果你的路徑只送 ③ 候選新增那 81 部，這個洞碰不到——但那要是**你驗證過的設計**，
不是碰巧。`seed_films()` 是全片庫的寫入路徑，它不知道誰呼叫它。）

### 2.5 ⚠️⚠️ `title_zh_source` 有四個值，而 `'admin'` 不可以被你的新分支覆蓋
`source_authority` 列舉是 **`('gov','tmdb','ugc','admin')`**（`0001_init.sql:20`）。

`0012_admin_corrections.sql:41-44` 的原文：
> ⚠️ 副作用要講明白：把 `title_zh_source` 設成 `'admin'` 之後，這一列就**永久脫離
> 政府資料的更新**。政府日後改了片名也不會同步過來。**這是刻意的取捨**，
> 而 `admin_correct_film()` 的回傳值會把它講出來，讓 UI 可以顯示。

⇒ **你的新分支必須只針對 `title_zh_source = 'tmdb'`，不可以寫成 `<> 'gov'`。**
寫成 `<> 'gov'` 會把 admin 人工修正過的片名在下一次 seed 時洗掉。

✅ **好消息：這件事有既有的斷言在守，你會被抓到。** `0012:321-346` 有一組冒煙測試
**會真的重跑 `seed_films()`**，admin 片名被洗掉就 raise，而且還附了一組對照組（`:337-346`）。
`0012:26-30` 自己就說明「`seed_films()` 的 update 路徑正是保護 `title_zh_source='admin'`
的機制」。⇒ 你改那條 `case` 的時候，**那組冒煙測試就是你的雙向自測**（§5.5）：
把條件寫寬一點應該讓它變紅，如果沒紅，是你的改動沒生效或那組測試沒跑到。

⚠️ `'ugc'` 那一類怎麼處理**沒有裁決**。§8.3 只講 TMDB 建的列。
⇒ **範圍嚴格限定 `'tmdb'`，`'ugc'` 寫進卡點問，不要自己擴大。**

### 2.6 F3 的主識別鍵撞擊：改 `tmdb_id` 要先刪舊鍵
`0017_fix_stub_tmdb_matches.sql:52-58` 記著：
`film_identity_sync` 觸發器插入 `tmdb:<新id>` 且 `is_primary = true`，**但不移除舊的那一列**，
而舊的也是 primary ⇒ 撞上 `film_identity_one_primary ON (film_id, kind) WHERE is_primary`
⇒ `link_film_to_tmdb` 直接丟 `unique_violation`。
⚠️ **`link_film_to_tmdb` 是 admin 端重新配對的唯一入口** ⇒ 任何修正配錯 id 的路徑都會踩到。
**解法照 `0017:63-73` 的既有手法**：先 `delete from public.film_identity` 舊的那一列，再 `link`。

### 2.7 其他查過的事實（會影響你的設計，不要再重查）
- **`seed_films()` 只認 service context**：`0001_init.sql:598` 的 `is_service_context()`
  （定義 `:60-66`，判 `session_user` ＋ JWT `role='service_role'`，**刻意不用 `current_user`**
  ——這個 repo 真的被打穿過一次），GRANT 只給 `service_role`（`9999_grants.sql:230-232`）。
  ⇒ 任何網頁入口都得先過 staff 判斷再取 `serviceSupabase()`（`server/utils/service-supabase.ts:16`）。
- **`film.tmdb_id` 是 UNIQUE**（`0001_init.sql:249`）且刻意 NULLABLE（實測 20% 台灣上映片
  TMDB 找不到）。而 **INSERT 分支沒有 `on conflict`** ⇒ 若某部片已有 `tmdb_id` 卻沒有對應的
  `film_identity` 列，去重會失手而直接吃 `unique_violation`，**整批回滾**
  （單一 simple-query 隱式交易，`scripts/db.ts:6`）。
- **有 `tmdb_id` 就一定有快照列，資料庫已經保證**：`0004:36-57` 的 `film_ensure_snapshot`
  觸發器（`after insert or update of tmdb_id`）⇒ 你不需要自己補快照列，但也不能假設沒有觸發器。
- **批次太大會撞 statement timeout**：`scripts/seed-supabase.ts:57` 的 `FILM_BATCH = 200`，
  `scripts/db.ts:37` 把 `statement_timeout` 設成 300 秒。`seed_films()` 是 plpgsql 迴圈。
- **payload 的欄位契約沒有 zod，只有一個手寫 interface**：`scripts/seed-supabase.ts:15-25`
  的 `FilmRow`，`source` 只宣告成 `string`（不是列舉）。要在 payload 加新欄位
  （例如 `titleZhSource`）就是**改那個 interface ＋ SQL 兩邊**。
- **`seed_films()` 的唯一生產呼叫端**是 `scripts/seed-supabase.ts:152`（`db.rpc`，批次 200）。
- **`apply_tmdb_snapshot()` 的唯一生產呼叫端**是 `server/utils/tmdb-refresh.ts:179`，
  由 cron（`server/api/cron/tmdb-refresh.get.ts`）每輪呼叫 ⇒ §1 講的「每次刷新再寫一次片名」
  是活的路徑，不是理論。
- **目前不存在任何「從 TMDB 新增作品」的網頁端點或後台 UI**。`server/api/admin/tmdb/`
  只有 `refresh`／`purge`／`status` 三支（`c431ab1`），全部只操作既有快照。
  ⇒ 卡點 #4 若放行，那是**全新的東西**，不是改既有的。
- **`verify:all` 開頭會偵測 `supabase/migrations` 與 `scripts` 有未提交變更並警告**
  （`scripts/verify-all.ts:679-689`）⇒ 看到那個警告是正常的，不是你弄壞了什麼。
- ⚠️ **一則過期註解**：`scripts/tmdb-backfill.ts:12-14` 寫著「沒有 `pnpm tmdb:backfill` 別名」，
  但 `package.json:31` 就有那一條。**規則（加 script 要核可）仍然有效，事實部分過期**。
  那個檔不在 §6.1 的足跡裡 ⇒ 要順手修它先回報。

---

## 3. ★★ 硬停點：這一輪**建好功能就停**，不要真的寫進 production

`BUILD_PLAN §7 F1`：**正式站指向同一顆 Supabase（David 的真實 174 筆），
沒有第二顆 production DB** ⇒ **任何 migration 與資料修正都是直接動線上資料。**

所以這一輪的交付邊界是：

1. 寫出 `seed_films()` 的新分支（新 migration 檔）
2. 寫出從 TMDB 候選清單走到 `seed_films()` 的匯入路徑
3. **用 dry-run 把「如果真的跑會發生什麼」攤成數字**：會新增幾部、會 UPDATE 幾部、
   其中幾部會觸發新的 gov 翻轉分支、有幾部落在 ② 疑似重複
4. **停下來回報，等主 session 放行。**

⇒ **不要自己套用 migration 到線上、不要自己跑真正的寫入。**
「建好功能」與「按下去」是兩件事，後者是 David 的決定。

### 3.1 冒煙斷言寫成「全表資料述詞」，不是 David-scoped 計數（F5.2）
上一輪的教訓：協調者給的分布數字全部帶著 `where email = …`，而 migration 改的是**整張表**。
⇒ 斷言要寫成「**不存在**符合 X 的列」這種資料述詞，
不要寫成「總數 = N」——後者在別人有合法資料時會變成**假紅燈**。

至少要有這四條（都是全表述詞）：
- **匯入前後，`title_zh_source='gov'` 的那些列，`title_zh` 零差異。** 守 §2.4.1 那個洞。
  ⚠️ **條件只能看 `title_zh_source`，不可以加 `origin='gov'`**——§2.4.0 證明了
  政府片配對成功之後 `origin` 就已經是 `'tmdb'`，加了 `origin` 條件會**漏掉大部分要守的列**。
  這正是 F5.4 那一類（斷言量錯了東西）；主 session 第一版就是這樣寫錯的。
  ⚠️ **這條必須配一組反向對照**：拿一列 `title_zh_source='gov'` 的政府列，餵一個新的政府片名進去，
  它**必須寫得進去**。沒有這組對照的話，「零差異」在 §2.4.2 那個壞法下也是綠的。
- **不存在 `title_zh_source='admin'` 卻被這次匯入改動過 `title_zh` 的列。** 守 §2.5。
- **匯入後，`origin='gov' and tmdb_id is null` 的列數必須仍是 267（不增加）**，
  且**這次新建的每一列，正規化後的 `title_zh`／`title_original` 都不得命中那 267 部裡的任何一列**。
  守 §2.2 的重複作品。⚠️ 比對邏輯 `scripts/tmdb-new-releases.ts:87-116` 已經有現成的可以搬。
  ⚠️⚠️ **不要寫成「不存在同一個 `tmdb_id` 對到兩個 `film_id`」**——`film.tmdb_id` 本來就是
  UNIQUE（`0001_init.sql:249`，活體 `film_tmdb_id_key` 確認過），真撞號會在 INSERT 當下
  丟 `unique_violation`，**那條述詞永遠是綠的、構造不出紅燈**，而且 §2.2 的重複裡舊那一列
  `tmdb_id is null`、**根本沒有共用的鍵可比** ⇒ 它抓不到它宣稱要守的東西。
  主 session 第一版就是這樣寫的，正是 #233「冒充的斷言比略過更糟」。
- **新匯入的列，`title_zh_source` 必須是 `'tmdb'`**（不是 `'gov'`）。守 §2.4.0。

**落點**：`scripts/verify-core.sql`。那裡的 **C2（`:206-224`）「政府核准的中文片名不得被
TMDB 蓋掉」已經在做同一族的事**——它抓一部 `title_zh_source='gov'` + `state='fresh'` 的片、
把快照片名改掉、跑 `apply_tmdb_snapshot()`，片名必須一個字都不變。
⚠️ 但 **C2 的取樣條件是 `f.title_zh_source = 'gov'` ⇒ 它選不到新匯入的片**。
**擴充 C2、不要另開一條孤立的檢查**（踩雷 #233：冒充的斷言比略過更糟）。

### 3.2 ⚠️ 讀 migration 檔 ≠ 讀 DB 裡活著的定義（踩雷 #189）
`supabase/migrations/0008` 與 `0010` 會在**執行時** `pg_get_functiondef()` 讀出
`seed_films()` 的原始碼、`replace()` 換掉一段字串、再 `execute` 回去（共三處）。
⇒ **`0001_init.sql` 裡的函式文字只是歷史。** §2.4 貼的那段也是歷史，
**你必須自己讀活體確認它現在長什麼樣**：
```sql
select pg_get_functiondef(p.oid) from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'seed_films';
```
⚠️ 這一條的代價是**靜默的**：拿舊定義推論「重跑 seed 會不會洗掉」，猜錯時資料被覆蓋
**不會有任何訊息、不會有任何測試變紅**。

✅ **這一輪查過了，可以直接用**：`0008:82-96` 與 `0010:47-62` 兩次改寫**都只動 INSERT 分支**
（`country`／`titleOriginal` 的 `coalesce`→`nullif`），**第 613 行那條 UPDATE 閘門兩次都沒被碰過**
⇒ §2.4 貼的那段 UPDATE 分支**就是線上現在跑的版本**。
但**你還是要自己讀一次活體確認**——這是方法問題，不是這一次對不對的問題。

### 3.3 ★★ 新 migration **不可以**用 `create or replace` 抄一份函式體
`0010:41-45` 明文記載了理由：**`0009` 就是這樣做的，結果靜默回退了 `0006` 的修正**，
而靜態檢查**全綠**，是 `verify-dmca` 才抓到的。
⇒ **必須沿用 `0008`／`0010` 的「讀出活體定義 → `replace` 字串 → `execute`」手法。**
這不是風格選擇，是這個 repo 踩過的坑。

⚠️ 用 `replace` 就代表**你要先確認那段字串在活體裡真的只出現一次、而且一字不差**。
`replace` 沒命中時 PostgreSQL 不會報錯，它會安靜地把原樣的定義寫回去
⇒ **migration 成功、改動沒發生**。所以要把**命中次數印出來**當斷言（這正是踩雷 #254 那一條）。

---

## 4. 其他硬性約束

### 4.1 查 DB 一律走 `pnpm db:sql`（踩雷 #253）
**不要自己開 pg client**：node-postgres 預設把 `date`／`timestamp` 解析成 JS `Date`、
`console.table` 再以 UTC 印 ⇒ `2016-09-28` 印成 `2016-09-27T16:00:00.000Z`，
上一輪差點據此回報「日期跟簡報對不上」。`scripts/db.ts:15-22` 的註解就是為這件事寫的。
⚠️ `scripts/tmdb-new-releases.ts` 不走 `db.ts`，所以它**自己套了同一道 date 解析器防護**
——你加欄位時那道防護要保持有效。

### 4.2 `src/**` 要給前端複用就不能有 `node:` import（踩雷 #130）
`pnpm build` 會是 **exit 0**，產物編成空物件，要等使用者操作到才炸，
訊息裡**沒有任何 `node:` 的線索**。檢查方式是 grep build log 的 `externalized`，
**typecheck 與 lint 都不會說話**。`import type` 不受影響。

### 4.3 `#pipeline/*` 要走 `nuxt.config.ts` 的 `alias`（踩雷 #80）
`package.json` 的 `imports` 別名在 Nitro 打包時**不補副檔名** ⇒ 執行期 `ENOENT`，
而 `typecheck`／`test`／`lint` **全綠**。同類錯誤本專案已發生三次。

### 4.4 `pnpm-lock.yaml` 必須跟 `package.json` 一起進版控（F1）
本機 install／dev／build／test／verify:all **沒有任何一個**會比對這兩個檔，
Vercel 的 `--frozen-lockfile` 會直接死在 install。
⚠️ 另一條線（records-ui）同時在跑。**要改 `package.json` 先回報**（§6.1 有一個預期的小改動）。

### 4.5 不要碰比對器的門檻
`matcher.ts` 檔頭記著《Fate/stay night》靠前綴配到系列第二部的事故。
F3 的結論是：**空殼條目與英文片名登記這兩件都不是比對器的 bug，是它照設計拒絕猜。**
⇒ 缺口用人工指定補（`0018` 就是），**不要調鬆門檻**。

### 4.6 註解慣例（`docs/CODE_STYLE.md`，32 行）
每則 ≤3 行，寫「為什麼」與「改了會怎樣」。
**量過的數字與「改了 X 會壞 Y」不可以蒸發**——搬進 `docs/`，程式裡留一行指標。
SQL 檔裡 `0012`／`0017` 那種**解釋取捨的長註解是這個 repo 的迴歸防線**，不要為了短而砍掉。

---

## 5. 驗證

### 5.1 四關 + verify:all
`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm verify:all`。
⚠️ **四關全綠看不到的東西在這一輪特別多**：#80（別名）、#130（`node:`）、#189（活體定義）
三條全部都是「四關綠但東西不會動」。四關是門檻，不是驗收。

### 5.2 指定 David 的資料用 `.env` 的 `IMPORT_TARGET_EMAIL`
**不要用 git 署名的那個信箱**（`david.chien@athena.com.tw`）——那是 commit 署名，
跟登入信箱是不同的兩個，拿它去查會得到 **0 筆而不是錯誤**。
所有腳本都用 `--env-file=.env`；**值不要寫進版控**（repo 是 public）。
⚠️ 但這一輪的主體是**全片庫**，不是 David 的 174 筆 ⇒ 見 §3.1。

### 5.3 造測試資料一律 `zz` 前綴，驗完立刻刪，刪後複查基準
片庫基準**兩個數字都要對一次**（主 session 實測，2026-09-21）：
`select count(*) from public.film` = **2,764**；其中 `merged_into_film_id is null` = **2,748**
（dry-run 印的是後者，差的 16 部是已合併的 UGC 作品）。
`origin` 分布：`tmdb` 2,480／`gov` 268／`ugc` 16，其中 **267 部 `origin='gov'` 沒有 `tmdb_id`**。
⚠️ 只記 2,748 而拿它去對 `count(*)`，會得到一個 **16 列的假差額**。
⚠️ 你量到的跟這裡不同就**先回報**，不要當成 `zz` 殘留去刪。

### 5.4 ★★ 先讀 `BUILD_PLAN §7.6`「檢查機制本身會失效」整節（#230–#244）
那一節收的就是「斷言存在、名字也對，但**它守的不是它宣稱要守的東西**」那一類。
節前的導言自己就列了要一起讀的既有條目，其中**兩條是你這一輪的核心**：
**#189**（讀 migration 不等於讀活體，見 §3.2）與 **#165**（跨層的欄位要有跨層的斷言）。

與你直接相關的四條：

- **#230** ★★ 突變測試（「故意弄壞它看會不會紅」）**本身有四種自壞法**，而每一種看起來
  都像「這條斷言沒有鑑別力」。其中一種：第一版用了 `vitest run --reporter=basic`，
  而 **vitest 5 沒有 `basic` 這個 reporter** ⇒ 每次都 exit≠0，8 個變異**全部漂亮地報 RED**。
  ⇒ 你要弄壞 §3.1 那三條冒煙述詞來自測時，先確認你的跑法本身是對的。
- **#231** ★★ 字串比對斷言的**四種假綠與一種假紅**，病根都是「錨點沒有落在它宣稱要守的
  東西上」。⇒ 你的冒煙述詞如果是 grep SQL 檔的字串，那就是這一族；**要走資料，不要走字串**。
- **#233** ★ **冒充的斷言比略過更糟**——驗證項的名字必須說得出它守的是什麼。
  ⇒ 不要寫一條叫 `tmdb/no-gov-title-clobber` 但實際上在比別的東西的檢查。
- **#240** `grep -r` 在這個 shell **看不到 `.env`** ⇒ 任何拿 `grep -r` 證明 `.env` 狀態的
  斷言都是假的（實測 `grep -rn` 回 4 個檔、`.env` 不在裡面）。

### 5.5 ★ 每一支你寫的檢查器，先餵已知答案雙向自測（踩雷 #254／#260）
未改動 → 綠、故意改一行 → 紅。**兩個方向都跑過才可以引用它的輸出。**
⚠️ `#254`：macOS 的 **BSD `sed` 不支援 `\b`**，上一輪「故意弄壞」根本沒改到檔、測試照樣綠。
每個弄壞法都要附一個「改完之後確實變成什麼樣」的數字（例如印出替換命中次數）。
⚠️ `#260`：上一輪連用四支壞掉的檢查器才答對一個問題。**檢查法本身要先證明它真的在檢查。**
⇒ 這一輪最該被自測的是「新分支會不會洗掉 admin 修正」那條斷言（§2.5）。

### 5.6 不要打正式站驗收（這一輪用不到，真的要用先確認 Ready）
踩雷 `#255`：**部署進行中的 Vercel 站會用舊版回應，而且回 200。**
⚠️ 本機 `vercel` CLI **沒有安裝**（主 session 實測 `command -v vercel` 無結果）
⇒ `vercel ls` 這條配方現在跑不動。真的需要就回報，不要自己 `npm i -g`。
⚠️ **絕不可 `vercel deploy --prebuilt`**（踩雷 #108）：本機 `.output/server/package.json`
釘的是 `@resvg/resvg-js-darwin-arm64`，送上 linux 會讓 OG 端點 500。讓 Vercel 自己建。

---

## 6. 足跡與共用 checkout

### 6.1 你的
```
src/tmdb/**
scripts/tmdb-new-releases.ts
scripts/<你新增的匯入腳本>
scripts/verify-core.sql               ← §3.1 的冒煙述詞落在這裡（擴充 C2，:206-224）
supabase/migrations/0019_*.sql        ← 下一個編號（現況最大是 0018，另有 9999_grants）
docs/handoff/tmdb-import.md           ← 這份，收工時你自己更新
```
**條件例外**（只有在對應卡點被放行之後才可以動，否則視為禁寫）：
```
app/pages/admin/-TmdbMaintenance.vue  ← 只在卡點 #4（後台觸發入口）放行後
server/api/admin/tmdb/*.post.ts       ← 同上；既有三支見 c431ab1，照它的形狀
app/types/database.types.ts           ← 只在卡點 #1（真的 apply migration）放行後
```
⚠️ **這四個都落在 §6.2 的封鎖區裡**，寫成條件例外是刻意的——
**deny 優先於 glob**，沒有放行就是不能動。

✅ **這一輪預期不需要重跑 `pnpm db:types`**：§3 規定不套 migration 到線上，
而 F1 說只有一顆 DB ⇒ `db:types` 讀到的 schema 不變，`database.types.ts` 實際是凍結的。

✅ **新增 `0019` 不需要同步 BUILD_PLAN**：`scripts/sync-schema-docs.ts:25-63` 的 SECTIONS
只收 `0001`／`0002`／`0003`／`9999`。（但改 `0001_init.sql` 會被那支擋，所以別改它。）
✅ **`package.json` 你完全不用碰。** 主 session 已經在派工前把
`"tmdb:new-releases": "tsx --env-file=.env scripts/tmdb-new-releases.ts"` 加好了
⇒ 直接 `pnpm tmdb:new-releases [--pages N]`。
（`scripts` 區塊的增刪不會改動 `pnpm-lock.yaml`，所以這一步沒有 F1 的風險。）
⇒ **`package.json` 從此對兩條線都是唯讀。** 真的需要新依賴就是卡點，
由主 session 在兩條線都靜止時執行 `pnpm add`，並把 `package.json` ＋ `pnpm-lock.yaml`
放在**同一個 commit**（F1）。**不要自己跑 `pnpm add`**：兩邊同時跑會產生兩份互不相容的
lockfile，而本機 install／dev／build／test／verify:all **沒有任何一關會發現**。

### 6.2 要讀、但**不要寫**
`src/pipeline/**`（`ingest-rating.ts` 是政府資料那條路）、`src/import/**`（§0 那個另一個匯入）、
`app/**`（整個前端這一輪都是 records-ui 的）、`nuxt.config.ts`、`pnpm-lock.yaml`、
`scripts/verify-all.ts`、`eslint.config.js`、`.omc/project-memory.json`
⇒ 真的必須動其中任何一個：**先回報，不要自己決定**。

### 6.3 ⚠️ 兩條線共用同一個 checkout
另一條線 **records-ui** 同時在跑（`app/pages/app/records/**`、`app/composables/useRecord*`）。
上一輪有先例：`1004076 fix(import): 還原 bbf5617 被 eslint --fix 改掉的兩個 NuxtLink`
——**一條線的 `--fix` 掃到了另一條線的檔**。硬性條款：

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

**這一輪你不需要 `pnpm dev`**（沒有前端工作）⇒ 不要開 dev server。
踩雷 `#241`：`127.0.0.1:3000` 回 200，但那是**另一個專案**的站——
port 被別人佔著時你量到的東西不是你以為的那個。

---

## 7. 回報

每個回合結束（完成、卡住、需要決定皆然）用 `━━ 回報 ━━` 那個格式收尾
（你的 auto-memory 裡有 `session-report-protocol`，照那份寫）。
**不要報喜不報憂**：繞路、驗證沒過、發現簡報有誤都要寫進去。

⚠️ **這一輪的回報要特別誠實區分「建好了」與「驗過了」。**
上一棒的 `F7` 只有一句教訓：**一個「成功／失敗」的回報，可能對應兩種相反的事實。**
`seed_films()` 的改動如果只是「migration 檔寫好了」，那就寫「未套用、未驗證」，
不要寫成「完成」。

### 收工前
1. 把「量過的數字」與「改了 X 會壞 Y」寫進 `docs/handoff/tmdb-import.md`。
2. ⚠️ **新踩雷先寫在這份交接的最後一節，用你的 #310–#329 編號，但不要自己動
   `docs/BUILD_PLAN.md`。** 兩條線同時往 §7 的同一張表尾端加列**一定會 git 衝突**
   （§7.6 的表尾是兩邊都要加的地方）。⇒ **由主 session 合併**。
   號段是你的、編號由你決定，只是**落點由主 session 放**。
3. `BUILD_PLAN §8.3` 第 1 則那個裁決框做完之後要更正狀態，**但不要自己動那個檔**
   （同第 2 點）。把「§8.3 該改成什麼」的文字寫進這份交接，**落點由主 session 放**。
   ⚠️ **不要刪掉它的理由**——那是唯一倖存的權威來源。
   而且這一輪你已經找到**裁決框漏掉的那一半**（§2.4.0 的 `title_zh_source` 沒被寫），
   那件事一定要寫進去。

---

## 8. 這些不要自己決定，寫進「卡點」

1. **★ 這一輪要不要真的把 migration 套用到線上、真的跑一次匯入**（§3）。
   建好 ＋ dry-run 數字 ⇒ 停 ⇒ 回報 ⇒ 等放行。
2. **`title_zh_source = 'ugc'` 的列要不要也被 gov 翻轉**（§2.5）。§8.3 沒裁決。
3. **一次匯入幾部。** dry-run 說候選新增 81 部，全進去等於片庫多 3%
   而且其中有「沒在台灣上映過」的作品。要不要分批、要不要先挑一小批試，是 David 的事。
4. **要不要在 admin 後台加一個觸發入口**（`c431ab1` 已有 TMDB refresh/purge 的先例），
   還是這一輪只做 CLI。
5. ~~② 疑似重複那條檢查要怎麼驗~~ **這一條不是卡點，這一輪就要做完。**
   ② 的分類是**純 JS 且 DB 只讀**（`scripts/tmdb-new-releases.ts:87-116`）
   ⇒ **在 TMDB 那一側注入合成樣本就驗得到，不需要寫入片庫**，跟第 1 點無關。
   做法：取一部 `tmdb_id is null` 的既有作品片名當樣本，驗它落進 ②；
   再取一個不存在的片名當反向對照，驗它落進 ③。
   ⇒ §2.2 那條「從未有真實樣本走過」這一輪就可以結掉。
6. 任何需要改 `package.json` dependencies／`nuxt.config.ts`／`src/pipeline/**` 的事。

> 過度指定跟指定不足一樣會造成返工（F5.3）。上面沒寫死的地方就是留給你判斷的，
> 做了什麼、為什麼，寫進回報就好。

---

# 9. 第六棒交付（2026-09-21）——建好了，**一個字都沒寫進線上**

> 三個 commit：`ebd9cbf`（0019）／`8a43882`（匯入路徑）／`c2e4a37`（C2 擴充）。
> **狀態：功能建好、在 rollback 交易內演練過；migration 未套用、匯入未執行。**
> §3 的硬停點照做，卡點 #1／#3 等 David 放行。

## 9.1 ★★ 裁決框漏掉的那一半（§8.3 第 1 則要補的文字）

**主 session 請把下面這段放進 `BUILD_PLAN §8.3` 第 1 則**（我照 §7 收工規則不自己動那個檔）：

> 【2026-09-21 補】這則裁決要改的是 **兩條**，原文只寫了 UPDATE 分支那一條：
> ① `seed_films()` 的 **INSERT 分支欄位清單裡根本沒有 `title_zh_source`**
> （`0001_init.sql:604-605`）⇒ 落回欄位預設值 `'gov'`（`:252`）。照原狀丟
> `source='tmdb'` 進去，結果是 `origin='tmdb'` 但 `title_zh_source='gov'`
> ——**與本裁決相反**，而且群眾翻譯的片名從此被標記成「官方核准的」，
> 同時讓 UPDATE 分支那道 `case when title_zh_source = 'gov'` 一直放行。
> ② UPDATE 分支那個 `case` 是 **source-blind** 的：它檢查的是**那一列既有的**來源，
> 不是進來的 `rec` 的來源 ⇒ TMDB 片名會直接寫進 `title_zh_source='gov'` 的作品。
> 「政府片名進來翻回 gov」只是一半，另一半是「**TMDB 片名進來時不可以碰 gov 的片名**」。
> 兩條都在 `0019_seed_films_title_zh_source.sql`，**狀態：未套用**。
> ★ `review_state='approved'` 那一半本來就成立（表級 CHECK `film_ugc_review`
> ＋ INSERT 已寫死），不需要做。

## 9.2 量過的數字（都是實測，不是推的）

| | 值 | 怎麼量的 |
|---|---|---|
| 片庫 `count(*)` ／存活 | **2,764** ／ **2,748** | `pnpm db:sql` |
| `origin` 分布 | tmdb 2,480／gov 268／ugc 16 | 同上 |
| `origin='gov'` 且無 `tmdb_id` | **267** | 同上 |
| `title_zh_source` 分布 | **gov 2,669／tmdb 79／ugc 16／admin 0** | 同上 |
| `title_original_source` 分布 | **tmdb 2,764（全部）** | 欄位預設值就是 `'tmdb'`（`0001:252`）|
| 有 `tmdb_id` 卻沒有對應 `film_identity` 列 | **0** | §2.7 那個 `unique_violation` 地雷目前沒有觸發條件 |
| dry-run `--pages 3` | 去重 94；①13 ②0 ③**81** | 與上一棒首跑一致 |
| dry-run `--pages 5`（預設） | 去重 130；①14 ②0 ③**116** | |
| 候選中會走 UPDATE 分支的 | **0**（兩種 pages 都是） | 逐筆 `resolve_film('tmdb:'||id)` |
| 會觸發 0019 gov 翻轉分支的 | **0** | 翻轉只在**政府**片名進來時發生，匯入送的全是 TMDB 片名 |

### ★ 0019 對**今天既有資料**的影響半徑（David 放行前要看的就是這個）
- 會被新的翻轉分支碰到的，只有 `title_zh_source='tmdb'` 的 **79 列**（全部是
  `import-mylog.ts` 的 `upsertTmdbFilm()` 建的，`origin` 也都是 `'tmdb'`）。
- 那 79 列**沒有任何一列**有 `gov:` 的 `film_identity` 鍵（實測 0 列）。
- 政府管線還會用 `tmdb:` 鍵當後備去 resolve ⇒ 真正的判準是「`.data/films.json`
  的 2,669 筆裡有幾筆 `tmdbId` 命中那 79 個」。**實測：0 筆。**
- ⇒ **套用 0019 之後的下一次 `pnpm seed`，會被翻轉的列數是 0。**
  這個數字會隨政府資料更新而變，不是永久保證。

## 9.3 改了 X 會壞 Y

- **判別子改用 `rec->>'source'` ⇒ 政府片名的整條更新路徑會靜默關掉。**
  那一欄的語意是「比對器有沒有配到 TMDB」（`consolidate.ts:82`），政府片名只要配對
  成功它就是 `'tmdb'`（活體 2,480 列）。⚠️ **而且 §3.1 第一條斷言在那個壞法下正好是綠的**
  ——所以 `C2f` 的反向對照（政府片名必須寫得進去）是**必要的**，不是裝飾。
- **新分支寫成 `title_zh_source <> 'gov'` ⇒ 洗掉 0012 的 admin 人工修正。**
  0019 有一條後置條件專門擋這個字串；冒煙的 U5／U6 也擋。實測把它改寬 → U5 紅。
- **0019 沒套用就跑匯入 ⇒ `origin='tmdb'` 但 `title_zh_source='gov'`，不會報錯。**
  匯入腳本的閘門 ① 會擋下 `--apply`（實測會擋）。
- **候選走進 UPDATE 分支 ⇒ `first_seen_roc_year` 被寫成 9999。**
  `least(coalesce(first_seen_roc_year, 9999), null)` 在 `least` 忽略 NULL 時回 9999。
  政府管線永遠帶著 `firstSeenRocYear` 所以碰不到；匯入腳本沒有 ⇒ 閘門 ② 直接拒絕寫入。
  ⚠️ **這是既有行為，0019 沒有改到它。** 日後若有人讓既有列走這條路要先修它。
- **`seed_films()` 的 INSERT 從不寫 `release_year`。** 由 cron 的 `apply_tmdb_snapshot()`
  之後補上。新匯入的片在第一次快取刷新前沒有年份——不是 bug，但畫面上會空著。
- **`$body$` 緊貼 `$fn$` 會產生 `$$`，把外層的 `do $$` 提前關掉。** 在 `verify-core.sql`
  真的踩到了（`syntax error at or near "fn$"`）。巢狀 dollar-quote 之間要留空白或換行。

## 9.4 驗證做到哪（誠實區分）

**已驗**（全部在 `begin/rollback` 交易內，或純 JS）：
- 0019 的九格冒煙矩陣全綠；**突變三發全紅且紅在正確的斷言上**
  （翻轉條件放寬成 `<> 'gov'` → U5；UPDATE 分支不改 → U1；INSERT 分支不改 → I1）。
- **0012 自己的冒煙測試對著改寫後的 `seed_films()` 仍然通過**（admin 修正撐過重跑匯入，
  且它自己的對照組也綠）。
- `verify-core.sql` 的 C2b–C2f：0019 未套用 → 略過且全綠；0019 套用（rollback 內）→
  真的跑且全綠；**突變兩發**（只改 INSERT → C2b 紅；只改 UPDATE → C2d 紅）。
- `classifyReleases()` 8 條單元測試（含反向對照）；**突變兩發**
  （索引永遠空 → 4 紅；有 `tmdb_id` 的也進索引 → 1 紅），還原後複查全綠。
- 四關：`typecheck` ✅／`lint` ✅（0 error）／`test` ✅ 532 條／`build` ✅ exit 0
  且 build log **沒有 `externalized`**（§4.2）。`verify:all` ✅ 0 失敗。
- 片庫基準收工複查：`count(*)`=2,764、存活 2,748、`zz`／`__verify__` 殘留 **0**、
  `seed_films()` 活體**仍然不含 `titleZhSource`**（= 0019 確實沒被套用）。

**未驗**（不要當成已驗）：
- **0019 沒有套用到線上**，所以「套用之後線上真的長那樣」沒有驗過。
- **`--apply` 的寫入路徑一次都沒有執行過。** 只驗到它的**兩道閘門會拒絕**
  （`--apply --limit 0` 實測被閘門 ① 擋下；那個組合無論閘門對錯都不可能寫入）。
  `seed_films()` 真的被 `--apply` 呼叫、真的 commit 的那條路徑**未驗**。
- **② 疑似重複在活體上仍然是 0 筆**。合成樣本證明了那段判斷會動（卡點 #5 結掉），
  但「真實的 TMDB 清單命中一部既有孤兒」這件事**還是沒發生過**。
- ⚠️ `pnpm verify:all` **中間有一次**跑出 58 通過／1 略過（`沒有 .output`）而不是 60/0/0
  ——那是 §6.4 講的共用產物：另一條線同時在 build，`.output` 當下不存在。
  **不是斷言變紅**（0 失敗），`.output` 回來之後重跑即為 **60／0／0**。
  ⇒ §6.4 是真的，共用 checkout 下「略過」的數字會自己跳動，要重跑才算數。

## 9.5 新踩雷（#310–#329 號段，落點由主 session 放進 `BUILD_PLAN §7.6`）

- **#310 ★★ 裁決框可以是對的，但**不完整**。** §8.3 第 1 則說「`title_zh_source` 要是
  `'tmdb'`」，但沒說 `seed_films()` 的 INSERT 分支**根本寫不出那個欄位**。照字面執行
  會得到與裁決相反的結果，而且沒有錯誤訊息。⇒ **裁決落地前要先確認「照它做」在現有
  程式碼裡真的做得到**，不要假設裁決者查過實作。
- **#311 ★★ 「同一個字在兩層是兩個意思」比錯字危險。** `rec->>'source'` 在管線裡的語意是
  「比對器有沒有配到 TMDB」，在直覺上卻像「這筆資料是誰送的」。拿它當判別子會靜默關掉
  政府片名的更新路徑，**而且主要的那條斷言在那個壞法下正好是綠的**。
  ⇒ 跨層的判別子要用**新的、明示的**欄位，不要複用語意相近的舊欄位；
  而且要配一條「該寫的必須還寫得進去」的反向對照才擋得住那個假綠燈。
- **#312 巢狀 dollar-quote 相鄰會產生 `$$`。** `$body$$fn$` 裡的 `y$` + `$f` 就是 `$$`，
  外層的 `do $$` 被提前關掉，錯誤訊息（`syntax error at or near "fn$"`）指向的位置
  跟原因無關。⇒ 巢狀 dollar tag 之間留換行。
- **#313 「安全地證明閘門會擋」有辦法。** 想驗 `--apply` 的拒絕邏輯又不能真的寫入時，
  挑一組**無論閘門對錯都不可能寫入**的參數（這裡是 `--limit 0`：閘門壞掉時
  `rows.length === 0` 也不會寫）。⇒ 驗到了拒絕，且沒有把線上資料押上去。
- **#314 verify 新增的斷言要對「還沒套用的 migration」自動略過。** 不然共用 checkout 的
  另一條線跑 `verify:all` 會吃到一片紅燈，而那片紅燈是對的、卻不是他們的事。
  ⇒ 以**活體函式定義**當開關（`pg_get_functiondef() like '%新欄位%'`），notice 略過、
  不計入 fails。

## 9.6 我碰了但不在 §6.1 足跡裡的兩個檔（回報用，沒有自作主張改別的）

- `scripts/seed-supabase.ts` — 只加了 `FilmRow.titleZhSource?: 'gov' | 'tmdb'`。
  §2.4.2 與 §2.7 明講「interface ＋ SQL 兩邊都要改」，但 §6.1 的足跡沒列這個檔。
  **判斷是意圖明顯**（契約的另一半），改動是一個 optional 欄位＋註解，沒有行為變化。
- `tests/tmdb-classify.test.ts` — 卡點 #5 要求這一輪把 ② 驗完，而 §6.1 沒列 `tests/`。
  新檔，不動既有測試。
⇒ 兩個都請主 session 確認；要退掉的話各自是一個獨立的小 revert。

## 9.7 卡點（等 David）

1. **要不要套用 0019 到線上、要不要真的跑匯入。** 兩件事分開：
   套用 0019 **本身不會改任何一列資料**（只換函式定義），且對下一次 `pnpm seed`
   的影響半徑實測是 **0 列**（§9.2）。真正改資料的是後面那次 `--apply`。
2. **`title_zh_source='ugc'` 要不要也被 gov 翻轉**（活體 16 列）。§8.3 沒裁決，
   0019 維持現狀（不碰）。
3. **一次匯入幾部。** `--pages 5` 的候選是 **116 部**（片庫 +4.2%），`--pages 3` 是 81 部。
   腳本有 `--limit N` 可以分批。其中含「沒有在台灣上映過」的作品——那是已裁決的取捨。
4. **要不要做 admin 後台的觸發入口。** 這一輪只做 CLI，沒有碰 `app/**` 與
   `server/api/admin/tmdb/*`（那兩個在 §6.1 是條件例外，卡點沒放行就是禁寫）。
5. **`title_zh_source='tmdb'` 的列 + TMDB 片名進來**這一格（U4）目前維持現狀「不更新」。
   沒有裁決。要讓 TMDB 匯入的片跟著 TMDB 改名的話，這一格要改成放行。
