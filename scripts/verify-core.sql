-- =============================================================================
-- 核心不變量驗收：schema、RLS／權限、TMDB 合規、資料完整性
--
-- 由 `scripts/verify-all.ts` 呼叫；也可以單獨跑：
--   pnpm db:sql -- scripts/verify-core.sql
--
-- ── 三條規矩（本檔的每一段都遵守）─────────────────────────────────────────
--
-- ① 每條斷言旁邊寫出它守的是哪個坑（§7 編號或 Step 編號）。
--    沒有那句話的斷言，日後有人看到它紅了會傾向刪掉它，而不是修程式。
--
-- ② 不留痕跡。整支包在 begin / rollback 裡，連 `create function` 也是——
--    PostgreSQL 的 DDL 是交易性的。不靠執行者記得清理。
--
-- ③ **假綠燈比紅燈危險。** 每條斷言都要能回答「被守的東西壞掉時，我真的會紅嗎」。
--    能證明的就證明：把它弄壞一次，確認斷言翻紅，再回滾。那種段落標成
--    〔反向對照〕。已經踩過兩次假綠燈——§7 #100（SET ROLE 模擬不了
--    is_service_context）與 #102（照散文 curl 一個不存在的 bucket，404 被判成通過）。
--
-- ★ 失敗不會在第一條就中止，而是全部收集起來最後一次報出來。
--   一條紅的把後面十條遮住，等於只驗到第一條。
-- =============================================================================

begin;

do $$
declare
  fails text[] := '{}';
  v_user uuid; v_venue text; v_film uuid; v_priv_film uuid; v_rec uuid;
  n integer; t text; v_claims text;
  v_caught boolean;
