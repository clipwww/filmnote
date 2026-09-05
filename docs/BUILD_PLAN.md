# 影記 / filmnote 建置計畫（前半部）

> 本文只涵蓋 §1 schema/RLS、§2 專案設定、§3 路由、§4 環境變數。建置步驟與法遵落點見計畫後半部。
> 基準版本（2026-09-05 實測）：`nuxt@4.5.2`、`@nuxt/ui@4.11.0`、`tailwindcss@4.3.3`、`@nuxtjs/supabase@2.0.10`、`echarts@6.1.0`、`typescript@5.9.3`。

---

# 1. 最終 Supabase schema 與 RLS

## 1.1 相對於提案 3 的六項結構性修正

骨幹取提案 3（惰性複雜度 < 活性複雜度），但以下六點是**必改**，其中三項是評審實測出的 P0：

| # | 問題 | 修正 |
|---|---|---|
| A | `auth.uid() is null ⇒ 視為 service_role 放行`。anon 的 `auth.uid()` 同樣是 NULL，等於對未登入者關掉全部守門 | 一律改用 `current_user in ('postgres','service_role','supabase_admin')` |
| B | 未做 `revoke execute ... from public`，PostgREST 把 `link_film_to_tmdb` 曝露給 anon | blanket revoke + `alter default privileges ... from **public**`（不是 anon/authenticated）+ 逐支 grant |
| C | `ugc-poster` bucket 設 `public: true` + anon select ⇒ 未審核海報全網可列舉 | **單一 bucket 但 `public: false`**，storage RLS 以 film 的審核狀態把關；讀取走 signed URL（不是付費牆，法遵不受影響） |
| D | `film_identity` / `film_tmdb_snapshot` / `username` 用 `using (true)` ⇒ 私有 UGC 片名、全站舊 username 外洩 | 三張表的 SELECT policy 鏡射 film / profile 的可見性 |
| E | `profile.role` / `service_status` 對 anon 可讀 ⇒ 管理員名單與三振紀錄公開 | **拆表**：`profile`（公開身分欄位）+ `profile_private`（role/service_status/strike_count，anon 無 policy 無 grant） |
| F | 所有 policy 用裸 `auth.uid()` / `is_staff()` | 全部包成 `(select ...)` 提成 InitPlan |

D+E 的副作用是**提權防線可以少一層**：`profile` 表裡根本沒有 role 欄位，`profile_update_self` 的 `with check (id = (select auth.uid()))` 就已經封死；`film` 的 UPDATE policy 直接在 `with check` 裡把 `review_state` / `visibility` / `tmdb_id` 釘成常數，也不再需要 guard trigger。表級 CHECK 仍保留作為最後一層。

## 1.2 完整 migration

檔案：`supabase/migrations/0001_init.sql`（**覆蓋**現有那份 1353 行的提案 3 草稿；它尚未套用到任何專案）。

```sql
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

-- 服務情境判定。★ 絕不用 auth.uid() is null —— anon 的 uid 同樣是 NULL。
create or replace function public.is_service_context()
returns boolean language sql stable set search_path = '' as $$
  select current_user in ('postgres','service_role','supabase_admin','supabase_storage_admin');
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

-- 新使用者：username 取 email @ 前綴，衝突時補流水號
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
  end loop;
  insert into public.profile (id, username) values (new.id, cand) on conflict (id) do nothing;
  insert into public.profile_private (id) values (new.id) on conflict (id) do nothing;
  insert into public.username (name, profile_id, kind) values (cand, new.id, 'active')
    on conflict (name) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

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
    state = case when state = 'gone' then 'gone' else 'pending' end,
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
       f.updated_at
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
-- 13. 權限（表層 GRANT 不做欄位級；函式一律先 revoke 再逐支 grant）
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on public.profile, public.username, public.film, public.film_identity,
  public.film_tmdb_snapshot, public.certificate, public.venue, public.screening_format,
  public.viewing_record, public.viewing_record_cost, public.legal_document,
  public.film_public, public.viewing_record_public to anon, authenticated;
grant select on public.profile_private, public.film_merge_log, public.import_run,
  public.takedown_notice, public.counter_notice, public.copyright_strike,
  public.data_report, public.legal_acceptance to authenticated;
grant insert, update, delete on public.viewing_record, public.viewing_record_cost to authenticated;
grant insert, update on public.film to authenticated;
grant update on public.profile to authenticated;
grant insert on public.legal_acceptance, public.data_report, public.counter_notice to authenticated;
grant insert on public.takedown_notice to anon, authenticated;
grant update on public.profile_private, public.film, public.viewing_record to authenticated; -- staff policy 把關
grant select on public.tmdb_refresh_due to service_role;
grant usage on all sequences in schema public to authenticated;

-- ★ Postgres 函式的預設 EXECUTE 授予對象是 PUBLIC，不是 anon/authenticated。
--   revoke 寫錯對象等於沒做，這正是提案 1 的 bug 與提案 3 P0 破口的共同根源。
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from public;

-- policy 內用到的 helper 必須對查詢角色開 EXECUTE，否則全站 403。
grant execute on function public.is_staff(), public.is_admin(),
  public.account_is_servable(uuid), public.owner_shows_cost(uuid),
  public.record_owner(uuid), public.record_is_public(uuid),
  public.film_usable_by(uuid, uuid), public.resolve_film(text),
  public.resolve_username(text), public.slugify(text) to anon, authenticated;
grant execute on function public.rename_username(text) to authenticated;
grant execute on function public.merge_films(uuid, uuid, text),
  public.approve_film(uuid, boolean) to authenticated, service_role;
grant execute on function public.link_film_to_tmdb(uuid, integer),
  public.apply_tmdb_snapshot(uuid), public.purge_expired_tmdb_cache(),
  public.seed_films(jsonb) to service_role;

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
grant execute on function public.ugc_poster_film(text) to anon, authenticated;

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
grant execute on function public.export_my_data() to authenticated;

-- -----------------------------------------------------------------------------
-- 16. 上線前自我檢查 —— 把最致命且靜默的失誤變成 migration 失敗
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

  select string_agg(p.proname, ', ') into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname not in ('is_staff','is_admin','account_is_servable','owner_shows_cost',
                           'record_owner','record_is_public','film_usable_by','resolve_film','resolve_username')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'));
  if bad is not null then raise exception 'SECURITY DEFINER 對 anon/PUBLIC 開放 EXECUTE：%', bad; end if;

  if exists (select 1 from storage.buckets where id = 'ugc-poster' and public) then
    raise exception 'ugc-poster 為 public bucket，未審核海報將全網可列舉'; end if;

  if not exists (select 1 from public.venue where id = 'virtual:streaming')
  or not exists (select 1 from public.venue where id = 'virtual:festival')
  or not exists (select 1 from public.venue where id = 'virtual:home')
  or not exists (select 1 from public.venue where id = 'virtual:other') then
    raise exception '四筆 virtual venue 缺漏 —— US-7 會在第一天壞掉'; end if;
end $$;
```

## 1.3 逐條 policy 擋住什麼

| Policy | 擋住的具體行為 |
|---|---|
| `profile_read` | 被三振終止服務者的個人頁對外消失（本人與 staff 仍可讀）。**role / 三振次數不在此表**，所以無論怎麼 `select=*` 都拿不到管理員名單。 |
| `pp_read_self` + 無 anon grant | `GET /rest/v1/profile_private?is_admin=eq.true` 這類針對性列舉在 anon 下直接空集合。 |
| `profile_update_self` | 使用者只能改自己那列；因為表中沒有權限欄位，PATCH 提權在結構上不存在。 |
| `username_read`（限 `kind='active'`） | 阻止 `GET /rest/v1/username?kind=eq.historical` 一次倒出全站改名前後對應（預設 username 取自 email @ 前綴 ⇒ 等於倒出 email local part 與身分綁定）。301 只走 `resolve_username()`，回傳字串、不回傳 user_id、不可列舉。 |
| `film_read` | anon 只看得到「公開 + 未取下 + 未合併」；UGC 作者額外看得到自己未過審的。被 §90-7 取下（`moderation_state='removed'`）的作品立即從全部公開路徑消失。 |
| `film_insert_ugc` | 新增作品時 `visibility` / `review_state` 被 WITH CHECK 釘成 `private` / `pending`，且 `tmdb_id` 必須為 NULL。使用者無法「新增即公開」，也無法冒領一個 TMDB id。停權者（`account_is_servable` 為 false）連新增都不行。 |
| `film_update_own_ugc` | 只在 `review_state='pending'` 期間可改，且 WITH CHECK 把六個管制欄位釘成常數 ⇒ 不需要 guard trigger，`PATCH {"visibility":"public"}` 直接被 RLS 拒絕。過審後作者即失去編輯權（避免「先過審再改內容」）。 |
| `film_public_requires_approval` CHECK | 讓「公開但未審核」這個狀態**根本無法被寫進資料庫**——即使 policy 全部失效，這條仍成立。 |
| `film_identity_read` / `film_snapshot_read` | 兩者的 `exists(... from film ...)` 會再套一次 `film_read`。堵住「私有 UGC 片名經 `slug:` 鍵外洩」與「已取下作品的 TMDB 內容仍可讀」。 |
| `certificate_read` | 政府核准紀錄本身是開放資料，但已 join 到私有作品者跟著隱藏，避免經 certificate 反推私有片名。 |
| `record_read` | anon 看得到的必須同時滿足：紀錄公開且未取下、**所屬作品公開且未取下**、作者未被終止服務。缺任一條即消失——這是提案 1 漏掉、導致「取下作品後其觀影紀錄與 memo 仍公開」的那一段。 |
| `record_insert` / `record_update` | `user_id` 只能是自己（不信任 body）；`film_usable_by` 阻止「拿別人未過審的私有 UGC 作品建立紀錄」來探測其存在。`moderation_state` 被釘成 `visible`，使用者無法自行改動管制狀態，也無法把已被取下的紀錄改回可見。 |
| `record_delete` | 只能刪自己的。被取下的紀錄仍可刪（使用者對自己資料有最終控制權），但取下狀態本身不是 DELETE，因此 §90-9 的回復義務仍可履行。 |
| `cost_read` | 三選一：本人、staff、或「紀錄公開 **且** 作者已開啟 `show_cost`」。因為 cost 是獨立的**列**，PostgREST 的 `select=*`、`select=*,viewing_record_cost(*)`、`!inner` embed、`order=viewing_record_cost(amount).desc`、`?amount=gt.500` 全部在套用 RLS 的 lateral 子查詢內求值 ⇒ 拿不到未授權的列，也無法用 filter 做二元搜尋推測金額。 |
| `cost_write` | 只能寫自己紀錄的票價；`record_owner()` 是 definer，避免 policy 對 `viewing_record` 遞迴。 |
| `takedown_insert`（開給 anon） | §90-4 要求公告受理窗口，故未登入的著作權人也能提交；但 `status` 被釘成 `received`，提交者無法自行標成 `actioned`，且提交後讀不回來（無 select policy）。 |
| storage `ugc_poster_read` | bucket 非 public ⇒ 讀取一定經 RLS。未審核／私有作品的海報連 list 都列不到。過審後 anon 即可簽 URL 觀看，**不構成付費牆**。 |
| storage `ugc_poster_write` | 路徑第一段必須是一部「自己建立且無 tmdb_id」的作品 uuid ⇒ 無法覆蓋他人海報，也無法對已比對到 TMDB 的作品上傳海報（SPEC：無必要，只增加曝險）。 |

