# schema-query-first

## SQL

```sql
-- =====================================================================
-- 影記 / filmnote — Supabase schema（Postgres 15+ / Supabase）
-- 設計優先序：統計查詢效能 > 寫入便利 > 儲存空間
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 擴充與 schema
-- ---------------------------------------------------------------------
create extension if not exists pg_trgm with schema extensions;
-- pg_cron 需先於 Supabase Dashboard > Database > Extensions 開啟。
create extension if not exists pg_cron;

-- private：不掛進 PostgREST 的 db-schemas。
-- Materialized view 無法套用 RLS（沒有 ALTER MATERIALIZED VIEW ... ENABLE RLS），
-- 因此一律放這裡，只透過 public 的 view / RPC 對外。
create schema if not exists private;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. 列舉型別
-- ---------------------------------------------------------------------
create type public.visibility_t     as enum ('public', 'private');
create type public.film_source_t    as enum ('tmdb', 'gov', 'ugc');
create type public.review_status_t  as enum ('pending', 'approved', 'rejected');
create type public.venue_kind_t     as enum ('cinema', 'streaming', 'festival', 'home', 'other');
create type public.poster_source_t  as enum ('tmdb', 'ugc', 'none');
create type public.takedown_state_t as enum
  ('received', 'removed', 'counter_noticed', 'restored', 'rejected');

-- ---------------------------------------------------------------------
-- 2. 台灣本地時間：可用於 generated column 的 IMMUTABLE 轉換
-- ---------------------------------------------------------------------
-- 關鍵限制（決定了整份 schema 的分桶策略）：
--   * `timestamptz AT TIME ZONE text`（timestamptz_zone）是 STABLE —— IANA tzdata
--     可能改版 → 不能用於 generated column 或索引運算式。
--   * `timestamptz AT TIME ZONE interval`（timestamptz_izone）是 IMMUTABLE。
--   * `extract(... from timestamptz)` 依賴 TimeZone GUC，同樣 STABLE；
--     必須先轉成 timestamp（without time zone）再 extract。
-- 台灣自 1980 年起固定 UTC+8、無日光節約時間，以固定 interval 取代具名時區
-- 語意等價；且即使 tzdata 日後變動，既有資料的分桶結果也不會漂移。
create or replace function public.tw_local(ts timestamptz)
returns timestamp
language sql immutable parallel safe
as $$ select ts at time zone interval '8 hours' $$;

comment on function public.tw_local(timestamptz) is
  'timestamptz → 台灣牆上時間（UTC+8 固定位移）。IMMUTABLE，可用於索引與 generated column。';

-- ---------------------------------------------------------------------
-- 3. 身分
-- ---------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  username       text not null,
  -- 大小寫不敏感的唯一鍵。不用 citext，以免 extension schema 與 PostgREST 型別對應打架。
  username_lower text generated always as (lower(username)) stored,
  display_name   text,
  avatar_url     text,
  show_cost      boolean  not null default false,   -- 隱私模型 #2：票價預設隱藏
  is_admin       boolean  not null default false,
  strike_count   smallint not null default 0,       -- 三振條款
  suspended_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint username_shape check (username ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,29}$')
);
create unique index profiles_username_lower_key on public.profiles (username_lower);

create table public.reserved_username (name text primary key);
insert into public.reserved_username(name) values
  ('u'),('api'),('admin'),('login'),('logout'),('auth'),('settings'),('about'),
  ('film'),('films'),('movie'),('venue'),('venues'),('search'),('legal'),
  ('copyright'),('dmca'),('terms'),('privacy'),('sitemap'),('robots'),
  ('assets'),('static'),('_nuxt'),('me'),('new'),('edit'),('export')
on conflict do nothing;

-- 隱私模型 #5：改名後舊網址 301。
create table public.username_history (
  old_username_lower text primary key,
  old_username       text not null,
  user_id            uuid not null references public.profiles(id) on delete cascade,
  changed_at         timestamptz not null default now()
);
create index username_history_user_idx on public.username_history (user_id, changed_at desc);

-- ---------------------------------------------------------------------
-- 4. 片庫
-- ---------------------------------------------------------------------
create table public.film (
  -- 確定性主鍵（沿用匯入管線）：tmdb:<id> / gov:<zh>:<orig> / ugc:<uuid>。
  -- 用 text 而非代理 uuid，是為了讓匯入可重跑 upsert 而不產生重複列。
  id                  text primary key check (id ~ '^(tmdb|gov|ugc):'),
  tmdb_id             integer unique,          -- ★ 必須可為 NULL：實測 20% 台灣上映片查無
  imdb_id             text,
  title_zh            text not null,
  title_original      text not null default '',
  country             text,
  runtime_minutes     smallint check (runtime_minutes between 1 and 1200),
  release_year        smallint,
  first_seen_roc_year smallint,
  poster_path         text,   -- TMDB 相對路徑，熱連結 image.tmdb.org，不轉存
  poster_storage_path text,   -- UGC 上傳（Supabase Storage，長邊 500px）
  poster_source       public.poster_source_t  not null default 'none',
  source              public.film_source_t    not null,
  visibility          public.visibility_t     not null default 'public',  -- 隱私模型 #4
  review_status       public.review_status_t  not null default 'approved',
  listed              boolean not null default true,  -- 是否進入公共片庫（可被搜尋/瀏覽）
  created_by          uuid references public.profiles(id) on delete set null,
  merged_into         text references public.film(id) on delete set null,
  tmdb_synced_at      timestamptz,   -- TMDB 條款：快取 ≤ 6 個月，需排程刷新
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint ugc_shape       check (source <> 'ugc' or created_by is not null),
  constraint tmdb_no_upload  check (tmdb_id is null or poster_storage_path is null),
  constraint no_self_merge   check (merged_into is distinct from id)
);

create table public.certificate (
  -- 確定性複合鍵「年度:字號:正規化片名」。permit_no 跨年度不唯一，不可當主鍵。
  id              text primary key,
  film_id         text not null references public.film(id) on delete cascade on update cascade,
  permit_no       text not null,
  roc_year        smallint not null,
  gregorian_year  smallint not null,
  rating          text,
  title_zh        text not null,
  title_original  text not null default '',
  country         text,
  language        text,
  producer        text,
  runtime_minutes smallint,
  version_note    text,
  defects         text[] not null default '{}'
);

-- ---------------------------------------------------------------------
-- 5. 觀影場所
-- ---------------------------------------------------------------------
create table public.venue (
  -- 影城為統一編號（實測 107/107 有值零重複）；非影城為 virtual:<kind>。
  id           text primary key
               check (id ~ '^([0-9]{8}|virtual:(streaming|festival|home|other))$'),
  name         text not null,
  company_name text,
  hall_count   smallint,
  address      text,
  phone        text,
  city         text,
  kind         public.venue_kind_t not null,
  lat          double precision,
  lng          double precision,
  is_active    boolean not null default true,
  closed_at    date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint venue_id_matches_kind check (
    (kind =  'cinema' and id ~ '^[0-9]{8}$') or
    (kind <> 'cinema' and id = 'virtual:' || kind::text)
  )
);

-- 播放版本供下拉選單。刻意不對 viewing_record 加 FK，以免新規格上市時擋住寫入。
create table public.screening_format (
  code       text primary key,
  label      text not null,
  sort_order smallint not null default 100
);
insert into public.screening_format(code, label, sort_order) values
  ('digital','數位',10),('imax','IMAX',20),('imax-laser','IMAX Laser',21),
  ('3d','3D',30),('4dx','4DX',40),('dbox','D-BOX',50),('dolby','Dolby Cinema',60),
  ('gc','Gold Class',70),('35mm','35mm',80),('other','其他',999)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- 6. 觀影紀錄（熱表）
-- ---------------------------------------------------------------------
create table public.viewing_record (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  film_id       text not null references public.film(id) on update cascade,
  venue_id      text not null references public.venue(id) on update cascade,

  watched_at    timestamptz not null,

  -- ── 台灣本地時間的分桶欄位（STORED generated）────────────────────────
  -- 用 generated column 而非 expression index：統計要「group by 這個值並把它讀出來」，
  -- 只有欄位化才能被 INCLUDE 進覆蓋索引做 index-only scan；
  -- expression index 只能在 WHERE 端用上，聚合仍要回 heap。
  -- 注意：generated column 不得引用另一個 generated column，故運算式重複書寫。
  watched_date  date     generated always as ((watched_at at time zone interval '8 hours')::date) stored,
  watched_year  smallint generated always as (extract(year  from (watched_at at time zone interval '8 hours'))::smallint) stored,
  watched_month smallint generated always as (extract(month from (watched_at at time zone interval '8 hours'))::smallint) stored,
  -- 0 = 週日，與前端 dayjs().weekday()（en locale）及 ECharts 既有元件一致。
  watched_dow   smallint generated always as (extract(dow   from (watched_at at time zone interval '8 hours'))::smallint) stored,
  watched_hour  smallint generated always as (extract(hour  from (watched_at at time zone interval '8 hours'))::smallint) stored,

  tickets       smallint not null default 1 check (tickets between 1 and 99),
  hall          text check (length(hall)    <= 40),
  version       text check (length(version) <= 32),
  memo          text check (length(memo)    <= 2000),

  visibility    public.visibility_t not null default 'public',

  -- film_public：film.visibility 的鏡射，由 trigger 維護。
  -- 存在的唯一理由是 RLS：若把「作品是否公開」寫成 policy 裡的 EXISTS 子查詢，
  -- 會變成逐列求值且無法與部分索引的述詞比對，公開時間軸就退化成 seq scan。
  film_public   boolean not null default true,
  -- 對外可見 = 使用者意圖公開 且 作品本身公開。
  -- RLS 述詞與部分索引述詞使用同一個欄位，planner 才能證明兩者等價。
  public_listed boolean generated always as
                (visibility = 'public'::public.visibility_t and film_public) stored,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint watched_at_sane check (watched_at > timestamptz '1900-01-01'),
  -- 供 viewing_record_cost 做複合 FK，宣告式保證兩表的 user_id 一致。
  constraint viewing_record_id_user_key unique (id, user_id)
);

-- ── 票價：獨立成表，不是為了正規化，是為了讓 RLS 管得到它 ──────────────
-- Postgres 的 RLS 只能做「列」層過濾，沒有條件式欄遮罩；
-- 欄位層 GRANT 是「角色」層，無法表達「本人或 show_cost 才看得到」；
-- 而 SELECT privilege 一旦拔掉，PostgREST 預設的 select=* 就直接 permission denied。
-- 把票價變成一個「列」，隱私模型 #2 便成為結構性保證，而不是某支 API 忘了遮的風險。
create table public.viewing_record_cost (
  record_id   uuid primary key,
  user_id     uuid    not null,
  amount      integer not null check (amount >= 0 and amount <= 100000),
  -- cost_public = 紀錄本身公開 且 作者開啟 show_cost。由 trigger 維護。
  -- 同樣是把跨表條件鏡射成同列欄位，policy 述詞才能與部分索引比對。
  cost_public boolean not null default false,
  foreign key (record_id, user_id)
    references public.viewing_record(id, user_id) on delete cascade on update cascade
);

-- ---------------------------------------------------------------------
-- 7. 法遵：通知／取下／回復通知／三振
-- ---------------------------------------------------------------------
create table public.takedown_notice (
  id               uuid primary key default gen_random_uuid(),
  target_kind      text not null check (target_kind in ('film','viewing_record','profile')),
  target_id        text not null,
  claimant_name    text not null,
  claimant_email   text not null,
  claimant_address text,
  work_description text not null,
  good_faith_stmt  boolean not null default false,
  accuracy_stmt    boolean not null default false,
  state            public.takedown_state_t not null default 'received',
  removed_at       timestamptz,
  -- 回復通知後：著作權人 10 個工作日內未提訴訟證明 → 須於 14 個工作日內回復。
  restore_due_at   timestamptz,
  restored_at      timestamptz,
  handled_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);
create index takedown_notice_state_idx  on public.takedown_notice (state, created_at);
create index takedown_notice_target_idx on public.takedown_notice (target_kind, target_id);
create index takedown_notice_due_idx    on public.takedown_notice (restore_due_at)
  where state = 'counter_noticed';

create table public.counter_notice (
  id         uuid primary key default gen_random_uuid(),
  notice_id  uuid not null references public.takedown_notice(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  statement  text not null,
  created_at timestamptz not null default now()
);
create index counter_notice_notice_idx on public.counter_notice (notice_id);
create index counter_notice_user_idx   on public.counter_notice (user_id);

create table public.copyright_strike (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  notice_id  uuid references public.takedown_notice(id) on delete set null,
  reason     text,
  created_at timestamptz not null default now()
);
create index copyright_strike_user_idx on public.copyright_strike (user_id, created_at);

-- ---------------------------------------------------------------------
-- 8. Trigger：維護鏡射欄位
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch       before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger film_touch           before update on public.film
  for each row execute function private.touch_updated_at();
create trigger venue_touch          before update on public.venue
  for each row execute function private.touch_updated_at();
create trigger viewing_record_touch before update on public.viewing_record
  for each row execute function private.touch_updated_at();

-- UGC 作品的預設：private / pending / 不進片庫。用 trigger 強制而非 policy 檢查，
-- 讓前端不必知道這些內部旗標；service_role（auth.uid() 為 null）匯入時不受影響。
create or replace function private.force_ugc_defaults()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null
     and not coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false) then
    new.source        := 'ugc'::public.film_source_t;
    new.created_by    := auth.uid();
    new.visibility    := 'private'::public.visibility_t;
    new.review_status := 'pending'::public.review_status_t;
    new.listed        := false;
    new.tmdb_id       := null;
    new.poster_path   := null;
    new.id            := coalesce(nullif(new.id, ''), 'ugc:' || gen_random_uuid()::text);
    if new.id !~ '^ugc:' then
      new.id := 'ugc:' || gen_random_uuid()::text;
    end if;
  end if;
  return new;
end $$;

create trigger film_force_ugc_defaults
  before insert on public.film
  for each row execute function private.force_ugc_defaults();

-- film_public 鏡射：寫入面。
create or replace function private.sync_record_film_public()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.film_public := coalesce(
    (select f.visibility = 'public'::public.visibility_t
     from public.film f where f.id = new.film_id), false);
  return new;
end $$;

create trigger viewing_record_film_public
  before insert or update of film_id on public.viewing_record
  for each row execute function private.sync_record_film_public();

-- film_public 鏡射：作品審核通過／退回時回填該片的紀錄（列數以該片為界）。
create or replace function private.propagate_film_visibility()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.viewing_record r
     set film_public = (new.visibility = 'public'::public.visibility_t)
   where r.film_id = new.id
     and r.film_public <> (new.visibility = 'public'::public.visibility_t);
  return null;
end $$;

create trigger film_visibility_propagate
  after update of visibility on public.film
  for each row
  when (old.visibility is distinct from new.visibility)
  execute function private.propagate_film_visibility();

-- cost_public = 紀錄公開 且 作者 show_cost。三個入口都要維持一致：
--   (1) 票價列建立時          (2) 紀錄的公開狀態改變時   (3) 使用者切換 show_cost 時
create or replace function private.default_cost_public()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.cost_public := coalesce(
    (select r.public_listed and p.show_cost
     from public.viewing_record r
     join public.profiles p on p.id = r.user_id
     where r.id = new.record_id), false);
  return new;
end $$;

create trigger viewing_record_cost_default
  before insert on public.viewing_record_cost
  for each row execute function private.default_cost_public();

create or replace function private.sync_cost_on_record()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.viewing_record_cost c
     set cost_public = new.public_listed
                       and coalesce((select p.show_cost from public.profiles p
                                     where p.id = new.user_id), false)
   where c.record_id = new.id;
  return null;
end $$;

create trigger viewing_record_cost_sync
  after update on public.viewing_record
  for each row
  when (old.public_listed is distinct from new.public_listed)
  execute function private.sync_cost_on_record();

create or replace function private.propagate_show_cost()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.viewing_record_cost c
     set cost_public = new.show_cost and r.public_listed
    from public.viewing_record r
   where c.record_id = r.id
     and c.user_id = new.id;
  return null;
end $$;

create trigger profiles_show_cost_propagate
  after update of show_cost on public.profiles
  for each row
  when (old.show_cost is distinct from new.show_cost)
  execute function private.propagate_show_cost();

-- 改名：寫入 username_history 供 301。
create or replace function private.record_username_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.reserved_username u where u.name = lower(new.username)) then
    raise exception '使用者名稱 % 為系統保留字', new.username;
  end if;
  if exists (select 1 from public.username_history h
             where h.old_username_lower = lower(new.username) and h.user_id <> new.id) then
    raise exception '使用者名稱 % 已被其他帳號使用過', new.username;
  end if;

  insert into public.username_history(old_username_lower, old_username, user_id)
  values (old.username_lower, old.username, old.id)
  on conflict (old_username_lower)
    do update set user_id = excluded.user_id, changed_at = now();

  delete from public.username_history h
   where h.old_username_lower = lower(new.username) and h.user_id = new.id;
  return new;
end $$;

create trigger profiles_username_change
  before update of username on public.profiles
  for each row
  when (lower(old.username) is distinct from lower(new.username))
  execute function private.record_username_change();

-- 三振條款：累計 3 次即停權。
create or replace function private.apply_strike()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.profiles p
     set strike_count = p.strike_count + 1,
         suspended_at = case when p.strike_count + 1 >= 3
                             then coalesce(p.suspended_at, now()) else p.suspended_at end
   where p.id = new.user_id;
  return null;
end $$;

create trigger copyright_strike_apply
  after insert on public.copyright_strike
  for each row execute function private.apply_strike();

-- 首次登入自動建 profile，username 取 email @ 前綴並去重。
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_base text; v_name text; v_i int := 0;
begin
  v_base := regexp_replace(lower(split_part(coalesce(new.email, ''), '@', 1)),
                           '[^a-z0-9_.-]', '', 'g');
  if v_base is null or length(v_base) < 2 then
    v_base := 'user' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  v_base := left(v_base, 24);
  v_name := v_base;
  while exists (select 1 from public.profiles p         where p.username_lower     = v_name)
     or exists (select 1 from public.username_history h where h.old_username_lower = v_name)
     or exists (select 1 from public.reserved_username u where u.name              = v_name)
  loop
    v_i := v_i + 1;
    v_name := v_base || v_i::text;
  end loop;

  insert into public.profiles(id, username, display_name, avatar_url)
  values (new.id, v_name,
          new.raw_user_meta_data ->> 'full_name',
          new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------
-- 9. 索引 —— 每一條服務哪個查詢
-- ---------------------------------------------------------------------

-- ★★ 統計主索引。所有「某使用者某年」的圖表都走這一條，且全程 index-only scan。
--    服務：年度貢獻圖、星期×時段熱力圖、月度趨勢、影城分布、版本分布、
--         國別分布（取 film_id 後對 film PK 做 nested loop）、
--         年度總場次／總票數、年份切換清單（distinct watched_year）。
--    排序性質：(user_id, watched_year) 定值後 watched_date 已排序，
--             貢獻圖的 group by watched_date 是 GroupAggregate，不需 Sort 節點。
create index viewing_record_user_year_idx
  on public.viewing_record (user_id, watched_year desc, watched_date)
  include (id, watched_dow, watched_hour, watched_month, tickets, film_id, venue_id, version);

-- 服務：多刷排行（group by film_id，輸入端免排序）；
--      「這部片我記過幾次／有沒有記過」的即時判斷。
create index viewing_record_user_film_idx
  on public.viewing_record (user_id, film_id);

-- 服務：本人自己的時間軸（含私密紀錄）分頁。
create index viewing_record_user_recent_idx
  on public.viewing_record (user_id, watched_at desc);

-- 服務：公開個人頁 /u/{username} 的時間軸。
--      部分索引述詞 = RLS 述詞（public_listed），planner 可證明 policy 在此索引上恆真；
--      索引本身也只含公開列，未登入路徑的掃描量與私密紀錄數量無關。
create index viewing_record_user_public_idx
  on public.viewing_record (user_id, watched_at desc)
  where public_listed;

-- 服務：電影頁「有哪些人看過這部片」。
--      這是唯一隨全站資料量成長的使用者面查詢，也是 film_watch_stats MV 的刷新來源。
create index viewing_record_film_public_idx
  on public.viewing_record (film_id, watched_at desc)
  include (user_id)
  where public_listed;

-- 服務：影城頁「這家戲院有誰去過」。
create index viewing_record_venue_public_idx
  on public.viewing_record (venue_id, watched_at desc)
  include (user_id)
  where public_listed;

-- 服務：首頁最新公開動態。
create index viewing_record_public_recent_idx
  on public.viewing_record (watched_at desc)
  where public_listed;

-- 服務：作品合併／刪除、影城歇業時的 FK 反查（需含私密列，故不加述詞）。
create index viewing_record_film_idx  on public.viewing_record (film_id);
create index viewing_record_venue_idx on public.viewing_record (venue_id);

-- 服務：年度總花費。本人路徑走第一條（index-only）；
--      公開路徑走第二條，其述詞與 RLS 述詞同形。
create index viewing_record_cost_user_idx
  on public.viewing_record_cost (user_id) include (record_id, amount);
create index viewing_record_cost_public_idx
  on public.viewing_record_cost (user_id) include (record_id, amount)
  where cost_public;

-- 服務：片庫搜尋。中文與原文雙路徑 —— 比對演算法的「雙查詢」在前端搜尋同樣成立。
create index film_title_zh_trgm_idx    on public.film
  using gin (title_zh       extensions.gin_trgm_ops) where listed;
create index film_title_orig_trgm_idx  on public.film
  using gin (title_original extensions.gin_trgm_ops) where listed;

create index film_browse_idx       on public.film (release_year desc nulls last, id)
  where listed and visibility = 'public';                       -- 公共片庫瀏覽
create index film_tmdb_stale_idx   on public.film (tmdb_synced_at nulls first)
  where tmdb_id is not null;                                    -- TMDB 6 個月快取刷新排程
create index film_review_queue_idx on public.film (created_at)
  where review_status = 'pending';                              -- 管理者審核佇列
create index film_created_by_idx   on public.film (created_by)
  where source = 'ugc';                                         -- 「我新增的作品」＋ RLS 分支
create index film_merged_into_idx  on public.film (merged_into)
  where merged_into is not null;                                -- 合併後的 301
create index film_country_idx      on public.film (country) where listed; -- 國別瀏覽頁

create index certificate_film_idx   on public.certificate (film_id);
create index certificate_permit_idx on public.certificate (roc_year, permit_no); -- 非唯一！
create index venue_kind_city_idx    on public.venue (kind, city, name) where is_active;
create index venue_name_trgm_idx    on public.venue using gin (name extensions.gin_trgm_ops);

-- 熱表以 INSERT 為主、UPDATE 少，把 autovacuum 調積極以維持 visibility map 新鮮；
-- 否則 index-only scan 會退化成大量 heap fetch，覆蓋索引就白做了。
alter table public.viewing_record set (
  autovacuum_vacuum_scale_factor        = 0.02,
  autovacuum_analyze_scale_factor       = 0.01,
  autovacuum_vacuum_insert_scale_factor = 0.02
);

-- ---------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------
-- 三條通則（直接回應「RLS 會不會讓聚合查詢走不了索引」）：
--  (a) 任何 STABLE 函式呼叫（auth.uid()、is_admin()）一律包成純量子查詢
--      `(select f())`，planner 才會提成 InitPlan 只求值一次；
--      直接寫 f() 會逐列求值 —— 幾百列的年度查詢就是幾百次 JWT JSON 解析。
--  (b) policy 述詞只用「同一列的欄位」，不用跨表 EXISTS；
--      跨表條件先鏡射成欄位（film_public / cost_public），
--      policy 才能與部分索引述詞比對，公開路徑才走得到 index-only scan。
--  (c) 每條 policy 都指定 TO 角色，避免 anon 也去跑只對 authenticated 有意義的分支。

alter table public.profiles            enable row level security;
alter table public.username_history    enable row level security;
alter table public.reserved_username   enable row level security;
alter table public.film                enable row level security;
alter table public.certificate         enable row level security;
alter table public.venue               enable row level security;
alter table public.screening_format    enable row level security;
alter table public.viewing_record      enable row level security;
alter table public.viewing_record_cost enable row level security;
alter table public.takedown_notice     enable row level security;
alter table public.counter_notice      enable row level security;
alter table public.copyright_strike    enable row level security;

-- SECURITY DEFINER 以避開 profiles 自身 policy 的遞迴。
-- 放在 public 而非 private：RLS 述詞中的函式呼叫會對查詢者做 EXECUTE 權限檢查，
-- 藏進 private 再 revoke 會讓 policy 在執行期直接 permission denied。
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.suspended_at is null from public.profiles p where p.id = auth.uid()), false)
$$;

grant execute on function public.is_admin()       to authenticated;
grant execute on function public.is_active_user() to authenticated;

-- profiles
create policy profiles_read_all    on public.profiles for select to anon, authenticated using (true);
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- 參考資料：全站可讀；寫入一律走 service_role（bypass RLS）。
create policy username_history_read  on public.username_history  for select to anon, authenticated using (true);
create policy reserved_username_read on public.reserved_username for select to anon, authenticated using (true);
create policy venue_read             on public.venue             for select to anon, authenticated using (true);
create policy screening_format_read  on public.screening_format  for select to anon, authenticated using (true);
create policy certificate_read       on public.certificate       for select to anon, authenticated using (true);

-- film
create policy film_read_public on public.film for select to anon, authenticated
  using (visibility = 'public'::public.visibility_t);
create policy film_read_own on public.film for select to authenticated
  using (created_by = (select auth.uid()));
create policy film_read_admin on public.film for select to authenticated
  using ((select public.is_admin()));
create policy film_insert_ugc on public.film for insert to authenticated
  with check ((select public.is_active_user()));   -- 其餘欄位由 force_ugc_defaults() 強制
create policy film_update_own_pending on public.film for update to authenticated
  using (created_by = (select auth.uid())
         and review_status = 'pending'::public.review_status_t)
  with check (created_by = (select auth.uid()));
create policy film_admin_write on public.film for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- viewing_record：兩條讀 policy 都只碰同一列的欄位。
create policy viewing_record_read_public on public.viewing_record
  for select to anon, authenticated using (public_listed);
create policy viewing_record_read_own on public.viewing_record
  for select to authenticated using (user_id = (select auth.uid()));
create policy viewing_record_insert_own on public.viewing_record
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_active_user()));
create policy viewing_record_update_own on public.viewing_record
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy viewing_record_delete_own on public.viewing_record
  for delete to authenticated using (user_id = (select auth.uid()));

-- viewing_record_cost：隱私模型 #2 的結構性落點。
create policy cost_read_public on public.viewing_record_cost
  for select to anon, authenticated using (cost_public);
create policy cost_read_own on public.viewing_record_cost
  for select to authenticated using (user_id = (select auth.uid()));
create policy cost_write_own on public.viewing_record_cost
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select public.is_active_user()));

-- 法遵
create policy takedown_insert_any on public.takedown_notice
  for insert to anon, authenticated with check (true);
create policy takedown_admin_all on public.takedown_notice
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy counter_notice_own on public.counter_notice
  for all to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()));
create policy strike_read_own on public.copyright_strike
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy strike_admin_write on public.copyright_strike
  for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- ---------------------------------------------------------------------
-- 11. 權限
-- ---------------------------------------------------------------------
-- 欄位層 GRANT 用在「寫入」（那裡它有效），不用在 SELECT
-- （SELECT 拔欄位會讓 PostgREST 的 select=* 直接 permission denied）。
grant usage on schema public to anon, authenticated;

grant select on
  public.profiles, public.username_history, public.reserved_username,
  public.film, public.certificate, public.venue, public.screening_format,
  public.viewing_record, public.viewing_record_cost
  to anon, authenticated;

-- 使用者只能改自己該改的欄位；film_public / public_listed / user_id 由系統維護。
grant insert (id, user_id, film_id, venue_id, watched_at, tickets, hall, version, memo, visibility)
  on public.viewing_record to authenticated;
grant update (film_id, venue_id, watched_at, tickets, hall, version, memo, visibility)
  on public.viewing_record to authenticated;
grant delete on public.viewing_record to authenticated;

grant insert (record_id, user_id, amount) on public.viewing_record_cost to authenticated;
grant update (amount)                     on public.viewing_record_cost to authenticated;
grant delete                              on public.viewing_record_cost to authenticated;

grant update (username, display_name, avatar_url, show_cost) on public.profiles to authenticated;

grant insert (id, title_zh, title_original, country, runtime_minutes,
              release_year, poster_storage_path, poster_source, source, created_by)
  on public.film to authenticated;
grant update (title_zh, title_original, country, runtime_minutes,
              release_year, poster_storage_path, poster_source)
  on public.film to authenticated;

grant insert         on public.takedown_notice to anon, authenticated;
grant insert, select on public.counter_notice  to authenticated;

-- ---------------------------------------------------------------------
-- 12. Materialized view：只放「跨使用者、無界成長」的聚合
-- ---------------------------------------------------------------------
-- 刻意不為「單一使用者的年度統計」建 MV：
--   重度使用者一年約 100–300 筆，二十年也只有數千列；走上面的覆蓋索引是
--   index-only scan，微秒級。MV 只會換來刷新成本、過時資料，以及一個沒有 RLS 的表。
-- 會建 MV 的，是掃描量隨「全站」成長、RLS 也幫不上忙的跨使用者聚合。
--
-- ★ MV 沒有 RLS，所以一律建在 private schema，且來源只取 public_listed 的列——
--   讓「只含公開資料」成為建構上的事實，而不是某條 policy 的承諾。
create materialized view private.film_watch_stats as
select r.film_id,
       count(*)::int                  as watch_count,
       count(distinct r.user_id)::int as watcher_count,
       max(r.watched_at)              as last_watched_at,
       count(*) filter (where r.watched_at > now() - interval '90 days')::int as watch_count_90d
from public.viewing_record r
where r.public_listed
group by r.film_id;

create unique index film_watch_stats_pk           on private.film_watch_stats (film_id);
create index        film_watch_stats_popular_idx  on private.film_watch_stats (watcher_count desc, watch_count desc);
create index        film_watch_stats_trending_idx on private.film_watch_stats (watch_count_90d desc);

create materialized view private.venue_watch_stats as
select r.venue_id,
       count(*)::int                  as watch_count,
       count(distinct r.user_id)::int as watcher_count,
       max(r.watched_at)              as last_watched_at
from public.viewing_record r
where r.public_listed
group by r.venue_id;

create unique index venue_watch_stats_pk          on private.venue_watch_stats (venue_id);
create index        venue_watch_stats_popular_idx on private.venue_watch_stats (watch_count desc);

-- 對外只暴露 view。MV 內容已保證全公開，故不需 security_invoker。
create view public.film_stats  as select * from private.film_watch_stats;
create view public.venue_stats as select * from private.venue_watch_stats;
grant select on public.film_stats, public.venue_stats to anon, authenticated;

create or replace function private.refresh_stats()
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- CONCURRENTLY 需要唯一索引，且不阻塞讀者。
  refresh materialized view concurrently private.film_watch_stats;
  refresh materialized view concurrently private.venue_watch_stats;
end $$;

select cron.schedule('filmnote-refresh-stats', '*/10 * * * *', $$select private.refresh_stats()$$);

-- ---------------------------------------------------------------------
-- 13. RPC：一次往返取回整個統計面板
-- ---------------------------------------------------------------------
-- 為什麼是一支 RPC 而不是七支 PostgREST 查詢：
--   七支 = 七次索引掃描 + 七次 RLS 求值 + 七次網路往返；
--   一支 RPC 用 MATERIALIZED CTE 把那一年的列掃一次，餵給七個聚合。

create or replace function public.resolve_username(p_username text)
returns table (user_id uuid, canonical_username text, redirected boolean)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, false
  from public.profiles p
  where p.username_lower = lower(p_username)
  union all
  select p2.id, p2.username, true
  from public.username_history h
  join public.profiles p2 on p2.id = h.user_id
  where h.old_username_lower = lower(p_username)
    and not exists (select 1 from public.profiles p3
                    where p3.username_lower = lower(p_username))
  limit 1
$$;

create or replace function public.user_year_stats(p_username text, p_year int default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_target       uuid;
  v_show_cost    boolean;
  v_viewer       uuid := auth.uid();
  v_is_owner     boolean;
  v_cost_allowed boolean;
  v_out          jsonb;
begin
  select t.user_id into v_target from public.resolve_username(p_username) t;
  if v_target is null then return null; end if;

  select p.show_cost into v_show_cost from public.profiles p where p.id = v_target;
  v_is_owner := (v_viewer is not null and v_viewer = v_target);
  -- 隱私模型 #2：非本人且未開啟 show_cost → 連聚合後的總花費都不得回傳。
  v_cost_allowed := v_is_owner or coalesce(v_show_cost, false);

  with scoped as materialized (
    -- 唯一一次掃描。走 viewing_record_user_year_idx，全部欄位都在索引裡。
    select r.id, r.film_id, r.venue_id, r.watched_date, r.watched_month,
           r.watched_dow, r.watched_hour, r.tickets, r.version
    from public.viewing_record r
    where r.user_id = v_target
      and (v_is_owner or r.public_listed)
      and (p_year is null or r.watched_year = p_year)
  ),
  contribution as (
    select jsonb_agg(jsonb_build_array(t.d, t.c) order by t.d) j
    from (select watched_date d, count(*) c from scoped group by 1) t
  ),
  heatmap as (
    -- 7 × 24 完整矩陣，缺格補 0，前端不必再補。
    select jsonb_agg(jsonb_build_array(g.dow, g.hr, coalesce(t.c, 0))) j
    from (select dow, hr from generate_series(0,6) dow, generate_series(0,23) hr) g
    left join (select watched_dow d, watched_hour h, count(*) c from scoped group by 1,2) t
      on t.d = g.dow and t.h = g.hr
  ),
  monthly as (
    select jsonb_agg(jsonb_build_array(g.m, coalesce(t.c,0), coalesce(t.k,0)) order by g.m) j
    from generate_series(1,12) g(m)
    left join (select watched_month m, count(*) c, sum(tickets) k from scoped group by 1) t
      on t.m = g.m
  ),
  venues as (
    select jsonb_agg(jsonb_build_object('venue_id', t.venue_id, 'name', v.name,
                                        'city', v.city, 'kind', v.kind, 'count', t.c)
                     order by t.c desc) j
    from (select venue_id, count(*) c from scoped group by 1) t
    join public.venue v on v.id = t.venue_id
  ),
  countries as (
    select jsonb_agg(jsonb_build_object('country', t.country, 'count', t.c) order by t.c desc) j
    from (select coalesce(f.country, '未知') country, count(*) c
          from scoped s join public.film f on f.id = s.film_id
          group by 1) t
  ),
  versions as (
    select jsonb_agg(jsonb_build_object('version', coalesce(t.version, '未填'), 'count', t.c)
                     order by t.c desc) j
    from (select version, count(*) c from scoped group by 1) t
  ),
  rewatch as (
    select jsonb_agg(jsonb_build_object('film_id', t.film_id, 'title_zh', f.title_zh,
                                        'poster_path', f.poster_path, 'count', t.c)
                     order by t.c desc) j
    from (select film_id, count(*) c from scoped group by 1
          having count(*) > 1 order by 2 desc limit 30) t
    join public.film f on f.id = t.film_id
  ),
  totals as (
    select count(*)::int screenings, coalesce(sum(tickets),0)::int tickets from scoped
  ),
  spend as (
    -- SECURITY DEFINER 內 RLS 不生效（definer 是表的擁有者），故在此明確把關。
    select case when v_cost_allowed then coalesce(sum(c.amount),0)::int end   total_cost,
           case when v_cost_allowed then count(c.record_id)::int      end   priced_records
    from scoped s left join public.viewing_record_cost c on c.record_id = s.id
  ),
  years as (
    select jsonb_agg(t.y order by t.y desc) j
    from (select distinct r.watched_year y
          from public.viewing_record r
          where r.user_id = v_target and (v_is_owner or r.public_listed)) t
  )
  select jsonb_build_object(
    'user_id',      v_target,
    'year',         p_year,
    'is_owner',     v_is_owner,
    'cost_visible', v_cost_allowed,
    'years',        coalesce((select j from years), '[]'::jsonb),
    'totals',       jsonb_build_object(
                      'screenings',     (select screenings from totals),
                      'tickets',        (select tickets    from totals),
                      'total_cost',     (select total_cost from spend),
                      'priced_records', (select priced_records from spend)),
    'contribution', coalesce((select j from contribution), '[]'::jsonb),
    'heatmap',      coalesce((select j from heatmap),      '[]'::jsonb),
    'monthly',      coalesce((select j from monthly),      '[]'::jsonb),
    'venues',       coalesce((select j from venues),       '[]'::jsonb),
    'countries',    coalesce((select j from countries),    '[]'::jsonb),
    'versions',     coalesce((select j from versions),     '[]'::jsonb),
    'rewatch',      coalesce((select j from rewatch),      '[]'::jsonb)
  ) into v_out;

  return v_out;
end $$;

-- 電影頁：有哪些人看過這部片。走 viewing_record_film_public_idx。
create or replace function public.film_watchers(p_film_id text, p_limit int default 30)
returns table (user_id uuid, username text, display_name text, avatar_url text,
               watch_count int, last_watched_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.username, p.display_name, p.avatar_url, t.c::int, t.last_at
  from (
    select r.user_id uid, count(*) c, max(r.watched_at) last_at
    from public.viewing_record r
    where r.film_id = p_film_id and r.public_listed
    group by r.user_id
    order by 3 desc
    limit greatest(1, least(p_limit, 100))
  ) t
  join public.profiles p on p.id = t.uid and p.suspended_at is null
  order by t.last_at desc
$$;

grant execute on function public.resolve_username(text)     to anon, authenticated;
grant execute on function public.user_year_stats(text, int) to anon, authenticated;
grant execute on function public.film_watchers(text, int)   to anon, authenticated;
grant execute on function public.tw_local(timestamptz)      to anon, authenticated;

revoke execute on all functions in schema private from public, anon, authenticated;
```

