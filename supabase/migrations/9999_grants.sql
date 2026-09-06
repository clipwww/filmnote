-- =============================================================================
-- 9999 — 權限：誰能存取什麼的唯一真相
--
-- ★ 這支永遠最後執行，且必須在每次新增公開物件後重跑。
--
-- 為什麼獨立成一支：
--   blanket revoke 隱含「下面這份清單就是全部的公開物件」這個不變量。若把它
--   留在 0001（一份設計成可重複執行的 migration），任何後續 migration 新增的
--   表或 view 都會破壞該不變量——單獨重跑 0001 就會把新物件的授權靜默撤銷，
--   前端拿到的是沒有上下文的 401。把新物件補進 0001 的清單只是把問題推到下一
--   支 migration，所以改為結構性解決：權限集中在這裡。
--
-- 新增公開表 / view 時，唯一要改的地方就是本檔的 grant 清單。
--
-- ⚠️ Supabase 的專案樣板自帶一份 pg_default_acl（實測 2026-09-05，PG 17.6）：
--      alter default privileges for role postgres in schema public
--        grant all     on tables    to anon, authenticated, service_role;
--        grant all     on sequences to anon, authenticated, service_role;
--        grant execute on functions to anon, authenticated, service_role;
--    ⇒ 每張新表出生就對 anon 有 arwdDxtm（含 DELETE/TRUNCATE），每支新函式出生
--      就對 anon 有 EXECUTE，而且是**直接授予 anon**、不經 PUBLIC。
--      只 `revoke … from public` 完全拿不掉。三個對象必須一起 revoke。
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 表與序列：先整塊收回，再逐一放行
--    ★ revoke 必須在 grant 之前，否則會把剛給的權限一起洗掉。
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;

grant usage on schema public to anon, authenticated;

-- 公開可讀（RLS 仍逐列把關；這裡只是「表級大門」）
grant select on public.profile, public.username, public.film, public.film_identity,
  public.film_tmdb_snapshot, public.certificate, public.venue, public.screening_format,
  public.viewing_record, public.viewing_record_cost, public.legal_document,
  public.film_public, public.viewing_record_public to anon, authenticated;

-- 0002 的場所選單 view。前端一律查它，不要直接查 venue——直接查會讓已歇業
-- 或海外的場所出現在「新增紀錄」的選單裡。
do $$ begin
  if to_regclass('public.venue_option') is not null then
    grant select on public.venue_option to anon, authenticated;
  else
    raise notice 'venue_option 尚不存在（0002 未套用），略過其 grant';
  end if;
end $$;

grant select on public.profile_private, public.film_merge_log, public.import_run,
  public.takedown_notice, public.counter_notice, public.copyright_strike,
  public.data_report, public.legal_acceptance to authenticated;

-- 0007 的條款竄改偵測 view。security_invoker ⇒ 沿用 legal_acceptance 的 RLS
-- （本人或 staff），所以一般使用者只看得到自己那幾筆有沒有對不上。
do $$ begin
  if to_regclass('public.legal_acceptance_drift') is not null then
    grant select on public.legal_acceptance_drift to authenticated;
  else
    raise notice 'legal_acceptance_drift 尚不存在（0007 未套用），略過其 grant';
  end if;
end $$;

-- 0006 的取下動作紀錄。RLS 是 staff-only，這裡只是表級大門。
do $$ begin
  if to_regclass('public.takedown_action') is not null then
    grant select on public.takedown_action to authenticated;
  else
    raise notice 'takedown_action 尚不存在（0006 未套用），略過其 grant';
  end if;
end $$;
grant insert, update, delete on public.viewing_record, public.viewing_record_cost to authenticated;
grant insert, update on public.film to authenticated;
-- 0008：作者刪除自建 UGC 作品。哪些列可刪由 film_delete_own_ugc policy 決定
-- （自己建的 + 仍 pending + 沒有任何 viewing_record 引用）。
grant delete on public.film to authenticated;
grant update on public.profile to authenticated;
grant insert on public.legal_acceptance, public.data_report, public.counter_notice to authenticated;
grant insert on public.takedown_notice to anon, authenticated;
grant update on public.profile_private, public.film, public.viewing_record to authenticated; -- staff policy 把關
grant select on public.tmdb_refresh_due to service_role;
grant usage on all sequences in schema public to authenticated;

-- -----------------------------------------------------------------------------
-- 2. 函式：同樣先整塊收回，再逐支放行
--    ★ 必須在所有 create function 之後——本檔永遠最後跑，所以這點自動成立。
--    實測：`alter default privileges … revoke execute … from public` **擋不住**
--    未來的函式（新函式的 proacl 會塌回 NULL ＝ 內建預設 ＝ PUBLIC 有 EXECUTE）。
--    唯一守得住的是本檔第 3 節的白名單檢查。
-- -----------------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- policy 內用到的 helper 必須對查詢角色開 EXECUTE，否則全站 403。
grant execute on function public.is_staff(), public.is_admin(),
  public.account_is_servable(uuid), public.owner_shows_cost(uuid),
  public.record_owner(uuid), public.record_is_public(uuid),
  public.film_usable_by(uuid, uuid), public.resolve_film(text),
  public.resolve_username(text), public.slugify(text),
  public.ugc_poster_film(text) to anon, authenticated;