## 1.4 未登入 anon 讀得到什麼（完整清單）

**讀得到**：`venue` / `screening_format` 全部；`legal_document` 全部；`film`（公開已審核）與其 `film_identity` / `film_tmdb_snapshot` / `certificate`；`profile`（未終止服務者的 username / display_name / avatar / bio / show_cost）；`username`（僅 active）；`viewing_record`（公開且作品公開且作者可服務）；`viewing_record_cost`（僅上述紀錄中作者已開 `show_cost` 者）；view `film_public` / `viewing_record_public`。

**寫得到**：只有 `takedown_notice` 的 INSERT。

**完全讀不到**：`profile_private`（role / service_status / strike_count）、`import_run`、`film_merge_log`、`legal_acceptance`、`counter_notice`、`copyright_strike`、`data_report`、`tmdb_refresh_due`、任何 pending/private 作品與其海報。**可執行的函式**只有九支 RLS helper 加 `resolve_film` / `resolve_username` / `slugify` / `ugc_poster_film`——`merge_films`、`link_film_to_tmdb`、`seed_films`、`purge_expired_tmdb_cache` 對 anon 一律 403。

## 1.5 UGC 作品 private → public 的轉換路徑

1. 使用者搜尋無結果 → `POST /rest/v1/film`，policy 強制寫成 `origin='ugc' / visibility='private' / review_state='pending' / tmdb_id=null`。
2. 立刻可用於自己的紀錄（`film_usable_by` 允許 `created_by = 自己`），但對他人與 anon 不存在（US-16 / 17）。
3. 海報上傳到 `ugc-poster/<film_id>/…`，此時只有作者看得到。
4. 管理員在 `/admin/films`（`film_review_queue_idx` 就是佇列）呼叫 `approve_film(id, true)` → `review_state='approved'` 且 `visibility='public'`。**這是唯一入口**：一般使用者的 UPDATE policy 把這兩欄釘死，`film_public_requires_approval` CHECK 再擋一次。
5. 過審瞬間，`film_read` / `film_identity_read` / `record_read` / storage 讀取 policy 全部即時放行——**零資料遷移、零海報搬檔**。這正是不做雙 bucket 的理由。
6. 事後比對到 TMDB：排程以 service_role 呼叫 `link_film_to_tmdb(film, tmdb_id)`。若該 tmdb_id 已有作品 → 自動 `merge_films`，把 identity 與 viewing_record 搬到存活者、敗方壓成 private；否則就地補上 `tmdb_id`、清掉 `ugc_poster_path`、建立 snapshot 排入刷新佇列（US-18）。

## 1.6 username 改名與 301

`username` 是**單一命名空間**：`active` / `historical` / `reserved` 三種 kind 共用同一張表的 PK，所以舊名不會被別人搶走。`rename_username()` 把舊列改成 `historical` 並插入新的 `active` 列，同時同步 `profile.username`。前端 `/u/[username]` 找不到 profile 時，Nitro server middleware 呼叫 `resolve_username(old)`；有值即回 `301 → /u/<new>`（實作見 §3）。保留字 30 個已在 migration 內 seed，涵蓋全部一級路由。

## 1.7 三份 pipeline 輸出如何 seed

新增 `scripts/seed-supabase.ts`（用既有的 `tsx`，走 `SUPABASE_SECRET_KEY`，service_role 繞過 RLS）：

| 檔案 | 目標 | 方式 |
|---|---|---|
| `.data/venues.json` | `venue` | `supabase.from('venue').upsert(rows, { onConflict: 'id' })`，`id` = 統一編號。`kind` 一律 `'cinema'`；四筆 virtual 已由 migration seed。分批 500 筆。 |
| `.data/films.json` | `film` + `film_identity` + `film_tmdb_snapshot` | `supabase.rpc('seed_films', { p_films: batch })`，每批 200 筆。RPC 以 `resolve_film(id)` 查確定性鍵 → 有就更新、沒有就新建並登錄 identity ⇒ **重跑不長列、不復活已合併的敗方**。 |
| `.data/certificates.json` | `certificate` | 先建 `key → film uuid` 對照（`select key, film_id from film_identity where kind in ('gov','tmdb')`），再 `upsert(..., { onConflict: 'id' })`；`id` 就是「年度:字號:正規化片名」。`raw` 存原始列，日後改良解析可就地重算。 |

每次執行先 `insert into import_run` 取得 id 寫進 `certificate.import_run_id` / `venue.last_import_id`，結束時更新 `status` 與 `stats`。**順序固定 venues → films → certificates**（certificate 的 FK 指向 film）。TMDB 內容不在此階段抓——seed 只建立 `film_tmdb_snapshot` 的 `pending` 空殼，由刷新排程逐步填滿。

---

# 2. Nuxt 專案設定

repo 目前是純 Node 匯入管線（`src/pipeline`、`src/match`…，vitest + tsx + oxlint + antfu）。**全部保留，Nuxt 疊在旁邊**：Nuxt 4 的 `srcDir` 預設是 `app/`，與現有的 `src/` 不衝突，兩者可共存於同一個 package。

## 2.1 package.json（在既有內容上疊加）

```jsonc
{
  "name": "filmnote",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22.12.0" },      // ← 從 >=22 收緊：@nuxt/ui 的 engines 是 ^20.19.0 || >=22.12.0
  "scripts": {
    // ── 保留 ───────────────────────────────────────────────
    "test": "vitest run",
    "test:watch": "vitest",
    "ingest:rating": "tsx src/pipeline/ingest-rating.ts",
    "ingest:cinema": "tsx src/pipeline/ingest-cinema.ts",
    // ── 新增 ───────────────────────────────────────────────
    "dev": "nuxt dev",
    "build": "nuxt build",
    "preview": "nuxt preview",
    "postinstall": "nuxt prepare",
    "seed": "tsx scripts/seed-supabase.ts",
    "db:types": "supabase gen types typescript --project-id $SUPABASE_PROJECT_ID --schema public > app/types/database.types.ts",
    // ── 改寫：typecheck 拆兩軌 ─────────────────────────────
    "typecheck": "npm run typecheck:app && npm run typecheck:pipeline",
    "typecheck:app": "nuxt typecheck",
    "typecheck:pipeline": "tsc -p tsconfig.pipeline.json --noEmit",
    "lint": "oxlint . && eslint .",
    "lint:fix": "oxlint --fix . && eslint . --fix"
  },
  "dependencies": {
    "csv-parse": "^7.0.2",
    "nuxt": "4.5.2",
    "@nuxt/ui": "^4.11.0",
    "tailwindcss": "^4.3.3",           // 必須是直接相依（@nuxt/ui 的 peerDependency）
    "@nuxtjs/supabase": "^2.0.10",
    "echarts": "^6.1.0",
    "vue-echarts": "^8.2.0",
    "@internationalized/date": "^3.12.3",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@antfu/eslint-config": "^9.5.1",
    "@types/node": "^26.4.1",
    "eslint": "^10.10.0",
    "eslint-plugin-oxlint": "^1.81.0",
    "oxlint": "^1.81.0",
    "tsx": "^4.23.13",
    "typescript": "5.9.3",             // ★ 精確 pin，不用 ^：TS 7 會讓 ts-api-utils 崩潰
    "vue-tsc": "^3.2.0",
    "vitest": "^5.0.0"
  },
  "overrides": { "typescript": "5.9.3" }   // 防止傳遞相依把 TS 拉到 6/7
}
```

`nuxt-echarts` 刻意不裝：`/app/**` 是 `ssr: false`，直接用 `vue-echarts` + 手動 `use([...])` tree-shake 即可；`/u/**`、`/film/**` 上的圖表包 `<ClientOnly>`。少一個模組、少一層版本相依。

## 2.2 tsconfig（現有那份改名，根目錄換成 solution file）

現有的 `tsconfig.json` 內容原封不動搬到 **`tsconfig.pipeline.json`**，只改兩處：

```jsonc
// tsconfig.pipeline.json
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2023"], "module": "ESNext", "moduleResolution": "bundler",
    "paths": { "#pipeline/*": ["./src/*"] },   // ← 從 ~/* 改名，避免與 Nuxt 的 ~ → app/ 撞名
    "resolveJsonModule": true, "types": ["node", "vitest/globals"],
    "strict": true, "noImplicitOverride": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "esModuleInterop": true, "verbatimModuleSyntax": true, "skipLibCheck": true
  },
  "include": ["src", "tests", "scripts", "vitest.config.ts"]
}
```

根目錄 `tsconfig.json` 換成 Nuxt 4 的 solution file：

```json
{
  "files": [],
  "references": [
    { "path": "./.nuxt/tsconfig.app.json" },
    { "path": "./.nuxt/tsconfig.server.json" },
    { "path": "./.nuxt/tsconfig.shared.json" },
    { "path": "./.nuxt/tsconfig.node.json" }
  ]
}
```

`vitest.config.ts` 的 alias 同步改成 `#pipeline` → `./src`；`src/**` 內既有的 `~/...` import 一次性改寫（目前只有 `types.ts` 被到處引用，範圍小）。`.gitignore` 補 `.nuxt/`、`.output/`、`.vercel/`。

## 2.3 nuxt.config.ts（新檔）

```ts
export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  future: { compatibilityVersion: 4 },
  ssr: true,                                   // 預設 SSR，只用 routeRules 把登入後區塊 opt out

  modules: ['@nuxt/ui', '@nuxtjs/supabase'],
  css: ['~/assets/css/main.css'],              // 內容只有 @import "tailwindcss"; @import "@nuxt/ui";

  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant-TW' },
      link: [{ rel: 'icon', href: '/favicon.ico' }],
    },
  },
  spaLoadingTemplate: 'app/spa-loading-template.html',

  routeRules: {
    '/':          { ssr: true, isr: 300 },
    '/legal/**':  { prerender: true },
    '/u/**':      { ssr: true, headers: { 'cache-control': 'private, no-store' } },
    '/film/**':   { ssr: true, isr: 3600 },
    '/venue/**':  { ssr: true, isr: 3600 },
    '/login':     { ssr: true },
    '/app/**':    { ssr: false, headers: { 'x-robots-tag': 'noindex, nofollow' } },
    '/admin/**':  { ssr: false, headers: { 'x-robots-tag': 'noindex, nofollow' } },
    '/api/**':    { headers: { 'cache-control': 'no-store' } },
  },

  supabase: {
    redirect: true,
    redirectOptions: {
      login: '/login',
      callback: '/confirm',                    // ★ 絕不能設 '/'：模組會對 callback 路徑硬加
                                               //   { ssr: false }，設成 '/' 等於關掉首頁 SSR
      include: ['/app(/*)?', '/admin(/*)?'],   // pattern 是 RegExp 不是 glob：'^' + p.replace(/\*/g,'.*') + '$'
      exclude: [],
      saveRedirectToCookie: true,
    },
    cookieOptions: {
      maxAge: 60 * 60 * 24 * 365,              // 預設只有 8 小時，對低頻使用的產品體驗太差
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',  // Safari 不接受 http://localhost 的 Secure cookie
    },
    types: '~/types/database.types.ts',
  },

  runtimeConfig: {
    tmdbApiKey: '',                            // NUXT_TMDB_API_KEY —— 只在 server 用
    cronSecret: '',                            // NUXT_CRON_SECRET
    public: { siteUrl: 'http://localhost:3000' },  // NUXT_PUBLIC_SITE_URL
  },

  nitro: { preset: undefined },                // Vercel 自動偵測，不要手動釘
  typescript: { typeCheck: false, strict: true },  // typecheck 交給 npm run typecheck，不拖慢 dev
})
```

