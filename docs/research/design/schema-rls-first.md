# schema-rls-first

## SQL

```sql
-- =============================================================================
-- 影記 / filmnote — Supabase schema
-- 檔案：/Users/david/Documents/Github/filmnote/supabase/migrations/0001_init.sql
-- 設計優先序：可演進性 > 資料完整性 > 查詢便利性
-- 一次可執行完畢；所有物件皆為 idempotent，可重跑。
-- =============================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto  with schema extensions;
create extension if not exists pg_trgm   with schema extensions;
create extension if not exists unaccent  with schema extensions;

-- -----------------------------------------------------------------------------
-- 0. 列舉型別
--    封閉狀態機用 enum（新增值只需 ALTER TYPE ADD VALUE）；
--    會持續長出成員的開放詞彙（播放版本）用查表，不用 enum。
-- -----------------------------------------------------------------------------
do $$ begin
  create type public.visibility        as enum ('public','private');
  create type public.moderation_state  as enum ('visible','withheld','removed');
  create type public.review_state      as enum ('pending','approved','rejected');
  create type public.film_origin       as enum ('gov','tmdb','ugc');
  create type public.source_authority  as enum ('gov','tmdb','ugc','admin');
  create type public.venue_kind        as enum ('cinema','streaming','festival','home','other');
  create type public.venue_status      as enum ('active','closed','merged');
  create type public.account_role      as enum ('user','moderator','admin');
  create type public.service_status    as enum ('active','limited','terminated');
  create type public.tmdb_cache_state  as enum ('pending','fresh','failed','gone');
  create type public.identity_kind     as enum ('tmdb','gov','ugc','imdb','slug','legacy');
  create type public.import_status     as enum ('running','succeeded','failed');
  create type public.notice_status     as enum
    ('received','rejected','actioned','counter_received','counter_forwarded','restored','litigation_notified');
  create type public.legal_doc_kind    as enum ('terms','privacy','copyright_policy');
  -- ★ 這個 enum 刻意不含任何與海報／劇照／作品圖像有關的值。
  --   要把海報鎖進付費牆，必須先 ALTER TYPE 新增值 —— 一次不可能誤觸的人為決定。
  create type public.entitlement_feature as enum
    ('advanced_stats','data_export','extended_history','api_access');
exception when duplicate_object then null; end $$;

comment on type public.entitlement_feature is
  '付費權益的封閉清單。著作權法 §90-7 第2款要求「未直接自侵權行為獲有財產上利益」，'
  '故海報／圖像相關功能永遠不得成為此型別的成員。新增值需經法務確認。';

-- -----------------------------------------------------------------------------
-- 1. 共用工具函式
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create or replace function public.slugify(src text)
returns text language sql stable as $$
  select coalesce(nullif(
    trim(both '-' from regexp_replace(lower(extensions.unaccent(coalesce(src,''))),
                                      '[^a-z0-9]+', '-', 'g')), ''), null);
$$;

-- 法定期間以工作日計；在 DB 內算，避免各處實作漂移。
-- 只扣週末，不含國定假日 → 蓄意保守（實際期限只會更晚，不會更早）。
create or replace function public.business_days_after(start_ts timestamptz, n integer)
returns timestamptz language plpgsql stable as $$
declare d timestamptz := start_ts; left_n integer := n;
begin
  while left_n > 0 loop
    d := d + interval '1 day';
    if extract(isodow from (d at time zone 'Asia/Taipei')) < 6 then
      left_n := left_n - 1;
    end if;
  end loop;
  return d;
end $$;

-- -----------------------------------------------------------------------------
-- 2. 使用者
-- -----------------------------------------------------------------------------
create table if not exists public.profile (
  id             uuid primary key references auth.users (id) on delete cascade,
  username       text not null,
  display_name   text,
  avatar_url     text,
  bio            text,
  show_cost      boolean not null default false,
  role           public.account_role  not null default 'user',
  service_status public.service_status not null default 'active',
  timezone       text not null default 'Asia/Taipei',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint profile_username_shape check (
    username = lower(username)
    and username ~ '^[a-z0-9](?:[a-z0-9_-]{1,28}[a-z0-9])$'
  )
);

-- username 與其歷史共用「單一命名空間」。
-- 這是唯一能保證「改名後舊網址仍指向本人、且舊名不會被別人搶走」的結構：
-- 舊名不是被刪除，而是換一個 kind 繼續佔位。
create table if not exists public.username (
  name        text primary key,
  profile_id  uuid references public.profile (id) on delete cascade,
  kind        text not null check (kind in ('active','historical','reserved')),
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  constraint username_lower check (name = lower(name)),
  constraint username_owner check (
    (kind = 'reserved' and profile_id is null) or
    (kind <> 'reserved' and profile_id is not null)
  )
);
create unique index if not exists username_one_active_per_profile
  on public.username (profile_id) where kind = 'active';
create index if not exists username_profile_idx on public.username (profile_id);

insert into public.username (name, kind)
select unnest(array[
  'u','api','admin','login','logout','auth','settings','about','account',
  'film','films','venue','venues','stats','legal','copyright','terms','privacy',
  'dmca','support','help','www','app','static','assets','_nuxt','sitemap','robots'
]), 'reserved'
on conflict (name) do nothing;

-- profile.username 永遠等於 username 表中該人的 active 列；由觸發器維持一致。
create or replace function public.sync_username_namespace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.username is distinct from old.username then
    if exists (select 1 from public.username u
               where u.name = new.username
                 and (u.profile_id is distinct from new.id or u.kind = 'reserved')) then
      raise exception 'username % 已被使用或為保留字', new.username
        using errcode = 'unique_violation';
    end if;
    if tg_op = 'UPDATE' then
      update public.username
         set kind = 'historical', released_at = now()
       where profile_id = new.id and kind = 'active';
    end if;
    insert into public.username (name, profile_id, kind)
         values (new.username, new.id, 'active')
    on conflict (name) do update set kind = 'active',
                                     profile_id = excluded.profile_id,
                                     released_at = null;
  end if;
  return null;
end $$;

-- must be AFTER: in BEFORE INSERT the profile row does not exist yet and
-- username.profile_id would violate its FK.
drop trigger if exists profile_username_sync on public.profile;
create trigger profile_username_sync
  after insert or update of username on public.profile
  for each row execute function public.sync_username_namespace();

drop trigger if exists profile_touch on public.profile;
create trigger profile_touch before update on public.profile
  for each row execute function public.touch_updated_at();

-- 首次登入自動建 profile：username 取 email @ 前綴，衝突時加流水號。
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base text; candidate text; n integer := 0;
begin
  base := coalesce(public.slugify(split_part(new.email, '@', 1)), 'user');
  base := left(regexp_replace(base, '[^a-z0-9_-]', '', 'g'), 24);
  if length(base) < 2 then base := 'user'; end if;
  candidate := base;
  while exists (select 1 from public.username u where u.name = candidate) loop
    n := n + 1; candidate := left(base, 24) || n::text;
  end loop;
  insert into public.profile (id, username, display_name, avatar_url)
  values (new.id, candidate,
          new.raw_user_meta_data ->> 'full_name',
          new.raw_user_meta_data ->> 'avatar_url');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 3. RLS 判斷用的輔助函式
--    一律 SECURITY DEFINER + search_path='' ：既繞開被查表自身的 RLS
--    （避免 policy 互相遞迴），也擋掉 search_path 挾持。
-- -----------------------------------------------------------------------------
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profile p
                  where p.id = auth.uid() and p.role in ('moderator','admin'));
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profile p
                  where p.id = auth.uid() and p.role = 'admin');
$$;

create or replace function public.account_is_servable(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profile p
                  where p.id = uid and p.service_status <> 'terminated');
$$;

create or replace function public.owner_shows_cost(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.show_cost from public.profile p where p.id = uid), false);
$$;

-- -----------------------------------------------------------------------------
-- 4. 匯入批次（provenance）
--    每一列公共資料都能回答「哪一次匯入、從哪個檔案來的」。
-- -----------------------------------------------------------------------------
create table if not exists public.import_run (
  id            bigint generated always as identity primary key,
  dataset       text not null check (dataset in ('gov_rating','gov_cinema','tmdb_refresh','user_backfill')),
  roc_year      smallint,
  source_url    text,
  source_sha256 text,
  status        public.import_status not null default 'running',
  rows_in       integer,
  rows_upserted integer,
  rows_skipped  integer,
  stats         jsonb not null default '{}'::jsonb,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index if not exists import_run_dataset_idx on public.import_run (dataset, started_at desc);

-- -----------------------------------------------------------------------------
-- 5. 作品（film）
--    ★ 主鍵是內部 UUID，不是匯入管線那把確定性字串鍵。
--      觀影紀錄指向 UUID；確定性鍵放在 film_identity。
--      「合併」因此退化成「把 identity 列改指向存活者」，
--      不需要動任何一筆 viewing_record 的語意，也不會斷掉 FK。
-- -----------------------------------------------------------------------------
create table if not exists public.film (
  id                  uuid primary key default extensions.gen_random_uuid(),

  -- TMDB *識別碼* 留在 film（識別碼不是被快取的內容，刪掉就永遠無法刷新）；
  -- TMDB *內容* 全部放 film_tmdb_snapshot，受 6 個月 TTL 管制。
  tmdb_id             integer unique,
  imdb_id             text unique,

  title_zh            text not null default '',
  title_zh_source     public.source_authority not null default 'gov',
  title_original      text not null default '',
  title_original_source public.source_authority not null default 'tmdb',
  country             text not null default '',
  language            text,
  runtime_minutes     integer check (runtime_minutes is null or runtime_minutes between 1 and 1200),
  release_year        smallint check (release_year is null or release_year between 1880 and 2200),
  first_seen_roc_year smallint,

  origin              public.film_origin      not null default 'gov',
  visibility          public.visibility       not null default 'public',
  review_state        public.review_state     not null default 'approved',
  moderation_state    public.moderation_state not null default 'visible',

  created_by          uuid references public.profile (id) on delete set null,
  ugc_poster_path     text,
  slug                text unique,
  merged_into_film_id uuid references public.film (id) on delete restrict,
  merged_at           timestamptz,

  search_text         text generated always as
                        (lower(coalesce(title_zh,'') || ' ' || coalesce(title_original,''))) stored,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- 已比對到 TMDB 者禁止自存海報（SPEC：無必要，只增加曝險）
  constraint film_no_ugc_poster_when_tmdb check (ugc_poster_path is null or tmdb_id is null),
  constraint film_not_self_merged        check (merged_into_film_id is null or merged_into_film_id <> id),
  constraint film_merged_has_time        check ((merged_into_film_id is null) = (merged_at is null)),
  constraint film_ugc_review             check (origin = 'ugc' or review_state = 'approved'),
  constraint film_pending_is_private     check (review_state = 'approved' or visibility = 'private')
);

comment on column public.film.tmdb_id is
  'NULLABLE 是硬性要求：實測 20% 的台灣上映片在 TMDB 找不到。';
comment on column public.film.title_zh_source is
  '欄位級 provenance。TMDB 排程刷新只能覆寫 source=tmdb 的欄位，'
  '因此政府核准片名不會被 6 個月一次的刷新洗掉。';

create index if not exists film_search_trgm on public.film
  using gin (search_text extensions.gin_trgm_ops);
create index if not exists film_public_idx on public.film (updated_at desc)
  where merged_into_film_id is null and visibility = 'public' and moderation_state = 'visible';
create index if not exists film_created_by_idx on public.film (created_by)
  where created_by is not null;
create index if not exists film_review_queue_idx on public.film (created_at)
  where review_state = 'pending';
create index if not exists film_merged_idx on public.film (merged_into_film_id)
  where merged_into_film_id is not null;

drop trigger if exists film_touch on public.film;
create trigger film_touch before update on public.film
  for each row execute function public.touch_updated_at();

-- ---- film_identity：一部作品的所有外部／歷史識別碼，單一命名空間 ----------
-- 匯入管線的確定性 id、TMDB id、IMDb id、舊 slug 全收在這裡。
--   重複匯入   → key 已存在 → 直接拿到 film_id，不新增列
--   合併作品   → 把敗方所有 key 改指向存活者，之後再匯入敗方的政府紀錄也不會復活
--   換 slug/301→ 舊 slug 留著繼續解析
create table if not exists public.film_identity (
  key         text primary key,
  kind        public.identity_kind not null,
  film_id     uuid not null references public.film (id) on delete cascade,
  is_primary  boolean not null default false,
  assigned_at timestamptz not null default now(),
  note        text,
  constraint film_identity_prefix check (key like kind::text || ':%')
);
create index if not exists film_identity_film_idx on public.film_identity (film_id);
create unique index if not exists film_identity_one_primary
  on public.film_identity (film_id, kind) where is_primary;

comment on table public.film_identity is
  '所有能指向一部作品的鍵的單一命名空間（tmdb:603 / gov:駭客任務:thematrix / slug:xxx / imdb:tt…）。'
  '合併只需要把列改指向存活者，viewing_record 完全不受影響。';

-- slug 自動生成（CJK 片名 slugify 後為空 → 退回 id 前綴），並登錄進 identity。
create or replace function public.film_assign_slug()
returns trigger language plpgsql security definer set search_path = '' as $$
declare base text;
begin
  if new.slug is null then
    base := coalesce(public.slugify(new.title_original), public.slugify(new.title_zh), 'film');
    new.slug := left(base, 48) || '-' || left(replace(new.id::text, '-', ''), 8);
  end if;
  return new;
end $$;

drop trigger if exists film_slug on public.film;
create trigger film_slug before insert on public.film
  for each row execute function public.film_assign_slug();

create or replace function public.film_sync_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.tmdb_id is not null then
    insert into public.film_identity (key, kind, film_id, is_primary)
    values ('tmdb:' || new.tmdb_id, 'tmdb', new.id, true)
    on conflict (key) do update set film_id = excluded.film_id;
  end if;
  if new.imdb_id is not null then
    insert into public.film_identity (key, kind, film_id, is_primary)
    values ('imdb:' || new.imdb_id, 'imdb', new.id, true)
    on conflict (key) do update set film_id = excluded.film_id;
  end if;
  if new.slug is not null then
    insert into public.film_identity (key, kind, film_id, is_primary)
    values ('slug:' || new.slug, 'slug', new.id, true)
    on conflict (key) do update set film_id = excluded.film_id;
  end if;
  return null;
end $$;

drop trigger if exists film_identity_sync on public.film;
create trigger film_identity_sync after insert or update of tmdb_id, imdb_id, slug on public.film
  for each row execute function public.film_sync_identity();

-- 任何鍵 → 最終存活的作品（跟隨合併鏈，最多 16 跳防環）
create or replace function public.resolve_film(p_key text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid; v_next uuid; hop integer := 0;
begin
  select fi.film_id into v_id from public.film_identity fi where fi.key = p_key;
  if v_id is null then return null; end if;
  loop
    select f.merged_into_film_id into v_next from public.film f where f.id = v_id;
    exit when v_next is null or hop >= 16;
    v_id := v_next; hop := hop + 1;
  end loop;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- 6. TMDB 快取（與 film 分表，這是 6 個月條款的關鍵）
--    分表的理由：清除快取變成 DELETE 一整列，不可能誤刪政府或 UGC 欄位。
-- -----------------------------------------------------------------------------
create table if not exists public.film_tmdb_snapshot (
  film_id         uuid primary key references public.film (id) on delete cascade,
  tmdb_id         integer not null,
  state           public.tmdb_cache_state not null default 'pending',

  title_zh        text,
  title_original  text,
  overview        text,
  poster_path     text,   -- 僅路徑；一律熱連結 image.tmdb.org，不轉存
  backdrop_path   text,
  runtime_minutes integer,
  release_date    date,
  tw_release_date date,
  genre_ids       integer[],
  payload         jsonb,  -- 原始回應，供日後擴充欄位而不必重打 API（同受 TTL 清除）

  fetched_at      timestamptz,
  -- ★ 硬性上限。180 天 < 6 個月，蓄意留安全邊際。
  expires_at      timestamptz not null default (now() + interval '180 days'),
  -- ★ 排程刷新的工作佇列就是這張表本身，不另設 queue。
  next_refresh_at timestamptz not null default now(),
  attempts        smallint not null default 0,
  last_error      text,
  etag            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint tmdb_snapshot_expiry check (fetched_at is null or expires_at > fetched_at)
);

comment on table public.film_tmdb_snapshot is
  'TMDB 條款禁止快取超過 6 個月。內容欄位全部住在這張表：'
  '到期即整列清空，film 本體（政府核准片名、UGC 欄位、觀影紀錄）毫髮無傷。';

create index if not exists tmdb_refresh_queue_idx
  on public.film_tmdb_snapshot (next_refresh_at)
  where state <> 'gone';
create index if not exists tmdb_expiry_idx
  on public.film_tmdb_snapshot (expires_at);

drop trigger if exists tmdb_snapshot_touch on public.film_tmdb_snapshot;
create trigger tmdb_snapshot_touch before update on public.film_tmdb_snapshot
  for each row execute function public.touch_updated_at();

-- 刷新後把可信度較低的欄位回填 film（政府欄位不動）
create or replace function public.apply_tmdb_snapshot(p_film_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.film f
     set title_zh = case when f.title_zh_source = 'tmdb' or f.title_zh = ''
                         then coalesce(s.title_zh, f.title_zh) else f.title_zh end,
         title_original = case when f.title_original_source in ('tmdb') or f.title_original = ''
                         then coalesce(s.title_original, f.title_original) else f.title_original end,
         runtime_minutes = coalesce(f.runtime_minutes, s.runtime_minutes),
         release_year   = coalesce(f.release_year, extract(year from s.release_date)::smallint),
         updated_at     = now()
    from public.film_tmdb_snapshot s
   where s.film_id = f.id and f.id = p_film_id and s.state = 'fresh';
end $$;

-- 到期清除。以 pg_cron 每日呼叫；即使 cron 掛掉，讀取端的 view 也不會吐出過期內容。
create or replace function public.purge_expired_tmdb_cache()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.film_tmdb_snapshot
     set title_zh = null, title_original = null, overview = null,
         poster_path = null, backdrop_path = null, runtime_minutes = null,
         release_date = null, tw_release_date = null, genre_ids = null,
         payload = null, etag = null,
         state = case when state = 'gone' then 'gone' else 'pending' end,
         next_refresh_at = least(next_refresh_at, now())
   where expires_at <= now()
     and (payload is not null or poster_path is not null or overview is not null);
  get diagnostics n = row_count;
  return n;
end $$;

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron';
    perform cron.schedule('filmnote-tmdb-purge', '17 3 * * *',
                          'select public.purge_expired_tmdb_cache()');
  end if;
exception when others then
  raise notice 'pg_cron 未啟用，請於 Supabase Dashboard 手動排程 purge_expired_tmdb_cache()';
end $$;

-- -----------------------------------------------------------------------------
-- 7. 核准紀錄（certificate）
--    PK 沿用匯入管線的確定性複合鍵 → upsert 即冪等，每年重跑不長列。
-- -----------------------------------------------------------------------------
create table if not exists public.certificate (
  id              text primary key,           -- 「年度:字號:正規化片名」
  film_id         uuid not null references public.film (id) on delete restrict,
  permit_no       text not null,              -- ★ 跨年度不唯一，僅為屬性
  roc_year        smallint not null,
  gregorian_year  smallint not null,
  rating          text,
  title_zh        text not null default '',
  title_original  text not null default '',
  country         text,
  language        text,
  producer        text,
  runtime_minutes integer,
  runtime_raw     text,
  version_note    text,
  defects         text[] not null default '{}',
  raw             jsonb,                      -- 原始 CSV 列，永久保留
  first_import_id bigint references public.import_run (id),
  last_import_id  bigint references public.import_run (id),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  withdrawn_at    timestamptz,                -- 上游年度檔中消失時標記，不刪列
  constraint certificate_defects_known check (
    defects <@ array['original-title-excel-date','original-title-corrupted',
                     'original-title-missing','title-zh-missing','runtime-unparseable',
                     'column-shift-recovered','column-count-unexpected']::text[]
  )
);
create index if not exists certificate_film_idx on public.certificate (film_id);
create index if not exists certificate_year_idx on public.certificate (roc_year);
create index if not exists certificate_permit_idx on public.certificate (permit_no);

comment on column public.certificate.permit_no is
  '分級證明字號。110–112 年 CSV 無系列前綴，四系列各自從 001 編號而大量撞號'
  '（110 年 128、111 年 143、112 年 157 筆重複），故不可作主鍵。';
comment on column public.certificate.raw is
  '原始 CSV 列。留著才可能在日後改良解析邏輯時就地重算，而不必重抓上游。';

-- -----------------------------------------------------------------------------
-- 8. 場所（venue）與播放版本
-- -----------------------------------------------------------------------------
create table if not exists public.venue (
  id             text primary key,            -- 統一編號，或 virtual:streaming 等
  kind           public.venue_kind not null,
  name           text not null,
  company_name   text not null default '',
  hall_count     integer not null default 0 check (hall_count >= 0),
  address        text not null default '',
  phone          text not null default '',
  city           text not null default '',
  lat            double precision,
  lng            double precision,
  status         public.venue_status not null default 'active',
  merged_into_venue_id text references public.venue (id) on delete restrict,
  closed_at      timestamptz,
  sort_weight    smallint not null default 0,
  raw            jsonb,
  first_import_id bigint references public.import_run (id),
  last_import_id  bigint references public.import_run (id),
  last_seen_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint venue_tax_id_shape check (
    id ~ '^[0-9]{8}$' or id like 'virtual:%' or id like 'ugc:%'
  ),
  constraint venue_not_self_merged check (merged_into_venue_id is null or merged_into_venue_id <> id)
);
create index if not exists venue_city_idx on public.venue (city) where status = 'active';
create index if not exists venue_name_trgm on public.venue
  using gin (name extensions.gin_trgm_ops);

drop trigger if exists venue_touch on public.venue;
create trigger venue_touch before update on public.venue
  for each row execute function public.touch_updated_at();

insert into public.venue (id, kind, name, sort_weight) values
  ('virtual:streaming','streaming','串流平台', -10),
  ('virtual:festival', 'festival', '影展',     -9),
  ('virtual:home',     'home',     '家中',     -8),
  ('virtual:other',    'other',    '其他',     -7)
on conflict (id) do nothing;

-- 播放版本用查表不用 enum：新增 4DX / ScreenX / Dolby Cinema 只是 INSERT。
create table if not exists public.screening_format (
  code       text primary key,
  label      text not null,
  sort_order smallint not null default 100,
  active     boolean not null default true
);
insert into public.screening_format (code, label, sort_order) values
  ('digital','數位', 10), ('imax','IMAX', 20), ('imax_laser','IMAX Laser', 25),
  ('3d','3D', 30), ('4dx','4DX', 40), ('screenx','ScreenX', 50),
  ('dolby','Dolby Cinema', 60), ('film_35','35mm 膠卷', 70), ('other','其他', 999)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 9. 觀影紀錄
--    時間以「台北當地的日期 + 選填的當地時間」存，不存 timestamptz：
--    ① 使用者說的是當地日期，貢獻圖與時段熱力圖不該做時區換算
--    ② 舊資料常只有日期沒有時間，硬塞 timestamptz 會捏造出假的 00:00
-- -----------------------------------------------------------------------------
create table if not exists public.viewing_record (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references public.profile (id) on delete cascade,
  film_id       uuid not null references public.film (id)   on delete restrict,
  venue_id      text not null references public.venue (id)  on delete restrict,

  watched_on    date not null,
  watched_time  time,
  tz            text not null default 'Asia/Taipei',

  ticket_count  smallint check (ticket_count is null or ticket_count between 1 and 99),
  hall_label    text,                     -- 影廳目前為自由文字；日後有影廳主檔再加 hall_id
  format_code   text references public.screening_format (code),
  format_note   text,
  memo          text,

  visibility       public.visibility       not null default 'public',
  moderation_state public.moderation_state not null default 'visible',

  import_key    text,                      -- 舊 log 專案匯入的來源鍵，供冪等重跑
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint viewing_record_sane_date check (watched_on >= date '1895-12-28'),
  constraint viewing_record_memo_len check (memo is null or length(memo) <= 2000)
);
create unique index if not exists viewing_record_import_key_uniq
  on public.viewing_record (user_id, import_key) where import_key is not null;
create index if not exists viewing_record_owner_idx
  on public.viewing_record (user_id, watched_on desc, watched_time desc nulls last);
create index if not exists viewing_record_film_public_idx
  on public.viewing_record (film_id, watched_on desc)
  where visibility = 'public' and moderation_state = 'visible';
create index if not exists viewing_record_venue_idx on public.viewing_record (venue_id);

drop trigger if exists viewing_record_touch on public.viewing_record;
create trigger viewing_record_touch before update on public.viewing_record
  for each row execute function public.touch_updated_at();

-- ---- 票價獨立成表 -----------------------------------------------------------
-- RLS 只能做「列」層級的遮蔽，做不到「欄」層級的條件遮蔽。
-- 把 cost 變成獨立的一列，show_cost 這條隱私規則才能由資料庫本身強制執行，
-- 而不是靠每一支 API 記得 select 時把欄位拿掉。
create table if not exists public.viewing_record_cost (
  record_id  uuid primary key references public.viewing_record (id) on delete cascade,
  amount     numeric(12,2) not null check (amount >= 0),
  currency   char(3) not null default 'TWD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.viewing_record_cost is
  '票價。獨立成表是為了讓「預設不公開」成為 RLS 可強制的事實 —— '
  'PostgREST 上任何 select=*、任何 join，都不可能在未開啟 show_cost 時取得金額。';

drop trigger if exists viewing_record_cost_touch on public.viewing_record_cost;
create trigger viewing_record_cost_touch before update on public.viewing_record_cost
  for each row execute function public.touch_updated_at();

-- 紀錄的擁有者（給 cost 的 policy 用；SECURITY DEFINER 以避免 policy 遞迴）
create or replace function public.record_owner(p_record uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select user_id from public.viewing_record where id = p_record;
$$;

create or replace function public.record_is_public(p_record uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.viewing_record r
      join public.film f on f.id = r.film_id
      join public.profile p on p.id = r.user_id
     where r.id = p_record
       and r.visibility = 'public' and r.moderation_state = 'visible'
       and f.visibility = 'public' and f.moderation_state = 'visible'
         and f.merged_into_film_id is null
       and p.service_status <> 'terminated');
$$;

-- 使用者可否把某部片用在自己的紀錄裡（UGC 未過審者只有作者能用）
create or replace function public.film_usable_by(p_film uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.film f
     where f.id = p_film
       and f.moderation_state <> 'removed'
       and f.merged_into_film_id is null
       and (f.visibility = 'public' or f.created_by = p_user));
$$;

-- 使用者不得自行竄改審核／管制欄位
create or replace function public.guard_record_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_staff() then
    if new.moderation_state is distinct from old.moderation_state then
      raise exception '不得修改 moderation_state' using errcode = '42501';
    end if;
    if new.user_id is distinct from old.user_id then
      raise exception '不得轉移紀錄擁有者' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create or replace function public.guard_record_date()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.watched_on > ((now() at time zone coalesce(new.tz,'Asia/Taipei'))::date + 1) then
    raise exception '觀影日期不得為未來' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists viewing_record_date_guard on public.viewing_record;
create trigger viewing_record_date_guard
  before insert or update of watched_on on public.viewing_record
  for each row execute function public.guard_record_date();

drop trigger if exists viewing_record_guard on public.viewing_record;
create trigger viewing_record_guard before update on public.viewing_record
  for each row execute function public.guard_record_columns();

create or replace function public.guard_film_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_staff() then
    if new.review_state is distinct from old.review_state
       or new.moderation_state is distinct from old.moderation_state
       or new.visibility is distinct from old.visibility
       or new.tmdb_id is distinct from old.tmdb_id
       or new.merged_into_film_id is distinct from old.merged_into_film_id
       or new.origin is distinct from old.origin
       or new.created_by is distinct from old.created_by then
      raise exception '此欄位僅限管理者修改' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists film_guard on public.film;
create trigger film_guard before update on public.film
  for each row execute function public.guard_film_columns();

-- -----------------------------------------------------------------------------
-- 10. 合併（gov→tmdb、UGC 去重、TMDB 上游合併）
--     單一函式吸收全部三種情境；一個交易內完成，且不刪任何觀影紀錄。
-- -----------------------------------------------------------------------------
create table if not exists public.film_merge_log (
  id           bigint generated always as identity primary key,
  loser_id     uuid not null references public.film (id) on delete restrict,
  winner_id    uuid not null references public.film (id) on delete restrict,
  performed_by uuid references public.profile (id) on delete set null,
  reason       text,
  moved_records integer not null default 0,
  moved_certificates integer not null default 0,
  snapshot     jsonb,          -- 合併前敗方的完整內容，供還原
  created_at   timestamptz not null default now()
);

create or replace function public.merge_films(
  p_loser uuid, p_winner uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_records integer; v_certs integer; v_loser public.film%rowtype;
begin
  if not (public.is_staff() or auth.uid() is null) then
    raise exception '僅限管理者' using errcode = '42501';
  end if;
  if p_loser = p_winner then raise exception '不能與自己合併'; end if;

  select * into strict v_loser from public.film where id = p_loser for update;
  perform 1 from public.film where id = p_winner for update;

  if v_loser.merged_into_film_id is not null then
    raise exception '敗方已被合併過，請先解析出根節點';
  end if;
  if exists (select 1 from public.film where id = p_winner and merged_into_film_id is not null) then
    raise exception '存活方本身已被合併，請改用其根節點';
  end if;

  -- ① 觀影紀錄改指存活者：紀錄一筆都不會消失，統計自動就地修正
  update public.viewing_record set film_id = p_winner where film_id = p_loser;
  get diagnostics v_records = row_count;

  -- ② 核准紀錄改掛存活者
  update public.certificate set film_id = p_winner where film_id = p_loser;
  get diagnostics v_certs = row_count;

  -- ③ 敗方的所有識別鍵（含 gov: 確定性鍵、舊 slug）改指存活者
  --    → 之後重跑政府匯入時，gov:xxx 會解析到存活者，不會復活出重複列
  update public.film_identity set film_id = p_winner, is_primary = false
   where film_id = p_loser;

  -- ④ 補齊存活者缺的欄位（政府核准片名優先，永不被覆蓋）
  update public.film w set
      tmdb_id         = coalesce(w.tmdb_id, v_loser.tmdb_id),
      imdb_id         = coalesce(w.imdb_id, v_loser.imdb_id),
      title_zh        = case when w.title_zh = '' then v_loser.title_zh else w.title_zh end,
      title_original  = case when w.title_original = '' then v_loser.title_original else w.title_original end,
      runtime_minutes = coalesce(w.runtime_minutes, v_loser.runtime_minutes),
      release_year    = coalesce(w.release_year, v_loser.release_year),
      country         = case when w.country = '' then v_loser.country else w.country end,
      first_seen_roc_year = least(coalesce(w.first_seen_roc_year, 9999),
                                  coalesce(v_loser.first_seen_roc_year, 9999)),
      updated_at      = now()
    where w.id = p_winner;

  -- ⑤ 敗方留成墓碑：不刪，才能 301 轉向、才能還原誤合併
  update public.film
     set merged_into_film_id = p_winner, merged_at = now(),
         visibility = 'private', updated_at = now()
   where id = p_loser;

  insert into public.film_merge_log
    (loser_id, winner_id, performed_by, reason, moved_records, moved_certificates, snapshot)
  values (p_loser, p_winner, auth.uid(), p_reason, v_records, v_certs, to_jsonb(v_loser));
end $$;

-- gov 作品事後比對到 TMDB：若該 tmdb_id 已存在別的作品就合併，否則就地升級。
create or replace function public.link_film_to_tmdb(p_film uuid, p_tmdb integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_existing uuid;
begin
  select id into v_existing from public.film where tmdb_id = p_tmdb;
  if v_existing is not null and v_existing <> p_film then
    perform public.merge_films(p_film, v_existing, 'tmdb backfill: ' || p_tmdb);
    return v_existing;
  end if;
  update public.film
     set tmdb_id = p_tmdb, origin = case when origin = 'ugc' then 'ugc' else 'tmdb' end,
         title_original_source = 'tmdb',
         ugc_poster_path = null,     -- 已有 TMDB 海報，UGC 海報依 SPEC 停用
         updated_at = now()
   where id = p_film;
  insert into public.film_tmdb_snapshot (film_id, tmdb_id, state, next_refresh_at)
       values (p_film, p_tmdb, 'pending', now())
  on conflict (film_id) do update set tmdb_id = excluded.tmdb_id, next_refresh_at = now();
  return p_film;
end $$;

create or replace function public.approve_film(p_film uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception '僅限管理者' using errcode = '42501'; end if;
  update public.film
     set review_state = 'approved', visibility = 'public', updated_at = now()
   where id = p_film and merged_into_film_id is null;
end $$;

-- -----------------------------------------------------------------------------
-- 11. 法遵：ToS 告知、通知／取下／回復通知、三振
--     ★ 取下一律是「狀態」不是 DELETE —— 刪掉就永遠無法履行回復義務。
-- -----------------------------------------------------------------------------
create table if not exists public.legal_document (
  id           bigint generated always as identity primary key,
  kind         public.legal_doc_kind not null,
  version      text not null,
  effective_at timestamptz not null,
  url          text,
  content_sha256 text,
  summary      text,
  unique (kind, version)
);

create table if not exists public.legal_acceptance (
  profile_id  uuid not null references public.profile (id) on delete cascade,
  document_id bigint not null references public.legal_document (id) on delete restrict,
  accepted_at timestamptz not null default now(),
  user_agent  text,
  primary key (profile_id, document_id)
);

create table if not exists public.takedown_notice (
  id             bigint generated always as identity primary key,
  public_ref     text not null unique
                   default ('TD-' || to_char(now(),'YYYYMMDD') || '-' ||
                            upper(substr(encode(extensions.gen_random_bytes(4),'hex'),1,8))),
  claimant_name  text not null,
  claimant_email text not null,
  claimant_address text,
  claimant_is_agent boolean not null default false,
  work_description text not null,
  target_kind    text not null check (target_kind in ('viewing_record','film','profile','other')),
  target_id      text not null,
  sworn_statement boolean not null default false,   -- §90-6 一之(四) 聲明
  evidence_url   text,
  status         public.notice_status not null default 'received',
  received_at    timestamptz not null default now(),
  actioned_at    timestamptz,
  notified_user_at timestamptz,
  handled_by     uuid references public.profile (id) on delete set null,
  internal_note  text
);
create index if not exists takedown_target_idx on public.takedown_notice (target_kind, target_id);

create table if not exists public.counter_notice (
  id            bigint generated always as identity primary key,
  notice_id     bigint not null references public.takedown_notice (id) on delete restrict,
  profile_id    uuid not null references public.profile (id) on delete cascade,
  statement     text not null,
  contact_email text not null,
  received_at   timestamptz not null default now(),
  forwarded_at  timestamptz,
  -- 著作權法 §90-9：著作權人 10 個工作日內未提訴訟證明 → 須於 14 個工作日內回復
  litigation_proof_due_at timestamptz,
  restore_due_at          timestamptz,
  litigation_proof_at     timestamptz,
  restored_at             timestamptz
);

create or replace function public.counter_notice_deadlines()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.forwarded_at is not null then
    new.litigation_proof_due_at := public.business_days_after(new.forwarded_at, 10);
    new.restore_due_at          := public.business_days_after(new.forwarded_at, 14);
  end if;
  return new;
end $$;

drop trigger if exists counter_notice_dates on public.counter_notice;
create trigger counter_notice_dates before insert or update of forwarded_at on public.counter_notice
  for each row execute function public.counter_notice_deadlines();

create table if not exists public.copyright_strike (
  id         bigint generated always as identity primary key,
  profile_id uuid not null references public.profile (id) on delete cascade,
  notice_id  bigint references public.takedown_notice (id) on delete set null,
  struck_at  timestamptz not null default now(),
  withdrawn_at timestamptz,
  note       text
);
create index if not exists strike_profile_idx on public.copyright_strike (profile_id)
  where withdrawn_at is null;

-- 三振條款：第三次生效即終止服務（狀態變更，資料不刪，以備申訴回復）
create or replace function public.apply_three_strikes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  select count(*) into n from public.copyright_strike
   where profile_id = new.profile_id and withdrawn_at is null;
  if n >= 3 then
    update public.profile set service_status = 'terminated', updated_at = now()
     where id = new.profile_id;
  elsif n = 2 then
    update public.profile set service_status = 'limited', updated_at = now()
     where id = new.profile_id and service_status = 'active';
  end if;
  return null;
end $$;

drop trigger if exists three_strikes on public.copyright_strike;
create trigger three_strikes after insert or update of withdrawn_at on public.copyright_strike
  for each row execute function public.apply_three_strikes();

-- 使用者回報資料錯誤（片名、影城歇業…）
create table if not exists public.data_report (
  id          bigint generated always as identity primary key,
  reporter_id uuid references public.profile (id) on delete set null,
  target_kind text not null check (target_kind in ('film','venue','certificate')),
  target_id   text not null,
  kind        text not null check (kind in ('wrong_title','wrong_metadata','closed','missing','duplicate','other')),
  body        text not null,
  status      text not null default 'open' check (status in ('open','accepted','rejected','done')),
  handled_by  uuid references public.profile (id) on delete set null,
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists data_report_open_idx on public.data_report (created_at) where status = 'open';

-- -----------------------------------------------------------------------------
-- 12. 付費（結構上與內容路徑隔離）
--     billing 只認得 profile，任何一張 film / viewing_record 都沒有 plan 欄位。
-- -----------------------------------------------------------------------------
create table if not exists public.subscription (
  profile_id  uuid primary key references public.profile (id) on delete cascade,
  plan        text not null default 'free',
  status      text not null default 'active'
                check (status in ('active','past_due','canceled','trialing')),
  provider    text,
  provider_ref text,
  current_period_end timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.entitlement_grant (
  profile_id uuid not null references public.profile (id) on delete cascade,
  feature    public.entitlement_feature not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  source     text not null default 'subscription',
  primary key (profile_id, feature)
);

create or replace function public.has_entitlement(f public.entitlement_feature)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.entitlement_grant g
                  where g.profile_id = auth.uid() and g.feature = f
                    and (g.expires_at is null or g.expires_at > now()));
$$;

-- -----------------------------------------------------------------------------
-- 13. 公開讀取用的 view
--     ★ 海報／作品資料的公開 view 授權給 anon —— anon 不可能持有 entitlement，
--       付費牆在結構上碰不到這條路徑；要蓋住海報必須撤銷 anon 的 grant，
--       那是一次顯眼且需要 migration 的決定，不會是誰隨手加個判斷就發生。
--     ★ TMDB 內容一律經過 expires_at 判斷，cron 掛掉也不會外洩過期快取。
-- -----------------------------------------------------------------------------
create or replace view public.film_public
with (security_invoker = true) as
select
  f.id, f.slug, f.tmdb_id, f.imdb_id,
  f.title_zh, f.title_original, f.country, f.language,
  f.runtime_minutes, f.release_year, f.first_seen_roc_year, f.origin,
  f.ugc_poster_path,
  case when s.expires_at > now() then s.poster_path   end as tmdb_poster_path,
  case when s.expires_at > now() then s.backdrop_path end as tmdb_backdrop_path,
  case when s.expires_at > now() then s.overview      end as overview,
  case when s.expires_at > now() then s.tw_release_date end as tw_release_date,
  s.expires_at as tmdb_cache_expires_at,
  f.updated_at
from public.film f
left join public.film_tmdb_snapshot s on s.film_id = f.id
where f.merged_into_film_id is null
  and f.visibility = 'public'
  and f.moderation_state = 'visible';

comment on view public.film_public is
  '公開片庫。TMDB 內容以 expires_at 於讀取時把關 —— 排程刷新失敗時，'
  '過期欄位自動變成 NULL（退回文字卡片），而不是繼續供應逾期快取。';

create or replace view public.viewing_record_public
with (security_invoker = true) as
select
  r.id, r.user_id, p.username, r.film_id, r.venue_id,
  r.watched_on, r.watched_time, r.tz,
  r.ticket_count, r.hall_label, r.format_code, r.format_note, r.memo,
  c.amount   as cost_amount,      -- RLS 未放行時此處自然為 NULL
  c.currency as cost_currency,
  r.created_at
from public.viewing_record r
join public.profile p on p.id = r.user_id
left join public.viewing_record_cost c on c.record_id = r.id
where r.visibility = 'public' and r.moderation_state = 'visible';

-- 刷新佇列（給排程 worker 用，service_role 專用）
create or replace view public.tmdb_refresh_due as
select s.film_id, s.tmdb_id, s.etag, s.attempts, s.expires_at, s.next_refresh_at
from public.film_tmdb_snapshot s
join public.film f on f.id = s.film_id
where s.state <> 'gone'
  and f.merged_into_film_id is null
  and s.next_refresh_at <= now()
order by s.expires_at asc nulls first, s.next_refresh_at asc;

-- -----------------------------------------------------------------------------
-- 14. RLS
-- -----------------------------------------------------------------------------
alter table public.profile              enable row level security;
alter table public.username             enable row level security;
alter table public.film                 enable row level security;
alter table public.film_identity        enable row level security;
alter table public.film_tmdb_snapshot   enable row level security;
alter table public.film_merge_log       enable row level security;
alter table public.certificate          enable row level security;
alter table public.venue                enable row level security;
alter table public.screening_format     enable row level security;
alter table public.viewing_record       enable row level security;
alter table public.viewing_record_cost  enable row level security;
alter table public.import_run           enable row level security;
alter table public.legal_document       enable row level security;
alter table public.legal_acceptance     enable row level security;
alter table public.takedown_notice      enable row level security;
alter table public.counter_notice       enable row level security;
alter table public.copyright_strike     enable row level security;
alter table public.data_report          enable row level security;
alter table public.subscription         enable row level security;
alter table public.entitlement_grant    enable row level security;

-- profile：公開的只有身分欄位；show_cost 是設定值本身不敏感。
drop policy if exists profile_read_public on public.profile;
create policy profile_read_public on public.profile
  for select to anon, authenticated
  using (service_status <> 'terminated' or id = auth.uid() or public.is_staff());

drop policy if exists profile_update_self on public.profile;
create policy profile_update_self on public.profile
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profile_staff_all on public.profile;
create policy profile_staff_all on public.profile
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- role / service_status 只能由 admin 改
create or replace function public.guard_profile_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role
       or new.service_status is distinct from old.service_status then
      raise exception '此欄位僅限管理者修改' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists profile_guard on public.profile;
create trigger profile_guard before update on public.profile
  for each row execute function public.guard_profile_columns();

-- username：全域可讀（301 轉向要查得到），只能由觸發器寫入
drop policy if exists username_read on public.username;
create policy username_read on public.username
  for select to anon, authenticated using (true);

-- 公共片庫：未登入可讀已公開者；作者可讀自己的未過審 UGC
drop policy if exists film_read on public.film;
create policy film_read on public.film
  for select to anon, authenticated
  using (
    (moderation_state = 'visible' and visibility = 'public'
     and merged_into_film_id is null)
    or created_by = auth.uid()
    or public.is_staff()
  );

drop policy if exists film_insert_ugc on public.film;
create policy film_insert_ugc on public.film
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and origin = 'ugc'
    and visibility = 'private'
    and review_state = 'pending'
    and moderation_state = 'visible'
    and tmdb_id is null
    and merged_into_film_id is null
    and public.account_is_servable(auth.uid())
  );

drop policy if exists film_update_own_ugc on public.film;
create policy film_update_own_ugc on public.film
  for update to authenticated
  using (created_by = auth.uid() and review_state <> 'approved' and merged_into_film_id is null)
  with check (created_by = auth.uid());

drop policy if exists film_staff_all on public.film;
create policy film_staff_all on public.film
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists film_identity_read on public.film_identity;
create policy film_identity_read on public.film_identity
  for select to anon, authenticated using (true);

drop policy if exists film_snapshot_read on public.film_tmdb_snapshot;
create policy film_snapshot_read on public.film_tmdb_snapshot
  for select to anon, authenticated using (true);

drop policy if exists merge_log_read on public.film_merge_log;
create policy merge_log_read on public.film_merge_log
  for select to authenticated using (public.is_staff());

drop policy if exists certificate_read on public.certificate;
create policy certificate_read on public.certificate
  for select to anon, authenticated using (true);

drop policy if exists venue_read on public.venue;
create policy venue_read on public.venue
  for select to anon, authenticated using (true);

drop policy if exists format_read on public.screening_format;
create policy format_read on public.screening_format
  for select to anon, authenticated using (true);

drop policy if exists import_run_read on public.import_run;
create policy import_run_read on public.import_run
  for select to authenticated using (public.is_staff());

-- ---- 觀影紀錄 --------------------------------------------------------------
drop policy if exists record_read on public.viewing_record;
create policy record_read on public.viewing_record
  for select to anon, authenticated
  using (
    user_id = auth.uid()
    or public.is_staff()
    or (
      visibility = 'public'
      and moderation_state = 'visible'
      and public.account_is_servable(user_id)
      and exists (select 1 from public.film f
                   where f.id = film_id
                     and f.visibility = 'public'
                     and f.moderation_state = 'visible'
                     and f.merged_into_film_id is null)
    )
  );

drop policy if exists record_insert on public.viewing_record;
create policy record_insert on public.viewing_record
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and moderation_state = 'visible'
    and public.account_is_servable(auth.uid())
    and public.film_usable_by(film_id, auth.uid())
  );

drop policy if exists record_update on public.viewing_record;
create policy record_update on public.viewing_record
  for update to authenticated
  using (user_id = auth.uid() and moderation_state <> 'removed')
  with check (user_id = auth.uid() and public.film_usable_by(film_id, auth.uid()));

drop policy if exists record_delete on public.viewing_record;
create policy record_delete on public.viewing_record
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists record_staff on public.viewing_record;
create policy record_staff on public.viewing_record
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---- 票價：整條隱私規則就是這一條 policy -----------------------------------
drop policy if exists cost_read on public.viewing_record_cost;
create policy cost_read on public.viewing_record_cost
  for select to anon, authenticated
  using (
    public.record_owner(record_id) = auth.uid()
    or public.is_staff()
    or (public.record_is_public(record_id)
        and public.owner_shows_cost(public.record_owner(record_id)))
  );

drop policy if exists cost_write on public.viewing_record_cost;
create policy cost_write on public.viewing_record_cost
  for all to authenticated
  using (public.record_owner(record_id) = auth.uid())
  with check (public.record_owner(record_id) = auth.uid());

-- ---- 法遵 ------------------------------------------------------------------
drop policy if exists legal_doc_read on public.legal_document;
create policy legal_doc_read on public.legal_document
  for select to anon, authenticated using (true);

drop policy if exists legal_accept_self on public.legal_acceptance;
create policy legal_accept_self on public.legal_acceptance
  for select to authenticated using (profile_id = auth.uid() or public.is_staff());
drop policy if exists legal_accept_insert on public.legal_acceptance;
create policy legal_accept_insert on public.legal_acceptance
  for insert to authenticated with check (profile_id = auth.uid());

-- 侵權通知：任何人都能提交（§90-4 要求公告受理窗口），但只有承辦人與被指對象能讀
drop policy if exists takedown_insert on public.takedown_notice;
create policy takedown_insert on public.takedown_notice
  for insert to anon, authenticated with check (status = 'received');
drop policy if exists takedown_read on public.takedown_notice;
create policy takedown_read on public.takedown_notice
  for select to authenticated using (public.is_staff());
drop policy if exists takedown_staff on public.takedown_notice;
create policy takedown_staff on public.takedown_notice
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists counter_self on public.counter_notice;
create policy counter_self on public.counter_notice
  for select to authenticated using (profile_id = auth.uid() or public.is_staff());
drop policy if exists counter_insert on public.counter_notice;
create policy counter_insert on public.counter_notice
  for insert to authenticated with check (profile_id = auth.uid());
drop policy if exists counter_staff on public.counter_notice;
create policy counter_staff on public.counter_notice
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists strike_self on public.copyright_strike;
create policy strike_self on public.copyright_strike
  for select to authenticated using (profile_id = auth.uid() or public.is_staff());
drop policy if exists strike_staff on public.copyright_strike;
create policy strike_staff on public.copyright_strike
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists report_insert on public.data_report;
create policy report_insert on public.data_report
  for insert to authenticated with check (reporter_id = auth.uid());
drop policy if exists report_read on public.data_report;
create policy report_read on public.data_report
  for select to authenticated using (reporter_id = auth.uid() or public.is_staff());
drop policy if exists report_staff on public.data_report;
create policy report_staff on public.data_report
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- ---- 付費 ------------------------------------------------------------------
drop policy if exists subscription_self on public.subscription;
create policy subscription_self on public.subscription
  for select to authenticated using (profile_id = auth.uid() or public.is_staff());
drop policy if exists entitlement_self on public.entitlement_grant;
create policy entitlement_self on public.entitlement_grant
  for select to authenticated using (profile_id = auth.uid() or public.is_staff());
-- 寫入一律經 service_role（金流 webhook），不給任何前端角色 policy。

-- -----------------------------------------------------------------------------
-- 15. 權限
-- -----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select on
  public.film_public, public.viewing_record_public,
  public.film, public.film_identity, public.film_tmdb_snapshot,
  public.certificate, public.venue, public.screening_format,
  public.viewing_record, public.viewing_record_cost,
  public.profile, public.username, public.legal_document
to anon, authenticated;

grant insert, update, delete on public.viewing_record, public.viewing_record_cost to authenticated;
grant insert, update on public.film to authenticated;
grant insert on public.legal_acceptance, public.data_report, public.counter_notice to authenticated;
grant insert on public.takedown_notice to anon, authenticated;
grant update on public.profile to authenticated;
grant select on public.subscription, public.entitlement_grant to authenticated;
grant select on
  public.film_merge_log, public.import_run, public.takedown_notice,
  public.counter_notice, public.copyright_strike, public.data_report,
  public.legal_acceptance
to authenticated;
grant select on public.tmdb_refresh_due to service_role;
grant usage on all sequences in schema public to authenticated;

revoke all on function public.merge_films(uuid, uuid, text) from public, anon;
revoke all on function public.purge_expired_tmdb_cache() from public, anon, authenticated;
grant execute on function public.merge_films(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.link_film_to_tmdb(uuid, integer) to service_role;
grant execute on function public.approve_film(uuid) to authenticated, service_role;
grant execute on function public.resolve_film(text) to anon, authenticated, service_role;
grant execute on function public.has_entitlement(public.entitlement_feature) to authenticated;

-- -----------------------------------------------------------------------------
-- 16. UGC 海報的 Storage bucket
--     公開讀（海報不得置於付費牆後）；只有作者能上傳，且路徑以其 uid 開頭。
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ugc-poster','ugc-poster', true, 2097152,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists ugc_poster_read on storage.objects;
create policy ugc_poster_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'ugc-poster');

drop policy if exists ugc_poster_write on storage.objects;
create policy ugc_poster_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ugc-poster' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists ugc_poster_manage on storage.objects;
create policy ugc_poster_manage on storage.objects
  for update to authenticated
  using (bucket_id = 'ugc-poster' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists ugc_poster_delete on storage.objects;
create policy ugc_poster_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'ugc-poster' and (storage.foldername(name))[1] = auth.uid()::text);

-- -----------------------------------------------------------------------------
-- 17. 匯出與帳號刪除（使用者故事 46 / 47）
-- -----------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'role' from public.profile p where p.id = auth.uid()),
    'records', coalesce((
      select jsonb_agg(jsonb_build_object(
        'watched_on', r.watched_on, 'watched_time', r.watched_time,
        'film_title_zh', f.title_zh, 'film_title_original', f.title_original,
        'tmdb_id', f.tmdb_id, 'venue', v.name, 'venue_id', v.id,
        'ticket_count', r.ticket_count, 'hall', r.hall_label,
        'format', r.format_code, 'memo', r.memo,
        'visibility', r.visibility,
        'cost_amount', c.amount, 'cost_currency', c.currency)
        order by r.watched_on, r.watched_time)
      from public.viewing_record r
      join public.film f on f.id = r.film_id
      join public.venue v on v.id = r.venue_id
      left join public.viewing_record_cost c on c.record_id = r.id
      where r.user_id = auth.uid()), '[]'::jsonb));
$$;
grant execute on function public.export_my_data() to authenticated;

```

