# judge-practical

### 提案 1：rls-first：8.5/10

【票價欄級保護：成立，三案中唯一真正閉合的】cost 移出 viewing_record 成為獨立列，且全案沒有任何 SECURITY DEFINER 路徑能讀到它——export_my_data、user_year_stats、search_film 一律 INVOKER，兩支 view 都 security_invoker + CI 斷言。因此 PostgREST 的 select=*、embedded resource（viewing_record?select=*,viewing_record_cost(*)）、order=viewing_record_cost(cost).desc、!inner embed、以及 ?cost=gt.500 這類 filter，全部都在 lateral 子查詢內套 RLS，拿不到未授權的列。加上 section 12 斷言「viewing_record 不得長回 cost 欄位」，把回歸變成 migration 失敗。

【仍然存在的洩漏路徑】
(1) 未來函式 fail-open：`alter default privileges ... revoke all on functions from anon, authenticated` 完全無效——Postgres 新函式的預設是 EXECUTE TO **PUBLIC**，不是 grant 給 anon/authenticated，revoke 對象寫錯了。section 8 的 `revoke execute on all functions in schema public from public` 只清掉當下存在的函式。因此**下一次 migration 新增的任何 public schema SECURITY DEFINER RPC，預設就是 anon 可呼叫**，包括未來某支回傳 sum(cost) 的統計 RPC。修法：`alter default privileges in schema public revoke execute on functions from public;` 並在 CI 加一條「public schema 內 prosecdef 函式不得對 PUBLIC/anon 有 EXECUTE」。
(2) guard 觸發器可被自家 definer 函式靜默關閉：`app.is_service_context()` 判斷 `current_user in ('postgres',...)`，而所有 SECURITY DEFINER 函式的 owner 都是 postgres → 任何日後新增的 definer 寫入函式，會讓 tg_film_guard / tg_viewing_record_guard / tg_profile_guard 整組跳過。目前無害（既有 definer 函式都自帶 is_admin 檢查），但這是一個「加一支函式就繞過三層防禦」的隱形開關。
(3) 作品取下不連動紀錄與票價：`app.cost_visible_to_caller()` 與 `viewing_record_select` 都只看 record 自己的 visibility / taken_down_at，不看 film。admin_takedown 對 film 下手時，所有引用該片的公開觀影紀錄（含 memo、含票價）**仍然公開**。§90-7「立即移除」在 film 這條路徑上是半殘的，而且是票價的一條間接洩漏（被取下作品的觀影消費仍可讀）。P3 的 record_is_public() 有做這個 join，P1 沒有。
(4) 側通道（自陳，確認存在）：`app.cost_visible_to_caller(uuid)` / `app.profile_is_active(uuid)` 對 anon 開 EXECUTE，是「此 record 是否公開且已開票價」的 oracle。因 app schema 不在 PostgREST 曝露清單，實務上不可直接呼叫，風險等級低，但依賴的是 Supabase 專案設定而非 SQL。
(5) 未開 FORCE ROW LEVEL SECURITY（自陳）：任何以 postgres 身分執行的 SQL（含日後的 definer 函式、psql 維運腳本）完全不受 RLS 約束。這是 (2) 的同一個根。
(6) `grant select on public.film` 含 created_by，公開作品揭露「誰新增的」；`username_claim` 現用名對 anon 全可列舉（自陳，屬產品決策）。

【評價】唯一同時做到「欄位級 GRANT（擋 PATCH 提權）+ RLS WITH CHECK（擋最終狀態）+ BEFORE trigger（擋 OLD→NEW）+ 表級 CHECK（擋非法狀態根本無法表示）」四層的提案，且是唯一對 public schema 函式做過 blanket revoke 的提案。扣分主要在 (1) 的預設權限寫錯與 (3) 的取下不連動。

### 提案 2：query-first：6/10

【票價欄級保護：結構對，但規則被複製成兩份，且其中一份繞過 RLS】cost 獨立成表的方向正確，PostgREST 的 select=* / embed 都擋得住。但把可見性快取成 `cost_public` 布林欄位後，同一條隱私規則同時存在於兩個地方：
(A) RLS policy `cost_read_public using (cost_public)` —— 讀的是**觸發器維護的鏡射值**；
(B) `user_year_stats()` 是 **SECURITY DEFINER**，RLS 完全不生效，改用 `v_cost_allowed := v_is_owner or show_cost` 手寫把關，而且 spend CTE **完全沒有引用 cost_public**，直接 sum(viewing_record_cost.amount)。
兩份定義只要漂移一次就外洩，而且方向相反：鏡射過期成 true 時 (A) 洩漏；鏡射過期成 false 時 (B) 洩漏。作者自陳「任何日後新增的 RPC 都必須重做這道把關，schema 本身無法強制」——這正是題目要問的「用 function 包裝時 RPC 是否可繞過」的答案：**可以，而且已經有一支這樣的函式在線上**。