## 2.4 ESLint + oxlint（在既有 `eslint.config.js` 上疊加）

```js
import antfu from '@antfu/eslint-config'
import oxlint from 'eslint-plugin-oxlint'

export default antfu(
  {
    type: 'app',                    // ← 從 'lib' 改（現在是應用程式，不是函式庫）
    typescript: true,
    vue: true,                      // ← 從 false 改：oxlint 的 vue/* 只有 46 條且完全不看 <template>
    formatters: { css: true },
    ignores: ['tests/fixtures/**', '.data/**', '.nuxt/**', '.output/**', '.vercel/**',
              'app/types/database.types.ts', 'supabase/migrations/**'],
  },
  {
    // 匯入管線仍以函式庫規範對待
    files: ['src/**/*.ts'],
    rules: { 'antfu/no-top-level-await': 'error' },
  },
  {
    files: ['src/pipeline/ingest-*.ts', 'scripts/**/*.ts', 'server/api/cron/**/*.ts'],
    rules: { 'no-console': 'off', 'antfu/no-top-level-await': 'off' },
  },
  {
    // Nuxt 的檔案系統慣例與 antfu 的命名規則衝突
    files: ['app/pages/**/*.vue', 'app/layouts/**/*.vue', 'app/app.vue', 'app/error.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  ...oxlint.configs['flat/recommended'],   // ← 必須放最後，關掉與 oxlint 重疊的規則
)
```

`.oxlintrc.json` 只需兩處增修：

```jsonc
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "categories": { "correctness": "error", "suspicious": "warn", "perf": "warn" },
  "plugins": ["vue", "typescript", "oxc", "import"],
  "rules": { "no-await-in-loop": "off" },
  "ignorePatterns": ["tests/fixtures/**", ".data/**", "node_modules/**",
                     ".nuxt/**", ".output/**", ".vercel/**", "app/types/database.types.ts"]
}
```

分工不變：oxlint 負責存檔時的即時回饋（毫秒級、不看 template），ESLint 負責 commit / CI 的完整檢查（`eslint-plugin-vue` 252 條含 template a11y、type-aware 規則）。TS 釘 5.9.3 的唯一理由就是 `typescript-eslint` 依賴的 `ts-api-utils` 在 TS 7 下崩潰，與 Nuxt UI 的 peer 範圍（`^5.6.3 || ^6 || ^7`）無衝突。

---

# 3. 路由結構

| 路徑 | 算繪 | 需登入 | 說明 |
|---|---|---|---|
| `/` | SSR + ISR 300 | 否 | 站台介紹 + 近期公開紀錄。ISR 安全的前提是 SSR 期間只讀公開資料（見下方注意）。 |
| `/login` | SSR | 否 | Google OAuth 進入點。 |
| `/confirm` | **強制 SPA** | 否 | OAuth callback。`@nuxtjs/supabase` 會自行對此路徑加 `{ ssr: false }`，不要自己再寫。 |
| `/u/[username]` | SSR，**不快取** | 否 | 公開個人頁。RLS 依觀看者而異（本人看得到自己的私密紀錄與票價）⇒ 絕不可 ISR/CDN 快取，`cache-control: private, no-store`。 |
| `/u/[username]/[year]` | SSR，不快取 | 否 | 年度回顧（US-42）。 |
| `/u/[username]/records/[id]` | SSR，不快取 | 否 | 單筆紀錄的 OG 分享頁（US-32）。 |
| `/film/[slug]` | SSR + ISR 3600 | 否 | 作品頁（US-27/33）。 |
| `/venue/[id]` | SSR + ISR 3600 | 否 | 影城頁。 |
| `/legal/terms`｜`/legal/privacy`｜`/legal/copyright`｜`/legal/dmca` | **prerender** | 否 | §90-4 的四要件頁面，建置期靜態產生。 |
| `/app` | SPA | **是** | 儀表板：貢獻圖、時段熱力圖、月度趨勢、影城／版本／國別分布（US-34~43）。 |
| `/app/new` | SPA | 是 | 三十秒記錄流程（US-4~9）。 |
| `/app/records`｜`/app/records/[id]/edit` | SPA | 是 | 列表與編輯（US-11）。 |
| `/app/films/new` | SPA | 是 | 手動新增作品 + 海報上傳（US-13~15）。 |
| `/app/settings` | SPA | 是 | username 改名、`show_cost` 開關、匯出、刪除帳號（US-24/30/46/47）。 |
| `/app/import` | SPA | 是 | 舊 log 專案匯入與未比對清單（US-56~58）。 |
| `/admin/films`｜`/admin/takedowns`｜`/admin/reports` | SPA | 是（staff） | 審核佇列、DMCA 承辦、資料回報。頁面層再以 `is_staff()` 二次確認。 |
| `/api/**`（Nitro） | server | 視端點 | `no-store`。`/api/cron/tmdb-purge`、`/api/cron/tmdb-refresh` 以 `NUXT_CRON_SECRET` 保護。 |
| `/sitemap.xml`｜`/robots.txt` | SSR（sitemap 快取 3600） | 否 | 只列公開作品與未終止服務者的個人頁。 |

**三個必須遵守的細節**：

1. **`/film/**` 的 ISR 只有在 SSR 期間完全不碰使用者身分時才安全。** 作品頁的 SSR fetch 必須經一支明確使用 anon client 的 Nitro 路由取得公開資料；「我看過這部片幾次」這類個人化內容一律在 client 端補。否則第一個造訪者的 RLS 結果會被快取給所有人。
2. **算繪模式的唯一入口是 `nuxt.config.ts` 的 `routeRules`。** `definePageMeta` 沒有 `ssr` 欄位，Vercel 也不支援在頁面元件內設定部署選項。
3. **改名 301 需要 Nitro server middleware**（`routeRules.redirect` 是建置期靜態的，查不了 DB）：

```ts
// server/middleware/username-redirect.ts
export default defineEventHandler(async (event) => {
  const m = /^\/u\/([^/]+)(\/.*)?$/.exec(event.path)
  if (!m) return
  const [, name, rest = ''] = m
  const client = await serverSupabaseClient(event)
  const { data: exists } = await client.from('profile').select('id').eq('username', name).maybeSingle()
  if (exists) return
  const { data: current } = await client.rpc('resolve_username', { p_name: name })
  if (current && current !== name)
    return sendRedirect(event, `/u/${current}${rest}`, 301)
})
```

---

# 4. 環境變數

## 4.1 現況

`.env` 已有 `TMDB_API_KEY`、`SUPABASE_URL`、`SUPABASE_KEY`（`sb_publishable_` 新格式）。**三個都不必改名**：`@nuxtjs/supabase@2.0.10` 的解析順序中 `SUPABASE_URL` → `url`、`SUPABASE_KEY` → `key` 都在鏈上。`.env` 尾端那行被註解掉的 Google client id 應刪除（它屬於 Supabase Dashboard，不屬於本檔）。

## 4.2 需要補上的

| 變數 | 取得處 | 用途與注意 |
|---|---|---|
| `SUPABASE_SECRET_KEY` | Supabase Dashboard → Project Settings → API Keys → 新版 `sb_secret_…`（**不是** legacy `service_role` JWT） | seed 腳本、TMDB 刷新排程、DMCA 取下操作。模組讀 `NUXT_SUPABASE_SECRET_KEY` → `SUPABASE_SECRET_KEY` → `SUPABASE_SERVICE_ROLE_KEY`。**絕不可進 `runtimeConfig.public`**；`serverSupabaseServiceRole()` 不做任何身分檢查，每次使用前必須先 `serverSupabaseUser()` 驗身分。 |
| `SUPABASE_PROJECT_ID` | Dashboard → General → Reference ID | 只給 `npm run db:types` 用。 |
| `NUXT_TMDB_API_KEY` | 現有 `TMDB_API_KEY` 的值 | 讓 Nitro 的刷新排程讀得到（`runtimeConfig.tmdbApiKey`）。匯入管線繼續讀 `TMDB_API_KEY`，兩者同值即可。**絕不可加 `NUXT_PUBLIC_` 前綴**。 |
| `NUXT_PUBLIC_SITE_URL` | 自訂：本機 `http://localhost:3000`，正式為 Vercel 網域 | OG `og:url`、sitemap、OAuth redirect 組裝。 |
| `NUXT_CRON_SECRET` | 自產（`openssl rand -hex 32`） | `/api/cron/*` 的 bearer 驗證，避免任何人觸發刷新耗盡 TMDB 配額。 |
| `COPYRIGHT_CONTACT_EMAIL` | 自訂（如 `copyright@filmnote.tw`） | §90-4 第③款要公告的受理窗口，同時是取下通知的收件地址。 |

## 4.3 不進 `.env` 的設定（放 Supabase / Google Console）

- **Google OAuth client ID / secret**：Google Cloud Console → Credentials 建立 Web application client，Authorized redirect URI 填 `https://<project-ref>.supabase.co/auth/v1/callback`；ID 與 secret 貼進 Supabase Dashboard → Authentication → Providers → Google。應用程式端一行都不需要。
- **Supabase Redirect URLs**：Authentication → URL Configuration 加入 `http://localhost:3000/confirm` 與 `https://<正式網域>/confirm`。注意 Dashboard 的 glob 語法（`*` 不跨 `/`、`**` 跨 `/`）與 `redirectOptions.include` 的 RegExp 語法**不一樣**，容易搞混。
- **Vercel 環境變數**：上表所有變數都要在 Vercel → Settings → Environment Variables 各環境重設一次；`SUPABASE_SECRET_KEY` / `NUXT_TMDB_API_KEY` / `NUXT_CRON_SECRET` 標記為 Sensitive。

## 4.4 更新後的 `.env.example`

```bash
# ── TMDB（非商業階段用免費 key；一旦收費須升級商業訂閱）──────────────
TMDB_API_KEY=
NUXT_TMDB_API_KEY=

# ── Supabase ─────────────────────────────────────────────────────────
SUPABASE_URL=
SUPABASE_KEY=                 # sb_publishable_… 可公開曝露
SUPABASE_SECRET_KEY=          # sb_secret_… ★ 僅 server 端，絕不可加 NUXT_PUBLIC_
SUPABASE_PROJECT_ID=          # 只給 npm run db:types

# ── 應用程式 ─────────────────────────────────────────────────────────
NUXT_PUBLIC_SITE_URL=http://localhost:3000
NUXT_CRON_SECRET=
COPYRIGHT_CONTACT_EMAIL=
```

`.gitignore` 現有的 `.env` / `.env.*` / `!.env.example` 規則已正確，不需修改。

---

# 5. 建置順序

每一步都是可獨立驗證的切片，前一步驗不過就不要開始下一步。所有 `curl` 假設以下環境變數已匯出（值取自 Supabase Dashboard → API Keys，新專案一律用 `sb_publishable_…` / `sb_secret_…`）：