## 設計理由

## 已落地檔案

`/Users/david/Documents/Github/filmnote/supabase/migrations/0001_init.sql`（1,353 行，20 表 / 42 policy / 21 index / 3 view）。

---

## 一、貫穿全案的一條原則

**「識別」與「FK 指向」必須分離。** 匯入管線目前用確定性字串當 `film.id`（`tmdb:603` / `gov:駭客任務:thematrix`）。這在管線內是對的（可重跑不重複），但若讓觀影紀錄直接 FK 到它，那麼「gov 片日後比對到 TMDB」就等同於**改主鍵**——所有指向它的紀錄都得跟著改，而且改完之後匯入管線再跑一次又會重新造出 `gov:` 那一列。

因此：

- `film.id` = 內部 UUID，是 `viewing_record` / `certificate` 唯一指向的東西
- 確定性鍵搬進 **`film_identity`**（`key` 為 PK 的單一命名空間，收 `tmdb:` / `gov:` / `ugc:` / `imdb:` / `slug:`）

四種未來變化因此塌縮成同一個動作 ——「把 identity 列改指向存活者」：

| 變化 | 動作 |
|---|---|
| gov 片事後比對到 TMDB | `link_film_to_tmdb()` |
| UGC 重複作品合併 | `merge_films()` |
| TMDB 上游自己合併兩個 id | `merge_films()` |
| 舊網址 301 | `resolve_film('slug:…')` |