## 設計理由

檔案位置：`/private/tmp/claude-501/-Users-david-Documents-Github-log/942964bf-1e2d-4766-a3d3-9ed624fa14bb/scratchpad/schema.sql`

## 1. 時區：為什麼是 generated column，而且是 `INTERVAL` 不是 `'Asia/Taipei'`

「星期幾」與「幾點」必須是台灣本地時間，這在 Postgres 有一個會擋住整個設計的細節：

| 運算式 | volatility | 能否用於 generated column / 索引 |
|---|---|---|
| `timestamptz AT TIME ZONE 'Asia/Taipei'`（`timestamptz_zone`） | **STABLE** | ✗ |
| `timestamptz AT TIME ZONE INTERVAL '8 hours'`（`timestamptz_izone`） | **IMMUTABLE** | ✓ |
| `extract(dow FROM timestamptz)` | **STABLE**（吃 TimeZone GUC） | ✗ |
| `extract(dow FROM timestamp)` | IMMUTABLE | ✓ |

具名時區是 STABLE，因為 IANA tzdata 會改版。所以分桶欄位必須寫成「先用固定 interval 轉成 `timestamp`（without tz），再 extract」。台灣自 1980 年起固定 UTC+8、無 DST，兩者語意等價；而且用固定位移還有一個好處：即使日後 tzdata 變動，既有資料的分桶結果也不會漂移。

