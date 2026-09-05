-- 由 docs/BUILD_PLAN.md §1.2 產生。修改請同步該節，兩者不得漂移。
-- 相對於 docs/research/design 提案 3 的六項結構性修正見 docs/BUILD_PLAN.md §1.1。
-- =============================================================================
-- 影記 / filmnote — Supabase schema
-- 可重複執行（idempotent）。以 supabase db push 或 psql 一次跑完。
-- =============================================================================
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;
create extension if not exists unaccent with schema extensions;

-- -----------------------------------------------------------------------------
-- 0. 列舉型別 —— 一個型別一個 DO block。
--    擠在同一個 exception 區塊時，第一個 duplicate 會 abort 整塊，後面全部靜默跳過。
-- -----------------------------------------------------------------------------
do $$ begin create type public.visibility       as enum ('public','private');            exception when duplicate_object then null; end $$;
do $$ begin create type public.moderation_state as enum ('visible','withheld','removed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.review_state     as enum ('pending','approved','rejected');exception when duplicate_object then null; end $$;
do $$ begin create type public.film_origin      as enum ('gov','tmdb','ugc');             exception when duplicate_object then null; end $$;
do $$ begin create type public.source_authority as enum ('gov','tmdb','ugc','admin');     exception when duplicate_object then null; end $$;
do $$ begin create type public.venue_kind       as enum ('cinema','streaming','festival','home','other'); exception when duplicate_object then null; end $$;
do $$ begin create type public.venue_status     as enum ('active','closed','merged');     exception when duplicate_object then null; end $$;
do $$ begin create type public.account_role     as enum ('user','moderator','admin');     exception when duplicate_object then null; end $$;
do $$ begin create type public.service_status   as enum ('active','limited','terminated');exception when duplicate_object then null; end $$;
do $$ begin create type public.tmdb_cache_state as enum ('pending','fresh','failed','gone'); exception when duplicate_object then null; end $$;
do $$ begin create type public.identity_kind    as enum ('tmdb','gov','ugc','imdb','slug','legacy'); exception when duplicate_object then null; end $$;
do $$ begin create type public.notice_status    as enum ('received','rejected','actioned','counter_received','counter_forwarded','restored','litigation_notified'); exception when duplicate_object then null; end $$;
do $$ begin create type public.legal_doc_kind   as enum ('terms','privacy','copyright_policy'); exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- 1. 共用工具
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.slugify(src text)
returns text language sql immutable set search_path = '' as $$
  select nullif(trim(both '-' from regexp_replace(
    lower(extensions.unaccent(coalesce(src,''))), '[^a-z0-9]+', '-', 'g')), '');
$$;

-- 服務情境判定。兩個都不能用，理由不同：
--
--   ✗ auth.uid() is null      —— anon 的 uid 同樣是 NULL，等於對全世界關掉守門
--                                （docs/BUILD_PLAN.md §1.1 修正 A、踩雷 #30）
--   ✗ current_user in (…)     —— 在 SECURITY DEFINER 內 current_user 是**函式擁有者**
--                                (postgres)，任何拿得到 EXECUTE 的人都會被判成服務端
--                                （踩雷 #31）。§1.1 修正 A 採用了這個寫法，但它是錯的。
--
--   2026-09-05 實測（PG 17.6 / PostgREST）已證實可利用：
--     一般登入使用者（is_staff() = false）呼叫 rpc/merge_films → HTTP 204，
--     任意兩部作品被合併、敗方 visibility 被壓成 private。
--
--   ✓ 正解是兩個都不受 SECURITY DEFINER 影響的來源：
--     ① session_user —— 直連資料庫（migration / psql）時是 postgres；
--                        走 PostgREST 時一律是 authenticator，anon 與 service_role 皆然
--     ② PostgREST 依「已驗簽的 JWT」設定的 request.jwt.claims.role
--        使用者無法自行覆寫：他們只能呼叫我們逐支 grant 的 RPC，沒有任何一支呼叫 set_config
create or replace function public.is_service_context()
returns boolean language sql stable set search_path = '' as $$
  select session_user in ('postgres','supabase_admin','supabase_storage_admin')
      or coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           '') = 'service_role';
$$;

-- 法定期間以工作日計（只扣週末，不含國定假日 ⇒ 蓄意保守，期限只會更晚不會更早）
create or replace function public.business_days_after(start_ts timestamptz, n integer)
returns timestamptz language plpgsql immutable set search_path = '' as $$
declare d timestamptz := start_ts; k integer := n;
begin
  while k > 0 loop
    d := d + interval '1 day';
    if extract(isodow from (d at time zone 'Asia/Taipei')) < 6 then k := k - 1; end if;
  end loop;
  return d;
end $$;

-- -----------------------------------------------------------------------------
-- 2. 使用者 —— 公開身分與內部狀態分表
-- -----------------------------------------------------------------------------
create table if not exists public.profile (
  id           uuid primary key references auth.users (id) on delete cascade,
  username     text not null,
  display_name text,
  avatar_url   text,
  bio          text check (bio is null or length(bio) <= 500),
  show_cost    boolean not null default false,   -- ★ 預設不公開票價
  timezone     text not null default 'Asia/Taipei',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profile_username_shape check (
    username = lower(username) and username ~ '^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$')
);
comment on table public.profile is
  '此表刻意只放「本來就會出現在公開個人頁上的欄位」。role / service_status / 三振次數在 profile_private。';

create table if not exists public.profile_private (
  id             uuid primary key references public.profile (id) on delete cascade,
  role           public.account_role   not null default 'user',
  service_status public.service_status not null default 'active',
  strike_count   smallint not null default 0,
  suspended_at   timestamptz,
  deletion_requested_at timestamptz,
  updated_at     timestamptz not null default now()
);

create table if not exists public.username (
  name        text primary key,
  profile_id  uuid references public.profile (id) on delete cascade,
  kind        text not null check (kind in ('active','historical','reserved')),
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  constraint username_lower check (name = lower(name)),
  constraint username_owner check (
    (kind = 'reserved' and profile_id is null) or (kind <> 'reserved' and profile_id is not null))
);
create unique index if not exists username_one_active on public.username (profile_id) where kind = 'active';
create index if not exists username_profile_idx on public.username (profile_id);

insert into public.username (name, kind)
select unnest(array['u','api','admin','app','login','logout','confirm','auth','settings','about',
  'account','film','films','venue','venues','stats','legal','copyright','terms','privacy','dmca',
  'support','help','www','static','assets','_nuxt','sitemap','robots','new','import','export']), 'reserved'