grant execute on function public.rename_username(text),
  public.export_my_data() to authenticated;

-- 0009 的 US-47 帳號刪除。兩支都**不收參數** ⇒ 在結構上只能作用在呼叫者自己身上。
-- ⚠️ account_purgeable_films(uuid) 刻意**不出現在這份清單**：它收一個 uuid，
--    一旦對 authenticated 開放，任何人都能拿別人的 uuid 列舉對方的未審核作品 id
--    與海報路徑。它只被上面兩支 SECURITY DEFINER 函式在內部呼叫。
do $$ begin
  if to_regprocedure('public.delete_my_account()') is not null then
    grant execute on function public.delete_my_account(),
      public.account_deletion_preview() to authenticated;
    revoke execute on function public.account_purgeable_films(uuid)
      from public, anon, authenticated;
  else
    raise notice 'delete_my_account 尚不存在（0009 未套用），略過其 grant';
  end if;
end $$;

-- 0008 的 film_delete_own_ugc policy 用到的 helper。它是 DEFINER（否則 policy
-- 會遞迴，見 0008 的註解），而 policy 由 authenticated 觸發 ⇒ 必須對它開 EXECUTE，
-- 否則刪除會變成一句沒有上下文的 42501（踩雷 #84 的同一個家族）。
-- 不開給 anon：anon 沒有 DELETE 權限，也不該能探測哪些作品有紀錄。
do $$ begin
  if to_regprocedure('public.film_has_records(uuid)') is not null then
    grant execute on function public.film_has_records(uuid) to authenticated;
  else
    raise notice 'film_has_records 尚不存在（0008 未套用），略過其 grant';
  end if;
end $$;

-- ★ trigger 裡呼叫的 helper 也需要對「觸發它的那個人」開 EXECUTE。
--   `counter_notice_deadlines`（0001）是 SECURITY INVOKER 的 trigger，它呼叫
--   `business_days_after()` 來算 §90-9 的兩個法定期限。本檔第 2 節的 blanket
--   revoke 會把那支收掉 ⇒ **一般使用者提出回復通知時會拿到 42501**，而這件事
--   只有在真的有人被取下、又真的要主張未侵權時才會發生——也就是它最不能壞的時候。
--   實測 2026-09-06（Step 8 驗收）才發現。
--   函式本身是 IMMUTABLE 的純日期運算、不碰任何資料表，開給 authenticated 不外洩東西。
grant execute on function public.business_days_after(timestamptz, integer) to authenticated;

-- 0003 的年度統計。公開個人頁未登入也要看得到，故對 anon 開放。
-- 安全性不靠這道 grant，而靠函式本身是 SECURITY INVOKER：呼叫者看不到的紀錄
-- 進不了聚合。因此它也必須列進第 3 節的白名單，否則自我檢查會擋下整份 migration。
do $$ begin
  if to_regprocedure('public.user_year_stats(text, integer)') is not null then
    grant execute on function public.user_year_stats(text, integer) to anon, authenticated;
  else
    raise notice 'user_year_stats 尚不存在（0003 未套用），略過其 grant';
  end if;
end $$;
-- 0010 的 /u/ 年表全量聚合。與 user_year_stats 同一個模式：對 anon 開放 EXECUTE，
-- 安全性靠函式本身是 SECURITY INVOKER（呼叫者看不到的紀錄進不了聚合）。
-- 它必須同時列進第 3 節的白名單，否則自我檢查會擋下整份 migration。
do $$ begin
  if to_regprocedure('public.user_year_counts(text)') is not null then
    grant execute on function public.user_year_counts(text) to anon, authenticated;
  else
    raise notice 'user_year_counts 尚不存在（0010 未套用），略過其 grant';
  end if;
end $$;
grant execute on function public.merge_films(uuid, uuid, text),
  public.approve_film(uuid, boolean) to authenticated, service_role;

-- 0006 的取下／三振／回復。對 authenticated 開放，實際把關在函式內的
-- is_staff()——與 merge_films / approve_film 同一個模式：一般登入者呼叫會拿到
-- 42501，而不是靠「沒有 grant」擋（那會變成沒有上下文的 404）。
do $$ begin
  if to_regprocedure('public.admin_takedown(bigint, uuid, uuid, text)') is not null then
    grant execute on function public.admin_takedown(bigint, uuid, uuid, text),
      public.admin_add_strike(uuid, bigint, text),
      public.admin_restore(bigint, text) to authenticated, service_role;
  else
    raise notice '0006 的三支 admin RPC 尚不存在，略過其 grant';
  end if;