```bash
export URL="https://<project-ref>.supabase.co"
export ANON="sb_publishable_..."        # 前端也拿得到，等同「任何人」
export SITE="http://localhost:3000"     # Step 11 之後改成 https://filmnote.tw
```

---

### Step 1 — 能跑起來、能用 Google 登入的最小骨架

**做**

1. `npx nuxi@latest init filmnote-app` 產在暫存目錄後把 `app/`、`nuxt.config.ts`、`tsconfig.json` 併進現有 repo（現有 repo 已有 `src/`（匯入管線）、`tests/`、`supabase/`，不要覆蓋）。
2. 裝相依，版本一律釘死：`nuxt@4.5.2`、`@nuxt/ui@^4.11.0`、`tailwindcss`（必須是直接相依，見踩雷 #56）、`@nuxtjs/supabase@^2.0.9`（踩雷 #21）、`nuxt-echarts` + `echarts@^6` + `vue-echarts@^8.2.0`、`typescript@5.9.x`（**不可升 TS 7**）。`package.json` 的 `engines.node` 從 `>=22` 收緊成 `>=22.12.0`（踩雷 #57 的 Nuxt UI engines）。
3. 寫 `nuxt.config.ts`（內容見第 2 節，此處不重複）：`routeRules` 先只放 `/`、`/legal/**`、`/u/**`、`/film/**`、`/app/**`、`/api/**` 六條；`supabase.redirectOptions.callback` 設 `/confirm`（**絕不能是 `/`**，踩雷 #14）。
4. `app/app.vue` 外層包 `<UApp>`（漏了 Modal/Toast 完全不動且無錯誤訊息，踩雷 #58）、`app/assets/css/main.css` 引入 Tailwind 與 Nuxt UI、`app/spa-loading-template.html`（**放在 `app/` 底下不是專案根目錄**，踩雷 #4）。
5. Google Cloud Console 建 OAuth Client，Authorized redirect URI 填 **`https://<project-ref>.supabase.co/auth/v1/callback`**；Supabase Dashboard → Authentication → URL Configuration 的 Redirect URLs 填 `http://localhost:3000/**`。這兩層是不同東西（踩雷 #18）。
6. `app/pages/login.vue`（`signInWithOAuth({ provider: 'google', options: { redirectTo: … + '/confirm' } })`）、`app/pages/confirm.vue`、`app/pages/index.vue`、`app/pages/app/index.vue` 四頁最小實作。
7. 本機開發若用 Safari，`cookieOptions.secure` 必須寫成 `process.env.NODE_ENV === 'production'`（踩雷 #19）；`maxAge` 調成一年（踩雷 #20）。

**怎麼確認它對了**

- `npm run dev` → `curl -s $SITE/ | grep -c '<div id="__nuxt"'` 回 1，且 HTML 內**已含首頁文字內容**（證明 SSR/prerender 生效，不是空殼）。
- `curl -s $SITE/app | grep -ci 'spa-loading'` > 0，且該回應**不含**任何登入後資料（證明 `ssr:false` 生效）。
- `curl -sI $SITE/app | grep -i x-robots-tag` → `noindex, nofollow`（`ssr:false` 路由的 `<meta name="robots">` 在爬蟲眼裡不存在，只有 HTTP header 有效，踩雷 #3）。
- 瀏覽器走完 Google 登入 → 回到 `/confirm` → 轉進 `/app`；DevTools → Application → Cookies 有 `sb-<ref>-auth-token`。
- 在 `/app` 印出 `useSupabaseUser().value` → 有 `sub`、**沒有 `id`**（v2 回傳的是 JWT claims 不是 User，踩雷 #13）。全 codebase `grep -rn 'user.value.id\|user\.id' app server` 必須為 0 筆。
- 未登入直接打 `$SITE/app/new` → 被導到 `/login`（驗 `include: ['/app(/*)?']` 的 RegExp 真的匹配子路徑，踩雷 #15）。
- `npm run build` 後 `ls .output/public/index.html` 存在（首頁確實被 prerender）、`ls .output/public/app` 不存在。

---

### Step 2 — Schema 上線、種子資料、型別產生

**做**

1. `supabase link --project-ref <ref>`，`supabase db push`（或本機 `supabase db reset`）跑 `supabase/migrations/0001_init.sql`（內容見第 3 節）。
2. 寫 `scripts/seed.ts`：讀 `.data/films.json` / `.data/certificates.json` / `.data/venues.json`，以 **service role key** 分批 upsert（`on conflict do nothing`），並插入四筆虛擬場所 `virtual:streaming` / `virtual:festival` / `virtual:home` / `virtual:other` —— **這是提案 2 漏掉、會讓 US-7 第一天就壞掉的那四列**，先插它們再插影城。
3. 產型別：`npx supabase gen types typescript --project-id "$PROJECT_REF" --schema public > app/types/database.types.ts` —— **必須是 `app/types/`**，產在根目錄會靜默退化成 `Database = unknown`（踩雷 #24）。

**怎麼確認它對了**

- Migration 結尾的自我檢查 DO block 沒有 raise。另外手動再跑一次三條斷言（migration 若被人改壞，這是第二道）：

```sql
-- ① public schema 不得有未開 RLS 的表
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;         -- 必須 0 列
-- ② public schema 的 view 必須全部 security_invoker
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'v'
   and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=true%';  -- 0 列
-- ③ 不得有 anon 可執行的 SECURITY DEFINER 函式
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prosecdef
   and has_function_privilege('anon', p.oid, 'execute');                          -- 0 列
-- ④ viewing_record 不得長回 cost 欄位
select 1 from information_schema.columns
 where table_schema='public' and table_name='viewing_record' and column_name like '%cost%';  -- 0 列
```

- **對 `alter default privileges` 做實測**（踩雷 #29 的正解只能實測）：在 migration 之後臨時 `create function public.zz_probe() returns int language sql as 'select 1'`，然後 `select has_function_privilege('anon','public.zz_probe()','execute')` → **必須為 false**，再 drop 掉。若為 true，代表 revoke 對象寫成 `anon` 而非 `PUBLIC`，下一支 RPC 就會裸奔。
- `select count(*) from public.venue where kind <> 'cinema'` → 4；`select count(*) from public.film` ≈ 2,664；`select count(*) from public.certificate` = 3,116。
- **重跑一次 `seed`，上述三個數字完全不變**（確定性鍵 + `on conflict do nothing` 的冪等性驗收）。
- `tsc --noEmit` 通過，且在頁面裡 `const c = useSupabaseClient<Database>()` 對 `from('viewing_record')` 有欄位自動完成（型別沒有退化成 unknown）。

---

### Step 3 — 公開電影頁 `/film/{slug}`（SSR + ISR）與搜尋

**做**

1. `app/pages/film/[slug].vue`：`useAsyncData` 讀 `film_public` view（含 `case when expires_at > now()` 把關的 TMDB 快取欄位）。
2. `app/components/FilmPoster.vue` —— **全站唯一**組海報 URL 的地方（見 6.2）。
3. SEO：`useSeoMeta` 的每個值都用 getter 語法 `() => film.value?.title_zh`（踩雷 #7）；不要用已 deprecated 的 `useServerSeoMeta`（踩雷 #6）。
4. `/film/**` 的 route rule 寫 `isr: { expiration: 3600, allowQuery: [] }` —— `allowQuery` 留空會被 query string 打爆快取（踩雷 #8）。
5. 搜尋 `/search`：`USelectMenu` 一律加 `ignore-filter` + `v-model:search-term`，過濾交給 Postgres 的 `pg_trgm`，不要靠 reka-ui 的子字串比對（踩雷 #50/#51）。

**怎麼確認它對了**

- `curl -s "$SITE/film/{slug}" | grep -c '<h1'` ≥ 1 且中文片名在**原始 HTML** 裡（不是 hydration 後才有）。
- 海報 `src` 必為 `https://image.tmdb.org/t/p/...` 或 Supabase public bucket，`grep -c 'filmnote.*\/poster-proxy' ` → 0（沒有自建代理＝沒有轉存）。
- `curl -s "$SITE/film/{slug}/_payload.json" | jq 'keys'` 有輸出（ISR 路由會另產 payload，這正是為何票價**必須在 RLS 層擋掉**而不是 `v-if` 隱藏，踩雷 #10）；再 `grep -c '"cost"' ` 該 payload → **0**。
- 把某片的 `film_tmdb_snapshot.expires_at` 手動改成過去 → 清快取重整 → 海報與簡介變成文字卡片（**不是繼續供應逾期快取**）。
- 搜尋「鬼媽媽的假期」找得到（政府核准名優先於 TMDB 的 `Our Season`）；搜尋 `Our Season` 也找得到（雙欄比對）。
- 中文 IME 實機測：注音打「ㄍㄨㄟˇㄇㄚ」過程中選單不得被 composition 中途的字元清空（踩雷 #21 於第 8 節列為高風險未驗證項）。

---

### Step 4 — 公開個人頁 `/u/{username}` 與**票價 SSR 洩漏驗收**

這一步是整份計畫最容易靜默出錯的地方，驗收比實作長是正常的。

**做**

1. `app/pages/u/[username].vue`：SSR，讀 `viewing_record_public` view。
2. `server/middleware/username-redirect.ts`：查 `username`（kind='historical'）→ 301 到現用名。`routeRules.redirect` 是建置期靜態的，做不到查 DB，必須寫 middleware。
3. **`/u/**` 的 route rule 只能是 `{ ssr: true }`，永遠不加 `isr` / `swr`**（踩雷 #1）。
4. 票價資料**不要**在 SSR 端抓：作者自己看自己的票價，走 `<ClientOnly>` 在 client 端補；SSR 一律以匿名視角 render。

**怎麼確認它對了**

先造一筆帶特徵值的資料：`show_cost = false`，某筆紀錄 `cost = 1234567`，另建一筆 `visibility='private'` 且 `memo='ZZTOPSECRET'`。

```bash
# ① 未登入者取公開個人頁：原始 HTML 不得出現票價或私密備註
curl -s "$SITE/u/david" > /tmp/anon.html
grep -c 1234567    /tmp/anon.html     # 必須 0
grep -c ZZTOPSECRET /tmp/anon.html    # 必須 0
# ② 關鍵：Nuxt 會把 useAsyncData 的結果序列化進 __NUXT_DATA__，
#    畫面看不到不代表沒外洩。直接掃那段 script：
sed -n 's/.*__NUXT_DATA__[^>]*>\(.*\)<\/script>.*/\1/p' /tmp/anon.html | grep -c 1234567   # 必須 0
# ③ 作者本人（帶 cookie）取同一頁，HTML 內同樣不該有票價（票價走 client-side）
curl -s -H "Cookie: sb-<ref>-auth-token=$MY_COOKIE" "$SITE/u/david" | grep -c 1234567      # 期望 0
# ④ 快取沒被打開
curl -sI "$SITE/u/david" | grep -i 'x-vercel-cache\|x-nitro-cache'    # 必須無輸出
curl -s -o /dev/null -w '%{http_code}\n' "$SITE/u/david/_payload.json" # 必須 404
```

再直接打 PostgREST，繞過整個前端：