`merge_films()` 的關鍵在第 ③ 步：敗方的 `gov:xxx` 鍵被改指向存活者。**下一次重跑政府匯入時，管線查到 `gov:xxx` 會直接拿到存活者的 UUID，不會復活出重複列。** 這是「合併」與「冪等匯入」不打架的唯一寫法。敗方那一列不刪、留成墓碑（`merged_into_film_id`），一是為了 301，二是誤合併時 `film_merge_log.snapshot` 存有合併前的完整 JSON 可還原。

---

## 二、政府資料重複匯入

- `certificate.id` 直接沿用管線的「年度:字號:正規化片名」→ `INSERT … ON CONFLICT (id) DO UPDATE` 即冪等
- `permit_no` 降級為屬性並加註解（110–112 年撞號 128/143/157 筆的實測數字寫進 `COMMENT`，避免後人重蹈）
- `certificate.raw jsonb` 保留原始 CSV 列。3,116 列的體積微不足道，但這代表**日後改良解析邏輯（例如修 `映演時間` 那 8 筆髒資料）可以就地重算，不必重抓上游**
- `import_run` + `first_import_id` / `last_import_id` / `withdrawn_at`：上游年度檔中某列消失時標記而不刪，年度 diff 因此可稽核
- `venue` 同理：`last_seen_at` + `status(active|closed|merged)`，年度 diff 出的歇業影城改狀態不刪列，否則指向它的歷史紀錄會斷