begin
  select id into v_user from public.profile order by created_at limit 1;
  select id into v_venue from public.venue order by id limit 1;
  v_claims := json_build_object('sub', v_user, 'role', 'authenticated')::text;

  -- ===========================================================================
  -- A. Schema 不變量（BUILD_PLAN §5 Step 2 的四條 + default privileges 實測）
  -- ===========================================================================

  -- A1〔Step 2 ①〕public schema 不得有未開 RLS 的表。
  --    漏開的表 = 該表的所有列對任何人全開，而且沒有任何錯誤訊息。
  select string_agg(c.relname, ', ') into t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if t is not null then fails := fails || format('A1 未開 RLS 的表：%s', t); end if;

  -- A2〔Step 2 ②〕public schema 的 view 必須全部 security_invoker。
  --    少了它，view 以擁有者（postgres）身分讀表 ⇒ RLS 整個讓開，
  --    而 view 看起來完全正常。踩雷 #42 的同一個家族。
  select string_agg(c.relname, ', ') into t
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%';
  if t is not null then fails := fails || format('A2 非 security_invoker 的 view：%s', t); end if;

  -- A2b〔反向對照〕故意建一個沒有 security_invoker 的 view，A2 必須抓到它。
  --     不做這一步的話，A2 在「查詢寫錯、永遠 0 列」時也是綠的。
  begin
    execute 'create view public.zz_probe_view as select 1 as x';
    select count(*) into n
      from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace
     where n2.nspname = 'public' and c.relkind = 'v' and c.relname = 'zz_probe_view'
       and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%';
    if n <> 1 then
      fails := fails || 'A2b 反向對照失效：故意建的非 invoker view 沒有被 A2 的條件抓到（A2 是假綠燈）'::text;
    end if;
    raise exception 'ZZ_ROLLBACK';
  exception when others then
    if sqlerrm <> 'ZZ_ROLLBACK' then raise; end if;
  end;

  -- A3〔踩雷 #73/#74〕anon 可執行的函式必須落在白名單內。
  --    ⚠️ BUILD_PLAN §5 Step 2 ③ 寫的是「不得有 anon 可執行的 SECURITY DEFINER
  --       函式」——那個措辭已經過時。policy 內用到的 helper（is_staff、
  --       account_is_servable、record_is_public…）**必須**是 DEFINER 且**必須**
  --       對 anon 開 EXECUTE，否則全站 403。照 Step 2 ③ 的字面寫，這條會列出
  --       九支「正常且必要」的函式然後翻紅——那是假紅燈，會誘使人去刪掉真正
  --       在守門的 grant。真正的不變量是 9999 §3 的顯式白名單，這裡鏡射它。
  select string_agg(p.proname, ', ') into t
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.proname not in ('is_staff','is_admin','account_is_servable','owner_shows_cost',
                           'record_owner','record_is_public','film_usable_by','resolve_film',
                           'resolve_username','slugify','ugc_poster_film','user_year_stats',
                           -- 0010 的 /u/ 年表全量聚合。與 user_year_stats 同一個模式：
                           -- SECURITY INVOKER、只回筆數、完全不碰金額。
                           -- ⚠️ 這份白名單與 9999 §3 的那份是**兩份**。加了一支對 anon
                           --    開放的 RPC 只改一邊，另一邊會翻紅——那是設計如此
                           --    （兩道獨立的門），但兩邊都要改。
                           'user_year_counts',
                           -- 本檔自己臨時建的探針（A5），不算破口
                           'zz_probe_fn')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'));
  if t is not null then fails := fails || format('A3 白名單外的函式對 anon/PUBLIC 開放 EXECUTE：%s', t); end if;

  -- A4〔Step 2 ④〕viewing_record 不得長回 cost 欄位。
  --    票價分表是整條隱私規則的地基（cost_read policy）。欄位長回主表，
  --    RLS 就再也擋不住它。
  select string_agg(column_name, ', ') into t from information_schema.columns
   where table_schema = 'public' and table_name = 'viewing_record' and column_name like '%cost%';
  if t is not null then fails := fails || format('A4 viewing_record 長出 cost 欄位：%s', t); end if;

  -- A5〔踩雷 #74〕前提檢查：新建的函式**仍然**會被 anon 繼承 EXECUTE。
  --    ⚠️ 方向與 BUILD_PLAN §5 Step 2 的敘述相反，而且 Step 2 是錯的。
  --       Step 2 寫「臨時建一支函式，has_function_privilege('anon',…) 必須為
  --       false」，但 #74 是**後來實測**推翻它的：`alter default privileges …
  --       revoke execute … from public` 擋不住未來的函式（新函式的 proacl 塌回
  --       NULL ＝ PUBLIC 有 EXECUTE）。照 Step 2 寫這條會永遠紅。
  --    所以這裡斷言的是「#74 描述的現實還在」。**它若翻紅是好消息**：代表
  --    Supabase／PG 改了預設行為，9999 的白名單可以放鬆——但那要有人先知道。
  execute 'create function public.zz_probe_fn() returns int language sql as ''select 1''';
  if not has_function_privilege('anon', 'public.zz_probe_fn()', 'execute') then
    fails := fails || ('A5 前提變了：新函式不再自動對 anon 開放 EXECUTE。'
                    || '這是好消息，但請重讀踩雷 #74 並確認 9999 的白名單是否還需要維持現狀')::text;
  end if;

  -- ===========================================================================
  -- B. RLS 與權限
  -- ===========================================================================

  insert into public.film (title_zh, origin, visibility, review_state)
  values ('__verify__公開片', 'gov', 'public', 'approved') returning id into v_film;
  insert into public.viewing_record (user_id, film_id, venue_id, watched_on, visibility)
  values (v_user, v_film, v_venue, current_date - 1, 'public') returning id into v_rec;
  insert into public.viewing_record_cost (record_id, amount) values (v_rec, 390);
  update public.profile set show_cost = false where id = v_user;

  -- B1〔踩雷 #10、#42〕show_cost = false 時，匿名讀不到票價。
  --    ★ 切 anon 一定要同時清掉 request.jwt.claims：auth.uid() 讀的是 GUC
  --      不是資料庫角色，留著 claims 會讓斷言以假的理由通過（§7 #100 的近親）。
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  if (select auth.uid()) is not null then
    fails := fails || 'B1 前置失敗：切成 anon 後 auth.uid() 仍非 null，以下匿名斷言全部無效'::text;
  end if;
  select count(*) into n from public.viewing_record_cost where record_id = v_rec;
  if n <> 0 then fails := fails || format('B1 匿名讀得到不公開的票價（%s 列）', n); end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  -- B1b〔反向對照〕把 show_cost 打開，同一條查詢必須看得到票價。
  --     沒有這一步，B1 在「查詢根本讀不到任何東西」時也是綠的——
  --     那正是 §7 #102 那個坑（分不出「擋住了」與「本來就沒東西」）。
  update public.profile set show_cost = true where id = v_user;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.viewing_record_cost where record_id = v_rec;
  if n <> 1 then
    fails := fails || 'B1b 反向對照失效：show_cost 開了匿名仍讀不到票價 ⇒ B1 是假綠燈'::text;
  end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);
  update public.profile set show_cost = false where id = v_user;

  -- B2〔踩雷 #37〕私密作品的片名不得經 film_identity 的 slug 外洩。
  -- ★ 只看這一部私密作品的 identity。原本寫成 `key like '%verify%'`，結果連
  --   上面那部**公開**測試片的 slug 也撈進來，斷言因此永遠紅——假紅燈與假綠燈
  --   一樣危險，它會讓人去改一條其實沒壞的 policy。
  insert into public.film (title_zh, origin, visibility, review_state, created_by)
  values ('__verify__私密片名不可外洩', 'ugc', 'private', 'pending', v_user)
  returning id into v_priv_film;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.film_identity where film_id = v_priv_film;
  if n <> 0 then fails := fails || format('B2 匿名可經 film_identity 看到私密作品的 slug（%s 列）', n); end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  -- ===========================================================================
  -- C. TMDB 六個月條款（BUILD_PLAN §5 Step 9）
  -- ===========================================================================

  -- C1 逾期快取不得供應。合規靠讀取端 view 的 expires_at 把關，
  --    **不是靠「cron 一定會跑」**。這一條本身就是反向對照：
  --    先確認看得到，弄成過期，再確認看不到。
  select f.id into v_film from public.film f
    join public.film_tmdb_snapshot s on s.film_id = f.id
   where s.poster_path is not null and s.expires_at > now()
     and f.visibility = 'public' and f.moderation_state = 'visible'
     and f.merged_into_film_id is null
   limit 1;

  if v_film is null then
    fails := fails || 'C1 無法驗證：找不到任何「有海報且未過期」的作品當樣本'::text;
  else
    select count(*) into n from public.film_public
     where id = v_film and tmdb_poster_path is not null;
    if n <> 1 then
      fails := fails || 'C1 前置失敗：樣本作品在 film_public 裡本來就沒有海報，以下斷言無效'::text;
    end if;

    update public.film_tmdb_snapshot set expires_at = now() - interval '1 day' where film_id = v_film;
    select count(*) into n from public.film_public
     where id = v_film and (tmdb_poster_path is not null or overview is not null
                            or tw_release_date is not null);
    if n <> 0 then
      fails := fails || 'C1 ★ 快取已過期，film_public 仍在供應 TMDB 內容（六個月條款破口）'::text;
    end if;
  end if;

  -- C2 政府核准的中文片名不得被 TMDB 蓋掉（SPEC 的第一條價值主張）。
  --    做法：拿一部 title_zh_source='gov' 的片，把快照的中文標題改成別的，
  --    跑 apply_tmdb_snapshot，片名必須一個字都不變。
  select f.id into v_film from public.film f
    join public.film_tmdb_snapshot s on s.film_id = f.id
   where f.title_zh_source = 'gov' and s.state = 'fresh' and f.title_zh <> ''
   limit 1;
  if v_film is null then
    fails := fails || 'C2 無法驗證：找不到 gov 片名 + fresh 快照的樣本'::text;
  else
    select title_zh into t from public.film where id = v_film;
    update public.film_tmdb_snapshot
       set title_zh = '__TMDB_想蓋掉的名字__', state = 'fresh' where film_id = v_film;
    perform public.apply_tmdb_snapshot(v_film);
    if (select title_zh from public.film where id = v_film) is distinct from t then
      fails := fails || format('C2 ★ 政府核准片名被 TMDB 蓋掉了（%s → %s）',
                               t, (select title_zh from public.film where id = v_film));
    end if;
  end if;

  -- ===========================================================================
  -- D. 資料完整性
  -- ===========================================================================

  -- D1 片名不得含 Unicode 私用區字元（U+E000–U+F8FF）。
  --    那是 Big5 → Unicode 轉換失敗的殘留，會直接顯示在公開頁上。
  --    src/normalize/defensive.ts 只偵測 `?` 型損毀，這一類完全沒有守門員
  --    ——所以由這條斷言守。
  -- 以碼位判斷而不是把私用區字元字面寫進 SQL：那些字元在編輯器／終端機／
  -- 剪貼簿之間很容易被吃掉或替換，寫成 57344–63743（U+E000–U+F8FF）才讀得懂也可靠。
  select count(*), string_agg(distinct title_original, ', ') into n, t
    from public.film
   where exists (select 1 from regexp_split_to_table(coalesce(title_zh,'') || coalesce(title_original,''), '') ch
                  where ascii(ch) between 57344 and 63743);
  if n > 0 then
    fails := fails || format('D1 有 %s 部作品的片名含私用區字元（原文片名：%s）', n, t);
  end if;

  -- D2 已合併的作品不得再出現在任何公開讀取路徑。
  select count(*) into n from public.film_public
   where id in (select id from public.film where merged_into_film_id is not null);
  if n <> 0 then fails := fails || format('D2 已合併的作品仍出現在 film_public（%s 列）', n); end if;

  -- D3〔踩雷 #81〕有 tmdb_id 就必須有快照列，否則永遠進不了刷新佇列。
  select count(*) into n from public.film f
   where f.tmdb_id is not null and f.merged_into_film_id is null
     and not exists (select 1 from public.film_tmdb_snapshot s where s.film_id = f.id);
  if n <> 0 then
    fails := fails || format('D3 有 %s 部帶 tmdb_id 的作品沒有快照列，它們永遠不會有海報', n);
  end if;

  -- ===========================================================================
  -- E. US-47 帳號刪除的結構保證（0009）
  --    這一組守的不是「刪除會不會成功」——那由 verify-all.ts 的 http/account-*
  --    真的刪一個帳號來證明。這裡守的是**刪除的形狀**：一旦下面任何一條回到
  --    0009 之前的樣子，刪除仍然會「成功」，只是會順手毀掉別的東西。
  -- ===========================================================================

  -- E1 法遵證據不得隨帳號一起消失。
  --    0009 之前 copyright_strike / counter_notice 的 profile_id 是 ON DELETE
  --    CASCADE ⇒ 被三振的人按一下刪除帳號，§90-4 要求的處理紀錄就沒了。
  select count(*) into n
    from pg_constraint c
   where c.contype = 'f'
     and c.conrelid in ('public.copyright_strike'::regclass, 'public.counter_notice'::regclass)
     and c.confrelid = 'public.profile'::regclass
     and c.confdeltype <> 'n';   -- 'n' = SET NULL
  if n <> 0 then
    fails := fails || format('E1 有 %s 條 DMCA 證據表的 FK 不是 ON DELETE SET NULL（帳號一刪，§90-4 的證據就沒了）', n);
  end if;

  -- E2 切斷 profile_id 之後，「同一主體累積三次」必須仍然成立。
  --    subject_ref 可以為 NULL 的話，三筆孤兒三振紀錄跟三個不同的人各被記一次
  --    在資料上長得一模一樣，而那正是 §90-4 第 2 款要證明的東西。
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public' and table_name in ('copyright_strike', 'counter_notice')
     and column_name = 'subject_ref' and is_nullable = 'NO';
  if n <> 2 then
    fails := fails || format('E2 subject_ref 不是兩張表都有且 NOT NULL（實得 %s／2）', n);
  end if;

  -- E3 delete_my_account / account_deletion_preview 不得有參數。
  --    它們的安全性完全建立在「無參數 ⇒ 結構上只能作用在 auth.uid() 自己身上」。
  --    9999 也有同一條（那裡讓 migration 失敗）；這裡讓驗收失敗，因為 9999
  --    不見得每次都會被重跑。
  select count(*) into n from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('delete_my_account', 'account_deletion_preview')
     and p.pronargs > 0;
  if n <> 0 then
    fails := fails || format('E3 delete_my_account / account_deletion_preview 出現了參數（就不再是「只能刪自己」）');
  end if;

  -- E4 兩階段刪除的殘骸不得長回來。
  --    deletion_requested_at 只要存在而沒有任何東西執行第二階段，刪除就只是
  --    「看起來有做」。要走兩階段，這個欄位必須跟真的會執行它的東西一起進來
  --    ——那時候把這條斷言換掉，而不是繞過它。
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'profile_private'
                and column_name = 'deletion_requested_at') then
    fails := fails || format('E4 profile_private.deletion_requested_at 又出現了（沒有執行者的兩階段刪除＝假的刪除）');
  end if;

  -- E5 UGC 作品的作者欄位必須是 ON DELETE SET NULL。
  --    改成 CASCADE 的話，刪一個帳號會把他建過、而別人正在引用的作品一起帶走
  --    ——viewing_record.film_id 是 RESTRICT，實際結果是刪除整個失敗；
  --    改成 RESTRICT 的話，只要建過一部作品就永遠刪不掉帳號。
  select count(*) into n from pg_constraint c
   where c.contype = 'f' and c.conrelid = 'public.film'::regclass
     and c.confrelid = 'public.profile'::regclass and c.confdeltype = 'n';
  if n <> 1 then
    fails := fails || format('E5 film.created_by 不是 ON DELETE SET NULL（刪帳號會炸掉別人引用中的作品）');
  end if;

  -- ===========================================================================
  -- 收尾
  -- ===========================================================================
  if array_length(fails, 1) is null then
    raise notice '✅ verify-core：全部通過';
  else
    foreach t in array fails loop
      raise warning '❌ %', t;
    end loop;
    raise exception 'verify-core 有 % 條斷言未通過（詳見上方 warning）', array_length(fails, 1);
  end if;
end $$;

rollback;
