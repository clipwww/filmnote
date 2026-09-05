-- =============================================================================
-- Step 7 驗收：管理端點背後的授權與合併不變量
--
--   pnpm db:sql -- scripts/verify-admin.sql
--
-- 整支包在 begin / rollback 裡，跑完不留任何資料。
--
-- ★ 範圍說明：這支驗的是**資料庫這一半**（approve_film / merge_films 的授權與
--   效果）。HTTP 那一半（Nuxt 端點的 cookie 驗身分、storage 的取檔與列舉）需要
--   一個真的 auth 使用者與真的 JWT，不能在 SQL 裡做——那部分是以臨時帳號
--   zzstep7@example.com 實打過的，結果記在 2026-09-06 的回報裡，帳號已刪除。
--
-- ★ 切成 anon / authenticated 時**必須同時設 request.jwt.claims**：`auth.uid()`
--   讀的是 GUC 不是資料庫角色。只 set local role 會讓斷言以假的理由通過
--   （與 verify-dmca.sql 同一個坑）。
-- =============================================================================

begin;

do $$
declare
  v_user uuid; v_venue text; v_loser uuid; v_winner uuid; v_rec uuid;
  v_claims text; n integer; v_vis text; v_state text; v_moved integer;
begin
  select id into v_user from public.profile order by created_at limit 1;
  if v_user is null then raise exception '驗收中止：DB 內沒有任何 profile'; end if;
  select id into v_venue from public.venue order by id limit 1;

  v_claims := json_build_object('sub', v_user, 'role', 'authenticated')::text;
  perform set_config('request.jwt.claims', v_claims, true);

  insert into public.film (title_zh, origin, visibility, review_state, created_by)
  values ('__admin__待審UGC', 'ugc', 'private', 'pending', v_user) returning id into v_loser;
  insert into public.film (title_zh, origin, visibility, review_state)
  values ('__admin__勝方', 'gov', 'public', 'approved') returning id into v_winner;
  insert into public.viewing_record (user_id, film_id, venue_id, watched_on, visibility)
  values (v_user, v_loser, v_venue, current_date - 3, 'public') returning id into v_rec;

  ---------------------------------------------------------------------------
  -- A. 一般登入使用者（is_staff() = false）不得審核、不得合併
  --    ★ BUILD_PLAN §1.1 記載：採用 current_user 判準時，這條實測回 204
  --      （合併成功）。那是真正被攻破過的一條，所以測的是**已登入者**
  --      而不是只測匿名。
  ---------------------------------------------------------------------------
  update public.profile_private set role = 'user' where id = v_user;
  execute 'set local role authenticated';

  begin
    perform public.approve_film(v_loser, true);
    raise exception 'A 失敗：一般使用者竟然可以審核';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';

  select visibility::text, review_state::text into v_vis, v_state
    from public.film where id = v_loser;
  if v_vis <> 'private' or v_state <> 'pending' then
    raise exception 'A 失敗：越權呼叫沒成功，但作品狀態卻變了（%/%）', v_vis, v_state; end if;

  ---------------------------------------------------------------------------
  -- B. 匿名同樣不得審核
  ---------------------------------------------------------------------------
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  execute 'set local role anon';
  if (select auth.uid()) is not null then
    raise exception 'B 失敗：切成 anon 後 auth.uid() 仍非 null，測試是假的'; end if;
  begin
    perform public.approve_film(v_loser, true);
    raise exception 'B 失敗：匿名竟然可以審核';
  exception when insufficient_privilege then null;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', v_claims, true);

  ---------------------------------------------------------------------------
  -- B2. ★ 這支腳本**測不了** merge_films 的授權，而且原因值得釘住
  --
  --     merge_films 的判準是 `is_service_context() or is_staff()`，而
  --     is_service_context() 的第一個條件是
  --         session_user in ('postgres','supabase_admin','supabase_storage_admin')
  --     `set local role` 只改 current_user，**session_user 不變**——直連時它
  --     永遠是 postgres。所以在這支腳本裡，不論切成 anon 還是 authenticated，
  --     merge_films 都會放行，而那是**正確的**（直連本來就是服務端情境）。
  --
  --     ⚠️ 危險在於：若把「模擬成 authenticated 後呼叫 merge_films」當成授權
  --        測試，它會回報破口重現——那是測試方法錯了，不是程式錯了。反過來
  --        寫（期望成功）則會給出一個永遠通過的假綠燈。
  --        真正的授權測試只能走真的 PostgREST + 真的使用者 JWT。
  --        實測結果（2026-09-06，臨時帳號 zzstep7@example.com）：
  --          一般登入使用者 → 403 / 42501「權限不足」
  --          匿名           → 401 / 42501「permission denied for function」
  --     這裡把「為什麼測不了」本身斷言起來，免得日後有人再加一次那個假測試。
  ---------------------------------------------------------------------------
  -- 直接斷言機制本身：session_user。（不呼叫 is_service_context()——它沒有對
  -- authenticated 開 EXECUTE，切換角色後呼叫會是 42501，那又是另一件事。）
  if session_user <> 'postgres' then
    raise exception 'B2 失敗：直連的 session_user 是 %（預期 postgres），本段推論需重驗', session_user;
  end if;
  execute 'set local role authenticated';
  if session_user <> 'postgres' then
    raise exception 'B2 失敗：set local role 竟然改變了 session_user（%），本段推論需重驗', session_user;
  end if;
  if current_user <> 'authenticated' then
    raise exception 'B2 失敗：set local role 沒有改變 current_user（%）', current_user;
  end if;
  execute 'reset role';

  ---------------------------------------------------------------------------
  -- C. staff 審核通過 → private/pending 變 public/approved
  --    （海報的可見性是這一步的副作用，由 ugc_poster_read policy 決定，
  --     不需要任何 storage 操作——那部分以真實 HTTP 驗過）
  ---------------------------------------------------------------------------
  update public.profile_private set role = 'moderator' where id = v_user;
  execute 'set local role authenticated';
  perform public.approve_film(v_loser, true);
  execute 'reset role';

  select visibility::text, review_state::text into v_vis, v_state
    from public.film where id = v_loser;
  if v_vis <> 'public' or v_state <> 'approved' then
    raise exception 'C 失敗：審核後狀態是 %/%（應為 public/approved）', v_vis, v_state; end if;

  ---------------------------------------------------------------------------
  -- D. staff 駁回 → 回到 private，且是可逆的（沒有檔案被搬走）
  ---------------------------------------------------------------------------
  execute 'set local role authenticated';
  perform public.approve_film(v_loser, false);
  execute 'reset role';
  select visibility::text, review_state::text into v_vis, v_state
    from public.film where id = v_loser;
  if v_vis <> 'private' or v_state <> 'rejected' then
    raise exception 'D 失敗：駁回後狀態是 %/%（應為 private/rejected）', v_vis, v_state; end if;

  -- 再通過一次，證明駁回不是單向門
  execute 'set local role authenticated';
  perform public.approve_film(v_loser, true);
  execute 'reset role';
  select visibility::text into v_vis from public.film where id = v_loser;
  if v_vis <> 'public' then raise exception 'D 失敗：駁回後無法再通過'; end if;

  ---------------------------------------------------------------------------
  -- E. 合併：一筆紀錄都不能不見
  --
  --    ⚠️ BUILD_PLAN §5 Step 7 第 4 點與 0001 §4 的表頭註解都寫「viewing_record
  --       一列都不動」。實作不是這樣，而且實作是對的：所有公開讀取路徑都要求
  --       `merged_into_film_id is null`，紀錄若還指著敗方就會整批從公開頁消失。
  --       使用者真正在乎的不變量是「紀錄不會不見」，所以這裡斷言的是那個。
  ---------------------------------------------------------------------------
  execute 'set local role authenticated';
  perform public.merge_films(v_loser, v_winner, '驗收：重複建立');
  execute 'reset role';

  select count(*) into n from public.viewing_record where id = v_rec and film_id = v_winner;
  if n <> 1 then raise exception 'E 失敗：紀錄沒有改指勝方（可能整筆不見了）'; end if;
  select count(*) into n from public.viewing_record where film_id = v_loser;
  if n <> 0 then raise exception 'E 失敗：仍有 % 筆紀錄指著敗方，它們會從公開頁消失', n; end if;
  select moved_records into v_moved from public.film_merge_log
    where loser_id = v_loser and winner_id = v_winner;
  if v_moved <> 1 then raise exception 'E 失敗：film_merge_log 記的 moved_records 是 %', v_moved; end if;
  if (select merged_into_film_id from public.film where id = v_loser) <> v_winner then
    raise exception 'E 失敗：敗方沒有被標記為已合併'; end if;
  -- 合併是冪等的：resolve_film 會沿著 merged_into_film_id 走到勝方
  if (select count(*) from public.film_identity where film_id = v_loser) <> 0 then
    raise exception 'E 失敗：film_identity 沒有改指勝方'; end if;

  raise notice '✅ Step 7 資料庫端驗收全部通過（A–E；merge_films 的授權見 B2，只能以真實 JWT 測）';
end $$;

rollback;