```bash
# ⑤ 票價表對 anon 完全空
curl -s "$URL/rest/v1/viewing_record_cost?select=*" -H "apikey: $ANON"                 # []
# ⑥ embedded resource（最常被忘記的一條）
curl -s "$URL/rest/v1/viewing_record?select=*,viewing_record_cost(amount)" -H "apikey: $ANON" \
  | jq '[.[].viewing_record_cost] | flatten | length'                                   # 0
# ⑦ !inner embed 與對 embed 欄位排序／過濾
curl -s "$URL/rest/v1/viewing_record?select=id,viewing_record_cost!inner(amount)" -H "apikey: $ANON"   # []
curl -s "$URL/rest/v1/viewing_record?select=id&order=viewing_record_cost(amount).desc"  -H "apikey: $ANON" | jq length
# ⑧ 私密紀錄與被停權者的紀錄
curl -s "$URL/rest/v1/viewing_record?select=memo&memo=eq.ZZTOPSECRET" -H "apikey: $ANON"  # []
# ⑨ 個資不得外洩：三振數／停權狀態／管理員名單
curl -s "$URL/rest/v1/profile?select=*" -H "apikey: $ANON" | jq '.[0] | keys'
#    → 不得含 role / service_status / strike_count 任一欄
# ⑩ 舊 username 不可列舉（改名的意義所在）
curl -s "$URL/rest/v1/username?select=*" -H "apikey: $ANON" | jq '[.[]|select(.kind=="historical")] | length'  # 0
```

- 改名後 `curl -sI "$SITE/u/{舊名}"` → `301` + `Location: /u/{新名}`。
- 打開 `show_cost` 後重跑 ①～⑦：④⑤⑥⑦ 開始有值，②仍為 0（因為票價仍走 client-side render）。

---

### Step 5 — 觀影紀錄 CRUD（`/app/**`，SPA）

**做**

1. `app/pages/app/records/new.vue`：片名（`USelectMenu` + `ignore-filter`）、日期時間（**`UInputDate granularity="minute"`**，`UCalendar` 沒有時間 UI，踩雷 #53）、場所（預設帶上次選的，US-6）。寫入 `watched_on date` + `watched_time time`（不是 timestamptz，這是本案最重要的一個決定）。
2. 票價寫進 `viewing_record_cost`（另一張表、另一次 insert，同一個 transaction 用 RPC 或兩次呼叫皆可）。
3. 編輯／刪除；`visibility` 切換；設定頁的 `show_cost` 開關。
4. SSR 端若要呼叫自家 `/api/**`，一律帶 `headers: useRequestHeaders(['cookie'])`（踩雷 #25）。

**怎麼確認它對了**

- 新增一筆只填三個欄位的紀錄成功（US-4）；日期預設今天（US-5）。
- `select watched_on, watched_time from viewing_record order by created_at desc limit 1` → `2026-09-05 | 21:30:00`，**不是 UTC 換算後的 13:30**，且只填日期的匯入資料 `watched_time` 為 NULL（不是被捏造的 `00:00`）。
- 用 A 帳號的 JWT 去 PATCH B 帳號的紀錄 → `PATCH /rest/v1/viewing_record?id=eq.<B的id>` 回 `0 rows` 或 404，不是 200。
- 提權測試：`PATCH /rest/v1/profile?id=eq.<自己>` body `{"role":"admin"}` → **必須被 BEFORE trigger 擋下並 raise**（RLS 的 WITH CHECK 看不到 OLD，擋不了這種改動，踩雷 #34）。
- 同上對 `film`：`{"review_state":"approved"}` → 被擋。
- 手機 375px 下表單可用（US-43 的前置）。

---

### Step 6 — 統計與圖表

**做**

1. `user_year_stats` 一律 **SECURITY INVOKER**（聚合是推論通道，踩雷 #42）；回傳含 `spend_is_partial` 旗標。
2. 圖表色票另開一組 **hex**（`@theme static { --color-chart-1: #10b981; … }`），圖表只吃這組，**絕不去讀 Nuxt UI 的 `--ui-color-*`（那些是 oklch，zrender 解析不了，踩雷 #47/#48）**。
3. 所有圖表包在 `<ClientOnly>` 內、給 `#fallback` 固定高度骨架（踩雷 #60/#61），用 `vue-echarts` 的 `autoresize`（踩雷 #59）。
4. 容器高度不要寫在 SFC 的 `<style scoped>` 裡（未分層 CSS 會蓋掉 Tailwind utility，踩雷 #49）。
5. dark mode 切換時監聽 `useColorMode()` 並重新 `setOption()`（canvas 內部顏色是 JS 算的，CSS 切換管不到）。

**怎麼確認它對了**

- `/u/{別人}` 的統計不含私密紀錄；`spend_is_partial = true` 時 UI 顯示「部分票價未公開」而非直接給總額。
- 未登入者 `POST /rest/v1/rpc/user_year_stats` 拿到的 `totals.spend` 只涵蓋已開放的票價（INVOKER 生效）。
- 切 dark mode，軸線與文字顏色跟著變，且**滑過長條圖不會整條變空白**（這就是 oklch 陷阱的實測驗收）。
- 貢獻圖的 `visualMap` 有正確的漸層（visualMap 必走插值路徑，是 oklch 的死亡點）。
- 375px 下貢獻圖與熱力圖仍可讀（US-43）。
- `UModal` 內的圖表開關兩次仍正常（`unmount-on-hide` 預設 true 是安全的；若改 false 必須手動 `chart.resize()`）。

---

### Step 7 — UGC 作品與管理審核

**做**

1. `/app/films/new`：只填片名 + 年份（US-14），海報選填上傳到 **private** bucket `ugc-poster-pending/{uid}/{film_id}.{ext}`。
2. `server/api/admin/films/[id]/approve.post.ts` —— **這是提案 1 沒做完、承認會 404 的那一步**：以 service role `storage.copy(..., { destinationBucket: 'ugc-poster' })` 搬檔 → 從 pending remove → 再以**使用者身分的 client** 呼叫 `admin_approve_film` RPC（`serverSupabaseServiceRole` 不做任何身分檢查，授權必須另外做，踩雷 #26）。
3. `/admin` 審核佇列用 `UTable`（`virtualize` 需要容器確定高度，踩雷 #54）。
4. `/admin/films/merge` 呼叫 `admin_merge_film`（只改 `film_identity` 指向，`viewing_record` 一列不動）。

**怎麼確認它對了**

- 建立 UGC 作品後：無痕視窗看不到、自己看得到、可立刻用於記錄（US-16/17）。
- **未審核海報不可公開存取**（兩條都要測，只測第一條會漏掉列舉）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$URL/storage/v1/object/public/ugc-poster-pending/$UID/$FILM.jpg"      # 400/404，不得 200
curl -s -X POST "$URL/storage/v1/object/list/ugc-poster-pending" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d '{"prefix":"","limit":100}'                                          # 必須 []
```

- 片名不得經 slug 外洩：`curl -s "$URL/rest/v1/film_identity?select=key" -H "apikey: $ANON" | grep -c '<私有片名切片>'` → 0（踩雷 #37）。
- 審核通過後：作品進公共片庫、海報改由 `ugc-poster` 供應且**已不在 pending bucket**、`film_identity` 多一筆 `slug:`。
- 合併兩部作品後：`viewing_record` 一列都沒少、敗方的 `gov:` 鍵指向存活者；**再跑一次 seed 不會復活出重複列**。
- 非 admin 帳號呼叫 `admin_approve_film` → `42501`。
- **匿名破壞性寫入測試**（提案 3 的 P0 破口）：`curl -X POST "$URL/rest/v1/rpc/admin_merge_film" -H "apikey: $ANON" -d '{...}'` → `401/404`，**不得是 200**。

---

### Step 8 — 法遵頁面與 DMCA 流程

**做**：依 6.1 的落點表建立四類頁面與兩支 API，`legal_document` 塞入第一版條款（含 `content_sha256`），`app/layouts/default.vue` 頁尾加顯名聲明。

**怎麼確認它對了**

- `/legal/copyright` 上有可讀的聯繫窗口（`copyright@filmnote.tw`）與完整的通知／取下／回復流程說明，且**每一頁的頁尾都連得到**。
- 未登入者可提交侵權通知、但讀不到：

```bash
curl -X POST "$URL/rest/v1/dmca_notice" -H "apikey: $ANON" \
     -H "Prefer: return=minimal" -H 'Content-Type: application/json' -d '{...}'   # 201
curl -s "$URL/rest/v1/dmca_notice?select=*" -H "apikey: $ANON"                    # [] / 401
```

不帶 `Prefer: return=minimal` 會失敗，這是刻意的——沒有 SELECT policy 就拿不到 RETURNING，確保這張表在 API 層是單向的。

- `admin_takedown` 後：該紀錄／作品在公開頁**立即**消失（US-52），**且引用該作品的其他人的公開紀錄與票價也一併消失**（這是提案 1 漏掉的 join，必須實測）。
- `admin_add_strike` 第三次後 `profile.service_status = 'terminated'`，該使用者個人頁與全部公開紀錄立即不可讀。
- `admin_restore` 後內容回復、`visibility` 一併還原、該次三振被作廢（不是沉默的半回復）。
- `dmca_counter_notice` 填 `forwarded_at` → `litigation_proof_due_at`（+10 工作日）與 `restore_due_at`（+14 工作日）自動算出。

---

### Step 9 — TMDB 六個月刷新排程

**做**：`server/api/cron/tmdb-refresh.get.ts`（驗 `Authorization: Bearer $CRON_SECRET`）取 `next_refresh_at <= now()` 的批次刷新，寫回 `expires_at = now()+180d`、`next_refresh_at = now()+150d`，失敗則指數退避；`tmdb-purge` 第二道防線；`vercel.json` 的 `crons` 兩條。刷新只覆寫 `title_zh_source='tmdb'` 的欄位。

**怎麼確認它對了**

- 把某列 `expires_at` 設成過去 → 重整 `/film/{slug}` → 海報與簡介變 NULL（退回文字卡片）。這證明合規靠的是讀取端 view 的把關，不是「cron 一定會跑」。
- 跑一次 refresh → `state='fresh'`、`expires_at` 往後推；**政府核准的 `title_zh` 沒有被 TMDB 的中文標題覆蓋**（`select title_zh from film where id = …` 前後一致）。
- TMDB 回 429 時整批不失敗，只推遲 `next_refresh_at`。

---

### Step 10 — 舊 log 資料匯入（US-56/57/58）

**做**：`/app/import` 上傳 CSV/JSON → 走接縫 A 的比對器 → 預覽（已比對／未比對）→ 以 `import_key` 寫入，`unique (user_id, import_key)` 保證冪等。

**怎麼確認它對了**：同一份檔案匯入兩次，`select count(*) from viewing_record where user_id = …` 不變；未比對到的片明列出來且可一鍵建 UGC 作品；只有日期沒有時間的舊資料 `watched_time` 為 NULL。

---

### Step 11 — 部署 Vercel

**做**：Framework Preset = Nuxt.js；Build Command 保持 `nuxt build`（**絕不能是 `nuxt generate`**，踩雷 #2）；**不設 `NITRO_PRESET`**（踩雷 #11）；Node 22.x/24.x；環境變數照 2.7；Supabase Redirect URLs 補 `https://*-<team-slug>.vercel.app/**` 與正式網域。