**為什麼是 generated column 而不是 expression index**：統計要「group by 這個值**並且把它讀出來**」。只有欄位化才能被 `INCLUDE` 進覆蓋索引做 index-only scan；expression index 只能在 WHERE 端用上，聚合仍要回 heap。

注意 Postgres 不允許 generated column 引用另一個 generated column，所以那段運算式在五個欄位裡重複書寫（不能先做 `watched_local` 再衍生）。

## 2. 一條索引服務七張圖

```
viewing_record_user_year_idx
  (user_id, watched_year desc, watched_date)
  INCLUDE (id, watched_dow, watched_hour, watched_month, tickets, film_id, venue_id, version)
```

| 查詢 | 走法 |
|---|---|
| 年度貢獻圖 | `(user_id, watched_year)` 定值後 `watched_date` 已排序 → **GroupAggregate，無 Sort 節點** |
| 星期×時段熱力圖 | dow/hour 在 INCLUDE 裡 → index-only scan + HashAggregate |
| 月度趨勢 | 同上，watched_month |
| 影城分布 | venue_id 在 INCLUDE 裡 |
| 版本分布 | version 在 INCLUDE 裡 |
| 國別分布 | 取 film_id 後對 film PK 做 nested loop（約 200 次 PK lookup，~0.1ms） |
| 年度總場次／總票數 | count(*) + sum(tickets)，全在索引內 |
| 年份切換清單 | `distinct watched_year`，索引前綴掃描 |

