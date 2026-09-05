# schema-evolution-first

## SQL

```sql
-- ============================================================================
-- 影記 / filmnote — Supabase schema（RLS 安全性優先）
-- 目標：任何「應用層忘記過濾」的情境都不得造成外洩。
-- 執行順序：本檔為單一 migration，可自上而下一次跑完。
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. 擴充套件與 schema
-- ---------------------------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm  with schema extensions;

-- app schema 存放「絕不能被 PostgREST 曝露」的東西：管理員名單、稽核軌跡、
-- 以及 RLS policy 用的 helper。PostgREST 預設只曝露 public schema，
-- 因此放進 app 的表格連 URL 都不存在。
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;
-- 注意：usage on schema 只讓 policy 內的函式呼叫得以解析，
-- 個別物件的權限一律預設拒絕，下方逐一 grant。

-- ---------------------------------------------------------------------------
-- 0.1 讓「忘記寫 policy」變成 fail-closed
-- Supabase 專案預設對 public schema 的新表格 grant all 給 anon/authenticated。
-- 那會讓「建了表但忘記 enable RLS」直接等於全站可讀寫。
-- 這裡把預設權限收回，往後每張表都必須顯式 grant。
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema app    revoke all on tables    from anon, authenticated;
alter default privileges in schema app    revoke all on functions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. 列舉型別
-- ---------------------------------------------------------------------------
create type public.venue_kind        as enum ('cinema', 'streaming', 'festival', 'home', 'other');
create type public.film_source       as enum ('tmdb', 'gov', 'ugc');
create type public.poster_source     as enum ('tmdb', 'ugc', 'none');
create type public.visibility        as enum ('public', 'private');
create type public.moderation_status as enum ('pending', 'approved', 'rejected');
create type public.account_status    as enum ('active', 'suspended', 'deleted');
create type public.content_kind      as enum ('film', 'viewing_record', 'poster');
create type public.notice_status     as enum ('received', 'taken_down', 'rejected', 'counter_received', 'restored');


-- ===========================================================================
-- 2. 表格
-- ===========================================================================

-- 2.1 管理員名單 —— 放在 app schema，PostgREST 看不到，
--     且**完全沒有任何 policy 與 grant**：只有 service_role（bypassrls）
--     能寫。任何「使用者自行提權」的路徑在此被物理阻斷。
--     ⚠️ 絕對不要改用 JWT 的 user_metadata 判斷管理員：
--        raw_user_meta_data 可被使用者以 supabase.auth.updateUser() 自行改寫。
create table app.admin_user (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  uuid references auth.users (id),
  revoked_at  timestamptz
);

-- 2.2 稽核軌跡（管理動作全紀錄，僅 service_role 可讀寫）
create table app.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null,
  target_kind text,
  target_id   text,
  detail      jsonb not null default '{}'::jsonb
);
create index audit_log_at_idx     on app.audit_log (at desc);
create index audit_log_target_idx on app.audit_log (target_kind, target_id);

-- 2.3 保留字（使用者名稱不得佔用路由）
create table app.reserved_username (
  name text primary key
);
insert into app.reserved_username (name) values
  ('u'),('api'),('admin'),('administrator'),('root'),('support'),('help'),
  ('login'),('logout'),('signup'),('signin'),('auth'),('callback'),('settings'),
  ('account'),('me'),('about'),('terms'),('privacy'),('copyright'),('dmca'),
  ('legal'),('contact'),('film'),('films'),('movie'),('movies'),('venue'),
  ('venues'),('cinema'),('cinemas'),('search'),('explore'),('stats'),('export'),
  ('import'),('static'),('assets'),('public'),('_nuxt'),('_ipx'),('sitemap'),
  ('robots'),('rss'),('feed'),('oauth'),('webhook'),('null'),('undefined'),
  ('filmnote'),('影記')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 2.4 profile —— 只放「本來就公開」的欄位。
--     刻意不含 email、不含 strike 次數、不含任何私密設定。
--     這樣即使 SELECT policy 寫錯，外洩的也只是本來就要公開的東西。
--     ⚠️ 沒有 username 欄位 —— 見 2.6 username_claim 的說明。
-- ---------------------------------------------------------------------------
create table public.profile (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 40),
  avatar_url   text check (avatar_url is null or avatar_url ~ '^https://'),
  -- 票價是否公開。預設 false —— 使用者故事 29 要求「沒察覺的情況下不會被看到」。
  show_cost    boolean not null default false,
  status       public.account_status not null default 'active',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 2.5 profile_private —— 只有本人與管理員看得到。三振紀錄、刪除排程等。
create table public.profile_private (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  strike_count         smallint not null default 0 check (strike_count >= 0),
  last_strike_at       timestamptz,
  suspended_reason     text,
  deletion_requested_at timestamptz,
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2.6 username_claim —— 使用者名稱的**唯一權威**（現用名與歷史名同一張表）
--
-- 為什麼不照 SPEC 那樣拆成 profile.username + username_history 兩處？
--   ① 兩處各自 unique，就無法在資料庫層阻止「A 改名後，B 註冊了 A 的舊名」，
--      造成 301 迴圈或身分劫持。合一之後，單一個 PRIMARY KEY 就是全域唯一。
--   ② 兩處等於兩個真相來源，改名交易一旦部分失敗就會漂移。
--
-- 隱私關鍵：`is_current = false` 的列**不對任何人公開**（見 policy）。
-- 預設使用者名稱取自 email 的 @ 前綴，若舊名可被任意查詢／列舉，
-- 等同公開全站使用者的 email local part，且能把「改名前的人」與
-- 「改名後的人」對應起來。轉向只能經由 resolve_username() 單向查詢。
-- ---------------------------------------------------------------------------
create table public.username_claim (
  name                text primary key
                      check (name ~ '^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$'),
  user_id             uuid not null references public.profile (id) on delete cascade,
  is_current          boolean not null default true,
  claimed_at          timestamptz not null default now(),
  released_at         timestamptz,
  -- 使用者可自行關閉轉向。功能面（US-25 舊連結不失效）與隱私面
  -- （不想讓人把舊名連到新名）本質衝突，因此把開關交給使用者。
  redirect_enabled    boolean not null default true,
  -- 轉向有期限：過期後舊名釋出，關聯自然消滅。
  redirect_expires_at timestamptz,
  constraint username_claim_current_shape
    check ((is_current and released_at is null)
        or ((not is_current) and released_at is not null))
);
-- 一人只能有一個現用名
create unique index username_claim_one_current
  on public.username_claim (user_id) where is_current;
create index username_claim_user_idx on public.username_claim (user_id);

-- 2.7 venue（觀影場所；含 virtual:* 的非影城選項）
create table public.venue (
  id           text primary key,     -- 統一編號，或 'virtual:streaming' 等
  kind         public.venue_kind not null,
  name         text not null,
  company_name text,
  hall_count   integer check (hall_count is null or hall_count >= 0),
  address      text,
  phone        text,
  city         text,
  lat          double precision,
  lng          double precision,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2.8 film —— 作品。TMDB／政府／UGC 三種來源共用一張表。
-- ---------------------------------------------------------------------------
create table public.film (
  id                uuid primary key default gen_random_uuid(),
  -- 匯入管線的確定性鍵（'tmdb:<id>' / 'gov:<zh>:<orig>' / 'ugc:<uuid>'）。
  -- ⚠️ 不能拿它當 PK：它是可猜測的字串，會讓 FK 探測變成「私有作品存在與否」
  --    的 oracle。PK 一律用不可猜測的 UUID。
  source_key        text not null unique,
  tmdb_id           integer unique,
  imdb_id           text,
  title_zh          text not null default '' check (char_length(title_zh)   <= 200),
  title_orig        text not null default '' check (char_length(title_orig) <= 300),
  country           text,
  runtime_minutes   integer check (runtime_minutes is null or runtime_minutes between 1 and 1200),
  release_year      integer check (release_year is null or release_year between 1880 and 2100),
  poster_source     public.poster_source not null default 'none',
  -- tmdb 時為 image.tmdb.org 的 path；ugc 時為 Storage 物件路徑。一律不自行轉存 TMDB 圖檔。
  poster_path       text,
  source            public.film_source not null,
  visibility        public.visibility not null default 'private',
  moderation_status public.moderation_status not null default 'pending',
  merged_into       uuid references public.film (id) on delete set null,
  taken_down_at     timestamptz,
  takedown_notice_id uuid,
  created_by        uuid references auth.users (id) on delete set null,
  tmdb_synced_at    timestamptz,     -- TMDB 快取 ≤ 6 個月的刷新依據
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- 結構性不變式：「公開但未審核」在這張表裡是無法表示的狀態。
  -- 即使日後某支 service_role 腳本寫錯，也造不出未審核卻公開的作品。
  constraint film_public_requires_approval
    check (visibility = 'private' or moderation_status = 'approved'),
  -- UGC 作品在被系統比對到 TMDB 之前不得自帶 tmdb_id
  constraint film_ugc_poster_rule
    check (poster_source <> 'ugc' or (source = 'ugc' and tmdb_id is null)),
  constraint film_no_self_merge check (merged_into is null or merged_into <> id)
);

-- 2.9 certificate（政府核准紀錄，多對一 → film）
create table public.certificate (
  id              text primary key,        -- 「年度:字號:正規化片名」
  permit_no       text not null,           -- 分級證明字號，跨年度不唯一，僅屬性
  film_id         uuid references public.film (id) on delete set null,
  roc_year        integer not null,
  gregorian_year  integer not null,
  rating          text,
  title_zh        text,
  title_orig      text,
  country         text,
  language        text,
  producer        text,
  runtime_minutes integer,
  version_note    text,
  defects         text[] not null default '{}',
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2.10 viewing_record —— 觀影紀錄。**刻意不含 cost 欄位。**
--
-- RLS 只能控制列、不能控制欄；而 cost 的可見性取決於「紀錄擁有者的
-- show_cost 設定」，是一個 per-row 的條件。既然如此，就把 cost 本身
-- 做成一列（見 2.11），把欄級問題轉換成 RLS 天生就能解的列級問題。
-- 這樣「忘記在 API 層 select 掉 cost」不再是一種可能的錯誤 ——
-- 因為 SELECT * FROM viewing_record 裡根本沒有 cost。
-- ---------------------------------------------------------------------------
create table public.viewing_record (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  film_id       uuid not null references public.film (id) on delete restrict,
  venue_id      text not null references public.venue (id) on delete restrict,
  -- 下界可用 CHECK（常數）；上界「不得晚於現在」必須放在觸發器裡，
  -- 因為 CHECK 只接受 IMMUTABLE 運算式，now() 是 STABLE。
  watched_at    timestamptz not null check (watched_at > timestamptz '1895-12-28'),
  tickets       smallint check (tickets is null or tickets between 1 and 50),
  hall          text  check (hall    is null or char_length(hall)    <= 60),
  version       text  check (version is null or char_length(version) <= 40),
  memo          text  check (memo    is null or char_length(memo)    <= 2000),
  visibility    public.visibility not null default 'public',
  taken_down_at timestamptz,
  takedown_notice_id uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- 供 viewing_record_cost 以複合外鍵綁定，杜絕 user_id 漂移
  unique (id, user_id)
);

-- ---------------------------------------------------------------------------
-- 2.11 viewing_record_cost —— 票價。獨立表格，獨立 RLS。
--
-- user_id 為反正規化，讓 policy 判斷「是不是本人」時不必 join；
-- 但以複合外鍵 (record_id, user_id) 綁回 viewing_record(id, user_id)，
-- 使兩者不可能不一致。
-- ---------------------------------------------------------------------------
create table public.viewing_record_cost (
  record_id  uuid primary key,
  user_id    uuid not null,
  cost       numeric(10, 2) not null check (cost >= 0 and cost <= 1000000),
  currency   char(3) not null default 'TWD' check (currency ~ '^[A-Z]{3}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint viewing_record_cost_owner_fk
    foreign key (record_id, user_id)
    references public.viewing_record (id, user_id) on delete cascade
);

-- 2.12 三振紀錄（著作權法 §90-4 第 2 款）
create table public.strike (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  reason     text not null,
  notice_id  uuid,
  issued_at  timestamptz not null default now(),
  -- 回復通知成立時撤銷該次三振
  voided_at  timestamptz,
  voided_reason text
);
create index strike_user_idx on public.strike (user_id) where voided_at is null;

-- 2.13 侵權通知（§90-4 第 3、4 款）—— 只能寫、不能讀的信箱表
create table public.dmca_notice (
  id             uuid primary key default gen_random_uuid(),
  received_at    timestamptz not null default now(),
  status         public.notice_status not null default 'received',
  -- 通知人資訊（依 §90-6 及施行辦法應載明事項）
  claimant_name  text not null check (char_length(claimant_name)  between 1 and 200),
  claimant_email text not null check (claimant_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  claimant_phone text,
  claimant_addr  text,
  work_desc      text not null check (char_length(work_desc) between 1 and 5000),
  target_urls    text[] not null check (cardinality(target_urls) between 1 and 50),
  good_faith     boolean not null,
  accuracy_oath  boolean not null,
  signature      text not null,
  -- 處理欄位（管理端寫入）
  target_kind    public.content_kind,
  target_id      text,
  handled_at     timestamptz,
  handled_by     uuid references auth.users (id),
  handler_note   text,
  constraint dmca_notice_oaths check (good_faith and accuracy_oath)
);
create index dmca_notice_open_idx on public.dmca_notice (received_at)
  where status = 'received';

-- 2.14 回復通知（§90-9）
create table public.dmca_counter_notice (
  id                 uuid primary key default gen_random_uuid(),
  notice_id          uuid not null references public.dmca_notice (id) on delete cascade,
  user_id            uuid not null references auth.users (id) on delete cascade,
  received_at        timestamptz not null default now(),
  statement          text not null check (char_length(statement) between 1 and 5000),
  -- 著作權人 10 個工作日內未提訴訟證明 → 須於 14 個工作日內回復
  forward_deadline   date,     -- 轉送著作權人 + 10 工作日
  restore_deadline   date,     -- 上者 + 14 工作日
  litigation_proof_at timestamptz,
  restored_at        timestamptz
);
create index dmca_counter_user_idx on public.dmca_counter_notice (user_id);

-- 2.15 資料回報（US-49／50：片名、影城有誤或歇業）
create table public.data_report (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid references auth.users (id) on delete set null,
  target_kind  public.content_kind not null,
  target_id    text not null,
  message      text not null check (char_length(message) between 1 and 2000),
  status       text not null default 'open' check (status in ('open','accepted','rejected')),
  created_at   timestamptz not null default now(),
  handled_at   timestamptz,
  handled_by   uuid references auth.users (id)
);
create index data_report_open_idx on public.data_report (created_at) where status = 'open';
create index data_report_reporter_idx on public.data_report (reporter_id);

-- 補上 film / viewing_record 對通知的外鍵（此時 dmca_notice 已存在）
alter table public.film
  add constraint film_takedown_notice_fk
  foreign key (takedown_notice_id) references public.dmca_notice (id) on delete set null;
alter table public.viewing_record
  add constraint viewing_record_takedown_notice_fk
  foreign key (takedown_notice_id) references public.dmca_notice (id) on delete set null;
alter table public.strike
  add constraint strike_notice_fk
  foreign key (notice_id) references public.dmca_notice (id) on delete set null;

-- ===========================================================================
-- 3. Policy 用的 helper 函式
--
-- 全部 `security definer` + `set search_path = ''` + 完整限定名稱。
-- ⚠️ 少了 `set search_path`，使用者只要在自己有建立權限的 schema 裡放一個
--    同名函式／運算子，就能在 definer（postgres）的權限下執行任意程式碼。
--    這是 SECURITY DEFINER 最常見的提權漏洞。
-- 用 definer 而非 invoker 的理由：讓「cost 可見與否」的判斷不依賴
--    profile / viewing_record 自己的 SELECT policy。日後任何人調整那些
--    policy，都不會意外改變票價的可見範圍。
-- ===========================================================================

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from app.admin_user a
    where a.user_id = (select auth.uid())
      and a.revoked_at is null
  )
$$;
comment on function app.is_admin() is
  '管理員判定。來源為 app.admin_user（無任何 policy，只有 service_role 可寫）。'
  '嚴禁改用 JWT 的 user_metadata：該欄位可被使用者自行改寫。';

create or replace function app.profile_is_active(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profile p
    where p.id = p_user and p.status = 'active'::public.account_status
  )
$$;

-- 票價可見性的單一判準。所有票價相關的 policy 只呼叫這一支，
-- 規則因此只有一個地方需要被審計。
create or replace function app.cost_visible_to_caller(p_record_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.viewing_record r
    join public.profile p on p.id = r.user_id
    where r.id = p_record_id
      and r.visibility    = 'public'::public.visibility   -- 私密紀錄的票價永不公開
      and r.taken_down_at is null                          -- 已取下者不公開
      and p.status        = 'active'::public.account_status
      and p.show_cost     is true                          -- 擁有者主動開啟
  )
$$;

-- 建立觀影紀錄時，引用的作品必須是「公開已審核」或「自己建的」。
create or replace function app.film_usable_by(p_film uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.film f
    where f.id = p_film
      and f.taken_down_at is null
      and (
        (f.visibility = 'public'::public.visibility
         and f.moderation_status = 'approved'::public.moderation_status)
        or f.created_by = p_user
      )
  )
$$;

-- 使用者名稱是否可用：同時檢查現用名、尚未過期的歷史名、保留字。
create or replace function app.username_available(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_name ~ '^[a-z0-9][a-z0-9_-]{1,28}[a-z0-9]$'
     and not exists (select 1 from app.reserved_username r where r.name = p_name)
     and not exists (
       select 1 from public.username_claim c
       where c.name = p_name
         and (c.is_current
              or c.redirect_expires_at is null
              or c.redirect_expires_at > now())
     )
$$;

-- 由 email 前綴產生預設使用者名稱。
-- ⚠️ 這是 SPEC 要求的行為，但它本身就是一種 email local part 的揭露。
--    因此：只取 @ 前的部分、剝除 +tag、非法字元轉 '-'、太短補隨機、
--    撞名時加隨機尾碼（不使用流水號，避免 alice-2 暗示 alice 的存在）。
create or replace function app.default_username(p_email text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_base      text;
  v_candidate text;
begin
  v_base := lower(coalesce(split_part(coalesce(p_email, ''), '@', 1), ''));
  v_base := split_part(v_base, '+', 1);
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := regexp_replace(v_base, '(^-+)|(-+$)', '', 'g');
  v_base := left(v_base, 20);

  if char_length(v_base) < 3 then
    v_base := 'user';
  end if;

  if app.username_available(v_base) then
    return v_base;
  end if;

  for i in 1 .. 12 loop
    v_candidate := left(v_base, 22) || '-' ||
                   lower(encode(extensions.gen_random_bytes(3), 'hex'));
    if app.username_available(v_candidate) then
      return v_candidate;
    end if;
  end loop;

  return 'user-' || lower(encode(extensions.gen_random_bytes(6), 'hex'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 3.1 舊使用者名稱轉向 —— 唯一對外的解析入口。
-- 只接受「舊名 → 現用名」的單向查詢，且不回傳 user_id。
-- 沒有列舉、沒有反查（給現用名查不出曾用名）、被停權或刪除者不轉向。
-- ---------------------------------------------------------------------------
create or replace function public.resolve_username(p_old_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select cur.name
  from public.username_claim old
  join public.username_claim cur
    on cur.user_id = old.user_id and cur.is_current
  join public.profile p on p.id = old.user_id
  where old.name = lower(p_old_name)
    and old.is_current is false
    and old.redirect_enabled is true
    and (old.redirect_expires_at is null or old.redirect_expires_at > now())
    and p.status = 'active'::public.account_status
  limit 1
$$;
comment on function public.resolve_username(text) is
  '舊 /u/{username} 的 301 目標。刻意不回傳 user_id，避免把舊名與帳號 ID 綁定。';

-- ===========================================================================
-- 4. 觸發器 —— RLS 表達不了的規則
--
-- RLS 的 WITH CHECK 只看得到 NEW，看不到 OLD，因此無法表達
-- 「這個欄位不准被改動」。BEFORE 觸發器看得到 OLD，補上這一塊。
-- 三層防禦：欄位級 GRANT（擋 PostgREST）→ RLS WITH CHECK（擋列的最終狀態）
--          → 觸發器（擋欄位的變動）。任一層失效，其餘兩層仍成立。
-- ===========================================================================

create or replace function app.is_service_context()
returns boolean
language sql
stable
set search_path = ''
as $$
  select current_user in
    ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin')
$$;

create or replace function app.tg_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4.1 新使用者：建立 profile / profile_private / 預設使用者名稱
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  insert into public.profile (id) values (new.id) on conflict do nothing;
  insert into public.profile_private (user_id) values (new.id) on conflict do nothing;

  v_name := app.default_username(new.email);
  begin
    insert into public.username_claim (name, user_id, is_current)
    values (v_name, new.id, true);
  exception when unique_violation then
    insert into public.username_claim (name, user_id, is_current)
    values ('user-' || lower(encode(extensions.gen_random_bytes(6), 'hex')), new.id, true);
  end;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------------------
-- 4.2 profile：禁止本人改動 status
--     （否則被三振停權者只要 PATCH status='active' 就復活了）
-- ---------------------------------------------------------------------------
create or replace function app.tg_profile_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_service_context() or app.is_admin() then
    return new;
  end if;
  if new.id <> old.id then
    raise exception 'profile.id 不可變更' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    raise exception 'profile.status 只能由管理端變更' using errcode = '42501';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'profile.created_at 不可變更' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profile_guard
  before update on public.profile
  for each row execute function app.tg_profile_guard();

create trigger profile_touch
  before update on public.profile
  for each row execute function app.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4.3 film：擋住 UGC 作品的自我提權
--     攻擊：使用者 PATCH 自己的 UGC 作品 → visibility='public',
--           moderation_status='approved'，把未審核資料塞進公共片庫。
-- ---------------------------------------------------------------------------
create or replace function app.tg_film_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_service_context() or app.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- 禁止自帶 tmdb_id：tmdb_id 有 UNIQUE 限制，允許使用者填寫等於給了一個
    -- 「這個 TMDB 作品在不在庫裡」的存在性 oracle（即使該列是私有的，
    -- 唯一鍵衝突仍會照樣回報），並可搶佔尚未匯入的 TMDB id。
    if new.tmdb_id is not null or new.imdb_id is not null then
      raise exception 'tmdb_id / imdb_id 由系統比對後填入' using errcode = '42501';
    end if;
    -- 其餘敏感欄位一律覆寫，不採信輸入。
    -- source_key 由系統產生：若讓使用者自填，他可以宣稱 'tmdb:550' 佔位，
    -- 讓日後正式匯入該片時撞上 UNIQUE 而失敗（供給側汙染）。
    new.created_by        := (select auth.uid());
    new.source            := 'ugc'::public.film_source;
    new.source_key        := 'ugc:' || gen_random_uuid()::text;
    new.visibility        := 'private'::public.visibility;
    new.moderation_status := 'pending'::public.moderation_status;
    new.merged_into       := null;
    new.taken_down_at     := null;
    new.takedown_notice_id := null;
    if new.created_by is null then
      raise exception '未登入' using errcode = '42501';
    end if;
    -- 配額：避免單一帳號灌爆免費方案的儲存與審核佇列
    if (select count(*) from public.film f
        where f.created_by = new.created_by
          and f.created_at > now() - interval '1 day') >= 50 then
      raise exception '今日新增作品已達上限' using errcode = '54000';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.id is distinct from old.id
     or new.source is distinct from old.source
     or new.source_key is distinct from old.source_key
     or new.created_by is distinct from old.created_by
     or new.visibility is distinct from old.visibility
     or new.moderation_status is distinct from old.moderation_status
     or new.tmdb_id is distinct from old.tmdb_id
     or new.imdb_id is distinct from old.imdb_id
     or new.merged_into is distinct from old.merged_into
     or new.taken_down_at is distinct from old.taken_down_at
     or new.takedown_notice_id is distinct from old.takedown_notice_id then
    raise exception '此欄位僅供管理端變更' using errcode = '42501';
  end if;
  -- 已比對到 TMDB 的作品禁止上傳海報（SPEC：無必要，只增加曝險）
  if new.poster_source = 'ugc'::public.poster_source and old.tmdb_id is not null then
    raise exception '已比對到 TMDB 的作品不得上傳海報' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger film_guard
  before insert or update on public.film
  for each row execute function app.tg_film_guard();

create trigger film_touch
  before update on public.film
  for each row execute function app.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4.4 viewing_record：擋住換主、擋住自行解除取下
-- ---------------------------------------------------------------------------
create or replace function app.tg_viewing_record_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_service_context() or app.is_admin() then
    return new;
  end if;

  if new.watched_at > now() + interval '2 days' then
    raise exception '觀影時間不可在未來' using errcode = '22007';
  end if;

  if tg_op = 'INSERT' then
    new.user_id            := (select auth.uid());
    new.taken_down_at      := null;
    new.takedown_notice_id := null;
    if new.user_id is null then
      raise exception '未登入' using errcode = '42501';
    end if;
    if not app.film_usable_by(new.film_id, new.user_id) then
      raise exception '引用的作品不存在或不可使用' using errcode = '42501';
    end if;
    if (select count(*) from public.viewing_record v
        where v.user_id = new.user_id
          and v.created_at > now() - interval '1 hour') >= 300 then
      raise exception '建立速率過快' using errcode = '54000';
    end if;
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.taken_down_at is distinct from old.taken_down_at
     or new.takedown_notice_id is distinct from old.takedown_notice_id then
    raise exception '此欄位僅供管理端變更' using errcode = '42501';
  end if;
  if new.film_id is distinct from old.film_id
     and not app.film_usable_by(new.film_id, old.user_id) then
    raise exception '引用的作品不存在或不可使用' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger viewing_record_guard
  before insert or update on public.viewing_record
  for each row execute function app.tg_viewing_record_guard();

create trigger viewing_record_touch
  before update on public.viewing_record
  for each row execute function app.tg_touch_updated_at();

create trigger viewing_record_cost_touch
  before update on public.viewing_record_cost
  for each row execute function app.tg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4.5 username_claim：使用者只能關閉自己的轉向，不能改名稱歸屬
-- ---------------------------------------------------------------------------
create or replace function app.tg_username_claim_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if app.is_service_context() or app.is_admin() then
    return new;
  end if;
  if new.name is distinct from old.name
     or new.user_id is distinct from old.user_id
     or new.is_current is distinct from old.is_current
     or new.claimed_at is distinct from old.claimed_at
     or new.released_at is distinct from old.released_at then
    raise exception '改名請使用 set_username()' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger username_claim_guard
  before update on public.username_claim
  for each row execute function app.tg_username_claim_guard();

-- ===========================================================================
-- 5. RLS
-- ===========================================================================
alter table public.profile             enable row level security;
alter table public.profile_private     enable row level security;
alter table public.username_claim      enable row level security;
alter table public.venue               enable row level security;
alter table public.film                enable row level security;
alter table public.certificate         enable row level security;
alter table public.viewing_record      enable row level security;
alter table public.viewing_record_cost enable row level security;
alter table public.strike              enable row level security;
alter table public.dmca_notice         enable row level security;
alter table public.dmca_counter_notice enable row level security;
alter table public.data_report         enable row level security;
-- app schema 的表格沒有任何 grant，開 RLS 只是為了「多一道」
alter table app.admin_user        enable row level security;
alter table app.audit_log         enable row level security;
alter table app.reserved_username enable row level security;

-- ---------------------------------------------------------------------------
-- 5.1 profile
-- ---------------------------------------------------------------------------
-- 擋住：讀取被停權（三振）或已刪除帳號的個人頁。
-- 停權者的內容必須立即停止公開，否則三振條款形同虛設。
create policy profile_select on public.profile
  for select to anon, authenticated
  using (
    status = 'active'::public.account_status
    or id = (select auth.uid())
    or app.is_admin()
  );

-- 擋住：改別人的設定。
-- 注意：本 policy 允許的欄位由下方欄位級 GRANT 再收斂一次
--       （status 沒有被 grant，PostgREST 連送都送不進來），
--       再加上 profile_guard 觸發器擋 OLD→NEW 的變動。
create policy profile_update_self on public.profile
  for update to authenticated
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 刻意「沒有」INSERT 與 DELETE policy：
--   INSERT 只由 auth.users 的觸發器建立 —— 使用者無法多開 profile 或指定 status。
--   DELETE 走 delete_my_account() —— 避免刪 profile 卻留下 auth.users 的孤兒狀態。

-- ---------------------------------------------------------------------------
-- 5.2 profile_private —— 只有本人與管理員
-- ---------------------------------------------------------------------------
-- 擋住：三振次數、停權理由、刪除排程被他人讀取。
-- 這些欄位放在獨立表格而非 profile，是為了讓 profile 的 SELECT policy
-- 可以放心地寫成「幾乎全公開」而不必逐欄擔心。
create policy profile_private_select on public.profile_private
  for select to authenticated
  using (user_id = (select auth.uid()) or app.is_admin());
-- 無任何寫入 policy：只有 service_role / SECURITY DEFINER 的管理函式能改。

-- ---------------------------------------------------------------------------
-- 5.3 username_claim
-- ---------------------------------------------------------------------------
-- 擋住：**歷史使用者名稱被列舉**。
-- 預設名取自 email 的 @ 前綴，若舊名可讀，等於公開全站的 email local part，
-- 並且可以把「改名前」與「改名後」的身分對應起來 —— 這正是使用者改名要
-- 擺脫的東西。歷史列只有本人與管理員看得到；訪客只能經 resolve_username()
-- 做單向查詢，無法反查、無法列舉。
create policy username_claim_select on public.username_claim
  for select to anon, authenticated
  using (
    (is_current and app.profile_is_active(user_id))
    or user_id = (select auth.uid())
    or app.is_admin()
  );

-- 擋住：改動名稱歸屬。使用者只被 grant 到 redirect_enabled 這一欄，
-- 另有 username_claim_guard 觸發器擋住其餘欄位。
create policy username_claim_update_self on public.username_claim
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- 允許使用者永久刪除自己的舊名（= 徹底切斷舊名與新名的關聯）。
-- 現用名不可刪，否則個人頁會失去入口。
create policy username_claim_delete_own_history on public.username_claim
  for delete to authenticated
  using (user_id = (select auth.uid()) and is_current is false);

-- ---------------------------------------------------------------------------
-- 5.4 venue / certificate —— 政府開放資料，全公開唯讀
-- ---------------------------------------------------------------------------
create policy venue_select on public.venue
  for select to anon, authenticated using (true);
create policy certificate_select on public.certificate
  for select to anon, authenticated using (true);
-- 無寫入 policy：只由匯入管線（service_role）維護。

-- ---------------------------------------------------------------------------
-- 5.5 film
-- ---------------------------------------------------------------------------
-- 擋住：① 讀到別人尚未審核的 UGC 作品（US-17）
--       ② 讀到已被著作權人通知取下的作品（§90-7 的「立即移除」）
create policy film_select on public.film
  for select to anon, authenticated
  using (
    (
      taken_down_at is null
      and visibility = 'public'::public.visibility
      and moderation_status = 'approved'::public.moderation_status
    )
    or created_by = (select auth.uid())
    or app.is_admin()
  );

-- 擋住：建立時直接指定 public / approved。
-- 三層都擋：欄位級 GRANT 不給 visibility、moderation_status；
--           觸發器強制覆寫成 private / pending；
--           這裡的 WITH CHECK 是最後一道 —— 即使前兩層被繞過，
--           寫進來的列若不是 private/pending 仍會被拒絕。
create policy film_insert_own_ugc on public.film
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and source = 'ugc'::public.film_source
    and visibility = 'private'::public.visibility
    and moderation_status = 'pending'::public.moderation_status
    and tmdb_id is null
    and taken_down_at is null
    and merged_into is null
  );

-- 擋住：① 修改別人的作品
--       ② 修改「已進入公共片庫」的作品（審核通過後即成為公共資料，
--          只能由管理端維護，否則一個使用者就能竄改全站看得到的片名）
--       ③ 藉由 UPDATE 把自己的作品升級成 public/approved
create policy film_update_own_pending on public.film
  for update to authenticated
  using (
    created_by = (select auth.uid())
    and moderation_status = 'pending'::public.moderation_status
    and taken_down_at is null
  )
  with check (
    created_by = (select auth.uid())
    and visibility = 'private'::public.visibility
    and moderation_status = 'pending'::public.moderation_status
    and tmdb_id is null
  );

create policy film_delete_own_pending on public.film
  for delete to authenticated
  using (
    created_by = (select auth.uid())
    and moderation_status <> 'approved'::public.moderation_status
    and taken_down_at is null
  );

-- ---------------------------------------------------------------------------
-- 5.6 viewing_record
-- ---------------------------------------------------------------------------
-- 擋住：① 讀到 visibility='private' 的紀錄（US-31）
--       ② 讀到停權／已刪除帳號的紀錄
--       ③ 讀到已取下的紀錄
create policy viewing_record_select on public.viewing_record
  for select to anon, authenticated
  using (
    (
      visibility = 'public'::public.visibility
      and taken_down_at is null
      and app.profile_is_active(user_id)
    )
    or user_id = (select auth.uid())
    or app.is_admin()
  );

create policy viewing_record_insert_own on public.viewing_record
  for insert to authenticated
  with check (user_id = (select auth.uid()) and taken_down_at is null);

-- 擋住：把已取下的紀錄改回可見（taken_down_at 亦未 grant，且有觸發器）
create policy viewing_record_update_own on public.viewing_record
  for update to authenticated
  using      (user_id = (select auth.uid()) and taken_down_at is null)
  with check (user_id = (select auth.uid()) and taken_down_at is null);

create policy viewing_record_delete_own on public.viewing_record
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5.7 viewing_record_cost —— 本設計的核心
--
-- RLS 是列級的，而票價的可見性是「每一列各自取決於擁有者的 show_cost」。
-- 把 cost 獨立成一列之後，這個條件就正好落在 RLS 的能力範圍內。
--
-- 這條 policy 擋住的攻擊：
--   ① 直接 GET /rest/v1/viewing_record_cost?select=* —— 只會拿到自己的，
--      加上「擁有者已開啟 show_cost 且紀錄為公開」的那些。
--   ② 巢狀查詢 GET /rest/v1/viewing_record?select=*,viewing_record_cost(*)
--      —— 巢狀資源同樣套用自己的 RLS，回傳 null。
--   ③ 應用層忘記把 cost 從回應中剔除 —— 不可能發生，因為
--      viewing_record 這張表裡根本沒有 cost 欄位。
--   ④ 開啟 show_cost 後又關閉 —— 判斷是查詢當下即時求值，沒有快取。
--   ⑤ 把私密紀錄的票價經由「開啟 show_cost」洩漏 —— 函式同時要求
--      r.visibility = 'public'。
-- ---------------------------------------------------------------------------
create policy viewing_record_cost_select on public.viewing_record_cost
  for select to anon, authenticated
  using (
    user_id = (select auth.uid())
    or app.cost_visible_to_caller(record_id)
  );

create policy viewing_record_cost_insert_own on public.viewing_record_cost
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy viewing_record_cost_update_own on public.viewing_record_cost
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy viewing_record_cost_delete_own on public.viewing_record_cost
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5.8 三振紀錄 —— 本人有知的權利（正當程序），他人不得讀
-- ---------------------------------------------------------------------------
create policy strike_select_own on public.strike
  for select to authenticated
  using (user_id = (select auth.uid()) or app.is_admin());

-- ---------------------------------------------------------------------------
-- 5.9 侵權通知 —— 只能寫、不能讀的信箱
-- 擋住：任何人讀取他人的侵權通知（含通知人的姓名、電話、地址、email）。
-- anon 也能提交，因為著作權人不一定是本站使用者（§90-6 的窗口義務）。
-- ---------------------------------------------------------------------------
create policy dmca_notice_insert_anyone on public.dmca_notice
  for insert to anon, authenticated
  with check (
    status = 'received'::public.notice_status
    and handled_at is null
    and handled_by is null
    and target_kind is null
    and target_id is null
  );

create policy dmca_notice_select_admin on public.dmca_notice
  for select to authenticated
  using (app.is_admin());

-- 回復通知：只有「內容被取下的那個人」能提
create policy dmca_counter_insert_own on public.dmca_counter_notice
  for insert to authenticated
  with check (user_id = (select auth.uid()) and restored_at is null);
create policy dmca_counter_select_own on public.dmca_counter_notice
  for select to authenticated
  using (user_id = (select auth.uid()) or app.is_admin());

-- ---------------------------------------------------------------------------
-- 5.10 資料回報
-- ---------------------------------------------------------------------------
create policy data_report_insert_own on public.data_report
  for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and status = 'open'
    and handled_at is null
  );
create policy data_report_select_own on public.data_report
  for select to authenticated
  using (reporter_id = (select auth.uid()) or app.is_admin());

-- ===========================================================================
-- 6. 檢視表
--
-- ⚠️ Postgres 的檢視表預設以**擁有者**權限執行，等於完全繞過 RLS。
--    在 public schema 建一個忘了加 security_invoker 的 view，
--    就是把整張底層表格經由 PostgREST 全站公開。
--    本專案所有 view 一律 `security_invoker = true`。
-- ===========================================================================

-- 6.1 個人頁的公開身分（profile + 現用使用者名稱）
create view public.profile_public
with (security_invoker = true, security_barrier = true) as
select
  p.id,
  c.name as username,
  p.display_name,
  p.avatar_url,
  p.show_cost,
  p.created_at
from public.profile p
join public.username_claim c on c.user_id = p.id and c.is_current;

-- 6.2 觀影紀錄的對外形狀。
--     cost 以 LEFT JOIN 帶出：讀者無權時 RLS 讓該列不存在，cost 自動為 NULL。
--     這是本設計「不可能忘記過濾」的具體體現 —— 前端拿到什麼，
--     完全由資料庫決定，Nitro 端不需要（也不應該）再寫任何條件。
create view public.viewing_record_public
with (security_invoker = true, security_barrier = true) as
select
  r.id,
  r.user_id,
  u.name as username,
  r.film_id,
  r.venue_id,
  r.watched_at,
  r.tickets,
  r.hall,
  r.version,
  r.memo,
  r.visibility,
  r.created_at,
  c.cost,
  c.currency
from public.viewing_record r
join public.username_claim u on u.user_id = r.user_id and u.is_current
left join public.viewing_record_cost c on c.record_id = r.id;

-- ===========================================================================
-- 7. RPC
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 7.1 改名。唯一能寫入 username_claim 的路徑。
-- ---------------------------------------------------------------------------
create or replace function public.set_username(p_name text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_name    text := lower(btrim(coalesce(p_name, '')));
  v_current text;
  v_renames int;
begin
  if v_user is null then
    raise exception '未登入' using errcode = '42501';
  end if;
  if not app.profile_is_active(v_user) then
    raise exception '帳號狀態不允許此操作' using errcode = '42501';
  end if;

  -- 鎖住自己的現用名，避免同一人並行改名產生兩個 is_current
  select c.name into v_current
  from public.username_claim c
  where c.user_id = v_user and c.is_current
  for update;

  if v_current = v_name then
    return v_name;
  end if;

  -- 改名次數限制：抑制以改名做名稱佔用／探測的行為
  select count(*) into v_renames
  from public.username_claim c
  where c.user_id = v_user and c.claimed_at > now() - interval '30 days';
  if v_renames >= 3 then
    raise exception '30 天內最多改名 3 次' using errcode = '54000';
  end if;

  if not app.username_available(v_name) then
    raise exception '此使用者名稱無法使用' using errcode = '23505';
  end if;

  update public.username_claim
     set is_current = false,
         released_at = now(),
         redirect_expires_at = now() + interval '180 days'
   where user_id = v_user and is_current;

  begin
    insert into public.username_claim (name, user_id, is_current)
    values (v_name, v_user, true);
  exception when unique_violation then
    -- 併發下另一人搶先取得同名；PRIMARY KEY 是最終仲裁者
    raise exception '此使用者名稱無法使用' using errcode = '23505';
  end;

  return v_name;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7.2 匯出（US-46）與帳號刪除（US-47）
--
-- ⚠️ export 刻意用 SECURITY INVOKER。
--    若寫成 DEFINER，一個寫錯的 WHERE 就會把全站資料倒出來；
--    用 INVOKER 時 RLS 仍然生效，最壞情況也只倒出「這個人本來就看得到的」。
-- ---------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profile_public p
                 where p.id = (select auth.uid())),
    'usernames', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
                  from public.username_claim c where c.user_id = (select auth.uid())),
    'records', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
                from (
                  select v.*, c.cost, c.currency
                  from public.viewing_record v
                  left join public.viewing_record_cost c on c.record_id = v.id
                  where v.user_id = (select auth.uid())
                  order by v.watched_at
                ) r),
    'ugc_films', (select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb)
                  from public.film f where f.created_by = (select auth.uid()))
  )
$$;

create or replace function public.delete_my_account()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
begin
  if v_user is null then
    raise exception '未登入' using errcode = '42501';
  end if;
  insert into app.audit_log (actor, action, target_kind, target_id)
  values (v_user, 'account.delete', 'profile', v_user::text);
  -- 使用者自建的 UGC 作品若已進入公共片庫，保留但解除歸屬
  -- （created_by 為 on delete set null），其餘經 cascade 一併刪除。
  delete from auth.users where id = v_user;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7.3 搜尋與統計 —— 一律 SECURITY INVOKER
--
-- ⚠️ 這是最容易在「RLS 都設好了」之後被繞開的地方：
--    一支 SECURITY DEFINER 的統計 RPC（例如 sum(cost)）會把 RLS 擋下來的
--    資料以聚合值的形式漏出去。聚合是推論通道，不是安全邊界。
--    寫成 INVOKER 之後，sum() 只會加總呼叫者本來就看得到的那些列。
-- ---------------------------------------------------------------------------
create or replace function public.search_film(p_q text, p_limit int default 20)
returns setof public.film
language sql
stable
security invoker
set search_path = ''
as $$
  select f.*
  from public.film f
  where p_q is not null and char_length(btrim(p_q)) >= 1
    and (f.title_zh ilike '%' || p_q || '%' or f.title_orig ilike '%' || p_q || '%')
  order by
    (f.title_zh = p_q or f.title_orig = p_q) desc,
    extensions.similarity(coalesce(f.title_zh, ''), p_q) desc
  limit least(coalesce(p_limit, 20), 50)
$$;

create or replace function public.user_year_stats(p_username text, p_year int)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'username',  p_username,
    'year',      p_year,
    'sessions',  count(*),
    'films',     count(distinct v.film_id),
    'tickets',   coalesce(sum(v.tickets), 0),
    -- cost 來自 viewing_record_cost，RLS 已先篩過；
    -- 因此 spend 只會是「呼叫者有權看見的那些票價」之和。
    'spend',     coalesce(sum(v.cost), 0),
    -- 明確告訴前端「這個總額可能不完整」，避免把被 RLS 濾掉的票價
    -- 誤呈現為「這個人這年只花了這些錢」。
    'spend_is_partial', count(*) filter (where v.cost is null) > 0
  )
  from public.viewing_record_public v
  where v.username = p_username
    and extract(year from v.watched_at at time zone 'Asia/Taipei') = p_year
$$;

-- ---------------------------------------------------------------------------
-- 7.4 管理端 RPC
--
-- 審核與取下**只能**經由這些函式。authenticated 對 film 的
-- moderation_status / visibility / taken_down_at 連欄位級 UPDATE 權限都沒有，
-- 因此「使用者自行提權」在資料庫層沒有可用的動詞。
-- 管理員身分來自 app.admin_user（無 policy、無 grant、PostgREST 看不到），
-- 而不是 JWT 裡任何使用者可寫的欄位。
-- ---------------------------------------------------------------------------
create or replace function public.admin_approve_film(p_film uuid, p_note text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not app.is_admin() then
    raise exception '需要管理員權限' using errcode = '42501';
  end if;
  update public.film
     set moderation_status = 'approved'::public.moderation_status,
         visibility        = 'public'::public.visibility,
         updated_at        = now()
   where id = p_film
     and taken_down_at is null;
  if not found then
    raise exception '作品不存在或已取下' using errcode = 'P0002';
  end if;
  -- ⚠️ 海報搬移不在這裡做：把物件從 ugc-poster-pending 搬到公開的
  --    ugc-poster 並更新 poster_path，必須由審核後端以 service_role
  --    在同一個工作流程中完成。若漏掉，公開作品的海報會 404
  --    （fail-closed，不會反過來洩漏未審核的圖）。
  insert into app.audit_log (actor, action, target_kind, target_id, detail)
  values ((select auth.uid()), 'film.approve', 'film', p_film::text,
          jsonb_build_object('note', p_note));
end;
$$;

create or replace function public.admin_reject_film(p_film uuid, p_note text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not app.is_admin() then
    raise exception '需要管理員權限' using errcode = '42501';
  end if;
  update public.film
     set moderation_status = 'rejected'::public.moderation_status,
         visibility        = 'private'::public.visibility,
         updated_at        = now()
   where id = p_film;
  insert into app.audit_log (actor, action, target_kind, target_id, detail)
  values ((select auth.uid()), 'film.reject', 'film', p_film::text,
          jsonb_build_object('note', p_note));
end;
$$;

-- 合併重複作品（US-20）：把 from 的紀錄與核准紀錄改掛到 into
create or replace function public.admin_merge_film(p_from uuid, p_into uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not app.is_admin() then
    raise exception '需要管理員權限' using errcode = '42501';
  end if;
  if p_from = p_into then
    raise exception '不能合併到自己' using errcode = '22023';
  end if;
  update public.viewing_record set film_id = p_into where film_id = p_from;
  update public.certificate    set film_id = p_into where film_id = p_from;
  update public.film
     set merged_into = p_into,
         visibility  = 'private'::public.visibility,
         moderation_status = 'rejected'::public.moderation_status,
         updated_at  = now()
   where id = p_from;
  insert into app.audit_log (actor, action, target_kind, target_id, detail)
  values ((select auth.uid()), 'film.merge', 'film', p_from::text,
          jsonb_build_object('into', p_into));
end;
$$;

-- §90-7「知悉侵權後立即移除」—— 取下是一個欄位的即時變更，
-- 不是批次工作，因為 policy 直接讀 taken_down_at。
create or replace function public.admin_takedown(
  p_notice uuid, p_kind public.content_kind, p_target text
) returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not app.is_admin() then
    raise exception '需要管理員權限' using errcode = '42501';
  end if;

  if p_kind = 'film'::public.content_kind or p_kind = 'poster'::public.content_kind then
    update public.film
       set taken_down_at = now(), takedown_notice_id = p_notice,
           visibility = 'private'::public.visibility, updated_at = now()
     where id = p_target::uuid;
  elsif p_kind = 'viewing_record'::public.content_kind then
    update public.viewing_record
       set taken_down_at = now(), takedown_notice_id = p_notice,
           visibility = 'private'::public.visibility, updated_at = now()
     where id = p_target::uuid;
  end if;

  update public.dmca_notice
     set status = 'taken_down'::public.notice_status,
         handled_at = now(), handled_by = (select auth.uid()),
         target_kind = p_kind, target_id = p_target
   where id = p_notice;

  insert into app.audit_log (actor, action, target_kind, target_id, detail)
  values ((select auth.uid()), 'content.takedown', p_kind::text, p_target,
          jsonb_build_object('notice', p_notice));
end;
$$;

-- 三振（§90-4 第 2 款）：滿三次自動停權，停權後其公開內容立即消失，
-- 因為 profile / viewing_record 的 SELECT policy 都檢查 status = 'active'。
create or replace function public.admin_add_strike(
  p_user uuid, p_reason text, p_notice uuid default null
) returns smallint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count smallint;
begin
  if not app.is_admin() then
    raise exception '需要管理員權限' using errcode = '42501';
  end if;

  insert into public.strike (user_id, reason, notice_id)
  values (p_user, p_reason, p_notice);

  select count(*)::smallint into v_count
  from public.strike s where s.user_id = p_user and s.voided_at is null;

  update public.profile_private
     set strike_count = v_count, last_strike_at = now(), updated_at = now()
   where user_id = p_user;

  if v_count >= 3 then
    update public.profile
       set status = 'suspended'::public.account_status, updated_at = now()
     where id = p_user;
    update public.profile_private
       set suspended_reason = '著作權三振條款' where user_id = p_user;
  end if;

  insert into app.audit_log (actor, action, target_kind, target_id, detail)
  values ((select auth.uid()), 'user.strike', 'profile', p_user::text,
          jsonb_build_object('count', v_count, 'reason', p_reason));
  return v_count;
end;
$$;

-- 回復（§90-9）：著作權人 10 個工作日內未提訴訟證明，
-- 平台須於 14 個工作日內回復內容，並撤銷該次三振。
create or replace function public.admin_restore(p_notice uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_kind   public.content_kind;
  v_target text;
begin
  if not app.is_admin() then
    raise exception '需要管理員權限' using errcode = '42501';
  end if;

  select n.target_kind, n.target_id into v_kind, v_target
  from public.dmca_notice n where n.id = p_notice;

  if v_kind in ('film'::public.content_kind, 'poster'::public.content_kind) then
    -- 取下時把 visibility 壓成 private，回復時必須一併還原，
    -- 否則作品雖然 taken_down_at 已清空卻仍舊看不見（沉默的半回復）。
    update public.film
       set taken_down_at = null, takedown_notice_id = null,
           visibility = case when moderation_status = 'approved'::public.moderation_status
                             then 'public'::public.visibility
                             else 'private'::public.visibility end,
           updated_at = now()
     where id = v_target::uuid;
  elsif v_kind = 'viewing_record'::public.content_kind then
    update public.viewing_record set taken_down_at = null, takedown_notice_id = null,
           visibility = 'public'::public.visibility,
           updated_at = now() where id = v_target::uuid;
  end if;

  update public.strike set voided_at = now(), voided_reason = '回復通知成立'
   where notice_id = p_notice and voided_at is null;
  update public.dmca_notice set status = 'restored'::public.notice_status
   where id = p_notice;
  update public.dmca_counter_notice set restored_at = now()
   where notice_id = p_notice;

  insert into app.audit_log (actor, action, target_kind, target_id, detail)
  values ((select auth.uid()), 'content.restore', v_kind::text, v_target,
          jsonb_build_object('notice', p_notice));
end;
$$;

-- ===========================================================================
-- 8. 權限 —— RLS 之外的第二道閘
--
-- RLS 管「哪些列」，GRANT 管「哪些欄」。兩者互補：
-- 想禁止使用者改動 moderation_status，RLS 做不到（WITH CHECK 看不到 OLD），
-- 但欄位級 GRANT 可以 —— PostgREST 在 SQL 送出前就會被 Postgres 擋下。
-- ===========================================================================

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
revoke all on all tables    in schema app    from public, anon, authenticated;
revoke execute on all functions in schema app from public, anon, authenticated;

-- 8.1 政府開放資料：全公開唯讀
grant select on public.venue       to anon, authenticated;
grant select on public.certificate to anon, authenticated;

-- 8.2 profile：可讀，但只有三個欄位可寫。
--     status 沒有被 grant —— 被三振停權的人連 PATCH 都送不出去。
grant select on public.profile to anon, authenticated;
grant update (display_name, avatar_url, show_cost) on public.profile to authenticated;

grant select on public.profile_private to authenticated;

-- 8.3 username_claim：只有 redirect_enabled 可寫；改名一律走 set_username()
grant select on public.username_claim to anon, authenticated;
grant update (redirect_enabled) on public.username_claim to authenticated;
grant delete on public.username_claim to authenticated;

-- 8.4 film：這幾個欄位是提權的入口，一律不 grant
--     （visibility / moderation_status / source / source_key / tmdb_id /
--       imdb_id / merged_into / taken_down_at / takedown_notice_id）
grant select on public.film to anon, authenticated;
grant insert (title_zh, title_orig, country, runtime_minutes, release_year,
              poster_source, poster_path, created_by)
  on public.film to authenticated;
grant update (title_zh, title_orig, country, runtime_minutes, release_year,
              poster_source, poster_path)
  on public.film to authenticated;
grant delete on public.film to authenticated;

-- 8.5 viewing_record：taken_down_at 不 grant，使用者無法自行復原被取下的內容
grant select on public.viewing_record to anon, authenticated;
grant insert (user_id, film_id, venue_id, watched_at, tickets, hall, version, memo, visibility)
  on public.viewing_record to authenticated;
grant update (film_id, venue_id, watched_at, tickets, hall, version, memo, visibility)
  on public.viewing_record to authenticated;
grant delete on public.viewing_record to authenticated;

-- 8.6 票價
grant select on public.viewing_record_cost to anon, authenticated;
grant insert (record_id, user_id, cost, currency) on public.viewing_record_cost to authenticated;
grant update (cost, currency) on public.viewing_record_cost to authenticated;
grant delete on public.viewing_record_cost to authenticated;

-- 8.7 法遵表格
grant select on public.strike to authenticated;
-- 侵權通知：**只給 INSERT，不給 SELECT**。連 RETURNING 都拿不到，
-- 因此前端必須帶 `Prefer: return=minimal`。這讓這張表在 API 層面是單向的。
grant insert (claimant_name, claimant_email, claimant_phone, claimant_addr,
              work_desc, target_urls, good_faith, accuracy_oath, signature)
  on public.dmca_notice to anon, authenticated;
grant select on public.dmca_notice to authenticated;   -- 由 policy 收斂為僅管理員
grant insert (notice_id, user_id, statement) on public.dmca_counter_notice to authenticated;
grant select on public.dmca_counter_notice to authenticated;
grant insert (reporter_id, target_kind, target_id, message) on public.data_report to authenticated;
grant select on public.data_report to authenticated;

-- 8.8 檢視表
grant select on public.profile_public        to anon, authenticated;
grant select on public.viewing_record_public to anon, authenticated;

-- 8.9 函式
-- policy 與非 definer 觸發器內用到的 helper，呼叫者需要 EXECUTE。
-- 這些函式位於 app schema，PostgREST 不曝露該 schema，因此無法被直接呼叫。
grant execute on function app.is_admin()                        to anon, authenticated;
grant execute on function app.is_service_context()              to anon, authenticated;
grant execute on function app.profile_is_active(uuid)           to anon, authenticated;
grant execute on function app.cost_visible_to_caller(uuid)      to anon, authenticated;
grant execute on function app.film_usable_by(uuid, uuid)        to anon, authenticated;

grant execute on function public.resolve_username(text)         to anon, authenticated;
grant execute on function public.search_film(text, int)         to anon, authenticated;
grant execute on function public.user_year_stats(text, int)     to anon, authenticated;
grant execute on function public.set_username(text)             to authenticated;
grant execute on function public.export_my_data()               to authenticated;
grant execute on function public.delete_my_account()            to authenticated;
grant execute on function public.admin_approve_film(uuid, text) to authenticated;
grant execute on function public.admin_reject_film(uuid, text)  to authenticated;
grant execute on function public.admin_merge_film(uuid, uuid)   to authenticated;
grant execute on function public.admin_takedown(uuid, public.content_kind, text) to authenticated;
grant execute on function public.admin_add_strike(uuid, text, uuid) to authenticated;
grant execute on function public.admin_restore(uuid)            to authenticated;

-- 8.10 service_role（伺服器端金鑰、匯入管線、審核搬檔）
-- 上面對 PUBLIC 的 revoke 會連帶收掉 service_role 隱含的 EXECUTE，補回來。
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema app    to service_role;
grant all on all tables in schema app to service_role;
grant usage, select on all sequences in schema app to service_role;

-- ===========================================================================
-- 9. 索引
--
-- RLS 的每一個判斷條件都會出現在每一次查詢的 WHERE 裡。
-- policy 用到的欄位沒有索引，就是全表掃描 —— 因此下列索引是
-- 「正確性以外的必需品」，不是最佳化。
-- ===========================================================================

-- policy 判斷用
create index film_created_by_idx on public.film (created_by) where created_by is not null;
create index viewing_record_user_idx on public.viewing_record (user_id);
create index viewing_record_cost_user_idx on public.viewing_record_cost (user_id);

-- 個人頁：某人的紀錄按時間排序（最高頻查詢）
create index viewing_record_user_watched_idx
  on public.viewing_record (user_id, watched_at desc);

-- 公開時間軸／電影頁「有哪些人看過」
create index viewing_record_public_film_idx
  on public.viewing_record (film_id, watched_at desc)
  where visibility = 'public' and taken_down_at is null;
create index viewing_record_public_watched_idx
  on public.viewing_record (watched_at desc)
  where visibility = 'public' and taken_down_at is null;
create index viewing_record_venue_idx on public.viewing_record (venue_id);

-- 片庫：只有公開已審核的作品需要被搜尋，部分索引同時縮小體積與曝險
create index film_public_title_zh_trgm
  on public.film using gin (title_zh extensions.gin_trgm_ops)
  where visibility = 'public' and moderation_status = 'approved' and taken_down_at is null;
create index film_public_title_orig_trgm
  on public.film using gin (title_orig extensions.gin_trgm_ops)
  where visibility = 'public' and moderation_status = 'approved' and taken_down_at is null;
-- 審核佇列
create index film_pending_idx on public.film (created_at)
  where moderation_status = 'pending';
-- TMDB 快取 6 個月刷新排程
create index film_tmdb_stale_idx on public.film (tmdb_synced_at)
  where tmdb_id is not null;

create index certificate_film_idx on public.certificate (film_id);
create index certificate_year_idx on public.certificate (roc_year);
create index venue_city_idx on public.venue (city) where is_active;

-- ===========================================================================
-- 10. Storage
--
-- 兩個 bucket 而非一個：
--   ugc-poster-pending — 私有。未審核作品的海報只有作者看得到。
--   ugc-poster         — 公開。審核通過後由管理函式搬過去。
-- 若只用一個公開 bucket，未審核作品的海報等於全網可取（RLS 對 public
-- bucket 的讀取不生效）；若只用一個私有 bucket，公開頁的每張海報都要簽
-- URL，既拖慢 SSR，也和「海報顯示不得置於付費牆之後」的要求相衝突。
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('ugc-poster-pending', 'ugc-poster-pending', false, 2097152,
   array['image/jpeg','image/png','image/webp']),
  ('ugc-poster',         'ugc-poster',         true,  2097152,
   array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- 路徑約定：{auth.uid()}/{film_id}.{ext}
-- 第一層資料夾即擁有者，讓 policy 不必查表就能判斷歸屬。
create policy ugc_poster_pending_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ugc-poster-pending'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy ugc_poster_pending_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ugc-poster-pending'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or app.is_admin())
  );

create policy ugc_poster_pending_update on storage.objects
  for update to authenticated
  using      (bucket_id = 'ugc-poster-pending'
              and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'ugc-poster-pending'
              and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy ugc_poster_pending_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ugc-poster-pending'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or app.is_admin())
  );

-- 公開 bucket：一般使用者不得寫入（沒有任何 insert/update policy）。
-- 搬移由審核流程以 service_role 執行。

-- ===========================================================================
-- 11. 非影城場所（US-7）
-- ===========================================================================
insert into public.venue (id, kind, name, city) values
  ('virtual:streaming', 'streaming', '串流平台', null),
  ('virtual:festival',  'festival',  '影展',     null),
  ('virtual:home',      'home',      '家中',     null),
  ('virtual:other',     'other',     '其他',     null)
on conflict (id) do nothing;

-- ===========================================================================
-- 12. 上線前自我檢查 —— 把三個最致命的失誤變成 migration 失敗
--     （建議同時放進 CI，對測試資料庫重跑）
-- ===========================================================================
do $$
declare r record;
begin
  -- ① public schema 的表格必須全部啟用 RLS。
  --    忘記 enable 的表格 = 全站可讀寫，且不會有任何錯誤訊息。
  for r in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  loop
    raise exception 'RLS 未啟用：public.%', r.relname;
  end loop;

  -- ② public schema 的檢視表必須全部 security_invoker。
  --    少一個就等於繞過底層所有 RLS。
  for r in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and coalesce((select o.option_value
                    from pg_options_to_table(c.reloptions) o
                    where o.option_name = 'security_invoker'), 'false') <> 'true'
  loop
    raise exception 'view 未設 security_invoker：public.%', r.relname;
  end loop;

  -- ③ viewing_record 不得長回 cost 欄位。
  --    整個票價設計建立在「這張表沒有這個欄位」之上。
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'viewing_record'
      and column_name ilike '%cost%'
  ) then
    raise exception 'viewing_record 不得含票價欄位——票價必須留在 viewing_record_cost';
  end if;

  -- ④ 所有 SECURITY DEFINER 函式都必須釘住 search_path。
  for r in
    select p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'app') and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
        where cfg like 'search_path=%'
      )
  loop
    raise exception 'SECURITY DEFINER 函式未釘 search_path：%', r.proname;
  end loop;
end;
$$;

commit;

-- ===========================================================================
-- 13. 建立第一位管理員（僅能以 service_role / psql 執行，不在 migration 內）
--   insert into app.admin_user (user_id) values ('<你的 auth.users.id>');
-- ===========================================================================
```