---

## 三、TMDB 六個月新鮮度

**分表是這一條的核心決策。** `film_tmdb_snapshot` 與 `film` 一比一分開：

- **識別碼留在 `film`**（`tmdb_id`）——刪掉就永遠無法刷新；**內容全在 snapshot**（title / overview / poster_path / runtime / payload）
- 清除快取因此是「把一列的內容欄位清空」，**結構上不可能誤傷政府核准片名或使用者紀錄**
- 追蹤新鮮度的欄位：`fetched_at` / `expires_at`（預設 now()+180 天，蓄意小於 6 個月留邊際）/ `next_refresh_at` / `attempts` / `last_error` / `etag` / `state(pending|fresh|failed|gone)`
- **佇列就是這張表本身**，不另建 queue 表：`tmdb_refresh_due` view + `tmdb_refresh_queue_idx` partial index。`state='gone'` 對應 TMDB 端刪片；免費 key 被節流時 worker 只需推遲 `next_refresh_at`，與既有 checkpoint 續跑的設計同構

**最關鍵的一點：合規在讀取端把關，不只靠 cron。** `film_public` view 的每個 TMDB 欄位都包在 `case when s.expires_at > now() then … end`。排程若失敗、pg_cron 若沒啟用、worker 若掛三個月，**過期欄位自動變成 NULL（頁面退回文字卡片），而不是繼續供應逾期快取**。`purge_expired_tmdb_cache()` 是第二道防線而非唯一防線。