【具體攻擊/失效路徑】
(1) 鏡射脫節即外洩，且預設方向是 fail-open：`film_public boolean not null default true`。任何繞過觸發器的寫入（COPY、pg_restore、`ALTER TABLE ... DISABLE TRIGGER`、service_role seed 直灌）都讓 public_listed=true，私有作品的紀錄直接進公開時間軸與 MV。cost_public 預設 false 算 fail-closed，但它建立在 public_listed 之上，上游一錯就跟著錯。
(2) UGC「預設私有」是 fail-open 的：`film.visibility default 'public'`、`review_status default 'approved'`、`listed default true`，而 insert 的欄位 GRANT 根本沒給 visibility/review_status → 它們一定走預設值，**唯一的保護是 `force_ugc_defaults` 這一支觸發器**。policy `film_insert_ugc with check ((select is_active_user()))` 沒有任何狀態約束，也沒有表級 CHECK 禁止「public 但 pending」。觸發器被 drop/disable 的那一刻，每一筆 UGC 新增都直接進公共片庫。P1 在同一點有四層。
(3) profiles 全欄位對 anon 公開：`profiles_read_all using (true)` + `grant select on public.profiles to anon`。**strike_count、suspended_at、is_admin 全部可讀**——等於公開每個使用者的著作權三振紀錄與停權狀態（比票價更敏感的個資），並提供一份完整的管理員名單供針對性攻擊。`GET /rest/v1/profiles?select=username,strike_count,is_admin&is_admin=eq.true` 一次拿到。
(4) username_history 對 anon 全可讀（`username_history_read using (true)` + grant select），且含 user_id：預設 username 取自 email @ 前綴 → 一次查詢取得全站改過名者的 email local part，並把改名前後身分完整對應。P1 明確把這條堵死，P2 反向全開。
(5) 管理端在 viewing_record 上沒有任何 policy，且該表沒有 moderation/taken_down 欄位 → §90-7 的「立即移除」在 API 層不存在，只能靠 service_role 腳本；相對地也表示取下狀態無法進入 RLS 述詞。
(6) MV 的保護只存在於 Supabase Dashboard 的 db-schemas 設定（自陳），SQL 層零防護；`public.film_stats` 是 security definer view（invoker=false），會混在 advisor 告警裡。
(7) `user_year_stats` 的 scoped CTE 不檢查 `suspended_at`，被三振停權者的統計與花費仍持續對外服務。

【評價】效能設計（覆蓋索引、InitPlan 包裝、autovacuum insert scale factor）是三案中最紮實的，`(select auth.uid())` 的處理也正確。但為了讓 policy 述詞能與部分索引比對而引入的三個鏡射欄位，把「不可能外洩」降級成「只要觸發器一直正確就不外洩」，再加上一支繞過 RLS 的 definer 統計 RPC，票價保護從結構性保證退回工程紀律。

### 提案 3：evolution-first：3/10

【票價規則本身最嚴謹，但整體被幾個 P0 級破口抵銷】cost_read policy 是三案中語意最完整的一條——即時求值，且 record_is_public() 同時 join film 與 profile，涵蓋「作品被取下 / 作者被終止服務」兩種 P1 漏掉的情況。viewing_record_public view 也正確標了 security_invoker。但以下問題讓整體不可上線：