## 設計理由

# 設計理由

檔案已寫在 `/private/tmp/claude-501/-Users-david-Documents-Github-log/942964bf-1e2d-4766-a3d3-9ed624fa14bb/scratchpad/filmnote_schema.sql`（1765 行），建議搬到 `filmnote/supabase/migrations/`。

貫穿全案的判準只有一條：**「應用層忘記過濾」不得成為一種可能的失敗方式。** 凡是要靠 Nitro 的某段程式碼記得做某件事才安全的設計，一律視為不合格。

---

## 1. 票價：把欄級問題改寫成列級問題

RLS 是列級的；`cost` 的可見性卻是「每一列各自取決於**擁有者的** `show_cost`」。四個候選方案的漏洞：

| 方案 | 漏洞 |
|---|---|
| **API 層過濾** | 唯一的保護是「每一個回傳路徑都記得剔除」。PostgREST 直連（`/rest/v1/viewing_record?select=*`）完全繞過 Nitro；新增一個 endpoint、一次 `select('*')` 重構、一個巢狀 embed，都是新的外洩點。**這是最壞的一個。** |
| **欄位級 REVOKE** | `revoke select (cost) from authenticated` 是角色級、非列級 —— 連本人都讀不到自己的票價。想同時滿足「本人可讀」與「他人條件可讀」，單靠 grant 做不到。 |
| **SECURITY DEFINER view / RPC** | definer 繞過底層 RLS，等於把全部規則重寫在 view 裡；一個 `WHERE` 寫錯就是全站外洩。而且只要底表仍被 PostgREST 曝露，攻擊者直接打底表即可。 |
| **✅ 獨立表格 `viewing_record_cost`** | `cost` 本身成為一列，條件正好落進 RLS 天生的能力範圍。 |

