-- =============================================================================
-- 0012 — 「照著改」的覆蓋層
--
-- adminui 的資料回報佇列上那顆鈕現在叫「受理，我會去修」而不是「照著改」，
-- 原因是**沒有地方可以寫修正而不被下次匯入洗掉**。這支補上那個地方。
--
-- ★ 主 session 已裁定：**不另建 overlay 表**，用 `source_authority` 既有的
--   `admin` 值。理由是 overlay 表會讓每一條讀取路徑都得套用它，而漏掉任何一條的
--   症狀是「有時看到修正後的、有時看到原始的」——那種不一致比一直顯示錯的還難查。
--
-- 政府原文完整保存在 `certificate` 的 3,116 列裡（每一張准演執照一列），
-- 所以「蓋掉 film.title_zh」不會讓原始資料消失。
--
-- ⚠️ 本檔寫到一半踩了 §7 #114 第二次：`text[] || '字串常值'` 會被解讀成
--    **陣列串接**（PostgreSQL 對未定型字串常值優先選 anyarray || anyarray），
--    錯誤是 `malformed array literal: "title_zh"`。一律寫 `|| 'x'::text`。
--    第一次是在斷言裡（只有該變紅時才炸），這次是在寫入端（一呼叫就炸）——
--    後者反而比較好，因為它立刻就被發現了。
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 先講清楚哪些欄位本來就不會被洗掉（實測 0001 的兩支函式）
--
--   seed_films() 的 **update 路徑**只碰三個欄位：
--     · title_zh            —— `case when title_zh_source = 'gov' then …` ⇒ 已受保護
--     · runtime_minutes     —— `coalesce(runtime_minutes, …)` ⇒ 只補 NULL，不覆寫
--     · first_seen_roc_year —— `least(…)` ⇒ 只會變小，不會被改成別的值
--   `country` / `title_original` **只在 INSERT 那一支寫**，update 路徑完全不碰。
--
--   apply_tmdb_snapshot() 碰四個：
--     · title_zh       —— `case when title_zh_source = 'tmdb' or title_zh = '' …`
--     · title_original —— `case when title_original_source = 'tmdb' or coalesce(...)='' …`
--     · runtime_minutes / release_year —— 都是 `coalesce(f.…, s.…)`，只補 NULL
--
-- ⇒ **機制早就在了，缺的是一個安全的入口。** 直接 `update film set title_zh = …`
--   而忘了把 `title_zh_source` 一起改成 'admin'，下一次重跑 seed 就洗掉了，
--   而且沒有任何錯誤訊息。所以修正必須走一支**同時寫值與寫來源**的 RPC。
--
-- ⚠️ 副作用要講明白：把 title_zh_source 設成 'admin' 之後，這一列就**永久脫離
--   政府資料的更新**。政府日後改了片名也不會同步過來。這是刻意的取捨，
--   而 admin_correct_film() 的回傳值會把它講出來，讓 UI 可以顯示。
-- -----------------------------------------------------------------------------

alter table public.film add column if not exists corrected_by uuid
  references public.profile (id) on delete set null;
alter table public.film add column if not exists corrected_at timestamptz;
alter table public.film add column if not exists correction_note text;

comment on column public.film.correction_note is
  '人工修正的理由。與 review_note（審核意見）分開：那一欄是對 UGC 作者說的，這一欄是對後來的維護者說的——「為什麼這一列脫離了政府資料」。';

