-- =============================================================================
-- Step 8 驗收：§90-4 通知／取下／三振／回復流程
--
--   pnpm db:sql -- scripts/verify-dmca.sql
--
-- 整支包在 begin / rollback 裡，跑完不留任何資料。任何一條斷言不成立就 raise，
-- 而不是印一堆數字讓人自己看。
--
-- ★ 為什麼用 `set local role` + `set_config('request.jwt.claims', …)`：
--   那是唯一能在沒有瀏覽器的情況下模擬 PostgREST 身分的方法。**不要用
--   postgres 角色驗 RLS**——它有 bypassrls，你會看到全部資料然後以為 policy
--   沒壞（前任交接筆記 2.2）。
--
-- ★★ 切成 anon **必須同時清掉 request.jwt.claims**。`auth.uid()` 的定義是
--    讀 GUC，不是讀當前資料庫角色：
--        coalesce(current_setting('request.jwt.claim.sub'),
--                 current_setting('request.jwt.claims')::jsonb->>'sub')
--    只 `set local role anon` 而留著 claims，`auth.uid()` 照樣回傳那個使用者，
--    於是 `profile_read` 的 `id = auth.uid()` 分支成立——測試「以匿名身分讀不到」
--    會**通過，但通過的理由是假的**。這正是「驗證層本身會騙你」的一種。
--
-- ★ 借用既有 profile 同時扮演「被取下的使用者」與「staff」，只是為了不去動
--   auth.users。is_staff() 只看 role、與 service_status 無關，三振測試照樣成立。
-- =============================================================================

begin;

do $$
declare
  v_user uuid; v_venue text; v_film uuid; v_priv_film uuid; v_rec uuid;
  v_notice bigint; v_notice2 bigint; v_notice3 bigint;
  v_claims text;
  n integer; c integer; v_status text; v_vis text; v_mod text;