實作要點：

- `viewing_record` **完全沒有 `cost` 欄位**。`SELECT *` 拿不到不存在的東西——這使「忘記過濾」在字面上不可能發生。第 12 節的自我檢查把「有人日後把 cost 加回來」變成 migration 失敗。
- 判斷集中在 `app.cost_visible_to_caller(record_id)` 一支函式，規則只有一處需要被審計。它同時要求 `visibility='public'`、`taken_down_at is null`、`profile.status='active'`、`show_cost is true` —— 所以**開啟 show_cost 不會連帶洩漏私密紀錄的票價**（這是最容易漏的組合）。
- 用 `SECURITY DEFINER` 而非 invoker，是為了讓票價規則**不依賴** `profile` / `viewing_record` 自己的 SELECT policy。日後有人調整那兩張表的 policy，票價的可見範圍不會被意外改動。
- `user_id` 在 cost 表反正規化（省掉 policy 內的 join），但以**複合外鍵** `(record_id, user_id) → viewing_record(id, user_id)` 綁死，漂移在結構上不可能。
- `viewing_record_public` view 以 `LEFT JOIN` 帶出 cost：無權時 RLS 讓該列不存在，`cost` 自動為 `NULL`。前端拿到什麼完全由資料庫決定。

**聚合是推論通道。** `user_year_stats` 刻意寫成 `SECURITY INVOKER` —— 一支 definer 的 `sum(cost)` 會把 RLS 擋下的資料以聚合值形式漏光。並回傳 `spend_is_partial`，避免把被濾掉的票價誤呈現為「這人這年只花這麼多」。`export_my_data` 同理用 invoker：最壞情況也只倒出呼叫者本來就看得到的東西。