另外 `film.title_zh_source` 這個欄位級 provenance 是防止**排程刷新洗掉政府核准片名**的機制：`apply_tmdb_snapshot()` 只覆寫 `source='tmdb'` 或空字串的欄位。`consolidate.ts` 裡「中文以政府為準、原文以 TMDB 為準」的規則因此被編碼進 SQL，不會在管線與刷新器之間漂移。

---

## 四、票價隱私：為什麼 cost 獨立成表

**RLS 只能遮蔽「列」，不能有條件地遮蔽「欄」。** 若 `cost` 留在 `viewing_record` 上：

- 欄位級 `GRANT` 做不到「依作者的 `show_cost` 而定」這種動態條件
- 一旦某支 API 忘記把欄位剔掉、或有人在 PostgREST 打 `select=*`，票價就外洩了——而這正是「使用者沒察覺就被看到」的情境

把 cost 變成 `viewing_record_cost` 的一列，`show_cost` 就成為**資料庫可強制的事實**：`cost_read` policy 一條就是全部規則。PostgREST 的任何 embed、任何 `select=*`、任何 SSR 誤用，在未開啟 `show_cost` 時都拿不到金額。`ticket_count` 留在主表（非敏感，且參與公開統計）。

`viewing_record_public` view 裡 `c.amount` 在 RLS 未放行時自然為 NULL，前端不需要任何條件判斷。

