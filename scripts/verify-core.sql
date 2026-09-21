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
                           -- 0013 首頁海報牆。SECURITY INVOKER，沿用 film_public
                           -- 的 RLS ⇒ 未審核作品的海報不會出現在背景上。
                           'home_poster_wall',
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

  -- C2b–C2f〔0019〕同一條價值主張，**另一條寫入路徑**。
  --    C2 守的是 apply_tmdb_snapshot()（快取刷新）那一側；但 §8.3 的「TMDB 直接匯入
  --    新片」走的是 seed_films()，而 C2 的取樣條件 `title_zh_source = 'gov'`
  --    **選不到新匯入的片** ⇒ 那條路徑原本沒有守門員。
  --    斷言一律寫成**全表資料述詞**（「不存在符合 X 的列」），不是 David-scoped 計數
  --    ——後者在別人有合法資料時會變成假紅燈（§7 F5.2）。
  --
  -- ⚠️ 0019 未套用時整段略過（notice，**不計入 fails**）：這些驗的是 0019 的行為，
  --    對著未套用的 seed_films() 它們本來就該紅，而那種紅燈會擋住另一條線的 verify:all。
  declare
    v_patched boolean; v_gov uuid; v_tid integer; v_before text;
    v_new uuid; v_dup uuid; v_n_before integer; v_n_after integer; v_c integer;
  begin
    select coalesce(pg_get_functiondef(p.oid) like '%titleZhSource%', false) into v_patched
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'seed_films';

    if not coalesce(v_patched, false) then
      raise notice 'C2b–C2f 略過：0019 未套用（seed_films 還不認得 titleZhSource）';
    else
      -- 近似 normalizeTitle。⚠️ 只折疊大小寫與標點，**吃不到版本標註與 NFKC 全形折疊**
      -- ⇒ 它抓得到的碰撞是真的，抓不到的那一半由 `classifyReleases()` 的 ② 與
      --   `tests/tmdb-classify.test.ts` 守。兩邊守的東西不同，不要當成同一道（§7 #233）。
      execute $fn$create or replace function pg_temp.zz_c2_norm(t text) returns text
        language sql immutable as $body$
          select regexp_replace(lower(coalesce(t,'')),
            '[[:space:]\-–—_:：,，.。!！?？''"“”‘’()（）\[\]【】《》~～、/|]+', '', 'g')
        $body$
      $fn$;

      create temp table zz_c2_before on commit drop as
        select id, title_zh, title_zh_source::text as src from public.film;
      select count(*) into v_n_before from public.film
       where origin = 'gov' and tmdb_id is null and merged_into_film_id is null;

      -- 取一部**真實的**政府片名作品當樣本，餵它一個 TMDB 送來的片名。
      select f.id, f.tmdb_id into v_gov from public.film f
       where f.title_zh_source = 'gov' and f.tmdb_id is not null
         and f.title_zh <> '' and f.merged_into_film_id is null
       order by f.id limit 1;

      if v_gov is null then
        fails := fails || 'C2b 無法驗證：找不到 title_zh_source=gov 且有 tmdb_id 的樣本'::text;
      else
        select tmdb_id, title_zh into v_tid, v_before from public.film where id = v_gov;

        -- ── 模擬一次 TMDB 直接匯入：一筆打在既有的政府列上、一筆是全新的 ──
        perform public.seed_films(jsonb_build_array(
          jsonb_build_object('id', 'tmdb:' || v_tid, 'tmdbId', v_tid,
            'titleZh', '__TMDB想蓋掉的名字__', 'titleZhSource', 'tmdb', 'source', 'tmdb'),
          jsonb_build_object('id', 'tmdb:999900021', 'tmdbId', 999900021,
            'titleZh', 'zzC2新匯入作品', 'titleZhSource', 'tmdb', 'source', 'tmdb')));

        -- C2b 全表述詞：title_zh_source='gov' 的列，title_zh 零差異。
        --     ⚠️ 條件只看 title_zh_source，**不可以加 origin='gov'**——政府片配對成功後
        --     origin 就已經是 'tmdb'（活體 2,480 列），加了會漏掉絕大部分要守的列。
        select count(*) into v_c
          from zz_c2_before b join public.film f on f.id = b.id
         where b.src = 'gov' and f.title_zh is distinct from b.title_zh;
        if v_c <> 0 then
          fails := fails || format('C2b ★ TMDB 匯入改動了 %s 列 title_zh_source=gov 的片名'
            '（SPEC 第一條價值主張，而且不會有任何錯誤訊息）', v_c);
        end if;

        -- C2c 全表述詞：不存在 title_zh_source='admin' 卻被這次匯入改過 title_zh 的列。
        --     0012 的人工修正一旦被洗掉，下一個維護者不會把兩件事連起來。
        select count(*) into v_c
          from zz_c2_before b join public.film f on f.id = b.id
         where b.src = 'admin' and f.title_zh is distinct from b.title_zh;
        if v_c <> 0 then
          fails := fails || format('C2c ★ TMDB 匯入洗掉了 %s 列 admin 人工修正的片名', v_c);
        end if;

        -- C2d 新匯入的列必須是 title_zh_source='tmdb'（不是落回預設值 'gov'）。
        --     落回 'gov' 的話，群眾翻譯的片名從此被標記成官方核准的（§8.3 的裁決反了）。
        select id into v_new from public.film where tmdb_id = 999900021;
        if v_new is null then
          fails := fails || 'C2d ★ 新匯入的作品根本沒有被建出來'::text;
        elsif (select title_zh_source::text from public.film where id = v_new) <> 'tmdb'
           or (select origin::text from public.film where id = v_new) <> 'tmdb' then
          fails := fails || format('C2d ★ 新匯入的列是 origin=%s／title_zh_source=%s，不是 tmdb/tmdb',
            (select origin::text from public.film where id = v_new),
            (select title_zh_source::text from public.film where id = v_new));
        end if;

        -- C2e 匯入不得讓「origin='gov' 且沒有 tmdb_id」那一群變多，且全片庫不得出現
        --     「一部有 tmdb_id、一部沒有，片名卻一樣」的配對——那就是 §2.2 的重複作品。
        select count(*) into v_n_after from public.film
         where origin = 'gov' and tmdb_id is null and merged_into_film_id is null;
        if v_n_after <> v_n_before then
          fails := fails || format('C2e 匯入後 origin=gov 且無 tmdb_id 的列數 %s → %s',
            v_n_before, v_n_after);
        end if;
        select count(*) into v_c
          from public.film a join public.film b on b.id <> a.id
         where a.merged_into_film_id is null and b.merged_into_film_id is null
           and a.tmdb_id is null and b.tmdb_id is not null
           and pg_temp.zz_c2_norm(a.title_zh) <> ''
           and pg_temp.zz_c2_norm(a.title_zh) = pg_temp.zz_c2_norm(b.title_zh);
        if v_c <> 0 then
          fails := fails || format('C2e ★ 片庫出現 %s 組重複作品（同片名，一部有 tmdb_id 一部沒有）', v_c);
        end if;

        -- C2f〔反向對照 ①〕同一列、同一支函式，**政府**片名必須照樣寫得進去。
        --     少了這一組，C2b 在「整條更新路徑被關掉」時也是綠的（那正是 F5.4 那一類）。
        perform public.seed_films(jsonb_build_array(jsonb_build_object(
          'id', 'tmdb:' || v_tid, 'tmdbId', v_tid, 'titleZh', '__政府改名了__')));
        if (select title_zh from public.film where id = v_gov) <> '__政府改名了__' then
          fails := fails || format('C2f ★ 反向對照——政府片名竟然寫不進去（實得 %s），'
            'C2b 的綠燈是假的', (select title_zh from public.film where id = v_gov));
        end if;

        -- C2f〔反向對照 ②〕故意造一組重複作品，C2e 的那條述詞必須抓得到。
        --     沒有這一步，C2e 在「查詢寫錯、永遠 0 列」時也是綠的（比照 A2b 的做法）。
        insert into public.film (title_zh, origin, review_state, visibility)
        values ('zzC2新匯入作品', 'gov', 'approved', 'public') returning id into v_dup;
        select count(*) into v_c
          from public.film a join public.film b on b.id <> a.id
         where a.merged_into_film_id is null and b.merged_into_film_id is null
           and a.tmdb_id is null and b.tmdb_id is not null
           and pg_temp.zz_c2_norm(a.title_zh) <> ''
           and pg_temp.zz_c2_norm(a.title_zh) = pg_temp.zz_c2_norm(b.title_zh);
        if v_c = 0 then
          fails := fails || 'C2e/f ★ 故意造出來的重複作品沒有被抓到——C2e 那條述詞沒有鑑別力'::text;
        end if;
        delete from public.film where id = v_dup;
      end if;
    end if;
  end;

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
  -- ⚠️ 第一版寫的是「film → profile 的 SET NULL 外鍵**數量**必須是 1」，
  --    而 0012 加了 film.corrected_by（也指向 profile）之後它就紅了——
  --    紅的理由與它要守的東西完全無關。斷言要**指名欄位**，不要數數量：
  --    數量會被任何一個無關的新欄位改變，而那是假紅燈（§7 #104）。
  select count(*) into n from pg_constraint c
   where c.contype = 'f' and c.conrelid = 'public.film'::regclass
     and c.confrelid = 'public.profile'::regclass and c.confdeltype = 'n'
     and (select a.attname from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) = 'created_by';
  if n <> 1 then
    fails := fails || format('E5 film.created_by 不是 ON DELETE SET NULL（刪帳號會炸掉別人引用中的作品）');
  end if;

  -- ===========================================================================
  -- F. policy 與表級 GRANT 必須一致（§7 #132 的機器化）
  --
  --    這個家族已經出現三次了：
  --      · #84  business_days_between 的前身：INVOKER trigger 呼叫的 helper 只
  --             revoke 沒 grant ⇒ 使用者提不出回復通知
  --      · #106 ② film_delete_own_ugc 的 policy 對了但少 `grant delete`
  --      · #132 takedown_notice / counter_notice 的 `for all` staff policy 完全
  --             是裝飾品，因為 authenticated 對它們只有 SELECT / INSERT
  --    第四次應該由機器抓到，不是由人踩到。
  --
  -- ★ 但「policy 允許而 grant 沒給」**不一定是 bug**。這個專案的管理端寫入
  --   刻意走 SECURITY DEFINER RPC（踩雷 #26），所以那些表的直接寫入權**本來就
  --   不該給**——給了反而讓 staff 改得動 claimant_name、work_description 這類
  --   法遵證據。所以這條斷言檢查的不是「有沒有缺口」，是
  --   **「每一個缺口都是寫下來的決定」**。新出現一個沒寫下來的，就翻紅。
  --
  -- ⚠️ 要放行一個新缺口之前先問：真正的修法是補 grant、還是補一支 RPC、
  --   還是那條 policy 根本不該是 `for all`？把答案寫進 why 欄。
  -- ===========================================================================
  select string_agg(format('%s.%s 缺 %s（policy: %s）', 'public', g.tablename, g.priv, g.policies),
                    E'\n           ') into t
    from (
      select pol.tablename, pol.priv, string_agg(distinct pol.policyname, ', ') as policies
        from (
          select p.tablename, p.policyname, r.grantee, v.priv
            from pg_policies p
            cross join lateral unnest(p.roles) as r(grantee)
            cross join lateral unnest(
              case when p.cmd = 'ALL' then array['SELECT','INSERT','UPDATE','DELETE']
                   else array[p.cmd::text] end) as v(priv)
           where p.schemaname = 'public'
        ) pol
       where pol.grantee in ('anon', 'authenticated')
         and not has_table_privilege(pol.grantee, 'public.' || pol.tablename, pol.priv)
         and (pol.tablename, pol.grantee, pol.priv) not in (
           -- ── 刻意的缺口。每一列都要有理由。 ───────────────────────────
           -- 寫入一律走 admin_add_strike() / admin_restore()；三振是法遵證據，
           -- 直接 UPDATE 等於可以改寫別人被記過的時間。
           ('copyright_strike', 'authenticated', 'INSERT'),
           ('copyright_strike', 'authenticated', 'UPDATE'),
           ('copyright_strike', 'authenticated', 'DELETE'),
           -- forwarded_at 走 admin_forward_counter_notice()、restored_at 走
           -- admin_restore()。DELETE **永遠不給**：0001「取下是狀態不是 DELETE」。
           ('counter_notice', 'authenticated', 'UPDATE'),
           ('counter_notice', 'authenticated', 'DELETE'),
           -- notified_user_at 走 admin_notify_user()、status 走 admin_takedown()
           -- 與 admin_restore()。DELETE 同上，永遠不給。
           ('takedown_notice', 'authenticated', 'UPDATE'),
           ('takedown_notice', 'authenticated', 'DELETE'),
           -- 取下動作紀錄全部由 admin_takedown() / admin_restore() 寫。
           ('takedown_action', 'authenticated', 'INSERT'),
           ('takedown_action', 'authenticated', 'UPDATE'),
           ('takedown_action', 'authenticated', 'DELETE'),
           -- 0011：結案走 admin_resolve_report()（駁回強制填理由，
           -- 直接 UPDATE 會繞過那個檢查）。
           ('data_report', 'authenticated', 'UPDATE'),
           ('data_report', 'authenticated', 'DELETE'),
           -- profile 由 handle_new_user() 建、由 delete_my_account() 刪。
           -- ★ DELETE 尤其不能給：直接 delete profile 會留下 auth.users 那一列
           --   （殭屍帳號，§7 #111），而且跳過 username 進隔離那一步。
           ('profile', 'authenticated', 'INSERT'),
           ('profile', 'authenticated', 'DELETE'),
           ('profile_private', 'authenticated', 'INSERT'),
           ('profile_private', 'authenticated', 'DELETE')
         )
       group by 1, 2
    ) g;
  if t is not null then
    fails := fails || format('F1 有 policy 允許但表級 GRANT 沒給的組合，且不在刻意清單裡：%s%s',
                             E'\n           ', t);
  end if;

  -- ===========================================================================
  -- H. 月度季節性與「歷年每月平均」（0003）
  --
  --    這一組守的是一個**算錯了也完全看不出來**的東西：平均線的分母。
  --    分母寫成 12、或寫成「有資料的年份數」、或寫成「有那個月份紀錄的年份數」，
  --    畫出來都是一條合理的虛線，只是每個月都偏。
  -- ===========================================================================
  declare
    v_user_name text;
    v_all jsonb;
    v_one jsonb;
    v_year integer;
  begin
    select p.username into v_user_name from public.profile p order by p.created_at limit 1;
    if v_user_name is null then
      raise notice 'H 段略過：DB 內沒有 profile';
    else
      v_all := public.user_year_stats(v_user_name, null);
      select (v_all->'available_years'->>0)::integer into v_year;
      v_one := public.user_year_stats(v_user_name, v_year);

      -- H1 全期的 monthly 就是季節性序列 ⇒ 加總必須等於總筆數。
      --    少一格（例如把某個月份濾掉）在圖上看不出來，只有加總會露餡。
      select coalesce(sum((e->>'records')::integer), 0) into n
        from jsonb_array_elements(v_all->'monthly') e;
      if n <> (v_all->'totals'->>'records')::integer then
        fails := fails || format('H1 全期 monthly 加總 %s 與 totals.records %s 不符',
                                 n, v_all->'totals'->>'records');
      end if;

      -- H2 基準線一定是 12 格，而且每一格的分母至少 1（否則是除以零或負數）。
      if jsonb_array_length(v_all->'monthly_baseline') <> 12 then
        fails := fails || format('H2 monthly_baseline 不是 12 格（實得 %s）',
                                 jsonb_array_length(v_all->'monthly_baseline'));
      end if;
      select count(*) into n from jsonb_array_elements(v_all->'monthly_baseline') e
       where (e->>'years_observed')::integer < 1;
      if n <> 0 then
        fails := fails || format('H2 有 %s 個月份的曝光分母小於 1', n);
      end if;

      -- H3 avg_records 必須真的等於 records / years_observed。
      --    分母改錯時這一條不會紅（它只驗一致性），H4 才是驗分母語意的那一條。
      select count(*) into n from jsonb_array_elements(v_all->'monthly_baseline') e
       where round((e->>'records')::numeric / (e->>'years_observed')::numeric, 2)
             is distinct from (e->>'avg_records')::numeric;
      if n <> 0 then
        fails := fails || format('H3 有 %s 個月份的 avg_records 與 records/years_observed 對不起來', n);
      end if;

      -- H4 ★ 基準線**不得受 p_year 影響**。
      --    這是設計稿那條虛線的全部意義：單一年份時它是對照基準
      --    （「整年 N 場，比歷年平均的 X 場多／少」），所以它必須跨全部年份算。
      --    一旦有人把它接到被 p_year 過濾過的 rec 上，虛線就變成「今年自己的平均」
      --    ——那條線會永遠貼著實線，而且**看起來很合理**。
      if v_all->'monthly_baseline' is distinct from v_one->'monthly_baseline' then
        fails := fails || format('H4 ★ 指定年份(%s)時的 monthly_baseline 與全期不同（虛線被 p_year 過濾了）', v_year);
      end if;

      -- H6 ★ 曝光分母的**語意**。
      --
      --    H2/H3 只驗一致性，H4 只驗「沒被 p_year 過濾」——三條都不會抓到
      --    「分母寫成有資料的年份數」這個錯（實測：把 years_observed 一律改成 13
      --    之後 H1–H5 全綠，而每個月的平均都偏）。
      --
      --    這裡用一個**與實作無關**的不變量：十二個月份的曝光數加起來，
      --    必須恰好等於觀測窗口裡的月份總數。
      --      David 實測：12+12+13×7+12+12+12 = 151
      --      窗口 2014-03 → 2026-09 = (2026-2014)×12 + (9-3) + 1 = 151 ✅
      --    分母改成「一律 13」會得到 156，立刻紅。
      declare
        v_months integer;
        v_sum integer;
      begin
        select ((extract(year from w.m1) - extract(year from w.m0)) * 12
                + (extract(month from w.m1) - extract(month from w.m0)) + 1)::integer
          into v_months
          from (select date_trunc('month', min(r.watched_on))::date as m0,
                       greatest(date_trunc('month', max(r.watched_on))::date,
                                date_trunc('month', current_date)::date) as m1
                  from public.viewing_record r
                  join public.profile p on p.id = r.user_id
                 where p.username = v_user_name) w;

        select coalesce(sum((e->>'years_observed')::integer), 0) into v_sum
          from jsonb_array_elements(v_all->'monthly_baseline') e;

        if v_months is not null and v_sum <> v_months then
          fails := fails || format(
            'H6 ★ 曝光分母加總 %s 與觀測窗口的月份數 %s 不符（平均線的分母算錯了，而畫出來看不出來）',
            v_sum, v_months);
        end if;
      end;

      -- H5 對照：指定年份時 monthly 的加總必須等於那一年的筆數。
      --     沒有它，H4 在「兩邊都被過濾壞掉」時也會綠。
      select coalesce(sum((e->>'records')::integer), 0) into n
        from jsonb_array_elements(v_one->'monthly') e;
      if n <> (v_one->'totals'->>'records')::integer then
        fails := fails || format('H5 指定年份的 monthly 加總 %s 與該年 totals %s 不符',
                                 n, v_one->'totals'->>'records');
      end if;
    end if;
  end;

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