end $$;
grant execute on function public.link_film_to_tmdb(uuid, integer),
  public.apply_tmdb_snapshot(uuid), public.purge_expired_tmdb_cache(),
  public.seed_films(jsonb) to service_role;

-- -----------------------------------------------------------------------------
-- 3. 權限自我檢查 —— 新增 RPC 忘了 revoke 時讓 migration 失敗，而不是靜默裸奔
-- -----------------------------------------------------------------------------
do $$ declare bad text;
begin
  -- ★ 這條檢查不限 SECURITY DEFINER，而是「所有」anon/PUBLIC 可執行的函式。
  --   原因：實測 PG 17.6 上 `alter default privileges … revoke execute on functions
  --   from public` **無法**阻止未來新增的函式被 PUBLIC 執行（新函式的 proacl 會塌回
  --   NULL ＝ 內建預設 ＝ PUBLIC 有 EXECUTE）。§1.1 修正 B 的保證在 Supabase 上不成立，
  --   所以「哪些函式可以被匿名執行」只能靠這份顯式白名單守住。
  --   新增 RPC 時若忘了在 §15.5 revoke，這裡就會讓整份 migration 失敗。
  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.proname not in ('is_staff','is_admin','account_is_servable','owner_shows_cost',
                           'record_owner','record_is_public','film_usable_by','resolve_film',
                           'resolve_username','slugify','ugc_poster_film',
                           -- ★ SECURITY INVOKER。匿名可執行是刻意的（公開個人頁的統計），
                           --   RLS 仍逐列把關；改成 DEFINER 會讓這行變成全站資料外洩。
                           'user_year_stats',
                           -- 同上（0010）。只回筆數、完全不碰金額，且是 INVOKER。
                           'user_year_counts')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'));
  if bad is not null then raise exception '函式對 anon/PUBLIC 開放 EXECUTE：%', bad; end if;


  -- anon 的寫入權限應該只剩一項：§90-4 要求公告受理窗口，故未登入的著作權人
  -- 也能提交侵權通知。多出任何一項都代表 grant 清單寫錯了。
  select string_agg(table_name || ':' || privilege_type, ', ' order by table_name) into bad
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
     and not (table_name = 'takedown_notice' and privilege_type = 'INSERT');
  if bad is not null then raise exception 'anon 有非預期的寫入權限：%', bad; end if;

  -- 這幾張表對 anon 應該連表級大門都沒有
  select string_agg(distinct table_name, ', ') into bad
    from information_schema.role_table_grants
   where table_schema = 'public' and grantee = 'anon'
     and table_name in ('profile_private','import_run','film_merge_log','legal_acceptance',
                        'counter_notice','copyright_strike','data_report','tmdb_refresh_due',
                        'takedown_action');
  if bad is not null then raise exception 'anon 對非公開表仍有 grant：%', bad; end if;

  -- user_year_stats 一旦被改成 SECURITY DEFINER，RLS 就整個讓開，而它對 anon
  -- 開放 EXECUTE ⇒ 任何人都能把全站觀影紀錄與票價聚合出來。這條讓那個改動
  -- 在 migration 階段就失敗，而不是等到有人發現總花費多了一個零。
  -- 這兩支都對 anon 開放 EXECUTE。改成 SECURITY DEFINER 的話 RLS 整個讓開，
  -- 任何人都能把全站觀影紀錄聚合出來。讓那個改動在 migration 階段就失敗，
  -- 而不是等到有人發現總花費多了一個零。
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('user_year_stats', 'user_year_counts')
     and p.prosecdef;
  if bad is not null then
    raise exception '% 必須是 SECURITY INVOKER（聚合是推論通道，踩雷 #42）', bad;
  end if;

  -- US-47：delete_my_account 的安全性完全建立在「它沒有參數」上。有人日後為了
  -- 方便加一個 p_user uuid（例如給管理端點用），這支函式就從「只能刪自己」變成
  -- 「授權寫對才只能刪自己」，而授權判斷一定會有第二個呼叫端忘記寫。
  -- 讓那個改動在 migration 階段就失敗，而不是等到有人的帳號被別人刪掉。
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('delete_my_account','account_deletion_preview')
                and p.pronargs > 0) then
    raise exception 'delete_my_account / account_deletion_preview 不得有參數（US-47：它們只能作用在 auth.uid() 自己身上）';
  end if;

  -- account_purgeable_films(uuid) 收別人的 uuid ⇒ 對登入者開放就是列舉他人
  -- 未審核作品與海報路徑的通道。
  if to_regprocedure('public.account_purgeable_films(uuid)') is not null
     and (has_function_privilege('authenticated', 'public.account_purgeable_films(uuid)', 'execute')
          or has_function_privilege('anon', 'public.account_purgeable_films(uuid)', 'execute')) then
    raise exception 'account_purgeable_films(uuid) 不得對 anon/authenticated 開放 EXECUTE';
  end if;
end $$;