---

## 2. anon 能讀什麼

| 可讀 | 不可讀 |
|---|---|
| `venue`、`certificate`（政府開放資料，全公開） | `profile_private`（三振次數、停權理由、刪除排程） |
| `profile`（active 帳號）、現用 username | **歷史 username**（見 §4） |
| `visibility='public'` 且未取下、擁有者 active 的 `viewing_record` | 私密紀錄、停權者的紀錄、已取下的紀錄 |
| `visibility='public' + approved + 未取下` 的 `film` | 未審核／被拒／已取下的 UGC 作品 |
| 擁有者已開啟 `show_cost` 的公開紀錄票價 | 其餘全部票價 |
| — | `app.admin_user` / `app.audit_log`（PostgREST 連 URL 都沒有） |
| 可寫 `dmca_notice`（著作權人未必是使用者） | 讀不回自己剛送的通知（**只寫不讀**的信箱表） |

「停權者的內容立即消失」是三振條款的實際執行面：`profile` / `viewing_record` 的 SELECT policy 都檢查 `status='active'`，`admin_add_strike` 滿三次即改 status，不需要另一支批次工作。

---

## 3. UGC private → public：誰執行、如何防提權

**攻擊：** `PATCH /rest/v1/film?id=eq.X` 帶 `{"visibility":"public","moderation_status":"approved"}`。