(1) **【P0】未認證使用者可呼叫 SECURITY DEFINER 破壞性函式。** 全案沒有做 `revoke execute on all functions in schema public from public`，Postgres 新函式預設 EXECUTE TO PUBLIC，PostgREST 因此把 `public.link_film_to_tmdb` 曝露給 anon。該函式是 SECURITY DEFINER 且**函式體內沒有任何權限檢查**。更致命的是它內部呼叫 `merge_films()`，而 merge_films 的守門寫成 `if not (public.is_staff() or auth.uid() is null) then raise` —— 對 anon 而言 `auth.uid() is null` 為真 → **不會 raise**。內部呼叫在 definer 情境下也不受 `revoke ... from anon` 限制。攻擊：`POST /rest/v1/rpc/link_film_to_tmdb {"p_film":"<任一 film uuid>","p_tmdb":<已存在的 tmdb_id>}` → 未登入者即可任意合併作品、搬走全部 viewing_record.film_id、把敗方壓成 private。同一個 `auth.uid() is null ⇒ 視為 service_role 放行` 的反向邏輯出現在 guard_film_columns / guard_record_columns / guard_profile_columns / apply_tmdb_snapshot，是全案的系統性缺陷。
(2) **【P0】未審核 UGC 海報全網可列舉。** bucket `ugc-poster` 設 `public: true`，且 `ugc_poster_read for select to anon using (bucket_id='ugc-poster')` —— Supabase 的物件列舉走 storage.objects 的 RLS，所以 anon 可以 list 整個 bucket 拿到每個路徑再逐一下載。private/pending 作品的海報因此對全網公開，直接違反「UGC 預設私有、審核後才公開」。P1 用 pending/public 雙 bucket 正確處理了這一點。
(3) **【高】私有作品的片名經 film_identity 外洩。** `film_identity_read using (true)` + `grant select on public.film_identity to anon`，而 slug 是由 `slugify(title_original|title_zh)` 生成並以 `slug:<slug>` 寫進 identity。`GET /rest/v1/film_identity?select=key,film_id` 一次倒出全部未審核、私有 UGC 作品的鍵與片名切片，film 表的 RLS 等於白設。`film_tmdb_snapshot` 同樣 `using (true)`，被 moderation_state='removed' 取下的作品其 TMDB 內容仍可讀。
(4) **【高】username 表對 anon 全可讀且含 profile_id。** `username_read using (true)`，kind='historical' 的列一併可讀 → 舊名 → profile_id → 現用名的雙向對應零成本完成，並洩漏全站 email local part（預設名取自 @ 前綴）。比 P2 更糟，因為連 user_id 都直接給。
(5) **【中高】profile 全欄位對 anon 公開：`role` 與 `service_status` 可讀** → 管理員名單可列舉；`service_status='limited'` 等於公開宣告該使用者已累積兩次著作權三振。
(6) **【中】單層防禦 + 全表 GRANT。** `grant insert, update, delete on public.viewing_record, viewing_record_cost`、`grant insert, update on public.film`、`grant update on public.profile` 全是表級無欄位限制；擋住 role/visibility/review_state/moderation_state 提權的**只有 guard 觸發器一層**，policy 的 WITH CHECK 只驗 created_by/user_id，也沒有 `film_public_requires_approval` 這類表級 CHECK。任一觸發器失效即為完整提權，而 (1) 已經示範了怎麼讓觸發器失效。
(7) 效能/正確性：cost_read 一條 policy 逐列呼叫 record_owner + record_is_public + owner_shows_cost 三支 definer 函式（自陳），且全案 policy 都用裸 `auth.uid()` / `public.is_staff()` 而非 `(select ...)`，不會被提成 InitPlan。

【評價】film_identity 單一命名空間、TMDB 快取分表 + 讀取端 expires_at 把關、取下用狀態不用 DELETE、business_days_after 把法定期間編碼進 DB —— 這些演進性設計是三案中最好的。但資安面上，一個 anon 可觸發的破壞性 RPC 加上一個可列舉的公開海報桶，已經足以讓票價那條漂亮的 policy 失去意義。

## 值得保留的點子

