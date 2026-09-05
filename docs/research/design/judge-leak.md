# judge-leak

### 提案 1：rls-first：5/10

時區：三案中第二好。只存 timestamptz，僅在 user_year_stats 用 `at time zone 'Asia/Taipei'` 轉換。具名時區 = DST 安全、不硬編偏移、零重複、加欄位不用重算。代價只是年份過濾走不到索引——在數千列規模完全無感。

主要維護負擔：欄位級 GRANT。6 張表逐欄列舉 insert/update 權限，代表每加一個欄位都要改三個地方（表、grant、guard trigger），而漏掉的失敗模式是 PostgREST 回一個沒有上下文的 403——一個人 debug 這個會很痛。這是整份設計裡持續課稅最重的一項，對「個人＋少數朋友」的威脅模型幾乎沒有收益。

規模不匹配：約 25 支函式、10 個 trigger、獨立 app schema、6 支 admin RPC、稽核表、DMCA 三表、雙 bucket。而雙 bucket 的搬檔步驟根本沒實作（自己也承認海報會 404）——加了複雜度但沒把它做完，比不加更糟。第一位管理員還得手動跑 SQL。

自稱的 fail-closed 有洞：`alter default privileges ... revoke all on functions from anon, authenticated` 是無效的——Postgres 函式的預設 EXECUTE 授予的是 PUBLIC，不是 anon/authenticated。「日後新增的函式預設不可執行」這個保證不成立。表格那條 revoke 才有效，但也依賴 migration 以設定 default privileges 的同一個 role 執行。

加分：複雜度多半是宣告式的，沒有需要持續對帳的鏡射欄位；film_public_requires_approval 用一條 CHECK 取代一堆 trigger 邏輯；第 12 節的上線前自我檢查（全表 RLS、view 必須 security_invoker）只有 20 行卻擋掉兩種最致命的失誤；export 用 SECURITY INVOKER 是正確直覺。單檔交易式 migration、seed 完整。

結論：安全模型本身是三案最紮實的，但為朋友圈規模的 app 付了企業級的日常成本。砍掉欄位級 grant、app schema、雙 bucket 與一半 admin RPC，這份會是 8 分。

### 提案 2：query-first：3.5/10

優化了唯一不重要的那條軸。作者自己算出「重度使用者一年 100–300 筆，二十年數千列」，然後為此蓋了 6 個 stored generated column、一條 INCLUDE 七欄的覆蓋索引、兩個 materialized view、pg_cron 每 10 分鐘 REFRESH CONCURRENTLY、以及一支 200 行的 jsonb 統計 RPC。數千列就算 seq scan 也是微秒級。這些全部是純成本。

時區：技術上正確，工程上最貴。`at time zone interval '8 hours'` 確實 IMMUTABLE（那張 volatility 對照表本身很有價值，值得留存），但代價是同一段運算式在 5 個欄位重複書寫、硬編 UTC+8、要改就得 rewrite 整張熱表並重建全部索引、海外觀影被記成台北牆上時間。用最複雜的路徑換一個沒人需要的 index-only scan。

三個 fail-open 的鏡射欄位是最大的維護炸彈。film_public（預設 true）、public_listed、cost_public 由 5 個 trigger 維護，而 RLS 述詞直接讀它們。任何繞過 trigger 的路徑、或 trigger 漏掉一個入口，失敗方向都是外洩。作者自己說需要「一支定期對帳查詢」——那支查詢不存在。一個人維護三條跨表鏡射的一致性，這是最容易在半年後爆掉的東西。

pg_cron + MV 在免費方案上是錯的組合：免費專案閒置會暫停、cron 不跑、MV 變舊；而且要先去 Dashboard 手動開 extension，migration 才跑得起來——已經不是「可一次跑完」的檔案。cron.schedule 重跑的行為也沒處理。

具體缺漏：venue_id_matches_kind CHECK 強制非影城必須是 virtual:<kind>，但整份 SQL 沒有 insert 那四筆 virtual venue。US-7（串流／影展／家中）在 MVP 第一天就是壞的。

那支 RPC 是 UI 耦合的長期債：七張圖的形狀寫死在 SQL 裡，改一個維度就要寫 migration，前端拿到無型別 jsonb，INCLUDE 索引也得跟著重建。

值得保留的：不對 SELECT 做欄位級 revoke（會讓 select=* 直接 403）這個判斷是三案中最務實的；(select auth.uid()) 包裝是一行成本的正確做法；基礎表結構本身最貼近標準 Supabase 慣例、最好讀。

### 提案 3：evolution-first：6.5/10

時區處理是三案最好的，而且是靠避開問題而不是解決問題。watched_on date + watched_time time + tz。觀影紀錄記的本來就是「那天晚上」這個牆上時間，貢獻圖與時段熱力圖不需要任何時區換算、不需要 IMMUTABLE 體操、不會為只有日期的舊資料捏造假的 00:00。對這個 domain 這是正解，而且最簡單。tz 欄位目前是裝飾品，但佔位成本為零。

複雜度多半是「惰性」的，這是關鍵差別。20 張表看起來最多，但 subscription / entitlement / legal_document / import_run 是不需要日常維護的靜態表——放著不動不會壞，不想要就 drop。相對地，提案 2 的三個鏡射欄位、提案 1 的欄位級 grant 是每次改 schema 都要付錢的活成本。惰性複雜度 < 活性複雜度，這一條決定了排序。