RLS 的 `WITH CHECK` 只看得到 NEW、看不到 OLD，因此**無法表達「這個欄位不准被改」**。四層防禦：

1. **欄位級 GRANT** — `visibility`、`moderation_status`、`source`、`source_key`、`tmdb_id`、`imdb_id`、`merged_into`、`taken_down_at` 全部不 grant 給 `authenticated`。PostgREST 在 SQL 送出前就被 Postgres 擋下。
2. **RLS WITH CHECK** — `film_update_own_pending` 要求最終列必須是 `private + pending`；`film_insert_own_ugc` 同理。即使前一層被繞過，寫進來的列也會被拒。
3. **BEFORE 觸發器** — `tg_film_guard` 看得到 OLD，逐欄比對 `is distinct from` 並 raise。
4. **表級 CHECK** — `film_public_requires_approval` 讓「public 但未 approved」**在這張表裡無法被表示**。即使日後某支 service_role 腳本寫錯，也造不出未審核卻公開的作品。

**升級只有一個動詞：** `admin_approve_film()`（`SECURITY DEFINER` + `SET search_path=''`）。`authenticated` 對那些欄位連 UPDATE 權限都沒有，所以在資料庫層面**不存在可用的提權動作**。

**管理員判定不可用 JWT。** `raw_user_meta_data` 可被使用者以 `supabase.auth.updateUser()` 自行改寫 —— 拿它判斷 admin 是一行程式的完整提權。本設計用 `app.admin_user`：無 policy、無 grant、PostgREST 不曝露 `app` schema，只有 service_role（bypassrls）能寫。