**怎麼確認它對了**

- 正式站 Google 登入完整走通。
- `curl -I https://filmnote.tw/app` → 有 `x-robots-tag`。
- `curl -I https://filmnote.tw/film/{slug}` 打兩次 → 第二次 `x-vercel-cache: HIT`。
- `curl -I https://filmnote.tw/u/{username}` → **沒有** `x-vercel-cache`。
- **重跑 Step 4 的全部十條驗收，這次打正式站。**（CDN 是新的變因，本機通過不代表線上通過。）
- `/legal/terms` 與 `/` 是 build 時就存在的靜態檔。

---

# 6. 法遵要件的落點

## 6.1 ISP 避風港四要件（著作權法 §90-4）

| 要件 | 落點 | 具體內容 |
|---|---|---|
| **① 服務條款告知著作權保護措施，並確實履行** | `app/pages/legal/terms.vue`（prerender）<br>`public.legal_document`（kind='terms'）<br>`public.legal_acceptance` | 條款正文含「著作權保護措施」專章。**版本與 `content_sha256` 寫進 `legal_document`**；使用者首次登入後在 `/app` 顯示一次性同意，寫入 `legal_acceptance`。沒有這兩張表，日後無從舉證「已於侵權發生時告知」。 |
| **② 三振條款（三次侵權終止服務）** | `app/pages/legal/terms.vue` 明文條列<br>`public.copyright_strike` + `admin_add_strike()` + `profile.service_status`<br>`app/pages/app/notices.vue` | 條款須明白寫出「三次涉有侵權情事應終止全部或部分服務」。技術落點：第 2 次 `limited`、第 3 次 `terminated`。停權後 `profile_select` 與 `viewing_record_select` 都檢查 `service_status`，公開內容**立即**消失，不需另一支批次工作。 |
| **③ 公告接收侵權通知的聯繫窗口** | `app/pages/legal/copyright.vue`（prerender）<br>`app/layouts/default.vue` 頁尾常駐連結 | 頁面載明窗口電子郵件 `copyright@filmnote.tw`、聯絡地址、受理程序、所需記載事項（§90-6 及施行辦法）。**必須全站每一頁都能到達。** |
| **④ 通知／取下／回復通知流程** | 通知：`app/pages/legal/copyright/notice.vue` + `server/api/legal/notice.post.ts` → `public.dmca_notice`<br>取下：`admin_takedown()` 設 `moderation_state='removed'`<br>告知使用者：`dmca_notice.notified_user_at` + `/app/notices`<br>回復通知：`app/pages/legal/copyright/counter/[id].vue` → `public.dmca_counter_notice`<br>期限：`business_days_after()` trigger<br>回復：`admin_restore()` | **取下一律是狀態不是 DELETE** —— 刪掉就永遠無法履行 §90-9 的回復義務，這是事後補不回來的 schema 決定。`forwarded_at` 一填，trigger 自動算出 `litigation_proof_due_at`（+10 工作日）與 `restore_due_at`（+14 工作日），各處實作不會漂移。 |

## 6.2 其他法遵落點

| 項目 | 落點 |
|---|---|
| **海報一律熱連結 `image.tmdb.org`，不自行轉存** | `app/components/FilmPoster.vue` 是**唯一**組海報 URL 的地方：`poster_source='tmdb'` → `https://image.tmdb.org/t/p/{size}{path}`；`'ugc'` → Supabase public bucket；`'none'` → 文字卡片。**不要用 `nuxt-og-image` 把 TMDB 海報 pipe 進自己的生成器**——那等同轉存。OG 圖只用純文字卡片或 TMDB 原圖直連。 |
| **海報不得置於付費牆之後**（§90-7 第 2 款） | 本階段**不建立任何 subscription / entitlement 表**。`film_public` view 與 `ugc-poster` bucket 一律對 `anon` 開放。日後若加付費牆，必須撤銷 anon 的 grant——那是一次顯眼、需要 migration、會被 review 看到的決定，不會是誰隨手加個判斷就發生。 |
| **政府開放資料顯名聲明** | `app/layouts/default.vue` 頁尾：「本站部分資料採用文化部影視及流行音樂產業局『電影片分級及相關資訊』與『全國電影院資料』開放資料，依政府資料開放授權條款第 1 版提供。」⚠️ **未盡顯名標示義務者視為自始未取得授權**——這行不可省。 |
| **TMDB attribution** | 同頁尾：TMDB logo（**須 less prominent than 本站標誌**）＋「This product uses the TMDB API but is not endorsed or certified by TMDB.」 |
| **TMDB 快取 ≤ 6 個月** | `film_tmdb_snapshot.expires_at` 預設 180 天；`film_public` view 讀取時 `case when expires_at > now()` 把關；`purge_expired_tmdb_cache()` 為第二道防線。 |
| **Vercel Hobby 商業使用禁令** | 站上**不得**宣傳未來收費、不得放贊助／捐款管道（Hobby 的定義涵蓋此兩者）。收費時同步升級 Vercel Pro + TMDB 商業訂閱。 |
| **DMCA 表單防濫發** | `server/api/legal/notice.post.ts` 必須加 Turnstile 或 rate limit —— `anon` 可 INSERT `dmca_notice` 是法定義務，但**資料庫層完全沒有防護**。 |
| **`memo` 為使用者自由文字且預設公開** | schema 只做長度限制（2000 字），內容審核不在資料庫層，靠 §90-4 的通知／取下流程處理。 |

---

# 7. 已知踩雷點

## 7.1 Nuxt / 算繪

| # | 踩雷點 | 來源 |
|---|---|---|
| 1 | **`/u/**` 絕不可加 `isr` / `swr`。** Nitro v2 快取「all incoming request headers are dropped when handling cached responses」，cache key 只由 `group:name:getKey` 組成，cookie 不在 key 裡；Vercel ISR 也以「路徑」為單位。同一個 `/u/{username}` 對作者與路人 render 出不同 HTML → 作者先造訪就把含票價的 HTML 寫進 CDN | `v2.nitro.build/guide/cache`、`vercel.com/docs/incremental-static-regeneration` |
| 2 | **`nuxt generate` 不能用。** 官方原文「Hybrid Rendering is not available when using `nuxt generate`」；Vercel 比較表亦標明不支援 SSR/ISR | `nuxt.com/docs/4.x/guide/concepts/rendering`、`vercel.com/docs/frameworks/full-stack/nuxt` |
| 3 | **`ssr:false` 路由的 `<meta name="robots">` 只在 hydration 後存在**，爬蟲第一次抓到的是空殼。必須用 HTTP header `x-robots-tag` | 同上 |
| 4 | **`spa-loading-template.html` 不在專案根目錄。** 文件寫 `~/spa-loading-template.html`，Nuxt 4 的 `~` = `<rootDir>/app` | `nuxt.com/docs/4.x/api/nuxt-config` |
| 5 | **算繪模式無法寫在頁面元件裡。** `PageMeta` 介面沒有 `ssr`；Vercel 明講「there is no way to configure route deployment options within your page components」。搬檔案時很容易忘了同步 `routeRules` | `nuxt.com/docs/4.x/api/utils/define-page-meta` |
| 6 | **`useServerSeoMeta` 已 deprecated**，`compatibilityVersion: 5` 之下 auto-import 會被移除。改寫 `if (import.meta.server) { useSeoMeta({…}) }` | `nuxt.com/docs/4.x/api/composables/use-server-seo-meta` |
| 7 | **`useSeoMeta` 的反應式值必須用 getter `() => value`**，直接傳值只抓 render 當下的快照 | `nuxt.com/docs/4.x/api/composables/use-seo-meta` |
| 8 | **`isr` 的 `allowQuery` 留 undefined 會快取爆炸。** 每個 query string 值產生一份獨立快取，被 `?a=1&a=2…` 打就吃光 Hobby 額度。`/film/**` 必須明確 `allowQuery: []` | `v2.nitro.build/deploy/providers/vercel` |
| 9 | **Vercel 要求 Nuxt 用 `isr` 而非 `swr`**：「The `isr` option enables Nuxt to use Vercel's Cache」。寫 `swr` 只會退化成 Cache-Control header | `vercel.com/docs/frameworks/full-stack/nuxt` |
| 10 | **`isr`/`swr` 路由會額外產生 `_payload.json`**（`useAsyncData` 的序列化結果）。SSR 時把票價塞進 payload，HTML 沒顯示也會被快取並公開可讀。**RLS 必須在資料層擋，不能只靠 `v-if`** | `nuxt.com/docs/4.x/getting-started/prerendering` |
| 11 | **`vercel_edge` preset 已 deprecated**，不要為了效能設 `NITRO_PRESET=vercel-edge` | `v2.nitro.build/deploy/providers/vercel` |
| 12 | **Node 版本要對齊。** `nuxt@4.5.2` engines `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0`；Vercel 停在 20.x 裝不起來 | npm registry |

## 7.2 Supabase / Auth

| # | 踩雷點 | 來源 |
|---|---|---|
| 13 | **v2 破壞性變更：`useSupabaseUser()` / `serverSupabaseUser()` 回傳 JWT claims 不是 User 物件。`user.id` 不存在，要用 `user.sub`。** 舊教學幾乎全是 v1 寫法 | 官方 migration 頁；`serverSupabaseUser.js`；issue #561 |
| 14 | **`redirectOptions.callback` 不要設成 `'/'`。** 模組會無條件對 callback 路徑加 `routeRules[callback] = { ssr:false }`，等於把首頁 SSR 關掉 | issue #582；`dist/module.mjs` |
| 15 | **`include`/`exclude` pattern 不是 glob，是 `new RegExp('^' + p.replace(/\*/g,'.*') + '$')`。** `'/app'` 不匹配 `/app/new`；`'*'` 與 `'**'` 行為相同；**與 Dashboard Redirect URLs 的 glob 語法不一樣** | `auth-redirect.js` |
| 16 | **`include` 有值時完全短路 `exclude`**，兩者不是疊加關係 | 同上 |
| 17 | **全域 auth middleware 檢查的是 `useSupabaseSession()`（未驗簽、來自 client），是 UX 導引不是安全邊界。** 真正授權靠 RLS + `serverSupabaseUser()` | 同上；官方 `serverSupabaseSession` 警告 |
| 18 | **Google Console 的 redirect URI 是 `https://<ref>.supabase.co/auth/v1/callback`，不是你的 `/confirm`。** 兩層搞混是最常見的 OAuth 失敗原因 | `supabase.com/docs/guides/auth/social-login/auth-google` |
| 19 | **`cookieOptions.secure` 預設 `true`，Safari 不接受 `http://localhost` 的 Secure cookie** → 本機 Safari session 完全不持久（Chrome 正常，極難察覺） | issue #545 |
| 20 | **`cookieOptions.maxAge` 預設只有 8 小時**，對低頻產品體驗很差 | `dist/module.mjs` defaults |
| 21 | **必須用 `@nuxtjs/supabase >= 2.0.9`。** 2.0.0–2.0.8 在 `ssr:false` 路由上 hard-refresh 會把已登入者踢回 `/login`——本專案 `/app/**` 正中此 bug | issues #605 / #611 |
| 22 | **開放中的安全性問題 #635（2.0.10 未修）**：`fetch-retry.js` 第三次失敗時 `console.error(..., safeInit)`，`safeInit` 只 destructure 掉 `headers` 沒掉 `body`，refresh token 會被寫進 Vercel log / Sentry。上線前 patch 或確保 log drain 有存取控制 | GitHub issue #635（實核 2.0.10 dist） |
| 23 | **沒啟用 JWT signing keys（留 HS256）時 `getClaims()` 會 fallback 成打 Auth server**，而 server plugin 每次 SSR 都跑 `getSession + getClaims` | `auth-js` `GoTrueClient.getClaims()` |
| 24 | **`types` 預設 `'~/types/database.types.ts'` = `app/types/`。** 產在根目錄模組讀不到，型別靜默退化成 `Database = unknown`（只有一行 warn） | issue #608 |
| 25 | **SSR 呼叫自家 `/api/**` 漏掉 `headers: useRequestHeaders(['cookie'])`** → `serverSupabaseUser` 回 null → SSR 畫面像未登入 | `supabase.nuxtjs.org/services/*` |
| 26 | **`serverSupabaseServiceRole` 不是 async，且完全不做身分檢查。** 每次使用前必須自己驗證呼叫者 | 官方文件 |
| 27 | **`handle_new_user` trigger 失敗會讓整個註冊失敗**（使用者看到 `Database error saving new user`）。username 撞名是必然事件（`david@gmail.com` vs `david@outlook.com`），trigger 內必須自行處理衝突並包 `exception when others then return new` | `supabase.com/docs/guides/auth/managing-user-data` |
| 28 | **`security definer` + `set search_path = ''` 兩者都不能省**，加了之後函式內每個表都要寫 `public.xxx` 全名 | 同上 |