begin
  ---------------------------------------------------------------------------
  -- 準備
  ---------------------------------------------------------------------------
  select id into v_user from public.profile order by created_at limit 1;
  if v_user is null then raise exception '驗收中止：DB 內沒有任何 profile'; end if;
  select id into v_venue from public.venue order by id limit 1;
  if v_venue is null then raise exception '驗收中止：DB 內沒有任何 venue'; end if;

  v_claims := json_build_object('sub', v_user, 'role', 'authenticated')::text;

  update public.profile_private set role = 'admin' where id = v_user;
  update public.profile set show_cost = true where id = v_user;

  insert into public.film (title_zh, title_original, origin, visibility, review_state)
  values ('__dmca__公開片', '__dmca__public', 'gov', 'public', 'approved') returning id into v_film;

  -- 私密待審的 UGC 作品：用來證明回復不是寫死成 public
  insert into public.film (title_zh, origin, visibility, review_state, created_by)
  values ('__dmca__私密片', 'ugc', 'private', 'pending', v_user) returning id into v_priv_film;

  insert into public.viewing_record (user_id, film_id, venue_id, watched_on, visibility)
  values (v_user, v_film, v_venue, current_date - 1, 'public') returning id into v_rec;
  insert into public.viewing_record_cost (record_id, amount) values (v_rec, 380);

  insert into public.takedown_notice
    (claimant_name, claimant_email, work_description, target_url, statement_good_faith)
  values ('__dmca__原告', 'dmca@example.invalid', '海報', 'https://example.invalid/x', true)
  returning id into v_notice;

  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- A. 基準線：以 anon 身分，作品／紀錄／票價都看得到
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';

  if (select auth.uid()) is not null then
    raise exception 'A 失敗：切成 anon 之後 auth.uid() 仍非 null，這個測試是假的'; end if;

  select count(*) into n from public.film_public where id = v_film;
  if n <> 1 then raise exception 'A 失敗：anon 看不到基準線的公開作品'; end if;
  select count(*) into n from public.viewing_record_public where id = v_rec;
  if n <> 1 then raise exception 'A 失敗：anon 看不到基準線的公開紀錄'; end if;
  select count(*) into n from public.viewing_record_cost where record_id = v_rec;
  if n <> 1 then raise exception 'A 失敗：anon 看不到基準線的票價（show_cost 已開）'; end if;

  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- B. ★ 取下作品 → 引用它的紀錄與票價也一併消失
  --    （BUILD_PLAN §5 Step 8 說這是提案 1 漏掉的 join，必須實測）
  ---------------------------------------------------------------------------
  n := public.admin_takedown(v_notice, v_film, null, '驗收');
  if n <> 1 then raise exception 'B 失敗：admin_takedown 回傳 % 而非 1', n; end if;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.film_public where id = v_film;
  if n <> 0 then raise exception 'B 失敗：取下後 anon 仍看得到作品'; end if;
  select count(*) into n from public.viewing_record_public where id = v_rec;
  if n <> 0 then raise exception 'B 失敗：★ 取下作品後，引用它的公開紀錄沒有跟著消失'; end if;
  select count(*) into n from public.viewing_record_cost where record_id = v_rec;
  if n <> 0 then raise exception 'B 失敗：★ 取下作品後，該紀錄的票價沒有跟著消失'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- C. 回復 → 全部回來，且 visibility / moderation_state 原樣還原
  ---------------------------------------------------------------------------
  n := public.admin_restore(v_notice, '驗收');
  if n <> 1 then raise exception 'C 失敗：admin_restore 回傳 % 而非 1', n; end if;

  select visibility::text, moderation_state::text into v_vis, v_mod from public.film where id = v_film;
  if v_vis <> 'public' or v_mod <> 'visible' then
    raise exception 'C 失敗：作品沒有原樣回復（vis=%, mod=%）', v_vis, v_mod; end if;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.viewing_record_public where id = v_rec;
  if n <> 1 then raise exception 'C 失敗：回復後公開紀錄沒有回來'; end if;
  select count(*) into n from public.viewing_record_cost where record_id = v_rec;
  if n <> 1 then raise exception 'C 失敗：回復後票價沒有回來'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- D. ★ 私密待審作品被取下再回復，必須仍然是 private
  --    寫死成 public 的回復會把從未公開過的作品 publish 出去。
  ---------------------------------------------------------------------------
  insert into public.takedown_notice
    (claimant_name, claimant_email, work_description, target_url, statement_good_faith)
  values ('__dmca__原告2', 'dmca2@example.invalid', '海報', 'https://example.invalid/y', true)
  returning id into v_notice2;

  perform public.admin_takedown(v_notice2, v_priv_film, null, '驗收');
  perform public.admin_restore(v_notice2, '驗收');
  select visibility::text, moderation_state::text into v_vis, v_mod
    from public.film where id = v_priv_film;
  if v_vis <> 'private' or v_mod <> 'visible' then
    raise exception 'D 失敗：★ 私密作品回復後成了 %/%（應為 private/visible）', v_vis, v_mod;
  end if;

  ---------------------------------------------------------------------------
  -- E. 三振：第 3 次後 terminated，個人頁與全部公開紀錄立即不可讀
  ---------------------------------------------------------------------------
  c := public.admin_add_strike(v_user, v_notice, '1');
  select service_status::text into v_status from public.profile_private where id = v_user;
  if c <> 1 or v_status <> 'active' then
    raise exception 'E 失敗：第 1 次三振後 status=%（應為 active）', v_status; end if;

  c := public.admin_add_strike(v_user, v_notice, '2');
  select service_status::text into v_status from public.profile_private where id = v_user;
  if c <> 2 or v_status <> 'limited' then
    raise exception 'E 失敗：第 2 次三振後 status=%（應為 limited）', v_status; end if;

  c := public.admin_add_strike(v_user, v_notice2, '3');
  select service_status::text into v_status from public.profile_private where id = v_user;
  if c <> 3 or v_status <> 'terminated' then
    raise exception 'E 失敗：第 3 次三振後 status=%（應為 terminated）', v_status; end if;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.profile where id = v_user;
  if n <> 0 then raise exception 'E 失敗：帳號已終止，anon 仍讀得到個人頁'; end if;
  select count(*) into n from public.viewing_record_public where user_id = v_user;
  if n <> 0 then raise exception 'E 失敗：帳號已終止，anon 仍讀得到 % 筆公開紀錄', n; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- F. 回復會作廢該通知的三振，且帳號真的復活（不是沉默的半回復）
  --    v_notice 有 2 次、v_notice2 有 1 次。
  ---------------------------------------------------------------------------
  perform public.admin_restore(v_notice2, '驗收');
  select service_status::text into v_status from public.profile_private where id = v_user;
  if v_status <> 'limited' then
    raise exception 'F 失敗：撤銷 1 次後 status=%（應為 limited）', v_status; end if;

  perform public.admin_restore(v_notice, '驗收');
  select service_status::text, strike_count into v_status, c
    from public.profile_private where id = v_user;
  if v_status <> 'active' or c <> 0 then
    raise exception 'F 失敗：★ 三振全部撤銷後 status=%、strike_count=%（應為 active / 0）', v_status, c;
  end if;
  if (select suspended_at from public.profile_private where id = v_user) is not null then
    raise exception 'F 失敗：帳號已復活但 suspended_at 沒清掉'; end if;

  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  select count(*) into n from public.profile where id = v_user;
  if n <> 1 then raise exception 'F 失敗：帳號復活後 anon 仍讀不到個人頁'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- G. 一般登入者不能呼叫這三支（要拿到 42501，不是靜默成功）
  ---------------------------------------------------------------------------
  update public.profile_private set role = 'user' where id = v_user;
  begin
    perform public.admin_takedown(v_notice, v_film, null, '越權');
    raise exception 'G 失敗：非 staff 竟然可以呼叫 admin_takedown';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_add_strike(v_user, v_notice, '越權');
    raise exception 'G 失敗：非 staff 竟然可以呼叫 admin_add_strike';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.admin_restore(v_notice, '越權');
    raise exception 'G 失敗：非 staff 竟然可以呼叫 admin_restore';
  exception when insufficient_privilege then null;
  end;

  ---------------------------------------------------------------------------
  -- H. 侵權通知在 API 層是單向的：anon 可 INSERT、讀不到
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  insert into public.takedown_notice
    (claimant_name, claimant_email, work_description, target_url, statement_good_faith)
  values ('__dmca__anon', 'anon@example.invalid', 'x', 'https://example.invalid/z', true);
  -- 「讀不到」有兩種合格的形式，這裡兩種都接受：
  --   ① 42501 —— 表級沒有 SELECT grant（實測就是這一種，比 RLS 更早擋下）
  --   ② 0 列  —— 有 grant 但沒有 SELECT policy
  -- 不合格的只有第三種：真的讀到列。
  begin
    select count(*) into n from public.takedown_notice;
    if n <> 0 then raise exception 'H 失敗：anon 讀得到 % 筆侵權通知（應為 0）', n; end if;
    raise notice 'H：anon 有 select grant 但 policy 擋下（0 列）';
  exception when insufficient_privilege then
    raise notice 'H：anon 連表級 SELECT grant 都沒有（42501），比 RLS 更早擋下';
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- I. 回復通知流程（§90-9）
  --    /api/legal/counter-notice 完全靠這條鏈：當事人讀得到針對自己的通知
  --    → 才知道要對哪一件提回復 → 插入時 policy 認 profile_id = auth.uid()。
  --    ★ 端點的登入路徑沒辦法在這裡走完（拿不到真的 OAuth session），
  --      所以這一段驗的是端點依賴的那條 RLS 鏈。
  ---------------------------------------------------------------------------
  update public.profile_private set role = 'admin' where id = v_user;
  insert into public.takedown_notice
    (claimant_name, claimant_email, work_description, target_url, statement_good_faith)
  values ('__dmca__原告3', 'dmca3@example.invalid', '紀錄', 'https://example.invalid/r', true)
  returning id into v_notice3;
  perform public.admin_takedown(v_notice3, null, v_rec, '驗收');

  -- 切回一般登入者（非 staff）
  update public.profile_private set role = 'user' where id = v_user;
  execute 'set local role authenticated';

  select count(*) into n from public.takedown_notice where id = v_notice3;
  if n <> 1 then
    raise exception 'I 失敗：被取下的當事人讀不到針對自己的通知，回復通知流程走不下去'; end if;
  select count(*) into n from public.takedown_notice where id = v_notice;
  if n <> 0 then
    raise exception 'I 失敗：當事人讀得到與自己無關的通知（notice 指向的是 gov 作品）'; end if;

  insert into public.counter_notice (notice_id, profile_id, reason)
  values (v_notice3, v_user, '海報係熱連結自 TMDB，並未重製。');

  execute 'reset role';
  select count(*) into n from public.counter_notice
   where notice_id = v_notice3
     and litigation_deadline_at is not null and restore_deadline_at is not null
     and litigation_deadline_at > received_at
     and restore_deadline_at > litigation_deadline_at;
  if n <> 1 then
    raise exception 'I 失敗：§90-9 的兩個法定期限沒有被 trigger 算出來'; end if;

  raise notice '✅ Step 8 驗收全部通過（A–I）';
end $$;

rollback;