另外兩個較隱蔽的洞已一併封住：

- **UNIQUE 存在性 oracle。** `film.tmdb_id` 有 UNIQUE；若允許使用者填寫，即使目標列是私有的，唯一鍵衝突仍會照樣回報 —— 這是一個「這部 TMDB 電影在不在庫裡」的查詢器。觸發器直接拒絕帶 `tmdb_id` 的插入。
- **`source_key` 佔位汙染。** 使用者若能自填 `source_key='tmdb:550'`，日後正式匯入該片會撞 UNIQUE 而失敗。改由觸發器強制產生 `ugc:<uuid>`，且不 grant 該欄位。
- **UUID 主鍵而非確定性鍵。** 匯入管線的 `tmdb:<id>` / `gov:<zh>:<orig>` 是**可猜測**的字串。若拿來當 PK，FK 檢查（繞過 RLS）就成了私有作品的存在性探測器。改存為 `source_key UNIQUE`，PK 用不可猜測的 UUID。

---

## 4. 改名轉向表的洩漏

這是本題最尖銳的地方。三個獨立問題：

**① 舊名可讀 = 公開全站的 email local part。** 預設 username 取自 email 的 `@` 前綴。若 `username_history` 對 anon 可 SELECT，攻擊者一次查詢就能拿到「所有改過名的人的原始 email 前綴」，並把改名前後的身分對應起來 —— **這正是使用者改名要擺脫的東西**。