配套：`alter table ... autovacuum_vacuum_insert_scale_factor = 0.02`。index-only scan 需要 visibility map 是新鮮的，否則會退化成大量 heap fetch，覆蓋索引就白做了。這條容易被漏掉。

其餘索引各自對應一個查詢，SQL 內每條上方都有註明。

## 3. 為什麼**不**用 materialized view 做個人統計

先算數量級：重度使用者一年約 100–300 筆，二十年也只有數千列。走上面的覆蓋索引是 index-only scan，微秒級。MV 只會換來刷新成本、過時資料，以及一個**沒有 RLS 的表**。

會建 MV 的只有掃描量隨「全站」成長的跨使用者聚合：`film_watch_stats`、`venue_watch_stats`。

**MV 的關鍵陷阱**：Postgres 沒有 `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY`。MV 完全無法套 RLS，直接暴露給 `anon` 就是全表外洩。這裡的處理是：MV 一律建在**不掛進 PostgREST db-schemas 的 `private` schema**，且來源只取 `public_listed` 的列 —— 讓「只含公開資料」成為**建構上的事實，而不是某條 policy 的承諾**。對外只暴露 `public.film_stats` / `public.venue_stats` 兩個 view。刷新用 `REFRESH ... CONCURRENTLY`（需唯一索引，不阻塞讀者），pg_cron 每 10 分鐘。