---

## 五、UGC 與審核

- `film_insert_ugc` policy 的 `WITH CHECK` 直接鎖死初始狀態：`origin='ugc' AND visibility='private' AND review_state='pending' AND tmdb_id IS NULL`
- `guard_film_columns` trigger 擋掉使用者自行翻 `review_state` / `visibility` / `tmdb_id`（RLS 的 WITH CHECK 只驗最終值，擋不住「從 pending 改成 approved」這種轉移，需要 trigger 比較 OLD/NEW）
- **審核通過不需要任何資料遷移**：`approve_film()` 只翻 `visibility`，所有指向它的公開紀錄立刻對外可見。因為 `record_read` policy 是即時 join 判斷片子公開性，而不是在紀錄上快取一份 flag
- `film_usable_by()` 保證使用者只能拿「已公開的片」或「自己建的片」記錄

三個 guard trigger 都寫成 `if auth.uid() is not null and not is_staff()`：`auth.uid()` 為 NULL 代表 service_role 直連（seed 腳本、`merge_films` 自身），必須放行，否則 schema 會擋住自己的匯入。

---

## 六、付費牆不能是唯一路徑

三層結構性隔離，而不是靠註解叮嚀：

1. **`entitlement_feature` 是封閉 enum，刻意不含任何海報／圖像相關的值**（只有 `advanced_stats` / `data_export` / `extended_history` / `api_access`）。要把海報鎖起來，必須先 `ALTER TYPE` 新增值——一次寫進 migration、會被 review 看到的顯性決定
2. **billing 只認得 `profile`。** `film` / `viewing_record` / `film_tmdb_snapshot` 上沒有任何 `plan` / `requires_subscription` 欄位。內容路徑與計費路徑在 schema 層沒有交點
3. **海報經 `film_public` view 供應，而該 view `GRANT SELECT TO anon`。** anon 依定義不可能持有 entitlement，這條路徑在結構上碰不到付費判斷。Storage bucket 也設 `public=true`。要加付費牆得先撤 anon 的 grant——同樣是顯性的、需要 migration 的動作