on conflict (name) do nothing;

-- RLS 判斷用的 helper。SECURITY DEFINER 是為了讓 policy 讀 profile_private 而不遞迴。
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profile_private p
                  where p.id = auth.uid() and p.role in ('moderator','admin'));
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profile_private p where p.id = auth.uid() and p.role = 'admin');
$$;
create or replace function public.account_is_servable(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.service_status <> 'terminated' from public.profile_private p where p.id = uid), false);
$$;
create or replace function public.owner_shows_cost(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.show_cost from public.profile p where p.id = uid), false);
$$;

-- 新使用者：username 取 email @ 前綴，衝突時補流水號。
-- ★ 整段包 exception handler（docs/BUILD_PLAN.md §7.2 踩雷 #27）：
--   此 trigger 一旦 raise，Supabase 的註冊整筆失敗，使用者只看到
--   "Database error saving new user" 且完全無法登入。profile 缺列可事後補
--   （見下方 backfill），註冊失敗補不回來 —— 失敗方向必須指向「先讓人進得來」。
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base text; cand text; n integer := 0;
begin
  base := coalesce(nullif(regexp_replace(lower(split_part(new.email,'@',1)),'[^a-z0-9_-]','','g'),''),'user');
  base := left(base, 24);
  if length(base) < 2 then base := base || 'x'; end if;
  loop
    cand := case when n = 0 then base else base || n::text end;
    exit when not exists (select 1 from public.username u where u.name = cand);
    n := n + 1;
    if n > 10000 then cand := 'user' || replace(new.id::text, '-', ''); exit; end if;
  end loop;
  insert into public.profile (id, username) values (new.id, cand) on conflict (id) do nothing;
  insert into public.profile_private (id) values (new.id) on conflict (id) do nothing;
  insert into public.username (name, profile_id, kind) values (cand, new.id, 'active')
    on conflict (name) do nothing;
  return new;
exception when others then
  raise warning 'handle_new_user 失敗 (user=%): % —— 帳號仍建立，profile 待 backfill', new.id, sqlerrm;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill：Step 1 的骨架先於 schema 上線，那時登入的帳號沒有 profile 列。
-- 沒有 profile_private 的帳號 account_is_servable() 回 false ⇒ 個人頁對外消失、
-- 連自己都建不了紀錄。這段補齊並保持冪等，日後 trigger 萬一吞掉錯誤也靠它復原。
do $$ declare u record; base text; cand text; n integer;
begin
  for u in select id, email from auth.users
            where id not in (select id from public.profile) loop
    base := coalesce(nullif(regexp_replace(lower(split_part(u.email,'@',1)),'[^a-z0-9_-]','','g'),''),'user');
    base := left(base, 24);
    if length(base) < 2 then base := base || 'x'; end if;
    n := 0;
    loop
      cand := case when n = 0 then base else base || n::text end;
      exit when not exists (select 1 from public.username x where x.name = cand);
      n := n + 1;
    end loop;
    insert into public.profile (id, username) values (u.id, cand) on conflict (id) do nothing;
    insert into public.username (name, profile_id, kind) values (cand, u.id, 'active')
      on conflict (name) do nothing;
  end loop;
  insert into public.profile_private (id) select p.id from public.profile p
    on conflict (id) do nothing;
end $$;

-- 改名。舊名不刪除，改 kind 繼續佔位 ⇒ 舊網址可解析，且舊名不會被別人搶走。
create or replace function public.rename_username(p_new text)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); old_name text;
begin
  if uid is null then raise exception '需要登入' using errcode = '42501'; end if;
  p_new := lower(trim(p_new));
  if p_new !~ '^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$' then
    raise exception 'username 格式不合' using errcode = '23514'; end if;
  if exists (select 1 from public.username u where u.name = p_new
             and (u.kind = 'reserved' or u.profile_id is distinct from uid)) then
    raise exception 'username 已被使用' using errcode = 'unique_violation'; end if;
  select u.name into old_name from public.username u where u.profile_id = uid and u.kind = 'active';
  update public.username set kind = 'historical', released_at = now()
   where profile_id = uid and kind = 'active' and name <> p_new;
  insert into public.username (name, profile_id, kind) values (p_new, uid, 'active')
    on conflict (name) do update set kind = 'active', released_at = null;
  update public.profile set username = p_new, updated_at = now() where id = uid;
  return p_new;
end $$;

-- 301 用的單向解析：只回傳現用名，不回傳 user_id，不可列舉。
create or replace function public.resolve_username(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select p.username from public.username u join public.profile p on p.id = u.profile_id
   where u.name = lower(p_name) and u.kind in ('active','historical')
     and public.account_is_servable(p.id);
$$;

-- -----------------------------------------------------------------------------
-- 3. 匯入批次（provenance）
-- -----------------------------------------------------------------------------
create table if not exists public.import_run (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('gov_rating','gov_cinema','tmdb_refresh','legacy_log')),
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  source_url text, roc_year smallint, note text, stats jsonb,
  started_at timestamptz not null default now(), finished_at timestamptz
);