- 【票價】cost 一律移出 viewing_record 成為獨立表——把欄級問題改寫成 RLS 天生能解的列級問題。三案共識，且確實能擋住 PostgREST 的 select=*、embedded resource、!inner embed、以及對 embed 欄位的 filter/order（這些都在套用 RLS 的 lateral 子查詢內求值）。
- 【票價】可見性一律即時求值（P1 的 app.cost_visible_to_caller、P3 的 record_is_public），不要像 P2 那樣快取成 cost_public 布林欄位——鏡射一旦漂移，同一條規則就有兩個互相矛盾的定義，且 film_public default true 讓失敗方向指向外洩。
- 【票價】P3 的 record_is_public() 判準最完整：同時要求 record 公開、**film 公開且未取下**、作者未被終止服務。P1 漏掉 film 這一段，導致被 §90-7 取下的作品其觀影紀錄與票價仍公開——應該把 P3 的 join 併進 P1 的 cost_visible_to_caller 與 viewing_record_select。
- 【RPC】所有統計/匯出函式一律 SECURITY INVOKER（P1）。聚合是推論通道不是安全邊界；一支 definer 的 sum(cost) 會把 RLS 擋下的資料以總額形式漏光。P2 的 user_year_stats 正是反例——它必須手寫重做一次票價規則，且作者自陳「任何新 RPC 都得再做一次」。
- 【RPC】P1 的 `revoke execute on all functions in schema public from public, anon, authenticated` 再逐支 grant，是三案中唯一正確的做法。P3 沒做這一步，直接導致 anon 可呼叫 link_film_to_tmdb → merge_films 的未認證破壞性寫入。
- 【反面教材，務必避免】把 `auth.uid() is null` 當成「service_role 直連，放行」的判準（P3 的 merge_films / guard_* 觸發器、P2 的 force_ugc_defaults）。anon 的 auth.uid() 同樣是 NULL——這個條件把守門邏輯對未登入者整組關掉。要判斷服務情境請用 `current_user`（P1 的 app.is_service_context）或明確的 role 檢查。
- 【提權】四層防禦缺一不可（P1）：欄位級 GRANT（PostgREST 送出前就被擋）→ RLS WITH CHECK（驗最終狀態）→ BEFORE trigger（RLS 看不到 OLD，只有它能表達「此欄不得變動」）→ 表級 CHECK（讓 `public 但未審核` 這個狀態根本無法被表示）。P2/P3 只靠觸發器一層 + 全表 GRANT。
- 【管理員】admin 判定放在 PostgREST 看不到的 schema、無 policy、無 grant、只有 service_role 能寫（P1 的 app.admin_user）。絕不放 JWT user_metadata（可被 updateUser 自改），也盡量不要像 P2/P3 那樣做成 profiles 的一個對 anon 可讀的欄位——那等於公開管理員名單。
- 【改名】舊 username 對外不可讀、不可列舉、不可反查，只留一支單向的 resolve_username() 且不回傳 user_id（P1）。P2/P3 讓 username_history / username 表對 anon 全開，等於公開全站 email local part 並把改名前後身分綁回去，直接抵銷改名的意義。
- 【個資】把三振次數、停權理由、刪除排程拆進 profile_private（P1），讓 profile 的 SELECT policy 可以放心寫成「幾乎全公開」。P2 的 strike_count/suspended_at/is_admin 與 P3 的 role/service_status 都是對 anon 可讀，等於公開使用者的懲處紀錄。
- 【海報】pending 與 approved 用兩個 bucket，pending 桶設 private 並以 RLS 限制作者本人（P1）。P3 為了「海報不得置於付費牆後」把單一桶設成 public + anon 可 select，結果 storage.objects 的列舉權限讓未審核海報全網可列舉可下載。
- 【CI】把致命失誤變成 migration 失敗（P1 section 12）：public 表必須全部 enable RLS、public view 必須全部 security_invoker、viewing_record 不得長回 cost 欄位、所有 SECURITY DEFINER 必須釘 search_path。建議再補三條：public schema 內 prosecdef 函式不得對 PUBLIC/anon 有 EXECUTE、所有 admin_ 前綴 definer 函式原始碼必須含權限檢查、alter default privileges 的 revoke 對象必須是 PUBLIC 而非 anon/authenticated（P1 這一條寫錯了，導致未來新增的函式預設 anon 可執行）。
- 【演進性】P3 的 film_identity 單一命名空間（確定性鍵與 FK 指向分離）+ merge_films 把敗方的 gov: 鍵改指存活者，是唯一能讓「合併」與「冪等重跑匯入」不打架的寫法；TMDB 內容分表 + 讀取端 `case when expires_at > now()` 把關（cron 掛掉自動退化成 NULL 而非續供逾期快取），這兩點值得原封不動搬進 P1。
- 【效能】P2 的 `(select auth.uid())` / `(select is_admin())` 包裝成純量子查詢讓 planner 提成 InitPlan 只求值一次，以及 viewing_record 的 autovacuum_vacuum_insert_scale_factor 調整（否則 visibility map 不新鮮，covering index 的 index-only scan 白做）——這兩點 P1 與 P3 都沒做，但可以在不犧牲任何安全性的前提下直接採用。