## 7.3 資料庫 / RLS（本次評審實際找到的）

| # | 踩雷點 | 來源 |
|---|---|---|
| 29 | **`alter default privileges … revoke execute on functions from anon, authenticated` 是無效的。** 新函式的預設 EXECUTE 授予的是 **PUBLIC**。寫錯對象 → 下一次 migration 新增的任何 RPC 預設就是 anon 可呼叫 | judge-leak，提案 1 §0.1 |
| 30 | **絕不用 `auth.uid() is null` 當「service_role 直連，放行」的判準。** anon 的 `auth.uid()` 同樣是 NULL —— 這條件把守門邏輯對未登入者整組關掉（提案 3 因此讓 anon 可呼叫破壞性 RPC） | judge-practical |
| 31 | **也不能用 `current_user` 判斷特權情境。** 所有 SECURITY DEFINER 的 owner 都是 postgres → 日後新增的 definer 函式會讓 guard 觸發器整組跳過。用 `session_user` + 顯式 transaction-local 旗標 | judge-practical |
| 32 | **Postgres 的 view 預設以擁有者權限執行 = 完全繞過 RLS。** 忘了 `security_invoker=true` 就是把底表全站公開 | PG 文件；提案 1 §6 |
| 33 | **絕不對 SELECT 做欄位級 `revoke`。** 一旦 `revoke select (cost)`，PostgREST 預設的 `select=*` 直接 permission denied，錯誤訊息毫無上下文 | judge-practical（提案 2 的正確判斷） |
| 34 | **RLS 的 `WITH CHECK` 只看得到 NEW，看不到 OLD**，無法表達「此欄不准被改」。必須靠 BEFORE 觸發器 | judge-leak |
| 35 | **`film.tmdb_id` 的 UNIQUE 是存在性 oracle。** 若允許使用者填寫，唯一鍵衝突會回報「這部片在不在庫裡」，並可搶佔尚未匯入的 id | 提案 1 rationale |
| 36 | **確定性字串鍵不可當 PK。** `tmdb:<id>` / `gov:<zh>:<orig>` 可猜測；當 PK 時 FK 檢查（繞過 RLS）就成了私有作品的存在性探測器 | 提案 1 rationale |
| 37 | **slug 會外洩片名。** `slugify(title)` 寫進 `film_identity` 後，若該表 `using (true)`，一次查詢倒出全部未審核私有作品的片名切片 | judge-practical（提案 3 缺陷） |
| 38 | **bucket 設 `public: true` + anon 可 select `storage.objects` → 未審核海報全網可列舉。** 物件列舉走 `storage.objects` 的 RLS，不是靠猜路徑 | judge-practical |
| 39 | **policy 裡的 STABLE 函式呼叫必須包成 `(select f())`**，否則逐列求值（幾百列 = 幾百次 `request.jwt.claims` JSON 解析）。包成純量子查詢後 planner 提成 InitPlan | 提案 2 rationale |
| 40 | **`create type` 不可全部擠在同一個 `DO … exception when duplicate_object` block。** 第一個 duplicate 就 abort 整個 block，後面的型別靜默不建立 | judge-leak |
| 41 | **Materialized view 無法套用 RLS**（沒有 `ALTER MATERIALIZED VIEW … ENABLE RLS`）。本計畫因此完全不用 MV | 提案 2 rationale |
| 42 | **聚合是推論通道不是安全邊界。** 一支 DEFINER 的 `sum(cost)` 會把 RLS 擋下的資料以總額形式漏光。統計／匯出 RPC 一律 INVOKER | 提案 1 rationale |
| 43 | **`timestamptz AT TIME ZONE 'Asia/Taipei'` 是 STABLE**（tzdata 會改版），不能用於 generated column 或索引運算式；`AT TIME ZONE INTERVAL '8 hours'` 才 IMMUTABLE。本計畫用 `date` + `time` 避開整個問題 | 提案 2 的 volatility 對照表 |
| 44 | **`permit_no` 不能當主鍵。** 110–112 年 CSV 無系列前綴，四系列各自從 001 編號而大量撞號（128/143/157 筆） | SPEC |
| 45 | **`create policy … on storage.objects` 需要該表擁有權。** SQL Editor 通常可以，CLI migration 偶爾需要 `supabase_admin` | 提案 1 自陳風險 |
| 46 | **`delete from auth.users` 是否為 postgres 可執行需實測。** 若否，帳號刪除須改走 Edge Function + Admin API | 同上 |

## 7.4 Nuxt UI / ECharts

| # | 踩雷點 | 來源 |
|---|---|---|
| 47 | **ECharts 完全看不懂 oklch。** Tailwind 4.3.3 與 Nuxt UI 的 token 全是 `oklch()`，`zrender@6.1.0` 的 `parse()` switch 只有 rgba/rgb/hsla/hsl 四個 case，其餘 `default: return;`。症狀極隱蔽：靜態填色正常，一旦走 hover emphasis / LinearGradient / **visualMap** / 色彩動畫就整條空白。貢獻圖與熱力圖必用 `VisualMapComponent` | `apache/echarts#20757`（2025-02-13 開，仍 open）；實讀 `zrender/lib/tool/color.js` |
| 48 | **`zrender` 的 `parse()` 先 `replace(/ /g,'')` 再 `.split(',')`** → 連 `rgb(0 0 0)` 這類現代空白分隔語法都失敗。傳給 ECharts 的顏色一律 hex 或舊式 `rgba(r, g, b, a)` | `apache/echarts#19604`（仍 open） |
| 49 | **Tailwind 4 的 cascade layer 造成優先權反轉：未分層 CSS 必勝所有 `@layer utilities`。** SFC 的 `<style scoped>` 經 Vite 處理後未分層 → `.chart{height:100%}` 靜靜蓋掉 `h-[400px]` → 容器 0 高 → ECharts 初始化成 0×0 | Tailwind compatibility 頁 + CSS Cascade Layers 規範 |
| 50 | **`USelectMenu` / `UInputMenu` 的搜尋不是 fuse.js**，是 reka-ui 的 `useFilter`（`Intl.Collator`, `sensitivity:'base'`），子字串比對而非模糊比對。3,000+ 筆片庫務必 `ignore-filter` + `v-model:search-term` | 實讀 `dist/runtime/composables/useFilter.js` |
| 51 | **`USelectMenu` 預設把整個 item 物件綁進 v-model**，要綁單欄必須顯式 `value-key`；`filter-fields` 預設只有 `[labelKey]` | `ui.nuxt.com/docs/components/select-menu` |
| 52 | **`UInputDate` / `UCalendar` 的 `locale` prop 在 v4.2.0 被拿掉、v4.8.2 才修回。** pin 在 4.2.0–4.8.1 之間繁中日期格式會壞。用 `^4.11.0` | Release notes #5432 / #6546 |
| 53 | **`UCalendar` 本身沒有時間選擇 UI。** `watched_time` 的正解是 `UInputDate granularity="minute"`，不是舊教學的 `UPopover` + `UCalendar` | `ui.nuxt.com/docs/components/input-date` |
| 54 | **`UTable` 啟用 `virtualize` 必須給容器確定高度**（官方：「A height constraint is required」），且啟用後不支援 row pinning | `ui.nuxt.com/docs/components/table` |
| 55 | **`@nuxt/fonts` / `@nuxt/icon` / `@nuxtjs/color-mode` 是 `@nuxt/ui` 的 bundled dependency 並自動註冊**，另外裝或加進 modules 會衝突 | 實讀 tarball |
| 56 | **`tailwindcss` 同時列在 `@nuxt/ui` 的 dependencies 與 peerDependencies**，官方安裝指令要求裝成直接相依 | `ui.nuxt.com/docs/getting-started/installation/nuxt` |
| 57 | **`@nuxt/ui@4.11.0` 的 engines 是 `^20.19.0 \|\| >=22.12.0`。** repo 現在寫 `>=22`，Node 22.0–22.11 落在支援範圍外 | `npm view` |
| 58 | **程式化開 Modal / Slideover（`useOverlay()`）、Toast、Tooltip 都需要 `app.vue` 有 `<UApp>`。** 漏掉不會有錯誤訊息，只是不動 | `ui.nuxt.com/docs/components/modal` |
| 59 | **`USidebar` / `UDashboardPanel` 收合時 window 尺寸沒變，`window.resize` 不會觸發。** 用 `vue-echarts` 的 `autoresize`（ResizeObserver） | `github.com/ecomfe/vue-echarts` README |
| 60 | **`.client.vue` 只在 auto-import 或從 `#components` import 時才生效。** 用真實路徑 explicit import 會**靜默**變成 SSR 元件、canvas 在 Node 裡爆掉。SSR 頁一律用 `<ClientOnly>` | `nuxt.com/docs/4.x/directory-structure/app/components` |
| 61 | **`<ClientOnly>` 的 default slot 會從 server build 被 tree-shake**（官方註明「any CSS used by components within it may not be inlined」）→ 務必用 `#fallback` 給固定高度骨架 | `nuxt.com/docs/4.x/api/components/client-only` |
| 62 | **Nuxt UI 的 locale 具名匯出是底線 `zh_tw`**，不是 `'zh-tw'` | 實讀 `dist/runtime/locale/` |
| 63 | **v3→v4 已改名**：`ButtonGroup`→`FieldGroup`、`PageMarquee`→`Marquee`、`PageAccordion` 移除；`UForm` 的 `nullify`→`nullable`，巢狀 form 要顯式 `nested` 與 `name`。抄 2025 年的範例會踩到 | `ui.nuxt.com/docs/getting-started/migration` |
| 64 | **`UForm` 不內建任何驗證函式庫**（官方明確警告）。`zod` peer 範圍 `^3.24.0 \|\| ^4.0.0`，要自己裝 | `ui.nuxt.com/docs/components/form` |