處置：歷史列（`is_current = false`）對 anon 與其他登入者**完全不可讀**，只有本人與管理員看得到。轉向只能經 `public.resolve_username(old) → new`：單向、不可反查（給現用名查不出曾用名）、不可列舉、**不回傳 user_id**（避免把舊名綁到帳號 ID）、停權或已刪除者不轉向。

**② 功能與隱私本質衝突。** 「舊連結仍能連到我」（US-25）與「別讓人把舊名連到新名」不可能同時完全成立 —— 轉向本身就是揭露。因此把開關交給使用者：`redirect_enabled`（可自行關閉）、`redirect_expires_at`（180 天後自動失效、名稱釋出、關聯消滅），並允許本人 `DELETE` 自己的歷史列以永久斷開。

**③ 兩張表 = 無法保證全域唯一。** SPEC 的 `profile.username` + `username_history` 各自 unique，資料庫層無法阻止「A 改名後，B 註冊了 A 的舊名」→ 301 迴圈或身分劫持；且是兩個真相來源，改名交易部分失敗就漂移。

**因此我偏離了 SPEC 的資料模型：** 合併為單一 `public.username_claim`（現用名 + 歷史名同表），`name` 是 PRIMARY KEY，全域唯一由一個索引保證，併發改名由 PK 仲裁；`(user_id) WHERE is_current` 的部分唯一索引保證一人一個現用名。`profile` 因此沒有 `username` 欄位，改由 `profile_public` view 提供 —— 這是刻意的取捨，若你偏好貼近 SPEC 的兩表形態，代價就是要在應用層自行處理上述競態。