---

## 七、法遵（Phase 1 無法回溯）

- **取下一律是狀態不是 DELETE。** `moderation_state(visible|withheld|removed)` 存在於 `film` 與 `viewing_record`。若取下 = 刪除，§90-9 的「回復」義務就永遠無法履行——這是 schema 層無法事後補救的錯誤
- **法定期間由 DB 計算**：`business_days_after()` + `counter_notice_deadlines` trigger，`forwarded_at` 一填就自動算出 10 個工作日的訴訟證明期限與 14 個工作日的回復期限，各處實作不會漂移
- **三振**：`copyright_strike` + `apply_three_strikes` trigger → `profile.service_status`。第二次 `limited`、第三次 `terminated`；`withdrawn_at` 允許撤銷（誤判申訴成立時）
- **服務條款告知的舉證**：`legal_document(kind, version, content_sha256)` + `legal_acceptance` —— 沒有這兩張表，日後無從證明「已於侵權發生時告知」
- **受理窗口**：`takedown_notice` 的 INSERT 開放給 anon（§90-4 要求公告窗口），`public_ref` 自動產生受理編號給著作權人追查

---

## 八、其他刻意的取捨

**觀影時間存 `watched_on date` + `watched_time time` + `tz`，不存 timestamptz。** 兩個理由：① 貢獻圖與星期×時段熱力圖要的是**當地**日期時間，存 timestamptz 每次繪圖都要做時區換算，且會踩到 generated column 的 IMMUTABLE 限制；② 舊 log 匯入的歷史資料常常只有日期，硬塞 timestamptz 會捏造出假的 00:00 污染時段統計。`tz` 欄位留給日後在國外看片的情境。