## 4. RLS 會不會讓聚合查詢走不了索引？會，如果犯這三個錯

**(a) `auth.uid()` 必須包成 `(select auth.uid())`。** 它是 STABLE，直接寫會**逐列求值** —— 幾百列的年度查詢就是幾百次 `request.jwt.claims` 的 JSON 解析。包成純量子查詢後 planner 會提成 InitPlan，只求值一次。同樣適用於 `is_admin()` / `is_active_user()`，SQL 裡全部寫成 `(select public.is_admin())`。

**(b) policy 述詞只能用「同一列的欄位」，不能用跨表 EXISTS。** 這是本設計兩個反正規化欄位的唯一存在理由：

- `viewing_record.film_public` — `film.visibility` 的鏡射。若把「作品是否公開」寫成 policy 裡的 `EXISTS (select 1 from film ...)`，會逐列求值且無法與部分索引述詞比對，公開時間軸直接退化成 seq scan。
- `viewing_record.public_listed` — `visibility = 'public' AND film_public` 的 stored generated column。**RLS 述詞與部分索引述詞用的是同一個欄位**，planner 才能證明 policy 在 `WHERE public_listed` 的部分索引上恆真，不必逐列複驗。
- `viewing_record_cost.cost_public` — 同理，`紀錄公開 AND 作者 show_cost` 的鏡射。

