-- =============================================================================
-- 0008 — ① 作者刪除自建 UGC 作品的 policy　② country 空字串正規化成 NULL
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. film 缺少作者的 DELETE policy
--
-- 0001 只有 film_read / film_insert_ugc / film_update_own_ugc / film_staff。
-- 使用者建了一部打錯字的 UGC 作品之後**沒有任何辦法移除它**——只能改，而且只在
-- pending 期間。這既是個產品缺口，也是為什麼別的 session 清不掉自己的測試作品。
--
-- ★ 三個條件必須同時成立，缺一不可：
--   ① created_by = auth.uid()  —— 只能刪自己建的
--   ② review_state = 'pending' —— 已核准的作品是片庫的一部分，不是個人物品；
--      而且它可能已經出現在別人的搜尋結果與紀錄裡
--   ③ **沒有任何 viewing_record 引用它** —— 這一條是硬的
--
-- 為什麼 ③ 不能省，即使 FK 已經是 on delete restrict：
--   靠 FK 擋，使用者會拿到一個沒有上下文的資料庫錯誤（23503），而且那是「刪除
--   請求送出去之後才失敗」。寫進 policy 則是這一列從一開始就不在可刪除的集合裡
--   ——UI 可以據此不顯示刪除鍵，而不是顯示了再讓它失敗。
--   更重要的是：**引用它的紀錄可能是別人的**。UGC 作品一經核准就對所有人可見，
--   別人可以拿它記錄自己的觀影。那時候刪除就不再是「收回自己的東西」，
--   而是破壞別人的資料。
--
-- ⚠️ policy 的 using 子句對「刪除當下」求值。若在同一個交易裡先刪紀錄再刪作品，
--    條件會成立——那是正確的，因為那時候真的沒有人引用它了。
-- -----------------------------------------------------------------------------
-- ⚠️ 引用檢查必須包成 SECURITY DEFINER 函式，不能直接寫在 policy 裡。
--    policy 內對 `viewing_record` 的子查詢會套用 `record_read`，而那條 policy
--    自己又 `exists (select 1 from film …)` ⇒ **infinite recursion detected in
--    policy for relation "film"**（實測，寫這支 migration 時第一版就是這樣炸的）。
--    0001 的 helper 全是 DEFINER 正是為了這件事，這裡沿用同一個模式。
create or replace function public.film_has_records(p_film uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.viewing_record r where r.film_id = p_film);
$$;

drop policy if exists film_delete_own_ugc on public.film;
create policy film_delete_own_ugc on public.film for delete to authenticated
  using (
    created_by = (select auth.uid())
    and origin = 'ugc'
    and review_state = 'pending'
    and merged_into_film_id is null
    and not (select public.film_has_records(film.id))
  );

-- ★ policy 只決定「哪些列」，表級 grant 才決定「能不能做這個動作」。
--   少了 DELETE grant，policy 寫得再對也只會得到 `permission denied for table film`
--   （實測，這支 migration 的冒煙測試第二版就是這樣炸的）。
--   9999 的清單裡也有一份——那才是權威；這裡再寫一次是為了讓本檔的冒煙測試
--   不依賴 9999 的執行順序。
grant delete on public.film to authenticated;

-- -----------------------------------------------------------------------------
-- 2. country 的空字串正規化成 NULL
--
-- 實測 2026-09-06：2,764 部作品裡有 35 列 `country = ''`。空字串與 NULL 在語意上
-- 是兩件事，而這裡明顯是「沒有資料」——它會在國別分布圖上多出一個空白分類，
-- 也會讓「從現有片庫的相異值長出來」的國別選單多出一個空選項。
--
-- ★ 連 `default ''` 一起拿掉，否則下一次 insert 又會生出一個空字串。
--   只跑 UPDATE 而不改 default，是那種「修好了但會自己長回來」的修法。
-- ★ 再加一條 check：讓空字串在結構上無法被表示，而不是靠每個寫入端記得。
-- -----------------------------------------------------------------------------
alter table public.film alter column country drop not null;
alter table public.film alter column country drop default;

update public.film set country = null where btrim(coalesce(country, '')) = '';

do $$ begin
  alter table public.film
    add constraint film_country_not_blank check (country is null or btrim(country) <> '');
exception when duplicate_object then null; end $$;

-- seed_films 原本寫 `coalesce(rec->>'country','')`，會把「沒有國別」寫成空字串，
-- 於是重跑 seed 就把上面那條 UPDATE 的成果洗掉，而且會撞上新的 check。
-- 改成 nullif：來源給空字串或沒給，一律落成 NULL。
do $$
declare src text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'seed_films';
  if src is null then
    raise notice 'seed_films 不存在，略過';
  elsif src like '%coalesce(rec->>''country'','''')%' then
    execute replace(src, 'coalesce(rec->>''country'','''')', 'nullif(rec->>''country'','''')');
    raise notice 'seed_films 的 country 已改為 nullif';
  else
    raise notice 'seed_films 的 country 已經不是 coalesce 版本，未改動';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. 冒煙測試（0005 的教訓：create/alter 都不保證東西真的會動）
--    包在有 EXCEPTION 子句的區塊裡 ⇒ 隱含 savepoint，跑完全部回滾。
-- -----------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_venue text; v_film uuid; v_rec uuid; n integer; blocked boolean := false;
begin
  begin
    select id into v_user from public.profile order by created_at limit 1;
    select id into v_venue from public.venue order by id limit 1;
    if v_user is null or v_venue is null then
      raise notice '冒煙測試略過：缺少 profile 或 venue'; return;
    end if;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_user, 'role', 'authenticated')::text, true);

    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0008', 'ugc', 'private', 'pending', v_user) returning id into v_film;

    -- ① 沒有引用時，作者刪得掉
    set local role authenticated;
    delete from public.film where id = v_film;
    get diagnostics n = row_count;
    reset role;
    if n <> 1 then raise exception '冒煙測試失敗：作者刪不掉自己的 pending UGC 作品'; end if;

    -- ② 有紀錄引用時，刪不掉（policy 讓它根本不在可刪除的集合裡）
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0008b', 'ugc', 'private', 'pending', v_user) returning id into v_film;
    insert into public.viewing_record (user_id, film_id, venue_id, watched_on)
    values (v_user, v_film, v_venue, current_date - 1) returning id into v_rec;

    set local role authenticated;
    delete from public.film where id = v_film;
    get diagnostics n = row_count;
    reset role;
    if n <> 0 then
      raise exception '冒煙測試失敗：★ 有紀錄引用時竟然刪得掉，會破壞別人的資料';
    end if;

    -- ③ country 的 check 真的擋得住空字串
    begin
      insert into public.film (title_zh, country, origin, visibility, review_state)
      values ('__smoke__0008c', '', 'gov', 'public', 'approved');
    exception when check_violation then blocked := true;
    end;
    if not blocked then
      raise exception '冒煙測試失敗：country 仍可寫入空字串';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0008 冒煙測試通過（刪除 policy 三條件 + country check，變更已回滾）';
end $$;