Migration 可重跑，對一人開發最友善：全程 create table if not exists / drop policy if exists / on conflict do nothing，pg_cron 用 do $$ ... exception 包起來並印 notice 而不是讓整份 migration 死掉。seed 完整（虛擬場所、播放版本、保留字）。

但那個 enum DO block 是陷阱：所有 create type 擠在同一區塊、共用一個 exception when duplicate_object then null。第一個 duplicate 就會 abort 整個 block，後面的型別全部不會建立——日後在清單裡加一個新 enum 再重跑，它會被靜默跳過。應該一個型別一個 DO block。

RLS 效能是三案最差（但也最好修）：helper 函式全部沒包 (select ...)，cost_read 一條 policy 最多逐列呼叫 4 次 SECURITY DEFINER。300 列 = 1200 次函式呼叫，在這個規模仍是毫秒級，改法是加括號、一行的事。相對地提案 2 為了同樣的問題引入三個鏡射欄位——用永久的一致性風險換一個目前不存在的效能問題。

過度設計的部分：付費／entitlement 兩表 + enum + 函式，為了「結構上讓付費牆碰不到海報」——這是理論純度，一行註解就夠了。business_days_after() 是 plpgsql 迴圈，服務一條大概永遠不會用到的 §90-9 流程。film_identity 則是唯一真正付得起自己成本的未來性設計：這個專案的匯入管線就是確定性鍵、gov 片日後比對到 TMDB 是必然事件，沒有它每次合併都要動 viewing_record 的 FK。

其他務實決定：沒有欄位級 grant（用 guard trigger 取代，加欄位只改一處）；取下是狀態不是 DELETE；單一公開 bucket（對朋友圈規模夠了，比提案 1 那個沒實作完的雙 bucket 好）；RLS 用即時 EXISTS 判斷片子公開性，審核通過不需要任何資料遷移。

## 值得保留的點子

- 票價獨立成 viewing_record_cost 表——三案獨立收斂到同一結論，這是唯一一件 RLS 在欄位層真的做不到、必須靠結構解決的事。直接採用。
- 提案 3 的時間模型：watched_on date + watched_time time（+ tz 備用）。避開整個時區問題而不是解決它；貢獻圖與熱力圖零換算，舊資料不會被捏造出假的 00:00。這是本次最重要的一個決定。
- 提案 2 的判斷：絕不對 SELECT 做欄位級 revoke（會讓 PostgREST 的 select=* 直接 permission denied）；欄位級 GRANT 只用在 INSERT/UPDATE。這條省你半天 debug。
- 把 policy 裡所有 STABLE 函式呼叫包成 (select auth.uid()) / (select is_admin())，讓 planner 提成 InitPlan。一行成本，套到提案 3 的 helper 上，就不需要提案 2 的三個鏡射欄位。
- 提案 1 第 12 節的上線前自我檢查 DO block：public schema 全表必須 enable RLS、所有 view 必須 security_invoker。20 行擋掉兩種最致命且靜默的失誤，放進每次 migration 結尾。
- 提案 1 的 CHECK：film_public_requires_approval（visibility='private' or moderation_status='approved'）。用一條宣告式約束讓「公開但未審核」在結構上無法被表示，取代一堆 trigger 判斷。
- 提案 3 的 idempotent DDL 風格（if not exists / drop policy if exists / on conflict do nothing）——但把 create type 拆成一個型別一個 DO block，避免第一個 duplicate 就吞掉後面全部。
- 提案 3 的 film_identity 單一命名空間：匯入管線本來就是確定性鍵，gov 片事後比對到 TMDB 是必然事件。合併退化成「改 identity 列指向」，viewing_record 一列都不用動，重跑匯入也不會復活重複列。這是唯一付得起自己成本的未來性設計。
- 提案 3 的 certificate.raw jsonb + import_run 批次來源紀錄：體積微不足道，但日後改良解析邏輯可以就地重算，不必重抓上游。對資料匯入導向的專案 CP 值極高。
- 提案 3 的「取下是狀態不是 DELETE」（moderation_state enum）：刪掉就永遠無法履行回復義務，而這是事後補不回來的 schema 決定。成本只是一個 enum 欄位。
- 提案 1 的 export_my_data 用 SECURITY INVOKER 而非 DEFINER：一個寫錯的 WHERE 在 definer 下會倒出全站資料，invoker 下最壞也只倒出呼叫者本來看得到的。同理適用所有統計／聚合 RPC——聚合是推論通道。
- 管理員判定放在資料表（profile.role 或獨立表），絕不用 JWT 的 user_metadata——那個欄位使用者可以用 supabase.auth.updateUser() 自己改寫。提案 1 的警告是對的，但這個規模用 profiles.role 就夠，不需要獨立 app schema。
- 先砍掉再上線的清單：materialized view + pg_cron、200 行的統計 RPC、generated 分桶欄位與 INCLUDE 覆蓋索引、付費／entitlement 表、欄位級 GRANT、雙 bucket 海報搬檔流程。這些都可以在有真實使用者與真實慢查詢之後再加，而且屆時你會知道該加哪一種。