---

## 5. 其他被納入的洩漏面

- **`security_invoker` view。** Postgres 的 view 預設以**擁有者**權限執行 = 完全繞過 RLS。在 `public` 建一個忘了加 `security_invoker=true` 的 view，就是把整張底表經 PostgREST 全站公開。第 12 節的自我檢查會讓這種 migration 直接失敗。
- **`SET search_path = ''`。** 每一支 SECURITY DEFINER 函式都釘住並完整限定名稱。少了它，使用者只要在自己有建立權限的 schema 放一個同名函式或運算子，就能在 postgres 權限下執行任意程式碼。自我檢查亦涵蓋此項。
- **預設權限 fail-closed。** Supabase 專案預設對 public 的新表 `grant all` 給 anon/authenticated —— 「建了表但忘記 enable RLS」＝全站可讀寫且沒有任何錯誤訊息。第 0.1 節收回預設，往後每張表都必須顯式 grant。
- **`profile` 拆成公開／私密兩張表**，讓 `profile` 的 SELECT policy 可以放心寫成「幾乎全公開」而不必逐欄擔心。
- **DMCA 通知只寫不讀**：不 grant SELECT 給提交者，連 `RETURNING` 都拿不到（前端須帶 `Prefer: return=minimal`），通知人的姓名／電話／地址／email 因此不可能被他人讀取。
- **海報兩個 bucket**：`ugc-poster-pending`（私有、RLS）與 `ugc-poster`（公開）。單一公開 bucket 會讓未審核海報全網可取（public bucket 的讀取不套 RLS）；單一私有 bucket 則每張海報都要簽 URL，拖慢 SSR 且與「海報不得置於付費牆後」的法遵要求相衝。
- **配額**：每人每日 50 部 UGC 作品、每小時 300 筆紀錄，抑制免費方案上的灌爆與審核佇列淹沒。


## 自陳風險

- 未經 Postgres 實機驗證。環境無 psql/docker，語法為人工審查。上線前務必先跑 `supabase db reset` 對本機專案驗證，特別留意：`create policy ... on storage.objects` 需要 storage.objects 的擁有權（Supabase SQL Editor 通常可，CLI migration 偶爾需 supabase_admin）；`delete from auth.users` 是否為 postgres 角色可執行（若否，帳號刪除須改走 Edge Function + Admin API）。
- 刻意未使用 `FORCE ROW LEVEL SECURITY`。所有 helper（cost_visible_to_caller、profile_is_active、film_usable_by）都是 postgres 擁有的 SECURITY DEFINER，靠「表擁有者不受 RLS 約束」讀到真值；開了 FORCE 這些函式會失效。代價是：任何以 postgres 身分執行的 SQL 都完全不受 RLS 保護。
- `app.cost_visible_to_caller(uuid)` 對 anon 開放 EXECUTE（policy 需要），形成一個 oracle：「這個 record_id 是否為公開且擁有者已開票價」。record_id 是 UUID，實務上不可猜測，但這是一個確實存在的側通道。同理 `app.profile_is_active(uuid)`。
- `resolve_username()` 的舊→新轉向本身就是揭露 —— 只要知道舊名就能得到新名，這是 US-25 的必然代價。緩解是不可列舉 + 使用者可關閉 + 180 天到期，不是消除。
- 預設 username 取自 email 前綴，即使做了正規化仍會洩漏 local part。若要根本解決，只能改為「首次登入強制自選名稱」，但這違反 US-23。
- 改名策略偏離 SPEC 的 `profile.username` + `username_history` 兩表模型（合併為 username_claim，profile 無 username 欄位）。所有查詢與型別都要改走 `profile_public` view。若團隊決定回到兩表形態，必須自行處理「B 註冊 A 的舊名」的競態。
- policy 中的三支 helper 是**每列**求值的相關子查詢（走 PK 索引，但仍是每列一次函式呼叫）。個人頁數千列尚可，全站公開時間軸分頁時需實測；若成為瓶頸，備案是把 `owner_shows_cost` / `owner_active` 以觸發器反正規化到 `viewing_record_cost`，但那會引入一致性風險（觸發器失敗即 fail-open）。
- `grant select on public.film` 含 `created_by`，公開已審核作品會揭露「誰新增了這部片」。若視為問題，需改成逐欄 grant 排除該欄。
- `username_claim` 的現用名對 anon 全可列舉（公開個人頁的必然結果），可被用來建立全站使用者清單。這是產品決策而非缺陷，但爬蟲防護要在邊緣層做。
- `admin_*` RPC 對 `authenticated` 開放 EXECUTE、由函式內部自行 `is_admin()` 把關。若日後有人新增一支忘記檢查的 admin 函式，就是完整提權。建議在 CI 加一條檢查：public schema 中所有 `admin_` 前綴的 definer 函式其原始碼必須含 `app.is_admin()`。
- `dmca_notice` 開放 anon INSERT，是垃圾訊息的靶。必須在 Nitro/Edge 端加 Turnstile 或速率限制；資料庫層沒有防護。
- `film_ugc_poster_rule` 這條 CHECK 會讓 US-18（UGC 作品事後比對到 TMDB）的同步腳本必須在同一句 UPDATE 內把 `poster_source` 一併改為 'tmdb'，否則違反約束。這是刻意的（符合 SPEC「已比對到 TMDB 的作品禁止上傳海報」），但腳本作者若不知情會撞牆。
- `admin_approve_film()` 不搬移 Storage 物件。審核後端必須在同一工作流程以 service_role 把海報從 pending bucket 搬到公開 bucket 並更新 poster_path，否則公開作品的海報 404（fail-closed，不會反向洩漏，但功能會壞）。
- `memo` 為使用者自由文字且預設公開，可被用來張貼侵權內容或個資。schema 只做長度限制，內容審核不在資料庫層。
- 本設計未涵蓋 TMDB 快取 ≤ 6 個月的實際清除排程（僅預留 `tmdb_synced_at` 與索引），該條款義務需另以排程作業落實。