-- -----------------------------------------------------------------------------
-- 2. admin_correct_film —— 唯一該被用來改片名的入口
--
-- ★ NULL 一律代表「這個欄位不要動」，不是「清空」。
--   清空片名沒有意義（title_zh 有 not null default ''，title_original 有
--   not blank 的 check），所以不需要哨兵值。
--
-- ★ p_report_id 給了就在**同一個交易**裡把那筆回報結案。
--   「照著改」是一個動作，不是兩個：分兩次呼叫的話，中間失敗會留下
--   「改了但回報還開著」或「回報結案了但沒改」，而兩者都沒有人會發現。
-- -----------------------------------------------------------------------------
create or replace function public.admin_correct_film(
  p_film uuid,
  p_title_zh text default null,
  p_title_original text default null,
  p_country text default null,
  p_note text default null,
  p_report_id bigint default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_before record;
  v_changed text[] := '{}';
  v_detached text[] := '{}';
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;

  select title_zh, title_zh_source, title_original, title_original_source, country
    into v_before from public.film where id = p_film;
  if not found then
    raise exception '找不到這部作品（id=%）', p_film using errcode = 'P0002'; end if;

  -- 修正一定要有理由。沒有理由的修正，下一個維護者看到 title_zh_source='admin'
  -- 只會知道「有人改過」，不知道為什麼，也就不敢改回去。
  if coalesce(btrim(p_note), '') = '' then
    raise exception '人工修正必須填寫理由' using errcode = '23514'; end if;

  if p_title_zh is not null and btrim(p_title_zh) <> '' then
    if btrim(p_title_zh) is distinct from v_before.title_zh then
      v_changed := v_changed || 'title_zh'::text;
      if v_before.title_zh_source <> 'admin' then
        v_detached := v_detached || 'title_zh'::text; end if;
    end if;
    update public.film
       set title_zh = btrim(p_title_zh), title_zh_source = 'admin'
     where id = p_film;
  end if;

  if p_title_original is not null and btrim(p_title_original) <> '' then
    if btrim(p_title_original) is distinct from v_before.title_original then
      v_changed := v_changed || 'title_original'::text;
      if v_before.title_original_source <> 'admin' then
        v_detached := v_detached || 'title_original'::text; end if;
    end if;
    update public.film
       set title_original = btrim(p_title_original), title_original_source = 'admin'
     where id = p_film;
  end if;

  -- country 沒有 *_source 欄位，但它也不需要：seed_films 的 update 路徑
  -- 根本不碰它（只有 INSERT 那一支寫）。所以直接改就是永久的。
  if p_country is not null then
    if nullif(btrim(p_country), '') is distinct from v_before.country then
      v_changed := v_changed || 'country'::text; end if;
    update public.film set country = nullif(btrim(p_country), '') where id = p_film;
  end if;

  update public.film
     set corrected_by = v_actor, corrected_at = now(),
         correction_note = p_note, updated_at = now()
   where id = p_film;

  -- 「照著改」是一個動作。回報的結案與修正必須同生共死。
  if p_report_id is not null then
    perform public.admin_resolve_report(p_report_id, 'accepted', p_note);
  end if;

  return jsonb_build_object(
    'film_id', p_film,
    'changed', to_jsonb(v_changed),
    -- ★ UI 要把這個講出來：這些欄位從此不再跟著政府／TMDB 更新。
    'detached_from_upstream', to_jsonb(v_detached),
    'report_resolved', p_report_id is not null);
end $$;

comment on function public.admin_correct_film(uuid, text, text, text, text, bigint) is
  '人工修正片名／國別，並把對應的 *_source 設成 admin ⇒ seed_films 與 apply_tmdb_snapshot 都不再覆寫。NULL 代表「不要動這個欄位」。給 p_report_id 就在同一個交易裡把回報結案。';

-- -----------------------------------------------------------------------------
-- 3. venue 這一半 —— 它比 film 更糟，因為完全沒有保護
--
-- 實測 `scripts/seed-supabase.ts` 的 seedVenues：
--     db.from('venue').upsert(batch, { onConflict: 'id' })
-- 那是**整列盲蓋**，涵蓋 name / company_name / hall_count / address / phone / city。
-- 也就是說 US-49/US-50 的影城更正一旦寫進去，下一次跑影城匯入就無聲消失，
-- 而回報者已經被告知「已受理並修正」。
--
-- ⚠️ status / selectable / sort_weight / closed_at **不在** upsert 的欄位清單裡，
--   所以「標記歇業」本來就不會被洗掉。要保護的只有上面那六個。
--
-- 做法與 film 不同：venue 有六個可能被改的欄位，開六個 *_source 欄位太重。
-- 改成一個 `curated_fields text[]`——記下「哪幾個欄位由人接管了」，
-- 而匯入端逐欄位判斷。
-- -----------------------------------------------------------------------------
alter table public.venue add column if not exists curated_fields text[] not null default '{}';
alter table public.venue add column if not exists corrected_by uuid
  references public.profile (id) on delete set null;
alter table public.venue add column if not exists corrected_at timestamptz;
alter table public.venue add column if not exists correction_note text;

do $$ begin
  alter table public.venue add constraint venue_curated_fields_known
    check (curated_fields <@ array['name','company_name','hall_count','address','phone','city']::text[]);
exception when duplicate_object then null; end $$;

comment on column public.venue.curated_fields is
  '由人工接管、匯入不得覆寫的欄位名。check 限定在 seedVenues 真的會寫的那六個——寫進一個匯入根本不碰的欄位名會讓人以為它受保護（例如 status，它本來就不會被覆寫）。';

/**
 * 影城匯入的唯一入口。與 seed_films 同一個模式：service context 專用、冪等。
 *
 * ★ 存在的理由不是「批次比較快」，是 `curated_fields` 的判斷**必須在 SQL 裡**。
 *   PostgREST 的 upsert 無法逐列決定要更新哪些欄位，所以只要匯入還走
 *   `.upsert()`，人工修正就一定會被蓋掉。
 */
create or replace function public.seed_venues(p_venues jsonb, p_import_id bigint default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare rec jsonb; n integer := 0;
begin
  if not public.is_service_context() then
    raise exception '僅限服務端' using errcode = '42501'; end if;

  for rec in select * from jsonb_array_elements(p_venues) loop
    insert into public.venue (id, kind, name, company_name, hall_count,
                              address, phone, city, raw, last_import_id, last_seen_at)
    values (rec->>'id', 'cinema', rec->>'name', coalesce(rec->>'company_name', ''),
            coalesce((rec->>'hall_count')::integer, 0), coalesce(rec->>'address', ''),
            coalesce(rec->>'phone', ''), coalesce(rec->>'city', ''),
            rec->'raw', p_import_id, now())
    on conflict (id) do update set
      -- ★ 逐欄位：被人接管的就保留原值。少寫任何一個 case，那個欄位的人工
      --   修正就會在下一次匯入時無聲消失。
      name         = case when 'name'         = any(public.venue.curated_fields) then public.venue.name         else excluded.name end,
      company_name = case when 'company_name' = any(public.venue.curated_fields) then public.venue.company_name else excluded.company_name end,
      hall_count   = case when 'hall_count'   = any(public.venue.curated_fields) then public.venue.hall_count   else excluded.hall_count end,
      address      = case when 'address'      = any(public.venue.curated_fields) then public.venue.address      else excluded.address end,
      phone        = case when 'phone'        = any(public.venue.curated_fields) then public.venue.phone        else excluded.phone end,
      city         = case when 'city'         = any(public.venue.curated_fields) then public.venue.city         else excluded.city end,
      -- raw 是「上游原樣」，永遠以上游為準：它存在的意義就是留下未經加工的來源。
      raw = excluded.raw,
      last_import_id = excluded.last_import_id,
      last_seen_at = excluded.last_seen_at,
      updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.admin_correct_venue(
  p_venue text,
  p_name text default null,
  p_city text default null,
  p_address text default null,
  p_phone text default null,
  p_note text default null,
  p_report_id bigint default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_changed text[] := '{}';
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;
  if not exists (select 1 from public.venue where id = p_venue) then
    raise exception '找不到這個場所（id=%）', p_venue using errcode = 'P0002'; end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception '人工修正必須填寫理由' using errcode = '23514'; end if;

  if p_name is not null and btrim(p_name) <> '' then
    update public.venue set name = btrim(p_name),
      curated_fields = (select array(select distinct unnest(curated_fields || 'name'::text)))
     where id = p_venue;
    v_changed := v_changed || 'name'::text;
  end if;
  if p_city is not null then
    update public.venue set city = btrim(p_city),
      curated_fields = (select array(select distinct unnest(curated_fields || 'city'::text)))
     where id = p_venue;
    v_changed := v_changed || 'city'::text;
  end if;
  if p_address is not null then
    update public.venue set address = btrim(p_address),
      curated_fields = (select array(select distinct unnest(curated_fields || 'address'::text)))
     where id = p_venue;
    v_changed := v_changed || 'address'::text;
  end if;
  if p_phone is not null then
    update public.venue set phone = btrim(p_phone),
      curated_fields = (select array(select distinct unnest(curated_fields || 'phone'::text)))
     where id = p_venue;
    v_changed := v_changed || 'phone'::text;
  end if;

  update public.venue set corrected_by = v_actor, corrected_at = now(),
         correction_note = p_note, updated_at = now()
   where id = p_venue;

  if p_report_id is not null then
    perform public.admin_resolve_report(p_report_id, 'accepted', p_note);
  end if;

  return jsonb_build_object('venue_id', p_venue, 'changed', to_jsonb(v_changed),
    'curated_fields', (select to_jsonb(curated_fields) from public.venue where id = p_venue),
    'report_resolved', p_report_id is not null);
end $$;

-- -----------------------------------------------------------------------------
-- 4. 授權（9999 才是權威）
-- -----------------------------------------------------------------------------
grant execute on function
  public.admin_correct_film(uuid, text, text, text, text, bigint),
  public.admin_correct_venue(text, text, text, text, text, text, bigint)
  to authenticated, service_role;
grant execute on function public.seed_venues(jsonb, bigint) to service_role;

-- -----------------------------------------------------------------------------
-- 5. 冒煙測試
--
-- ★ 這一段的重點**不是**「RPC 有沒有寫進去」，是「寫進去之後**重跑匯入**還在不在」。
--   只驗前者的話，覆蓋層看起來完全正常，直到某天有人重跑 seed 才發現全被洗掉——
--   而那時候沒有人會把兩件事連起來。
-- -----------------------------------------------------------------------------
do $$
declare
  v_staff uuid; v_film uuid; v_venue text; v_report bigint;
  v_key text; v_title text; blocked boolean;
begin
  begin
    select id into v_staff from public.profile order by created_at limit 1;
    if v_staff is null then raise notice '0012 冒煙測試略過：沒有 profile'; return; end if;
    update public.profile_private set role = 'admin' where id = v_staff;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

    -- ── film ────────────────────────────────────────────────────────────
    insert into public.film (title_zh, title_original, country, origin, visibility, review_state)
    values ('__smoke__0012政府原名', 'ORIGINAL', '日本', 'gov', 'public', 'approved')
    returning id into v_film;
    -- 匯入管線用 film_identity 的鍵找既有作品，所以要有一個
    v_key := 'gov:__smoke__0012';
    insert into public.film_identity (key, kind, film_id) values (v_key, 'gov', v_film);

    blocked := false;
    begin
      perform public.admin_correct_film(v_film, '__smoke__0012人工修正', null, null, null);
    exception when check_violation then blocked := true;
    end;
    if not blocked then
      raise exception '冒煙測試失敗：★ 沒有理由的人工修正竟然通過（下一個維護者不敢改回去）';
    end if;

    perform public.admin_correct_film(
      v_film, '__smoke__0012人工修正', null, '台灣', '回報說片名有錯字');

    if (select title_zh_source::text from public.film where id = v_film) <> 'admin' then
      raise exception '冒煙測試失敗：title_zh_source 沒有被設成 admin（下次 seed 就洗掉了）';
    end if;

    -- ★★ 真的重跑一次匯入，用**政府原本那個名字**
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', v_key, 'titleZh', '__smoke__0012政府原名', 'country', '日本')));
    select title_zh into v_title from public.film where id = v_film;
    if v_title <> '__smoke__0012人工修正' then
      raise exception '冒煙測試失敗：★ 重跑 seed_films 之後人工修正被洗掉了（實得 %）', v_title;
    end if;
    if (select country from public.film where id = v_film) <> '台灣' then
      raise exception '冒煙測試失敗：country 的人工修正被洗掉了';
    end if;

    -- ★★ 反向對照：**沒有**被人工修正的作品必須照樣被政府資料更新。
    --    少了這一組，上面那條在「seed_films 根本沒作用」時也會綠（§7 #102）。
    declare v_other uuid; v_other_key text := 'gov:__smoke__0012b';
    begin
      insert into public.film (title_zh, origin, visibility, review_state)
      values ('__smoke__0012舊名', 'gov', 'public', 'approved') returning id into v_other;
      insert into public.film_identity (key, kind, film_id) values (v_other_key, 'gov', v_other);
      perform public.seed_films(jsonb_build_array(jsonb_build_object(
        'id', v_other_key, 'titleZh', '__smoke__0012新名')));
      if (select title_zh from public.film where id = v_other) <> '__smoke__0012新名' then
        raise exception '冒煙測試失敗：★ 對照組——沒被人工修正的作品竟然也沒更新，代表 seed_films 這一段根本沒跑到';
      end if;
    end;

    -- ── venue ───────────────────────────────────────────────────────────
    v_venue := '99999999';
    insert into public.venue (id, kind, name, city, address, phone)
    values (v_venue, 'cinema', '__smoke__0012原名', '台北市', '原地址', '02-0000')
    on conflict (id) do update set name = excluded.name, city = excluded.city;

    perform public.admin_correct_venue(v_venue, '__smoke__0012正名', '新北市', null, null, '回報說影城名稱錯了');
    if (select name from public.venue where id = v_venue) <> '__smoke__0012正名' then
      raise exception '冒煙測試失敗：venue 的人工修正沒有寫進去';
    end if;

    -- ★★ 重跑影城匯入，用原本的名字
    perform public.seed_venues(jsonb_build_array(jsonb_build_object(
      'id', v_venue, 'name', '__smoke__0012原名', 'city', '台北市',
      'address', '上游地址', 'phone', '02-1111')));
    if (select name from public.venue where id = v_venue) <> '__smoke__0012正名' then
      raise exception '冒煙測試失敗：★ 重跑 seed_venues 之後影城名稱被洗回去了';
    end if;
    if (select city from public.venue where id = v_venue) <> '新北市' then
      raise exception '冒煙測試失敗：★ 影城城市被洗回去了';
    end if;
    -- 沒被接管的欄位必須照樣更新——否則整支 seed_venues 等於停擺
    if (select address from public.venue where id = v_venue) <> '上游地址' then
      raise exception '冒煙測試失敗：★ 對照組——沒被接管的 address 竟然沒更新，seed_venues 這一段沒跑到';
    end if;

    -- ── 「照著改」是一個交易 ────────────────────────────────────────────
    insert into public.data_report (reporter_id, subject_kind, subject_key, body)
    values (v_staff, 'film', v_key, '__smoke__0012 片名錯了') returning id into v_report;
    perform public.admin_correct_film(v_film, '__smoke__0012再修一次', null, null,
      '照著回報修正', v_report);
    if not exists (select 1 from public.data_report
                    where id = v_report and status = 'accepted' and resolved_at is not null) then
      raise exception '冒煙測試失敗：★ 修正了但回報沒有一起結案（回報者永遠看到 open）';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0012 冒煙測試通過（film／venue 的人工修正都撐過了重跑匯入，且各有反向對照；變更已回滾）';
end $$;