回填的代價是有界的：作品審核通過只更新該片的紀錄；切換 `show_cost` 只更新自己的票價列。

**(c) 每條 policy 都指定 `TO` 角色**，避免 `anon` 也去跑只對 `authenticated` 有意義的分支。

## 5. 票價為什麼獨立成一張表

這是本設計最不直覺、但我認為唯一站得住的一步。隱私模型 #2 要求「關閉時該欄位不得出現在**任何**公開回應中」。Postgres 能給的工具只有兩個，兩個都不夠：

- **RLS 只能做「列」層過濾**，沒有條件式的欄遮罩。
- **欄位層 GRANT 是「角色」層**，無法表達「本人**或** show_cost 才看得到」。而且一旦 `revoke select (cost)`，PostgREST 預設的 `select=*` 會直接 permission denied ——「用欄位權限遮票價」這條路在 Supabase 上根本走不通。

把票價變成一個**列**，RLS 就管得到了。`viewing_record_cost` 的 `user_id` 靠與 `viewing_record(id, user_id)` 的**複合 FK** 宣告式保證一致（零 trigger），`cost_public` 由 trigger 維護。於是「票價不外洩」是結構性保證，而不是某支 API 忘了遮的風險。

代價是一次 join，但年度總花費走 `viewing_record_cost (user_id) INCLUDE (record_id, amount)` 仍是 index-only scan，且對 ≤300 列的 hash join 成本可忽略。前端讀自己的票價用 PostgREST embedding 即可：`viewing_record?select=*,viewing_record_cost(amount)`。