**播放版本用查表 (`screening_format`) 不用 enum**，因為這是會持續長出成員的開放詞彙（4DX、ScreenX、Dolby Cinema…），新增只是 INSERT。反之封閉狀態機（visibility / review_state / moderation_state）用 enum，型別安全且 Supabase codegen 產得漂亮。

**`hall_label` 目前是自由文字。** 政府資料不提供影廳層級資訊，現在就建空的 `venue_hall` 表只是徒增複雜度。演進路徑已預留：日後加 `hall_id uuid NULL` 並回填即可。

**搜尋用 pg_trgm GIN 而非 tsvector。** CJK 沒有可靠的 Postgres 斷詞器，`to_tsvector` 對中文片名近乎無效；trigram 對「中文前綴比對」與「原文拼寫錯誤」（實測有 `INVISILBLE`、`GRIME STORY`）都有容錯。

**`viewing_record.import_key` + `UNIQUE(user_id, import_key)`**：David 的舊 log 資料可重跑匯入而不產生重複列，與公共資料採同一套冪等策略。

**FK 方向刻意保守**：`film` / `venue` 對 `viewing_record` 是 `ON DELETE RESTRICT`（不可能因為刪片而失去使用者紀錄），`profile` 對 `viewing_record` 是 CASCADE（帳號刪除要能真的清乾淨），`film.created_by` 是 `SET NULL`（作者刪帳號但已過審的公共作品要留下，別人的紀錄還指著它）。


## 自陳風險

- 未在真實 Postgres 上執行過（此機無 psql / docker），僅做人工靜態檢查。相依於 Supabase 現行環境的部分未驗證：security_invoker view 需 PG15+、`(?:…)` 非捕獲群組正則、`storage.foldername()`、`extensions` schema 中的 pg_trgm opclass、以及 `auth.users` 觸發器的建立權限。上線前務必先 `supabase db reset` 跑一次。
- RLS policy 中的 SECURITY DEFINER 輔助函式（is_staff / account_is_servable / film_usable_by / record_owner / record_is_public / owner_shows_cost）目前是逐列呼叫。個人頁一次拉 300 筆紀錄時，光 cost policy 就是 900 次函式呼叫。緩解手段是把不含列參數者包成 `(select public.is_staff())` 讓 planner 當 InitPlan 只算一次——目前寫法未做此優化，需在真實資料量上 EXPLAIN 後調整。
- 票價分表使公開清單多一次 join / PostgREST embed。若實測太慢，備案是在 viewing_record 上加一個由 profile.show_cost 觸發器同步的布林欄位做預過濾，但那會引入需要維護一致性的反正規化。
- `business_days_after()` 只扣週末，未含台灣國定假日與颱風假。§90-9 的 10／14 個工作日會算得比實際早（對平台是保守方向、不至於違法），但正式營運前應補一張假日表。
- `apply_tmdb_snapshot()` 會把 TMDB 的 runtime / release_year 回填進 film 本體，而 film 本體不受 6 個月 TTL 管制。片長與年份屬事實性資料（非受著作權保護的表達），實務上應無問題，但嚴格解讀 TMDB 條款時是灰色地帶，值得與 SPEC 中「付費牆法律意見」一併確認。
- `merge_films()` 未清理敗方的 film_tmdb_snapshot 列（因 PK 是 film_id，會留在墓碑上）。不會污染讀取，但長期會累積無用列，且該列仍會被 tmdb_refresh_due 排除（有 merged_into 過濾）——只是佔空間。
- `link_film_to_tmdb()` 是先查後寫，併發 backfill 存在競態；目前僅靠 film.tmdb_id 的 unique 約束在衝突時報錯，函式本身沒有 advisory lock，呼叫端需自行重試。
- slug 對 CJK 片名幾乎退化成「film-<id 前 8 碼>」（slugify 後為空），SEO 效益有限。若在意，需改用拼音轉寫或以 title_original 為主，但那對日本片同樣無效。
- UGC 私有作品被使用者的公開紀錄引用時，該紀錄對外整筆不可見（record_read policy 連動判斷）。使用者會看到「我設了公開卻沒人看得到」，schema 層無法解釋，必須靠 UI 明示「待審核通過後才會公開」。
- anon 可 INSERT takedown_notice（§90-4 要求公告受理窗口）。濫發防護完全在 schema 之外，必須在 Nitro 層加 rate limit 與 CAPTCHA；另外 PostgREST 預設回傳 representation，該端點需強制 `Prefer: return=minimal` 否則 anon 能讀回自己剛寫的列。
- certificate.raw 與 film_tmdb_snapshot.payload 永久／半永久保留原始 JSON，會顯著放大 DB 體積。政府資料可永久保存於法無礙，但 Supabase 免費專案 500MB 上限需留意；payload 受 TTL 清除，raw 不受。
- username 保留字清單是硬編碼的一次性 seed。日後新增路由（如 /explore）時若忘了同步加入保留字，可能與既有使用者名稱撞號，屆時無法回收。