-- -----------------------------------------------------------------------------
-- 4. 作品
--    主鍵是內部 UUID；匯入管線那把確定性字串鍵放 film_identity。
--    合併因此退化成「改 identity 列指向」，viewing_record 一列都不動。
-- -----------------------------------------------------------------------------
create table if not exists public.film (
  id uuid primary key default extensions.gen_random_uuid(),
  tmdb_id integer unique,          -- ★ 必須 NULLABLE：實測 20% 台灣上映片 TMDB 找不到
  imdb_id text unique,
  title_zh text not null default '',
  title_zh_source public.source_authority not null default 'gov',
  title_original text not null default '',
  title_original_source public.source_authority not null default 'tmdb',
  country text not null default '', language text,
  runtime_minutes integer check (runtime_minutes is null or runtime_minutes between 1 and 1200),
  release_year smallint check (release_year is null or release_year between 1880 and 2200),
  first_seen_roc_year smallint,
  origin public.film_origin not null default 'gov',
  visibility public.visibility not null default 'public',
  review_state public.review_state not null default 'approved',
  moderation_state public.moderation_state not null default 'visible',
  created_by uuid references public.profile (id) on delete set null,
  ugc_poster_path text,
  slug text unique,
  merged_into_film_id uuid references public.film (id) on delete restrict,
  merged_at timestamptz,
  search_text text generated always as
    (lower(coalesce(title_zh,'') || ' ' || coalesce(title_original,''))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ★ 讓「公開但未審核」在結構上無法被表示
  constraint film_public_requires_approval check (visibility = 'private' or review_state = 'approved'),
  constraint film_ugc_review        check (origin = 'ugc' or review_state = 'approved'),
  constraint film_no_ugc_poster_when_tmdb check (ugc_poster_path is null or tmdb_id is null),
  constraint film_not_self_merged   check (merged_into_film_id is null or merged_into_film_id <> id),
  constraint film_merged_has_time   check ((merged_into_film_id is null) = (merged_at is null))
);
create index if not exists film_search_trgm on public.film using gin (search_text extensions.gin_trgm_ops);
create index if not exists film_public_idx on public.film (updated_at desc)
  where merged_into_film_id is null and visibility = 'public' and moderation_state = 'visible';
create index if not exists film_created_by_idx on public.film (created_by) where created_by is not null;
create index if not exists film_review_queue_idx on public.film (created_at) where review_state = 'pending';
drop trigger if exists film_touch on public.film;
create trigger film_touch before update on public.film for each row execute function public.touch_updated_at();

create table if not exists public.film_identity (
  key text primary key, kind public.identity_kind not null,
  film_id uuid not null references public.film (id) on delete cascade,
  is_primary boolean not null default false,
  assigned_at timestamptz not null default now(), note text,
  constraint film_identity_prefix check (key like kind::text || ':%')
);
create index if not exists film_identity_film_idx on public.film_identity (film_id);
create unique index if not exists film_identity_one_primary on public.film_identity (film_id, kind) where is_primary;

create or replace function public.film_assign_slug()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.slug is null then
    new.slug := left(coalesce(public.slugify(new.title_original), public.slugify(new.title_zh), 'film'), 48)
             || '-' || left(replace(new.id::text,'-',''), 8);
  end if;
  return new;
end $$;
drop trigger if exists film_slug on public.film;
create trigger film_slug before insert on public.film for each row execute function public.film_assign_slug();

create or replace function public.film_sync_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.tmdb_id is not null then
    insert into public.film_identity (key, kind, film_id, is_primary)
    values ('tmdb:'||new.tmdb_id,'tmdb',new.id,true) on conflict (key) do update set film_id = excluded.film_id; end if;
  if new.imdb_id is not null then
    insert into public.film_identity (key, kind, film_id, is_primary)
    values ('imdb:'||new.imdb_id,'imdb',new.id,true) on conflict (key) do update set film_id = excluded.film_id; end if;
  if new.slug is not null then
    insert into public.film_identity (key, kind, film_id, is_primary)
    values ('slug:'||new.slug,'slug',new.id,true) on conflict (key) do update set film_id = excluded.film_id; end if;
  return null;
end $$;
drop trigger if exists film_identity_sync on public.film;
create trigger film_identity_sync after insert or update of tmdb_id, imdb_id, slug on public.film
  for each row execute function public.film_sync_identity();

create or replace function public.resolve_film(p_key text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid; nx uuid; hop int := 0;
begin
  select fi.film_id into v from public.film_identity fi where fi.key = p_key;
  if v is null then return null; end if;
  loop select f.merged_into_film_id into nx from public.film f where f.id = v;
      exit when nx is null or hop >= 16; v := nx; hop := hop + 1; end loop;
  return v;
end $$;

-- -----------------------------------------------------------------------------
-- 5. TMDB 快取（分表 = 6 個月條款的關鍵：到期整列清空，film 本體毫髮無傷）
-- -----------------------------------------------------------------------------
create table if not exists public.film_tmdb_snapshot (
  film_id uuid primary key references public.film (id) on delete cascade,
  tmdb_id integer not null, state public.tmdb_cache_state not null default 'pending',
  title_zh text, title_original text, overview text,
  poster_path text, backdrop_path text,   -- 僅路徑；一律熱連結 image.tmdb.org
  runtime_minutes integer, release_date date, tw_release_date date,
  genre_ids integer[], payload jsonb,
  fetched_at timestamptz,
  expires_at timestamptz not null default (now() + interval '180 days'),  -- ★ 180 < 6 個月
  next_refresh_at timestamptz not null default now(),
  attempts smallint not null default 0, last_error text, etag text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists tmdb_refresh_queue_idx on public.film_tmdb_snapshot (next_refresh_at) where state <> 'gone';
create index if not exists tmdb_expiry_idx on public.film_tmdb_snapshot (expires_at);
drop trigger if exists tmdb_touch on public.film_tmdb_snapshot;
create trigger tmdb_touch before update on public.film_tmdb_snapshot for each row execute function public.touch_updated_at();

create or replace function public.apply_tmdb_snapshot(p_film_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (public.is_service_context() or public.is_staff()) then
    raise exception '權限不足' using errcode = '42501'; end if;
  update public.film f set
    title_zh = case when f.title_zh_source = 'tmdb' or f.title_zh = '' then coalesce(s.title_zh, f.title_zh) else f.title_zh end,
    title_original = case when f.title_original_source = 'tmdb' or f.title_original = '' then coalesce(s.title_original, f.title_original) else f.title_original end,
    runtime_minutes = coalesce(f.runtime_minutes, s.runtime_minutes),
    release_year = coalesce(f.release_year, extract(year from s.release_date)::smallint),
    updated_at = now()
  from public.film_tmdb_snapshot s where s.film_id = f.id and f.id = p_film_id and s.state = 'fresh';
end $$;

-- 到期清除。★ 不掛 pg_cron（免費專案閒置會暫停 ⇒ cron 不跑 ⇒ 快取變舊而無人知）。
-- 由 Vercel Cron 打 /api/cron/tmdb-purge，以 secret key 呼叫。即使完全沒跑，
-- 讀取端 view 的 expires_at 判斷也會讓逾期內容自動變成 NULL。
create or replace function public.purge_expired_tmdb_cache()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not public.is_service_context() then raise exception '僅限服務端' using errcode = '42501'; end if;
  update public.film_tmdb_snapshot set
    title_zh=null, title_original=null, overview=null, poster_path=null, backdrop_path=null,
    runtime_minutes=null, release_date=null, tw_release_date=null, genre_ids=null, payload=null, etag=null,
    -- ★ 顯式轉型不可省：三個分支全是常值時 CASE 會解析成 text，而 text → enum
    --   沒有隱含轉換 ⇒ 函式在**執行期**失敗（create function 不檢查函式體）。
    --   實測 2026-09-06 才發現，詳見 0005。
    state = (case when state = 'gone' then 'gone' else 'pending' end)::public.tmdb_cache_state,
    next_refresh_at = least(next_refresh_at, now())
  where expires_at <= now() and (payload is not null or poster_path is not null or overview is not null);
  get diagnostics n = row_count; return n;
end $$;

-- -----------------------------------------------------------------------------
-- 6. 核准紀錄（PK 沿用匯入管線的確定性複合鍵「年度:字號:正規化片名」）
-- -----------------------------------------------------------------------------
create table if not exists public.certificate (
  id text primary key,
  film_id uuid references public.film (id) on delete set null,
  permit_no text not null,                -- ★ 跨年度不唯一，僅為屬性
  roc_year smallint not null, gregorian_year smallint not null,
  rating text, title_zh text not null default '', title_original text not null default '',
  country text, language text, producer text,
  runtime_minutes integer, version_note text,
  defects text[] not null default '{}',
  raw jsonb,                              -- 原始列；日後改良解析可就地重算，不必重抓上游
  import_run_id bigint references public.import_run (id),
  created_at timestamptz not null default now()
);
create index if not exists certificate_film_idx on public.certificate (film_id);
create index if not exists certificate_year_idx on public.certificate (roc_year);
create index if not exists certificate_permit_idx on public.certificate (permit_no);

-- -----------------------------------------------------------------------------
-- 7. 場所與播放版本
-- -----------------------------------------------------------------------------
create table if not exists public.venue (
  id text primary key,                    -- 統一編號，或 virtual:<kind>
  kind public.venue_kind not null,
  name text not null, company_name text not null default '',
  hall_count integer not null default 0 check (hall_count >= 0),
  address text not null default '', phone text not null default '', city text not null default '',
  lat double precision, lng double precision,
  status public.venue_status not null default 'active',
  merged_into_venue_id text references public.venue (id) on delete restrict,
  closed_at timestamptz, sort_weight smallint not null default 0, raw jsonb,
  last_import_id bigint references public.import_run (id),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint venue_id_shape check (id ~ '^[0-9]{8}$' or id like 'virtual:%' or id like 'ugc:%'),
  constraint venue_virtual_matches_kind check (
    id !~ '^virtual:' or id = 'virtual:' || kind::text),
  constraint venue_not_self_merged check (merged_into_venue_id is null or merged_into_venue_id <> id)
);
create index if not exists venue_city_idx on public.venue (city) where status = 'active';
create index if not exists venue_name_trgm on public.venue using gin (name extensions.gin_trgm_ops);
drop trigger if exists venue_touch on public.venue;
create trigger venue_touch before update on public.venue for each row execute function public.touch_updated_at();

-- ★ 這四列必須在 CHECK 生效的同一份 migration 內就存在，否則 US-7 第一天就壞。
insert into public.venue (id, kind, name, sort_weight) values
  ('virtual:streaming','streaming','串流平台',-10),
  ('virtual:festival','festival','影展',-9),
  ('virtual:home','home','家中',-8),
  ('virtual:other','other','其他',-7)
on conflict (id) do nothing;

create table if not exists public.screening_format (
  code text primary key, label text not null,
  sort_order smallint not null default 100, active boolean not null default true);
insert into public.screening_format (code,label,sort_order) values
  ('digital','數位',10),('imax','IMAX',20),('imax_laser','IMAX Laser',25),('3d','3D',30),
  ('4dx','4DX',40),('screenx','ScreenX',50),('dolby','Dolby Cinema',60),
  ('film_35','35mm 膠卷',70),('other','其他',999)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 8. 觀影紀錄
--    時間存「台北牆上時間」：watched_on date + watched_time time（+ tz 備用）。
--    ① 使用者說的是當地日期，貢獻圖與時段熱力圖零時區換算
--    ② 舊資料常只有日期，硬塞 timestamptz 會捏造出假的 00:00
-- -----------------------------------------------------------------------------
create table if not exists public.viewing_record (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.profile (id) on delete cascade,
  film_id uuid not null references public.film (id) on delete restrict,
  venue_id text not null references public.venue (id) on delete restrict,
  watched_on date not null,
  watched_time time,
  tz text not null default 'Asia/Taipei',
  ticket_count smallint check (ticket_count is null or ticket_count between 1 and 99),
  hall_label text check (hall_label is null or length(hall_label) <= 40),
  format_code text references public.screening_format (code),
  format_note text, memo text check (memo is null or length(memo) <= 2000),
  visibility public.visibility not null default 'public',
  moderation_state public.moderation_state not null default 'visible',
  import_key text,                        -- 舊 log 專案的來源鍵，供冪等重跑
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint viewing_record_sane_date check (watched_on >= date '1895-12-28')
);
create unique index if not exists viewing_record_import_key_uniq
  on public.viewing_record (user_id, import_key) where import_key is not null;
create index if not exists viewing_record_owner_idx
  on public.viewing_record (user_id, watched_on desc, watched_time desc nulls last);
create index if not exists viewing_record_film_public_idx
  on public.viewing_record (film_id, watched_on desc)
  where visibility = 'public' and moderation_state = 'visible';
create index if not exists viewing_record_venue_idx on public.viewing_record (venue_id);
drop trigger if exists vr_touch on public.viewing_record;
create trigger vr_touch before update on public.viewing_record for each row execute function public.touch_updated_at();

create or replace function public.guard_record_date()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.watched_on > ((now() at time zone coalesce(new.tz,'Asia/Taipei'))::date + 1) then
    raise exception '觀影日期不得為未來' using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists vr_date_guard on public.viewing_record;
create trigger vr_date_guard before insert or update of watched_on on public.viewing_record
  for each row execute function public.guard_record_date();

-- ---- 票價獨立成表 -----------------------------------------------------------
-- RLS 只能遮「列」不能有條件地遮「欄」。把 cost 變成獨立的一列，
-- show_cost 這條規則才由資料庫本身強制執行，而不是靠每支 API 記得把欄位拿掉。
create table if not exists public.viewing_record_cost (
  record_id uuid primary key references public.viewing_record (id) on delete cascade,
  amount numeric(12,2) not null check (amount >= 0),
  currency char(3) not null default 'TWD',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
drop trigger if exists vrc_touch on public.viewing_record_cost;
create trigger vrc_touch before update on public.viewing_record_cost for each row execute function public.touch_updated_at();

create or replace function public.record_owner(p_record uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select user_id from public.viewing_record where id = p_record; $$;

-- 完整判準：紀錄公開 且 作品公開未取下未合併 且 作者未被終止服務
create or replace function public.record_is_public(p_record uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.viewing_record r
    join public.film f on f.id = r.film_id
    where r.id = p_record
      and r.visibility = 'public' and r.moderation_state = 'visible'
      and f.visibility = 'public' and f.moderation_state = 'visible' and f.merged_into_film_id is null
      and public.account_is_servable(r.user_id)); $$;

create or replace function public.film_usable_by(p_film uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.film f where f.id = p_film
    and f.moderation_state <> 'removed' and f.merged_into_film_id is null
    and (f.visibility = 'public' or f.created_by = p_user)); $$;

-- -----------------------------------------------------------------------------
-- 9. 合併與審核（僅保留三支真正必要的 admin RPC）
-- -----------------------------------------------------------------------------
create table if not exists public.film_merge_log (
  id bigint generated always as identity primary key,
  loser_id uuid not null references public.film (id) on delete restrict,
  winner_id uuid not null references public.film (id) on delete restrict,
  performed_by uuid references public.profile (id) on delete set null,
  reason text, moved_records integer not null default 0,
  snapshot jsonb, created_at timestamptz not null default now());

create or replace function public.merge_films(p_loser uuid, p_winner uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not (public.is_service_context() or public.is_staff()) then
    raise exception '權限不足' using errcode = '42501'; end if;   -- ★ 不再用 auth.uid() is null
  if p_loser = p_winner then raise exception '不可合併至自身'; end if;
  update public.viewing_record set film_id = p_winner, updated_at = now() where film_id = p_loser;
  get diagnostics n = row_count;
  update public.certificate set film_id = p_winner where film_id = p_loser;
  update public.film_identity set film_id = p_winner, is_primary = false where film_id = p_loser;
  insert into public.film_merge_log (loser_id, winner_id, performed_by, reason, moved_records, snapshot)
    values (p_loser, p_winner, auth.uid(), p_reason, n,
            (select to_jsonb(f) from public.film f where f.id = p_loser));
  update public.film set merged_into_film_id = p_winner, merged_at = now(),
         visibility = 'private', updated_at = now() where id = p_loser;
end $$;

create or replace function public.link_film_to_tmdb(p_film uuid, p_tmdb integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing uuid;
begin
  if not (public.is_service_context() or public.is_staff()) then
    raise exception '權限不足' using errcode = '42501'; end if;
  select id into existing from public.film where tmdb_id = p_tmdb;
  if existing is not null and existing <> p_film then
    perform public.merge_films(p_film, existing, 'tmdb 事後比對命中'); return existing; end if;
  update public.film set tmdb_id = p_tmdb, origin = case when origin = 'ugc' then 'tmdb' else origin end,
         ugc_poster_path = null, updated_at = now() where id = p_film;
  insert into public.film_tmdb_snapshot (film_id, tmdb_id) values (p_film, p_tmdb)
    on conflict (film_id) do update set tmdb_id = excluded.tmdb_id, next_refresh_at = now();
  return p_film;
end $$;

-- UGC private → public 的唯一入口
create or replace function public.approve_film(p_film uuid, p_approve boolean default true)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception '權限不足' using errcode = '42501'; end if;
  if p_approve then
    update public.film set review_state = 'approved', visibility = 'public', updated_at = now()
     where id = p_film and merged_into_film_id is null;
  else
    update public.film set review_state = 'rejected', visibility = 'private', updated_at = now()
     where id = p_film;
  end if;
end $$;

-- 匯入管線的批次 upsert（唯一的 seed 用 RPC；service_role 專用、冪等）
create or replace function public.seed_films(p_films jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare rec jsonb; fid uuid; n integer := 0;
begin
  if not public.is_service_context() then raise exception '僅限服務端' using errcode = '42501'; end if;
  for rec in select * from jsonb_array_elements(p_films) loop
    fid := public.resolve_film(rec->>'id');
    if fid is null and (rec->>'tmdbId') is not null then
      fid := public.resolve_film('tmdb:' || (rec->>'tmdbId')); end if;
    if fid is null then
      insert into public.film (tmdb_id, title_zh, title_original, country, runtime_minutes,
                               first_seen_roc_year, origin, review_state, visibility)
      values ((rec->>'tmdbId')::integer, coalesce(rec->>'titleZh',''), coalesce(rec->>'titleOriginal',''),
              coalesce(rec->>'country',''), (rec->>'runtimeMinutes')::integer,
              (rec->>'firstSeenRocYear')::smallint,
              (coalesce(rec->>'source','gov'))::public.film_origin, 'approved', 'public')
      returning id into fid;
    else
      update public.film set
        title_zh = case when title_zh_source = 'gov' then coalesce(nullif(rec->>'titleZh',''), title_zh) else title_zh end,
        runtime_minutes = coalesce(runtime_minutes, (rec->>'runtimeMinutes')::integer),
        first_seen_roc_year = least(coalesce(first_seen_roc_year, 9999), (rec->>'firstSeenRocYear')::smallint),
        updated_at = now() where id = fid;
    end if;
    insert into public.film_identity (key, kind, film_id)
    values (rec->>'id', (split_part(rec->>'id', ':', 1))::public.identity_kind, fid)
      on conflict (key) do update set film_id = excluded.film_id;
    if (rec->>'tmdbId') is not null then
      insert into public.film_tmdb_snapshot (film_id, tmdb_id) values (fid, (rec->>'tmdbId')::integer)
        on conflict (film_id) do nothing; end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- 10. 法遵資料表（流程與頁面在計畫後半部；此處只建結構）
--     ★ 取下是「狀態」不是 DELETE —— 刪掉就永遠無法履行 §90-9 的回復義務。
-- -----------------------------------------------------------------------------
create table if not exists public.legal_document (
  id bigint generated always as identity primary key,
  kind public.legal_doc_kind not null, version text not null,
  effective_at timestamptz not null default now(), body_md text not null,
  unique (kind, version));
create table if not exists public.legal_acceptance (
  profile_id uuid not null references public.profile (id) on delete cascade,
  document_id bigint not null references public.legal_document (id) on delete restrict,
  accepted_at timestamptz not null default now(), primary key (profile_id, document_id));
create table if not exists public.takedown_notice (
  id bigint generated always as identity primary key,
  status public.notice_status not null default 'received',
  claimant_name text not null, claimant_email text not null, claimant_phone text,
  work_description text not null, target_url text not null,
  target_film_id uuid references public.film (id) on delete set null,
  target_record_id uuid references public.viewing_record (id) on delete set null,
  statement_good_faith boolean not null default false,
  received_at timestamptz not null default now(), actioned_at timestamptz,
  handled_by uuid references public.profile (id) on delete set null, note text);
create table if not exists public.counter_notice (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.takedown_notice (id) on delete cascade,
  profile_id uuid not null references public.profile (id) on delete cascade,
  reason text not null, received_at timestamptz not null default now(),
  forwarded_at timestamptz,
  -- §90-9：著作權人 10 個工作日內未提訴訟證明 → 須於 14 個工作日內回復
  litigation_deadline_at timestamptz, restore_deadline_at timestamptz, restored_at timestamptz);
create or replace function public.counter_notice_deadlines()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.litigation_deadline_at := public.business_days_after(coalesce(new.forwarded_at, new.received_at), 10);
  new.restore_deadline_at    := public.business_days_after(coalesce(new.forwarded_at, new.received_at), 14);
  return new;
end $$;
drop trigger if exists counter_deadlines on public.counter_notice;
create trigger counter_deadlines before insert or update of forwarded_at on public.counter_notice
  for each row execute function public.counter_notice_deadlines();
create table if not exists public.copyright_strike (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profile (id) on delete cascade,
  notice_id bigint references public.takedown_notice (id) on delete set null,
  created_at timestamptz not null default now(), revoked_at timestamptz, note text);
create or replace function public.apply_three_strikes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c integer;
begin
  select count(*) into c from public.copyright_strike
   where profile_id = new.profile_id and revoked_at is null;
  update public.profile_private set strike_count = c,
    service_status = case when c >= 3 then 'terminated' when c = 2 then 'limited' else service_status end,
    suspended_at = case when c >= 3 then now() else suspended_at end, updated_at = now()
   where id = new.profile_id;
  return null;
end $$;
drop trigger if exists strike_apply on public.copyright_strike;
create trigger strike_apply after insert or update on public.copyright_strike
  for each row execute function public.apply_three_strikes();
create table if not exists public.data_report (
  id bigint generated always as identity primary key,
  reporter_id uuid references public.profile (id) on delete set null,
  subject_kind text not null check (subject_kind in ('film','venue')),
  subject_key text not null, body text not null,
  status text not null default 'open' check (status in ('open','accepted','rejected')),
  created_at timestamptz not null default now());

-- -----------------------------------------------------------------------------
-- 11. 公開讀取用的 view（全部 security_invoker）
-- -----------------------------------------------------------------------------
create or replace view public.film_public with (security_invoker = true) as
select f.id, f.slug, f.tmdb_id, f.imdb_id, f.title_zh, f.title_original, f.country, f.language,
       f.runtime_minutes, f.release_year, f.first_seen_roc_year, f.origin, f.ugc_poster_path,
       case when s.expires_at > now() then s.poster_path end   as tmdb_poster_path,
       case when s.expires_at > now() then s.backdrop_path end as tmdb_backdrop_path,
       case when s.expires_at > now() then s.overview end      as overview,
       case when s.expires_at > now() then s.tw_release_date end as tw_release_date,
       f.updated_at,
       -- 搜尋用。內容是 lower(title_zh || ' ' || title_original) 的 generated column，
       -- 兩個欄位本來就公開，所以不外洩任何東西；曝露它是為了讓 `like` 走得到
       -- film_search_trgm（gin_trgm_ops）。實測 2,669 列：走索引 4 個 buffer，
       -- 對 title_zh / title_original 各做 ilike 則是 seq scan、144 個 buffer。
       f.search_text
from public.film f left join public.film_tmdb_snapshot s on s.film_id = f.id
where f.merged_into_film_id is null and f.visibility = 'public' and f.moderation_state = 'visible';
comment on view public.film_public is
  'TMDB 內容以 expires_at 於讀取時把關：排程失敗時過期欄位自動變 NULL（退回文字卡片），而不是續供逾期快取。';

create or replace view public.viewing_record_public with (security_invoker = true) as
select r.id, r.user_id, p.username, r.film_id, r.venue_id, r.watched_on, r.watched_time, r.tz,
       r.ticket_count, r.hall_label, r.format_code, r.format_note, r.memo,
       c.amount as cost_amount, c.currency as cost_currency,   -- RLS 未放行時自然為 NULL
       r.created_at
from public.viewing_record r
join public.profile p on p.id = r.user_id
left join public.viewing_record_cost c on c.record_id = r.id
where r.visibility = 'public' and r.moderation_state = 'visible';

create or replace view public.tmdb_refresh_due with (security_invoker = true) as
select s.film_id, s.tmdb_id, s.etag, s.attempts, s.expires_at, s.next_refresh_at
from public.film_tmdb_snapshot s join public.film f on f.id = s.film_id
where s.state <> 'gone' and f.merged_into_film_id is null and s.next_refresh_at <= now()
order by s.expires_at asc nulls first;

-- -----------------------------------------------------------------------------
-- 12. RLS
--     ★ 所有 STABLE 函式呼叫包成 (select ...) 讓 planner 提成 InitPlan（只求值一次）。
--     ★ 絕不對 SELECT 做欄位級 revoke —— 會讓 PostgREST 的 select=* 直接 403。
-- -----------------------------------------------------------------------------
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;

-- profile
drop policy if exists profile_read on public.profile;
create policy profile_read on public.profile for select to anon, authenticated
  using ((select public.account_is_servable(id)) or id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists profile_update_self on public.profile;
create policy profile_update_self on public.profile for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
drop policy if exists profile_staff on public.profile;
create policy profile_staff on public.profile for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- profile_private：本人可讀，只有 admin 可寫。anon 無 policy 亦無 grant。
drop policy if exists pp_read_self on public.profile_private;
create policy pp_read_self on public.profile_private for select to authenticated
  using (id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists pp_admin on public.profile_private;
create policy pp_admin on public.profile_private for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- username：只有 active 列可讀（301 走 resolve_username，不開放列舉 historical）
drop policy if exists username_read on public.username;
create policy username_read on public.username for select to anon, authenticated
  using (kind = 'active' or profile_id = (select auth.uid()) or (select public.is_staff()));

-- film
drop policy if exists film_read on public.film;
create policy film_read on public.film for select to anon, authenticated
  using ((moderation_state = 'visible' and visibility = 'public' and merged_into_film_id is null)
         or created_by = (select auth.uid()) or (select public.is_staff()));
drop policy if exists film_insert_ugc on public.film;
create policy film_insert_ugc on public.film for insert to authenticated
  with check (created_by = (select auth.uid()) and origin = 'ugc'
    and visibility = 'private' and review_state = 'pending' and moderation_state = 'visible'
    and tmdb_id is null and merged_into_film_id is null
    and (select public.account_is_servable((select auth.uid()))));
drop policy if exists film_update_own_ugc on public.film;
create policy film_update_own_ugc on public.film for update to authenticated
  using (created_by = (select auth.uid()) and review_state = 'pending' and merged_into_film_id is null)
  -- with check 把全部管制欄位釘成常數 ⇒ 不需要 guard trigger 也無法提權
  with check (created_by = (select auth.uid()) and origin = 'ugc' and visibility = 'private'
    and review_state = 'pending' and moderation_state = 'visible'
    and tmdb_id is null and merged_into_film_id is null);
drop policy if exists film_staff on public.film;
create policy film_staff on public.film for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- film_identity / film_tmdb_snapshot：可見性鏡射 film（★ 不可 using(true)，否則私有片名經 slug 外洩）
drop policy if exists film_identity_read on public.film_identity;
create policy film_identity_read on public.film_identity for select to anon, authenticated
  using (exists (select 1 from public.film f where f.id = film_id));
drop policy if exists film_snapshot_read on public.film_tmdb_snapshot;
create policy film_snapshot_read on public.film_tmdb_snapshot for select to anon, authenticated
  using (exists (select 1 from public.film f where f.id = film_id));
drop policy if exists merge_log_read on public.film_merge_log;
create policy merge_log_read on public.film_merge_log for select to authenticated using ((select public.is_staff()));

drop policy if exists certificate_read on public.certificate;
create policy certificate_read on public.certificate for select to anon, authenticated
  using (film_id is null or exists (select 1 from public.film f where f.id = film_id));
drop policy if exists venue_read on public.venue;
create policy venue_read on public.venue for select to anon, authenticated using (true);
drop policy if exists format_read on public.screening_format;
create policy format_read on public.screening_format for select to anon, authenticated using (true);
drop policy if exists import_run_read on public.import_run;
create policy import_run_read on public.import_run for select to authenticated using ((select public.is_staff()));

-- 觀影紀錄
drop policy if exists record_read on public.viewing_record;
create policy record_read on public.viewing_record for select to anon, authenticated
  using (user_id = (select auth.uid()) or (select public.is_staff())
    or (visibility = 'public' and moderation_state = 'visible'
        and (select public.account_is_servable(user_id))
        and exists (select 1 from public.film f where f.id = film_id
              and f.visibility = 'public' and f.moderation_state = 'visible'
              and f.merged_into_film_id is null)));
drop policy if exists record_insert on public.viewing_record;
create policy record_insert on public.viewing_record for insert to authenticated
  with check (user_id = (select auth.uid()) and moderation_state = 'visible'
    and (select public.account_is_servable((select auth.uid())))
    and (select public.film_usable_by(film_id, (select auth.uid()))));
drop policy if exists record_update on public.viewing_record;
create policy record_update on public.viewing_record for update to authenticated
  using (user_id = (select auth.uid()) and moderation_state = 'visible')
  with check (user_id = (select auth.uid()) and moderation_state = 'visible'
    and (select public.film_usable_by(film_id, (select auth.uid()))));
drop policy if exists record_delete on public.viewing_record;
create policy record_delete on public.viewing_record for delete to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists record_staff on public.viewing_record;
create policy record_staff on public.viewing_record for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- 票價：整條隱私規則就是這兩條 policy
drop policy if exists cost_read on public.viewing_record_cost;
create policy cost_read on public.viewing_record_cost for select to anon, authenticated
  using ((select public.record_owner(record_id)) = (select auth.uid())
      or (select public.is_staff())
      or ((select public.record_is_public(record_id))
          and (select public.owner_shows_cost((select public.record_owner(record_id))))));
drop policy if exists cost_write on public.viewing_record_cost;
create policy cost_write on public.viewing_record_cost for all to authenticated
  using ((select public.record_owner(record_id)) = (select auth.uid()))
  with check ((select public.record_owner(record_id)) = (select auth.uid()));

-- 法遵
drop policy if exists legal_doc_read on public.legal_document;
create policy legal_doc_read on public.legal_document for select to anon, authenticated using (true);
drop policy if exists legal_accept_self on public.legal_acceptance;
create policy legal_accept_self on public.legal_acceptance for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists legal_accept_insert on public.legal_acceptance;
create policy legal_accept_insert on public.legal_acceptance for insert to authenticated
  with check (profile_id = (select auth.uid()));
drop policy if exists takedown_insert on public.takedown_notice;   -- §90-4 要求公告受理窗口
create policy takedown_insert on public.takedown_notice for insert to anon, authenticated
  with check (status = 'received');
drop policy if exists takedown_staff on public.takedown_notice;
create policy takedown_staff on public.takedown_notice for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists counter_self on public.counter_notice;
create policy counter_self on public.counter_notice for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists counter_insert on public.counter_notice;
create policy counter_insert on public.counter_notice for insert to authenticated
  with check (profile_id = (select auth.uid()));
drop policy if exists counter_staff on public.counter_notice;
create policy counter_staff on public.counter_notice for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists strike_self on public.copyright_strike;
create policy strike_self on public.copyright_strike for select to authenticated
  using (profile_id = (select auth.uid()) or (select public.is_staff()));
drop policy if exists strike_staff on public.copyright_strike;
create policy strike_staff on public.copyright_strike for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists report_insert on public.data_report;
create policy report_insert on public.data_report for insert to authenticated
  with check (reporter_id = (select auth.uid()));
drop policy if exists report_read on public.data_report;
create policy report_read on public.data_report for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.is_staff()));

-- -----------------------------------------------------------------------------
-- 13. 權限 —— ★ 已整塊移到 9999_grants.sql
--
--    原因：本檔設計成可重複執行，而權限區塊裡的 blanket revoke 隱含一個不變量:
--    「這份 grant 清單就是全部的公開物件」。任何後續 migration 新增表或 view
--    都會破壞它——例如 0002 的 venue_option，若在它之後單獨重跑本檔，
--    `revoke all on all tables … from anon, authenticated` 會把它的 SELECT
--    靜默撤銷，前端選單變成 401 而看不出原因。
--
--    這是結構問題不是遺漏：把新物件補進本檔的清單，下一支 migration 又會再犯。
--    因此「誰能存取什麼」集中到永遠最後執行的 9999_grants.sql，成為單一真相。
--    本檔只負責結構與 RLS policy。
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 14. UGC 海報 Storage
--     單一 bucket，但 public = false ⇒ 讀取走 RLS（signed URL 或 /object/authenticated）。
--     這不是付費牆：anon 憑 publishable key 即可簽出 URL，海報對所有人免費可見。
--     public = true 會讓 storage.objects 的列舉權限把「未審核 UGC 海報」全網公開。
--     路徑約定：<film_id>/<random>.<ext>
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ugc-poster','ugc-poster', false, 2097152, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.ugc_poster_film(p_name text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(p_name,'/',1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(p_name,'/',1)::uuid end; $$;

drop policy if exists ugc_poster_read on storage.objects;
create policy ugc_poster_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'ugc-poster' and exists (
    select 1 from public.film f where f.id = public.ugc_poster_film(name)
      and ((f.visibility = 'public' and f.review_state = 'approved' and f.moderation_state = 'visible')
           or f.created_by = (select auth.uid()) or (select public.is_staff()))));
drop policy if exists ugc_poster_write on storage.objects;
create policy ugc_poster_write on storage.objects for insert to authenticated
  with check (bucket_id = 'ugc-poster' and exists (
    select 1 from public.film f where f.id = public.ugc_poster_film(name)
      and f.created_by = (select auth.uid()) and f.tmdb_id is null));
drop policy if exists ugc_poster_manage on storage.objects;
create policy ugc_poster_manage on storage.objects for update to authenticated
  using (bucket_id = 'ugc-poster' and exists (
    select 1 from public.film f where f.id = public.ugc_poster_film(name) and f.created_by = (select auth.uid())));
drop policy if exists ugc_poster_delete on storage.objects;
create policy ugc_poster_delete on storage.objects for delete to authenticated
  using (bucket_id = 'ugc-poster' and exists (
    select 1 from public.film f where f.id = public.ugc_poster_film(name)
      and (f.created_by = (select auth.uid()) or (select public.is_staff()))));

-- -----------------------------------------------------------------------------
-- 15. 匯出與帳號刪除（US-46 / 47）★ SECURITY INVOKER —— 聚合是推論通道，不是安全邊界
-- -----------------------------------------------------------------------------
create or replace function public.export_my_data() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('exported_at', now(),
    'profile', (select to_jsonb(p) from public.profile p where p.id = auth.uid()),
    'records', coalesce((select jsonb_agg(jsonb_build_object(
        'watched_on', r.watched_on, 'watched_time', r.watched_time,
        'film_title_zh', f.title_zh, 'film_title_original', f.title_original, 'tmdb_id', f.tmdb_id,
        'venue', v.name, 'venue_id', v.id, 'ticket_count', r.ticket_count, 'hall', r.hall_label,
        'format', r.format_code, 'memo', r.memo, 'visibility', r.visibility,
        'cost_amount', c.amount, 'cost_currency', c.currency) order by r.watched_on, r.watched_time)
      from public.viewing_record r
      join public.film f on f.id = r.film_id join public.venue v on v.id = r.venue_id
      left join public.viewing_record_cost c on c.record_id = r.id
      where r.user_id = auth.uid()), '[]'::jsonb));
$$;

-- -----------------------------------------------------------------------------
-- 16. 結構自我檢查 —— 把最致命且靜默的失誤變成 migration 失敗
--     （權限類的檢查在 9999_grants.sql，因為權限在那裡才成形）
-- -----------------------------------------------------------------------------
do $$ declare bad text;
begin
  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if bad is not null then raise exception 'RLS 未啟用：%', bad; end if;

  select string_agg(c.relname, ', ') into bad from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%';
  if bad is not null then raise exception 'view 非 security_invoker：%', bad; end if;

  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'viewing_record'
               and column_name in ('cost','amount','price')) then
    raise exception 'viewing_record 長回票價欄位 —— 票價必須留在 viewing_record_cost'; end if;

  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path%';
  if bad is not null then raise exception 'SECURITY DEFINER 未釘 search_path：%', bad; end if;

  -- ★ 迴歸守衛：is_service_context() 絕不可回頭用 current_user。
  --   在 SECURITY DEFINER 內 current_user 是函式擁有者 (postgres)，任何拿得到
  --   EXECUTE 的使用者都會被判成服務端（踩雷 #31，已實測可利用）。
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'is_service_context'
                and pg_get_functiondef(p.oid) ~ 'current_user') then
    raise exception 'is_service_context() 使用了 current_user —— 在 SECURITY DEFINER 內會被提權';
  end if;

  if exists (select 1 from storage.buckets where id = 'ugc-poster' and public) then
    raise exception 'ugc-poster 為 public bucket，未審核海報將全網可列舉'; end if;

  if not exists (select 1 from public.venue where id = 'virtual:streaming')
  or not exists (select 1 from public.venue where id = 'virtual:festival')
  or not exists (select 1 from public.venue where id = 'virtual:home')
  or not exists (select 1 from public.venue where id = 'virtual:other') then
    raise exception '四筆 virtual venue 缺漏 —— US-7 會在第一天壞掉'; end if;

  -- 本檔不再設定任何權限（見 §13 的說明）。單獨套用本檔的資料庫，所有表都還
  -- 停在 Supabase 預設的「對 anon 全開」狀態，只靠 RLS 擋著。這是刻意的分工，
  -- 但漏跑 9999 是會出事的，所以在這裡吵一聲。
  if not exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon'
       and table_name = 'takedown_notice' and privilege_type = 'INSERT'
  ) or exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and grantee = 'anon' and table_name = 'profile_private'
  ) then
    raise warning '權限尚未套用：請接著執行 9999_grants.sql，否則 anon 對所有表都有寫入權';
  end if;
end $$;