**額外把關**：SECURITY DEFINER 函式內 RLS 不生效（definer 是表的擁有者），所以 `user_year_stats` 內以 `v_cost_allowed` 明確把關 —— 非本人且未開 `show_cost` 時，連**聚合後的總花費**都回 NULL，不只是逐筆欄位。

## 6. 一支 RPC 而不是七支查詢

七支 PostgREST 查詢 = 七次索引掃描 + 七次 RLS 求值 + 七次網路往返（Vercel → Supabase）。`user_year_stats()` 用 `WITH scoped AS MATERIALIZED` 把那一年的列掃**一次**，餵給七個聚合，回一包 jsonb。熱力圖還在 SQL 端補齊 7×24 完整矩陣，前端不必補格。

## 7. 沿用匯入管線的既有決策

- `film.id` 用 **text 確定性主鍵**（`tmdb:<id>` / `gov:<zh>:<orig>`）而非代理 uuid —— 讓匯入可重跑 upsert 而不產生重複列。
- `film.tmdb_id` **可為 NULL**（plain UNIQUE 允許多個 NULL，正是需要的行為）。
- `certificate.id` 用「年度:字號:正規化片名」，`permit_no` 只建**非唯一**索引（110–112 年撞號 128/143/157 筆）。
- `venue.id` 為統一編號或 `virtual:<kind>`，用 CHECK 約束綁定 id 形狀與 kind。
- 多刷排行以 `film_id` 分組（不是 title），兩層模型的統計正確性才成立。