## 7.5 資料匯入（來自 SPEC 實測）

| # | 踩雷點 |
|---|---|
| 65 | 包裝 JSON 與 CSV **皆為 UTF-8 with BOM**，直接 `JSON.parse` 會失敗 |
| 66 | 包裝 JSON 的 `FileName` 是陷阱：只指向**最舊**的年度；逐年 CSV 藏在 `相關檔案` 的 `名稱(URL);…` 字串裡 |
| 67 | CSV **必須以陣列模式解析並偵測欄數**，用 `columns: true` 會靜默錯位（《劇場版IDOLiSH7》原文片名含逗號未被引號包住） |
| 68 | 年份**不可作硬篩**（《紅豬》核准 113 年、TMDB 1992），只加分不懲罰 |
| 69 | TMDB 的 `original_title` 常為母語而非英文（政府給 `Porco Rosso`、TMDB 存 `紅の豚`）→ 必須雙查詢 |
| 70 | **缺少片長交叉驗證會產生假陽性**（《一屍到底》配到 `Making Of One Cut of the Dead`、《貓的報恩》配到 `Batman Returns`） |
| 71 | **TMDB 免費 key 在規模化匯入時會被節流**（實測後跑的批次慢約 6 倍）。管線必須可中斷可續跑 |
| 72 | **Supabase 免費專案閒置 7 天會自動暫停。** 上線前須以排程 ping 維持活躍 |

---

# 8. 未能驗證事項（執行者必須自行確認）

## 8.1 資料庫（最高優先）

1. **本計畫的 SQL 未在真實 Postgres 上執行過。** 第一件事是對本機專案 `supabase db reset` 跑一次。特別留意：`create policy … on storage.objects` 是否需要 `supabase_admin`；`delete from auth.users` 是否為 postgres 可執行（若否，`delete_my_account()` 必須改走 Edge Function + Admin API）；`admin_add_strike()` 內對 `profile` 的 UPDATE 會觸發 guard trigger，其 transaction-local bypass 旗標在 AFTER trigger 情境下是否確實生效。
2. **特權情境判定（`session_user` / `current_user`）的三個判準需逐一實測**：PostgREST + service_role key 時 `current_user` 是否為 `service_role`；PostgREST + user JWT 呼叫 DEFINER 函式時 `session_user` 是否為 `authenticator`；`db reset` / seed 時 `session_user` 是否為 `postgres`。任一不符，guard 觸發器會在錯誤方向失效（要麼擋住 seed，要麼放行使用者）。
3. **Vercel ISR 是否會把 cookie 納入快取 key，官方文件從未明文說明。**「`/u/**` 不可快取」是綜合 Nitro cache 文件與 Vercel ISR 文件推導的工程判斷。**上線前務必實測 Step 4 的第 ③④ 條。**
4. **`viewing_record_select` 的 policy 內含 EXISTS 子查詢**（檢查 film 與 profile 狀態）。需以 `EXPLAIN (ANALYZE, BUFFERS)` 對真實資料量確認是 semi-join 而非逐列求值。若成為瓶頸，備案是反正規化——但那會引入一致性風險且**失敗方向指向外洩**（提案 2 的教訓），非不得已不做。
5. **helper 函式對 anon 開放 EXECUTE 會形成 oracle**（「這個 record 是否公開且已開票價」）。實務上 UUID 不可猜測，且 helper 放在不曝露的 schema——但**這個保護只存在於 Supabase 專案設定（`db-schemas`），不在 SQL 裡**。需確認該設定只有 `public`（與 `graphql_public`）。
6. **未使用 `FORCE ROW LEVEL SECURITY`。** helper 靠「表擁有者不受 RLS 約束」讀真值；開了 FORCE 會失效。代價是任何以 postgres 身分執行的 SQL 完全不受 RLS 保護。需確認這個取捨可接受。
7. **現用 username 對 anon 全可列舉**（公開個人頁的必然結果），可被用來建立全站使用者清單。爬蟲防護要在邊緣層做，schema 層無解。
8. **`resolve_username()` 的舊→新轉向本身就是揭露**——知道舊名就得到新名。這是 US-25 的必然代價；緩解是不可列舉 + 可關閉 + 到期，不是消除。
9. **`grant select on public.film` 含 `created_by`**，公開已審核作品會揭露「誰新增了這部片」。若視為問題需改成逐欄 grant 排除該欄。
10. **`admin_*` RPC 對 `authenticated` 開放 EXECUTE、由函式內部自行把關。** 斷言只能做字串比對（`admin_` 前綴的 definer 函式原始碼必須含權限檢查），不是語意檢查——仍需 code review。

## 8.2 Nuxt / 套件

11. **沒有實際 scaffold 過 Nuxt 4.5.2 + `@nuxtjs/supabase` 2.0.10 + `@nuxt/ui` 4.11.0 的組合。** 所有結論來自官方文件、npm tarball 的 dist 原始碼與 GitHub issues 的交叉比對，不是執行結果。**是否有相依衝突（尤其 `@nuxt/kit` 版本）未實際跑過安裝驗證。**
12. **`@nuxtjs/supabase` 官方文件站沒有任何一頁講 hybrid rendering 的建議設定**（issue #605 明確指出這個缺口）。`routeRules` 與 `redirectOptions` 的搭配是從原始碼推導的，不是官方背書。
13. **模組的 redirect middleware 在 `ssr:false` 路由上的執行時機**未在官方文件找到說明。
14. **issue #606（`page:start` 每次導航都 `await getClaims()`）**：回報者宣稱 2.0.9 修好，但核對 2.0.10 的 dist，該段仍存在且仍 await。「JWKS 端點不可達時導航是否會 hang」未實測。
15. **`routeRules` 在 `nuxt.config` 參考文件中仍被標為 Experimental**，雖然它是 hybrid rendering 的唯一入口。
16. **`appMiddleware` route rule 的完整語義**未能驗證（middleware 專章完全沒提，找不到官方範例）。若要用它控制 `/app/**` 的 auth middleware，先在本機驗證。
17. **`experimental.spaLoadingTemplateLocation` 在 Nuxt 4 是否還存在**未能確認（`nuxt-config.md` 全文 grep 不到）。
18. **`@nuxt/ui` v4 與 `ssr:false` routeRules 的互動**（Tailwind 4 的 CSS 是否會因頁面被踢出 server bundle 而漏掉某些 utility）完全未查證。
19. **`vue-echarts@8.2.0` 與 Nuxt 4 SSR 的整合細節**（是否需要 transpile、有無 ESM interop 問題）未實測，只驗證了 peer 相容。
20. **`UTable` 在 3,000+ 筆 × 實際欄位數下的真實 FPS 與記憶體沒有實測**（官方虛擬化範例是 1,000 筆合成資料）。建議先做一次真實資料 profiling。
21. **中文 IME（注音／拼音）在 `USelectMenu` / `UInputMenu` 搜尋框的 composition 行為沒有實機驗證。** `useIMEGuard` 雖存在於 v4，但實測整包 runtime 只有 `ChatPrompt.vue` 用它。**這是繁中產品的高風險點，務必實機測。**
22. **用 Canvas 2D `fillStyle` 把 oklch 正規化成 hex 的 fallback 未實機驗證**（超出 sRGB 色域時可能回 `color(display-p3 …)`，zrender 一樣解析不了）。主方案請用 `@theme static` 的 hex 色票。
23. **Vercel Hobby 對本組合的實際 build 時間與 Serverless Function 大小上限是否會踩到未實測。**
24. **Hobby 上 SSR function 冷啟動對 JWKS 快取的影響**沒有官方說明也未實測；若冷啟動頻繁，已登入者的首個 SSR 請求仍可能多一次網路往返。

## 8.3 產品 / 法務

25. **付費牆與著作權法 §90-7 第 2 款的關係需律師意見**，無法從條文推斷。本計畫的處理是「Phase 1 完全不建付費結構」，把問題延後。
26. **`business_days_after()` 只扣週末，未含台灣國定假日與颱風假。** 期限會算得比實際早（對平台是保守方向，不至於違法），但正式營運前應補一張假日表。
27. **TMDB 商業方案的實際定價與自助訂閱可用性未核實**（$149/月僅來自論壇發言，訂閱頁需登入且實測 401）。本階段用免費 key 不阻塞。
28. **TMDB 演職員（cast / crew）的中文化程度未測**（已測項目僅涵蓋片名與簡介）。
29. **TMDB 的 runtime / release_year 回填進 `film` 本體，而本體不受 6 個月 TTL 管制。** 片長與年份屬事實性資料，實務上應無問題，但嚴格解讀 TMDB 條款時是灰色地帶，建議與付費牆法律意見一併確認。
30. **UGC 私有作品被公開紀錄引用時，該紀錄對外整筆不可見。** 使用者會看到「我設了公開卻沒人看得到」，schema 層無法解釋，**必須靠 UI 明示「待審核通過後才會公開」**。
31. **多刷排行以 `film_id` 分組。** 管理者合併重複作品後歷史統計會改變（技術上正確，但「我去年的多刷排行怎麼變了」是真實的使用者困惑）。
32. **`dmca_notice` 開放 anon INSERT 是垃圾訊息的靶。** 必須在 Nitro/Edge 端加 Turnstile 或速率限制；資料庫層沒有防護。
33. **`certificate.raw` 永久保留原始 JSON 會放大 DB 體積。** 3,116 列估計數 MB，應無問題，但 **Supabase 免費專案 500MB 上限**需實測確認。

---

## 附：本計畫刻意**不做**的事（避免日後重複評估）

| 項目 | 理由 |
|---|---|
| Materialized view + pg_cron 做個人統計 | 二十年也只有數千列，走索引是微秒級。MV 只換來刷新成本、過時資料，以及一個**沒有 RLS 的表**；免費專案閒置暫停期間 pg_cron 也不會執行 |
| `generated` 分桶欄位 + `INCLUDE` 覆蓋索引 | 同上；INCLUDE 欄位一旦增減就得重建整條索引，統計面板加維度時會持續肥大 |
| 三個鏡射欄位（`film_public` / `public_listed` / `cost_public`） | 把「不可能外洩」降級成「只要觸發器一直正確就不外洩」，且 `default true` 讓失敗方向指向外洩 |
| 付費 / entitlement 表 | 理論純度不值那個成本；Phase 1 完全不建，海報路徑在結構上碰不到付費判斷 |
| 欄位級 GRANT（SELECT） | 見踩雷 #33；`select=*` 會直接 403。欄位級 GRANT 只用於 INSERT/UPDATE |
| `nuxt-echarts` 模組的 SSR 元件 | 建立在 experimental 的 `<NuxtIsland>` 上，模組自帶警語；且 ECharts SSR 強制固定 width/height，與響應式圖表天生衝突 |
| `nuxt-og-image` 生成含 TMDB 海報的 OG 圖 | 把 TMDB 海報 pipe 進自己的生成器等同轉存 |
| 影廳主檔（`venue_hall`） | 政府資料不提供影廳層級資訊，現在建空表徒增複雜度。演進路徑已預留（日後加 `hall_id uuid NULL` 回填即可） |