## 8. 法遵欄位一併建好

`takedown_notice` / `counter_notice` / `copyright_strike` 三表 + `profiles.strike_count/suspended_at` + 三振 trigger。`takedown_notice_due_idx` 服務「回復通知後 10/14 個工作日」的到期掃描。這些是 SPEC 明示「事後無法回溯適用」的，所以放進第一版而不是留待日後。停權效果透過 `is_active_user()` 綁在所有寫入 policy 的 WITH CHECK 上。

## 自陳風險

- **這份 SQL 未在真實 Postgres 上執行過** —— 本機無 psql/docker 可驗。已做括號與 dollar-quote 平衡檢查，但語法與 volatility 假設（尤其 `timestamptz_izone` 為 IMMUTABLE、generated column 可用 `extract`）必須先在 Supabase 分支專案跑一次 `supabase db reset` 確認。若 `AT TIME ZONE INTERVAL` 在該版本被拒，退路是建一支謊稱 IMMUTABLE 的包裝函式（不安全）或改由應用層寫入 `watched_local`。
- 固定 UTC+8 假設台灣永不恢復日光節約時間。若恢復，所有 generated column 必須重算並重建全部索引（`ALTER TABLE ... DROP/ADD COLUMN`，熱表會鎖表）。
- 海外觀影的「星期幾／幾點」會以台北牆上時間計算，不是當地時間。使用者在東京看晚場 21:00 會被記成台北 20:00。若日後要修，需在 venue 或 record 上加時區欄位，且分桶欄位不能再是 generated（會變 STABLE）。
- 三個鏡射欄位（`film_public`、`public_listed`、`cost_public`）靠 trigger 維護。任何繞過 trigger 的批次寫入 —— `COPY`、`ALTER TABLE ... DISABLE TRIGGER`、seed 腳本用 service_role 直灌 —— 都會讓 RLS 述詞與事實脫節，且**失敗方向是外洩**（`film_public` 預設 true）。需要一支定期對帳查詢，並在 seed 腳本後強制重算。
- `viewing_record_user_year_idx` 的 INCLUDE 承載約 60 bytes/列，全站 100 萬筆約 90MB。且 INCLUDE 欄位一旦要增減就得重建整條索引。若統計面板要加新維度（如影廳、票種），這條索引會持續肥大。
- MV 每 10 分鐘 `REFRESH CONCURRENTLY` 會全表掃 `public_listed` 的列。資料量成長到數百萬列後，這個成本會超過 Supabase 免費專案的合理負載，屆時要改成 trigger 維護的增量計數表。Supabase 免費專案閒置暫停期間 pg_cron 不會執行，恢復後 MV 會是舊的。
- `private` schema 是安全邊界，但它只是「沒被加進 PostgREST 的 db-schemas」。任何人（或未來的自己）把 `private` 加進設定，兩個沒有 RLS 的 MV 就全部外洩。這個約束只存在於 Supabase 專案設定，不在 schema 裡，沒有任何 SQL 層的防護。
- `public.film_stats` / `public.venue_stats` 是 security-definer view（PG15 預設 `security_invoker = false`），Supabase 的 security advisor 會告警。此處是刻意的（來源已保證全公開），但它會混在真正的告警裡被忽略。
- SECURITY DEFINER RPC 內 RLS 完全不生效，票價把關全靠 `user_year_stats` 內的 `v_cost_allowed`。**任何日後新增的 RPC 都必須重做這道把關**，schema 本身無法強制。這是整份設計裡最脆弱的一環。
- `user_year_stats` 的 `(v_is_owner or r.public_listed)` 在 plpgsql 是參數化條件。若 plan cache 選了 generic plan，planner 可能拿不到 `viewing_record_user_public_idx` 這條部分索引，退回較差的計畫。必要時需拆成兩支函式，或設 `plan_cache_mode = force_custom_plan`。
- `profiles` 全站可讀 → username、display_name、avatar_url 可被完整枚舉。這是公開個人頁的必然代價，但沒有速率限制。
- `takedown_notice` 允許 `anon` insert 且無速率限制與 CAPTCHA，會被灌垃圾。法遵要求「公告接收侵權通知的窗口」，但沒要求是資料庫直寫；改走 Edge Function + 驗證會更穩妥。
- 多刷排行以 `film_id` 分組。管理者合併重複作品後，使用者的歷史統計會改變（技術上正確，但「我去年的多刷排行怎麼變了」是真實的使用者困惑）。`merged_into` 只記錄關係，沒有做紀錄的自動 repoint —— 合併流程仍需一支獨立的 migration 腳本。
- TMDB 「快取 ≤ 6 個月」只準備了 `tmdb_synced_at` 欄位與 `film_tmdb_stale_idx`，實際的刷新／清除排程未實作。條款遵循靠的是那支還不存在的 job。
- `user_year_stats` 的 `years` CTE 會對 `viewing_record` 做第二次掃描（取全部年份而非單年）。年份清單其實可以快取在 profiles 上，目前為求簡單沒做。
