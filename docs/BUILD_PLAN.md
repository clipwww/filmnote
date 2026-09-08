# 影記 / filmnote 建置計畫（前半部）

> 本文只涵蓋 §1 schema/RLS、§2 專案設定、§3 路由、§4 環境變數。建置步驟與法遵落點見計畫後半部。
> 基準版本（2026-09-05 實測）：`nuxt@4.5.2`、`@nuxt/ui@4.11.0`、`tailwindcss@4.3.3`、`@nuxtjs/supabase@2.0.10`、`echarts@6.1.0`、`typescript@5.9.3`。

---

# 1. 最終 Supabase schema 與 RLS

## 1.1 相對於提案 3 的六項結構性修正

骨幹取提案 3（惰性複雜度 < 活性複雜度），但以下六點是**必改**，其中三項是評審實測出的 P0：

| # | 問題 | 修正 |
|---|---|---|
| A | `auth.uid() is null ⇒ 視為 service_role 放行`。anon 的 `auth.uid()` 同樣是 NULL，等於對未登入者關掉全部守門 | `is_service_context()` 改判 **`session_user` + PostgREST 的 JWT `role` claim**。⚠️ 本欄原本寫「改用 `current_user in (…)`」，**那同樣是錯的**——見下方「修正 A 的更正」與踩雷 #31 |
| B | 未做 `revoke execute ... from public`，PostgREST 把 `link_film_to_tmdb` 曝露給 anon | blanket revoke + 逐支 grant，但 revoke 的對象必須是 **`public, anon, authenticated` 三個一起**，且函式的 revoke 要放在**所有 `create function` 之後**。⚠️ 只 revoke `public` 不夠——見下方「修正 B 的更正」與踩雷 #73 |
| C | `ugc-poster` bucket 設 `public: true` + anon select ⇒ 未審核海報全網可列舉 | **單一 bucket 但 `public: false`**，storage RLS 以 film 的審核狀態把關；讀取走 signed URL（不是付費牆，法遵不受影響） |
| D | `film_identity` / `film_tmdb_snapshot` / `username` 用 `using (true)` ⇒ 私有 UGC 片名、全站舊 username 外洩 | 三張表的 SELECT policy 鏡射 film / profile 的可見性 |
| E | `profile.role` / `service_status` 對 anon 可讀 ⇒ 管理員名單與三振紀錄公開 | **拆表**：`profile`（公開身分欄位）+ `profile_private`（role/service_status/strike_count，anon 無 policy 無 grant） |
| F | 所有 policy 用裸 `auth.uid()` / `is_staff()` | 全部包成 `(select ...)` 提成 InitPlan |

### 修正 A 的更正（2026-09-05 於真實 Supabase 專案實測後改寫）

**`current_user` 不能用來判斷特權情境，這條原文是可被利用的。** 踩雷 #31 早就寫著這件事，但本表 A 欄仍採用了 `current_user`，兩處互相矛盾。

原因：`is_service_context()` 是被 `merge_films` / `link_film_to_tmdb` / `seed_films` 這類 **SECURITY DEFINER** 函式呼叫的，而在 definer 內 `current_user` 是**函式擁有者 `postgres`**，不是呼叫者。實測（PG 17.6 + PostgREST）：

```
一般登入使用者（is_staff() = false）在 SECURITY DEFINER 內：
  current_user = 'postgres'   session_user = 'authenticator'
  request.jwt.claims->>'role' = 'authenticated'
  ⇒ is_service_context() 回 true
```

於是任何**已註冊的一般使用者**都能成功呼叫 `POST /rest/v1/rpc/merge_films`（實測回 **HTTP 204**），把任意兩部作品合併：敗方 `visibility` 被壓成 `private` 而從公開片庫消失，所有人指向它的 `viewing_record` 被搬走。這是全站級破壞。

§5 Step 7 的驗收之所以抓不到，是因為它只測**匿名**（`$ANON` → 期望 401），沒測**已登入的一般使用者**。修正後該驗收應增加一列：以一般使用者 JWT 呼叫 `merge_films` → 必須 `403 / 42501`。

正解（兩個來源都不受 SECURITY DEFINER 影響）：

```sql
create or replace function public.is_service_context()
returns boolean language sql stable set search_path = '' as $$
  select session_user in ('postgres','supabase_admin','supabase_storage_admin')
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                  '') = 'service_role';
$$;
```

`session_user` 走 PostgREST 時**一律**是 `authenticator`（anon 與 service_role 皆然），只有直連才是 `postgres`；`request.jwt.claims.role` 是 PostgREST 依已驗簽 JWT 設定的，使用者無法覆寫——他們只能呼叫逐支 grant 的 RPC，而沒有任何一支會呼叫 `set_config`。實測對照表：

| 呼叫路徑 | `current_user`（definer 內） | `session_user` | `jwt.claims.role` |
|---|---|---|---|
| 直連 postgres（migration / `db:sql`） | `postgres` | `postgres` | *(none)* |
| PostgREST + publishable key | **`postgres`** | `authenticator` | `anon` |
| PostgREST + 使用者 JWT | **`postgres`** | `authenticator` | `authenticated` |
| PostgREST + secret key | **`postgres`** | `authenticator` | `service_role` |

§12 的 migration 結尾另加一條迴歸守衛：`is_service_context()` 的原始碼若再出現 `current_user`，整份 migration 直接 raise。

### 修正 B 的更正（同上，實測後改寫）

**Supabase 的專案樣板自帶一份 `pg_default_acl`，直接把權限授給 `anon` / `authenticated`，而不是經由 PUBLIC。** 踩雷 #29 說「預設 EXECUTE 授予的是 PUBLIC，寫成 `from anon, authenticated` 是無效的」——這句只對了一半。實測任一新專案：

```
grantor=postgres  schema=public  objtype=f  →  postgres=X | anon=X | authenticated=X | service_role=X
grantor=postgres  schema=public  objtype=r  →  postgres=arwdDxtm | anon=arwdDxtm | authenticated=arwdDxtm | …
grantor=postgres  schema=public  objtype=S  →  （序列同上）
```

也就是說：**每一張新表出生就對 `anon` 有 `arwdDxtm`（含 DELETE / TRUNCATE），每一支新函式出生就對 `anon` 有 EXECUTE。** 只 `revoke … from public` 完全拿不掉這一份。

本計畫第一次套用時，§12 結尾的自我檢查就是被這個擋下來的：

```
error: SECURITY DEFINER 對 anon/PUBLIC 開放 EXECUTE：link_film_to_tmdb, handle_new_user,
film_sync_identity, apply_three_strikes, approve_film, rename_username, merge_films,
apply_tmdb_snapshot, purge_expired_tmdb_cache, seed_films
```

objtype=`r` 那一列的影響更值得注意：§1.3 宣稱的「`pp_read_self` + **無 anon grant**」這層縱深防禦，在修正前**根本不存在**——`profile_private` / `import_run` / `copyright_strike` 等表實際上對 anon 是全開的，只剩 RLS 一層擋著。

正解有三個要點：

1. revoke 的對象一律寫成 **`public, anon, authenticated`** 三個一起。
2. **表與序列**的 blanket revoke 要放在 §13 的 `grant` **之前**（否則會把要給的權限一起洗掉）。
3. **函式**的 revoke 要放在**所有 `create function` 之後**（新增 §15.5）——否則 §14 / §15 才建立的函式會落在 revoke 後面，重新拿到 Supabase 預設授予 anon 的 EXECUTE。

### ⚠️ 修正 B 承諾的「日後新增的函式預設不可執行」在 Supabase 上做不到

`alter default privileges … revoke execute on functions from anon, authenticated` **有效**（實測 `pg_default_acl` 該列會被改寫）。但 **`from public` 那一份拿不掉**。migration 跑完後新建一支探測函式：

```
zz_probe.proacl = '=X/postgres | postgres=X/postgres | service_role=X/postgres'
                        ↑ 這就是 PUBLIC
has_function_privilege('anon',   'zz_probe()', 'execute') = true
has_function_privilege('public', 'zz_probe()', 'execute') = true
```

新函式的 `proacl` 會塌回 `NULL`，而 `NULL` 就是「內建預設」＝ PUBLIC 有 EXECUTE。試過先清空整列再 revoke、調換順序，結果相同。

⇒ **唯一可靠的守門是 §12 結尾的自我檢查**，且該檢查必須從「只查 SECURITY DEFINER」擴大成「**查所有** anon/PUBLIC 可執行的函式，比對一份顯式白名單」。日後新增 RPC 若忘了在 §15.5 revoke，migration 會失敗而不是靜默裸奔。

D+E 的副作用是**提權防線可以少一層**：`profile` 表裡根本沒有 role 欄位，`profile_update_self` 的 `with check (id = (select auth.uid()))` 就已經封死；`film` 的 UPDATE policy 直接在 `with check` 裡把 `review_state` / `visibility` / `tmdb_id` 釘成常數，也不再需要 guard trigger。表級 CHECK 仍保留作為最後一層。

## 1.2 完整 migration

> 本節與 `supabase/migrations/0001_init.sql` **逐字相同**（該檔以本節產生）。
> 「不得漂移」不靠記得——`pnpm exec tsx scripts/sync-schema-docs.ts` 會比對
> §1.2 / §1.2a / §1.2b 與 `supabase/migrations/**`，不一致就 exit 1；
> 加 `--write` 直接同步回本文件。
> 2026-09-05 已在真實 Supabase 專案（PostgreSQL 17.6）套用並通過全部驗收，
> 對已 seed 的資料重跑亦不損一列。修改任一邊都必須同步另一邊。
>
> ⚠️ **權限（revoke + grant）已不在本節，見 §1.2b。** 原因：本檔設計成可重複
> 執行，而 blanket revoke 隱含「這份 grant 清單就是全部的公開物件」這個不變量。
> 任何後續 migration 新增的表或 view 都會破壞它——例如 `0002` 的 `venue_option`，
> 若在它之後單獨重跑本檔，`revoke all on all tables … from anon, authenticated`
> 會把該 view 的 SELECT 靜默撤銷，前端得到的是沒有上下文的 401。
> 把新物件補進本檔的清單只是把問題推給下一支 migration，所以改為結構性解決。

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
```


## 1.2a 後續 migration（`0002`、`0003`）

0001 之後、9999 之前執行。兩支都可重複執行。

**`0002_venue_selectable.sql`** —— 場所能不能出現在「新增紀錄」的選單。
舊 log 匯入帶進三家不在 2025 年名冊中的影城（兩家已歇業、一家在日本大阪），
這些是真的去過的地方、必須留在歷史紀錄裡，但沒有人能在已拆除的戲院看新片。
刻意不沿用 `status='closed'` 表達：心斎橋那家還在正常營業，它不該進選單的理由是
「不在台灣、超出 SPEC 範圍」，把兩件事塞進同一個 enum 會逼出一個謊。
**前端一律查 `public.venue_option`，不可直接查 `venue`。**

**`0003_user_year_stats.sql`** —— 年度統計 RPC（Step 6、US-34～43）。
**SECURITY INVOKER，不可改 DEFINER**：聚合是推論通道（踩雷 #42），
DEFINER 會讓 RLS 整個讓開，此時一個寫錯的 WHERE 不會回 403，
而是安靜地把全站資料算進總計倒給呼叫者。代價是總花費對不同觀看者是不同的
數字，故回傳 `totals.spend_is_partial` 讓前端知道自己拿到的是不是全部。
9999 的自我檢查會在它被改成 DEFINER 時讓 migration 失敗。

回傳形狀的 TypeScript 契約在 `server/utils/user-year-stats.ts`
（RPC 宣告 `returns jsonb`，型別產生器只能標成 `Json`，故手寫）。

```sql
-- =============================================================================
-- 0002 — 場所是否可出現在「新增紀錄」的下拉選單
--
-- 起因：舊 log 匯入（US-56）帶進三家不在 2025 年影視局名冊中的影城——
-- 台北日新威秀（2020-09-08 歇業）、喜滿客京華影城（2019-11-30 歇業）、
-- AEON Cinema THEATUS 心斎橋（日本大阪）。這些是真實去過的地方，
-- 必須保留在歷史紀錄裡（虛化成 virtual:other 會讓影城分佈統計少算），
-- 但**不可以出現在新增紀錄的選單**——沒有人能在已拆除的戲院看新片。
--
-- 為什麼是獨立欄位而不是沿用 status：
--   status='closed' 只能表達「歇業」。心斎橋那家還在正常營業，
--   它不該出現在選單的理由是「不在台灣、超出 SPEC 範圍」，不是歇業。
--   把兩件事塞進同一個 enum 會逼出一個謊。
--
-- 可重複執行。
-- =============================================================================

alter table public.venue
  add column if not exists selectable boolean not null default true;

comment on column public.venue.selectable is
  '是否可出現在「新增紀錄」的場所選單。歷史用（已歇業、海外）一律 false，'
  '既有紀錄仍正常顯示。Step 7 的 UGC 場所審核通過後把此欄改 true 即可放行。';

-- 已歇業或已合併者，在結構上就不該被選。既有資料一次補齊。
update public.venue set selectable = false
 where selectable and (status <> 'active' or merged_into_venue_id is not null);

create index if not exists venue_option_idx on public.venue (sort_weight, name)
  where selectable and status = 'active' and merged_into_venue_id is null;

-- -----------------------------------------------------------------------------
-- 選單用的唯一入口。
-- 前端一律查這個 view，不要直接查 venue——直接查就會把歇業與海外影城
-- 一起撈進選單，而那正是這份 migration 要防的事。
-- security_invoker：沿用呼叫者的 RLS，與 0001 的其他 view 一致。
-- -----------------------------------------------------------------------------
create or replace view public.venue_option with (security_invoker = true) as
select id, kind, name, city, hall_count, sort_weight
  from public.venue
 where selectable
   and status = 'active'
   and merged_into_venue_id is null;

comment on view public.venue_option is
  '新增／編輯觀影紀錄時可選的場所。已歇業、已合併、海外與待審 UGC 場所都不在其中。';

grant select on public.venue_option to anon, authenticated;
```

```sql
-- =============================================================================
-- 0003 — 年度統計 RPC（Step 6、US-34～43）
--
-- ★ SECURITY INVOKER，不可改成 DEFINER。
--
-- 聚合是推論通道（踩雷 #42）。DEFINER 會讓函式以擁有者身分讀表，RLS 整個
-- 讓開——此時一個寫錯的 WHERE 不會回 403，而是安靜地把全站資料算進總計倒
-- 給呼叫者。INVOKER 則讓 RLS 逐列把關：呼叫者看不到的紀錄本來就進不了聚合，
-- 正確性不必倚賴這支函式的 WHERE 寫對。
--
-- 這個選擇有代價：票價要看 viewing_record_cost 的 RLS 臉色，所以總花費對不同
-- 觀看者會是不同的數字。那不是 bug，是規格——但**前端必須知道自己拿到的是不
-- 是全部**，否則會把「只算得到一半」顯示成「這就是全部」。故回傳
-- `totals.spend_is_partial`。
--
-- 時區：schema 刻意用 watched_on date + watched_time time 存台北牆上時間
-- （0001 §8）。所以「星期幾」「幾點」直接從這兩欄取，**不做 at time zone**——
-- 那會把已經正確的牆上時間再轉一次，得到偏移 8 小時的熱力圖。
--
-- 可重複執行。
-- =============================================================================

create or replace function public.user_year_stats(
  p_username text,
  p_year integer default null      -- null = 不分年度，涵蓋全部
)
returns jsonb
language sql
stable
security invoker                   -- ★ 見檔頭。改成 definer 會讓 RLS 失效。
set search_path = ''
as $$
with target as (
  select p.id
    from public.profile p
   where p.username = public.resolve_username(p_username)
),
-- RLS 在這裡生效：呼叫者看不到的紀錄不會出現，後面所有聚合自動正確。
rec as (
  select r.id, r.film_id, r.venue_id, r.watched_on, r.watched_time,
         coalesce(r.ticket_count, 1) as ticket_count,
         r.format_code,
         c.amount as cost
    from public.viewing_record r
    join target t on t.id = r.user_id
    -- left join：票價被 RLS 擋掉時保留紀錄本身，只是 cost 為 NULL。
    -- inner join 會讓「沒公開票價」連場次都消失，統計直接失真。
    left join public.viewing_record_cost c on c.record_id = r.id
   where p_year is null or extract(year from r.watched_on)::integer = p_year
),
-- 年份清單不受 p_year 影響——前端要用它畫年度切換器（US-42）。
years as (
  select distinct extract(year from r.watched_on)::integer as y
    from public.viewing_record r join target t on t.id = r.user_id
),
totals as (
  select count(*)::integer                                      as records,
         count(distinct film_id)::integer                       as films,
         coalesce(sum(ticket_count), 0)::integer                 as tickets,
         coalesce(sum(cost), 0)::numeric(12, 2)                  as spend,
         count(cost)::integer                                    as spend_known_records,
         (count(*) - count(cost))::integer                       as spend_unknown_records,
         count(*) filter (where watched_time is null)::integer   as records_without_time
    from rec
)
select case when not exists (select 1 from target) then null else jsonb_build_object(
  'username', public.resolve_username(p_username),
  'year', p_year,
  'is_own', exists (select 1 from target t where t.id = (select auth.uid())),
  'available_years', coalesce((select jsonb_agg(y order by y desc) from years), '[]'::jsonb),

  'totals', (select jsonb_build_object(
      'records', t.records,
      'films', t.films,
      'tickets', t.tickets,
      'spend', t.spend,
      'spend_currency', 'TWD',
      -- ★ 前端據此決定要顯示總額還是「部分票價未公開」
      'spend_is_partial', t.spend_unknown_records > 0,
      'spend_known_records', t.spend_known_records,
      'spend_unknown_records', t.spend_unknown_records,
      'records_without_time', t.records_without_time
    ) from totals t),

  -- 貢獻圖（US-34）。ECharts calendar 吃 [date, value]，這裡給具名欄位，
  -- 前端自行 map，避免把圖表函式庫的資料格式綁進 API 契約。
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object(
             'date', to_char(watched_on, 'YYYY-MM-DD'),
             'records', n, 'tickets', tk) order by watched_on)
      from (select watched_on, count(*)::integer n, sum(ticket_count)::integer tk
              from rec group by watched_on) d), '[]'::jsonb),

  -- 星期 × 時段熱力圖（US-35）。weekday 用 ISO：1=週一 … 7=週日。
  -- watched_time 為 NULL 的舊資料進不了這張圖，其筆數見 totals.records_without_time。
  'weekday_hour', coalesce((
    select jsonb_agg(jsonb_build_object(
             'weekday', wd, 'hour', hr, 'records', n) order by wd, hr)
      from (select extract(isodow from watched_on)::integer wd,
                   extract(hour from watched_time)::integer hr,
                   count(*)::integer n
              from rec where watched_time is not null
             group by 1, 2) w), '[]'::jsonb),

  -- 月度趨勢（US-36）
  'monthly', coalesce((
    select jsonb_agg(jsonb_build_object(
             'month', m, 'records', n, 'tickets', tk,
             'spend', sp, 'spend_is_partial', unknown > 0) order by m)
      from (select extract(month from watched_on)::integer m,
                   count(*)::integer n, sum(ticket_count)::integer tk,
                   coalesce(sum(cost), 0)::numeric(12, 2) sp,
                   (count(*) - count(cost))::integer unknown
              from rec group by 1) mo), '[]'::jsonb),

  -- 影城分布（US-37）
  'venues', coalesce((
    select jsonb_agg(jsonb_build_object(
             'venue_id', venue_id, 'name', name, 'city', city,
             'kind', kind, 'records', n) order by n desc, name)
      from (select r.venue_id, v.name, v.city, v.kind::text as kind, count(*)::integer n
              from rec r left join public.venue v on v.id = r.venue_id
             group by 1, 2, 3, 4) vv), '[]'::jsonb),

  -- 國別分布。film 讀不到時（他人的私密 UGC 作品）歸為空字串，前端顯示「未分類」。
  'countries', coalesce((
    select jsonb_agg(jsonb_build_object('country', country, 'records', n)
                     order by n desc, country)
      from (select coalesce(f.country, '') as country, count(*)::integer n
              from rec r left join public.film f on f.id = r.film_id
             group by 1) cc), '[]'::jsonb),

  -- 版本分布
  'formats', coalesce((
    select jsonb_agg(jsonb_build_object(
             'code', code, 'label', label, 'records', n) order by n desc, code)
      from (select coalesce(r.format_code, 'other') as code,
                   coalesce(max(s.label), '其他') as label,
                   count(*)::integer n
              from rec r
              left join public.screening_format s on s.code = r.format_code
             group by 1) ff), '[]'::jsonb),

  -- 多刷排行（US-41）。只列同一年內看過兩次以上的。
  'repeats', coalesce((
    select jsonb_agg(jsonb_build_object(
             'film_id', film_id, 'title_zh', title_zh, 'slug', slug,
             'poster_path', poster_path, 'records', n) order by n desc, title_zh)
      from (select r.film_id, f.title_zh, f.slug, s.poster_path, count(*)::integer n
              from rec r
              left join public.film f on f.id = r.film_id
              left join public.film_tmdb_snapshot s on s.film_id = r.film_id
             group by 1, 2, 3, 4
            having count(*) > 1) rr), '[]'::jsonb)
) end
$$;

comment on function public.user_year_stats(text, integer) is
  '年度觀影統計。SECURITY INVOKER——聚合結果一律受呼叫者的 RLS 限制，'
  '故 totals.spend 只涵蓋呼叫者看得到的票價，是否完整見 totals.spend_is_partial。'
  '星期與時段直接取自 watched_on / watched_time，不做時區轉換。'
  'p_year 為 null 時涵蓋全部年度。查無此使用者（或帳號不可服務）回傳 NULL。';
```


## 1.2b 權限 migration（`9999_grants.sql`）

「誰能存取什麼」的**單一真相**，永遠最後執行，且每次新增公開物件後都要重跑。
新增公開表 / view 時唯一要改的就是這一支的 grant 清單。

驗收（這正是拆分前會壞掉的情境）：

```bash
# 依序套用，然後以 anon 實測
pnpm run db:sql -- supabase/migrations/0001_init.sql
pnpm run db:sql -- supabase/migrations/0002_venue_selectable.sql
pnpm run db:sql -- supabase/migrations/9999_grants.sql
curl -s "$URL/rest/v1/venue_option?select=id&limit=3" -H "apikey: $ANON"   # 有值

# 單獨重跑 0001，再測一次 —— 拆分前這一步會讓上面那條變 401
pnpm run db:sql -- supabase/migrations/0001_init.sql
curl -s "$URL/rest/v1/venue_option?select=id&limit=3" -H "apikey: $ANON"   # 仍有值
```

`0001` 結尾另有一條 `raise warning`：若偵測到權限尚未套用（`anon` 對
`takedown_notice` 沒有 INSERT、或對 `profile_private` 仍有 grant），會提醒接著
執行本檔。這裡刻意用 warning 而非 exception——全新安裝時 `0001` 本來就跑在
`9999` 之前，硬性失敗會讓第一次安裝無法完成。

```sql
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
grant insert, update, delete on public.viewing_record, public.viewing_record_cost to authenticated;
grant insert, update on public.film to authenticated;
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
grant execute on function public.merge_films(uuid, uuid, text),
  public.approve_film(uuid, boolean) to authenticated, service_role;
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
                           'user_year_stats')
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
                        'counter_notice','copyright_strike','data_report','tmdb_refresh_due');
  if bad is not null then raise exception 'anon 對非公開表仍有 grant：%', bad; end if;

  -- user_year_stats 一旦被改成 SECURITY DEFINER，RLS 就整個讓開，而它對 anon
  -- 開放 EXECUTE ⇒ 任何人都能把全站觀影紀錄與票價聚合出來。這條讓那個改動
  -- 在 migration 階段就失敗，而不是等到有人發現總花費多了一個零。
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'user_year_stats' and p.prosecdef) then
    raise exception 'user_year_stats 必須是 SECURITY INVOKER（聚合是推論通道，踩雷 #42）';
  end if;
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

**完全讀不到**：`profile_private`（role / service_status / strike_count）、`import_run`、`film_merge_log`、`legal_acceptance`、`counter_notice`、`copyright_strike`、`data_report`、`tmdb_refresh_due`、任何 pending/private 作品與其海報。**可執行的函式**恰為十一支（`is_staff` / `is_admin` / `account_is_servable` / `owner_shows_cost` / `record_owner` / `record_is_public` / `film_usable_by` / `resolve_film` / `resolve_username` / `slugify` / `ugc_poster_film`）——`merge_films`、`approve_film`、`link_film_to_tmdb`、`seed_films`、`purge_expired_tmdb_cache`、`export_my_data`、`rename_username` 對 anon 一律 401。這份清單同時是 §12 自我檢查的白名單，新增 RPC 忘了 revoke 會讓 migration 失敗。

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

> **這張表是計畫，不是現況。** 表中多數路由尚未建立。哪些畫面已經是真的、
> 哪些還是骨架，看 `docs/handoff/frontend.md §1`——那裡是唯一的現況真值，
> 不要在本節另外維護一份狀態欄，兩份一定會不同步。

| 路徑 | 算繪 | 需登入 | 說明 |
|---|---|---|---|
| `/` | SSR + ISR 300 | 否 | 站台介紹 + 近期公開紀錄。ISR 安全的前提是 SSR 期間只讀公開資料（見下方注意）。 |
| `/login` | SSR | 否 | Google OAuth 進入點。 |
| `/confirm` | **強制 SPA** | 否 | OAuth callback。`@nuxtjs/supabase` 會自行對此路徑加 `{ ssr: false }`，不要自己再寫。 |
| `/u/[username]` | SSR，**不快取** | 否 | 公開個人頁。RLS 依觀看者而異（本人看得到自己的私密紀錄與票價）⇒ 絕不可 ISR/CDN 快取，`cache-control: private, no-store`。 |
| `/u/[username]/[year]` | SSR，不快取 | 否 | 年度回顧（US-42）。 |
| `/u/[username]/records/[id]` | SSR，不快取 | 否 | 單筆紀錄的 OG 分享頁（US-32）。 |
| `/film/[slug]` | SSR + ISR 3600 | 否 | 作品頁（US-27/33）。 |
| `/film` | 302 → `/search` | 否 | **不建瀏覽索引頁**：索引頁是新功能且要等設計定案，移除死路的成本是一行。`/search` 與「找不到片」流程都連得到這裡。 |
| `/search` | SSR，**不快取** | 否 | 雙欄片名搜尋（US-1~3）。結果依 query 而異，`allowQuery` 一開就是快取爆炸（踩雷 #8），故 `no-store`。⚠️ 用 `UInput` + 結果格線，**不是** Step 3 寫的 `USelectMenu`——那是公開頁面不是表單欄位；`USelectMenu` + `ignore-filter` 的規範用在 `/app/records/new` 的片名選擇。 |
| `/venue/[id]` | SSR + ISR 3600 | 否 | 影城頁。 |
| `/legal/terms`｜`/legal/privacy`｜`/legal/copyright`｜`/legal/dmca` | **prerender** | 否 | §90-4 的四要件頁面，建置期靜態產生。 |
| `/app` | SPA | **是** | 儀表板：貢獻圖、時段熱力圖、月度趨勢、影城／版本／國別分布（US-34~43）。 |
| `/app/records/new` | SPA | 是 | 三十秒記錄流程（US-4~9）。**本節先前寫 `/app/new`，與實作不符**，以實作為準。 |
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
| ~~`COPYRIGHT_CONTACT_EMAIL`~~ | —（**不要再設**） | ~~§90-4 第③款要公告的受理窗口，同時是取下通知的收件地址。~~ → **2026-09-07 David 裁定移除**：受理窗口改成只有 `/legal/dmca` 那張表單，理由與法源見 §6.1③。`nuxt.config.ts` 的 runtimeConfig key 與 `.env.example` 的那一行都已拿掉，全 repo 對 `process.env.COPYRIGHT_CONTACT_EMAIL` **0 個讀取點**（2026-09-08 覆核）。⚠️ 這一列刻意留成墓碑而不是直接刪掉——刪掉的話下一個部署的人只會覺得「表裡漏了一個」，然後去 Vercel 補設一個沒有任何程式在讀的變數。 |

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
# COPYRIGHT_CONTACT_EMAIL 已於 2026-09-07 移除（David 裁定）：本服務不公告電子郵件
# 受理窗口，§90-4 第 3 款要公告的窗口就是 /legal/dmca 那張表。不要加回來。
```

⚠️ **上面這段是摘錄，不是 `.env.example` 的逐字複製**（2026-09-08 覆核實際檔案）。實際的檔案另外還有三個變數，而且各自帶著不可省略的說明：`DATABASE_URL`（只給 `pnpm db:sql` 套 migration 用，含 DB 密碼）、`CRON_SECRET`（★ 部署到 Vercel 時**必須**是這個名字，否則排程照跑但請求不帶 `Authorization` header ⇒ 端點一律 401 而 cron 面板顯示成功，見 §5 Step 11）、`IMPORT_TARGET_EMAIL`（`scripts/import-mylog.ts` 的目標帳號，刻意不給預設值也不寫死——DB 裡有多個 session 建的測試帳號，用「唯一一筆 profile」之類的假設會把紀錄匯到別人身上）。⇒ **以 `.env.example` 檔案本身為準**，不要拿這一段去覆蓋它。

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
- `npm run build` 後 `ls -d .output/public/app` **不存在**（`ssr:false` 的路由不會產生靜態檔）。
  ⚠️ **不要**斷言 `.output/public/index.html` 存在——`/` 走的是 `isr` 不是 `prerender`，兩者互斥：
  prerender 在 build 時產生靜態檔，ISR 是首次請求才算繪並在邊緣快取。實測 `.output/public/`
  只有 `_nuxt/`。`/` 的 SSR 改以原始 HTML 內容驗證：`curl -s $SITE/ | grep -c '<首頁文字>'` ≥ 1。

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

> ⚠️ **本節先前描述的是「雙 bucket 搬檔」架構（`ugc-poster-pending` → `ugc-poster`），
> 那個架構在 §1.1 修正 C 已被否決而本節沒有同步。** 實作是**單一 bucket `ugc-poster`
> 且 `public: false`**，由 storage RLS 依 film 的審核狀態把關，讀取走 signed URL
> （不是付費牆，法遵不受影響）。審核通過不搬檔，只改審核狀態。
> 函式名也修正過：實際是 `approve_film` 與 `merge_films`，不是 `admin_approve_film` /
> `admin_merge_film`（2026-09-06 對實際 DB 查證）。

1. `/app/films/new`：只填片名 + 年份（US-14），海報選填上傳到 **private** bucket `ugc-poster/{film_id}/…`（`public: false`，未審核前只有作者讀得到）。
   ⚠️ **上傳成功不等於畫得出來**：必須把路徑寫進 `film.ugc_poster_path`，否則 `film_public.ugc_poster_path` 是 null，畫面會退回文字卡片——海報明明已公開可讀卻不顯示。
2. `server/api/admin/films/[id]/approve.post.ts` —— **這是提案 1 沒做完、承認會 404 的那一步**：以**使用者身分的 client** 呼叫 `approve_film` RPC（`serverSupabaseServiceRole` 不做任何身分檢查，授權必須另外做，踩雷 #26）。單一 bucket 架構下不需要搬檔。
3. `/admin` 審核佇列用 `UTable`（`virtualize` 需要容器確定高度，踩雷 #54）。
   **不需要新端點**：staff 靠 `film_read` 的 `is_staff()` 分支就能直接查 PostgREST。
4. `/admin/films/merge` 呼叫 `merge_films`（只改 `film_identity` 指向，`viewing_record` 一列不動）。

**怎麼確認它對了**

- 建立 UGC 作品後：無痕視窗看不到、自己看得到、可立刻用於記錄（US-16/17）。
- **未審核海報不可公開存取**（兩條都要測，只測第一條會漏掉列舉）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "$URL/storage/v1/object/public/ugc-poster/$FILM/poster.jpg"            # 400/404，不得 200
curl -s -X POST "$URL/storage/v1/object/list/ugc-poster" \
  -H "apikey: $ANON" -H 'Content-Type: application/json' \
  -d '{"prefix":"","limit":100}'                                          # 必須 []
```

- 片名不得經 slug 外洩：`curl -s "$URL/rest/v1/film_identity?select=key" -H "apikey: $ANON" | grep -c '<私有片名切片>'` → 0（踩雷 #37）。
- 審核通過後：作品進公共片庫、海報改由 signed URL 供應（**檔案沒有移動過**，變的是 storage RLS 的判定結果）、`film_identity` 多一筆 `slug:`。
- 合併兩部作品後：`viewing_record` 一列都沒少、敗方的 `gov:` 鍵指向存活者；**再跑一次 seed 不會復活出重複列**。
- 非 admin 帳號呼叫 `approve_film` → `42501`。
- **破壞性寫入測試（兩種身分都要測，只測匿名會漏掉真正的破口）**：
  ```bash
  # ① 匿名 —— 沒有 EXECUTE，應該連函式都看不到
  curl -X POST "$URL/rest/v1/rpc/merge_films" -H "apikey: $ANON" \
       -d '{"p_loser":"<A>","p_winner":"<B>"}'            # 401/404，不得 200/204
  # ② 已登入的一般使用者（is_staff() = false）★ 這條才是實際被攻破的那一條
  curl -X POST "$URL/rest/v1/rpc/merge_films" -H "apikey: $ANON" \
       -H "Authorization: Bearer $USER_JWT" \
       -d '{"p_loser":"<A>","p_winner":"<B>"}'            # 必須 403 / 42501 權限不足
  # ③ service_role —— 排程與 seed 靠這條，必須仍然可用
  curl -X POST "$URL/rest/v1/rpc/merge_films" -H "apikey: $SECRET" \
       -H "Authorization: Bearer $SECRET" -d '{...}'            # 204
  ```
  ②在採用 `current_user` 判準時實測回 **204**（合併成功），見 §1.1「修正 A 的更正」。

---

### Step 8 — 法遵頁面與 DMCA 流程

**做**：依 6.1 的落點表建立四類頁面與兩支 API，`legal_document` 塞入第一版條款（含 `content_sha256`），`app/layouts/default.vue` 頁尾加顯名聲明。

**怎麼確認它對了**

- `/legal/copyright` 上有可讀的聯繫窗口（**`/legal/dmca` 表單，不公告電子郵件**——2026-09-07 David 裁定，理由見 §6.1③）與完整的通知／取下／回復流程說明，且**每一頁的頁尾都連得到**（`AttributionFooter` 的 `legalLinks` 含 `/legal/dmca`，該元件掛在 `app/layouts/default.vue`，而 `app/layouts/` 只有這一個 layout ⇒ 「每一頁」是結構上成立的，不是逐頁檢查出來的）。
- ⚠️ **驗收要分成兩層，只跑第一層會得到「規格已生效」的假綠燈**（2026-09-08 文件稽核抓到）：

  | 層 | 守什麼 | 怎麼驗 |
  |---|---|---|
  | ① 原始碼／markdown | `docs/legal/*.md` 與 `app/pages/legal/*.vue` 的字面內容 | `pnpm exec vitest run tests/legal-contact-channel.test.ts` |
  | ② **使用者真正讀到的** | `public.legal_document.body_md` | 見下方 |

  **② 才是法遵上算數的那一層。** `/legal/**` 的正文**不是**從 `.md` 讀的——
  `app/pages/legal/{terms,privacy}.vue` 只有一行 `<LegalDocumentView>`，
  `useLegalDocument.ts` 去撈 `legal_document.body_md`。
  ⇒ **只改 markdown 而沒跑 `node --env-file=.env scripts/load-legal.mjs`，
  站上顯示的仍然是舊版，而且完全沒有聲音。** 那支 vitest 讀的是磁碟上的檔，
  它對這件事**零鑑別力**——把 DB 裡的舊條文留著不動，9 條照樣全綠。

  ②的驗法（任一）：
  ```
  pnpm db:sql -- --query "select kind, left(content_sha256,12) from legal_document order by kind"
  ```
  跟本機以 `stripInternal` 重算的 sha256 前 12 碼比對；或直接查關鍵字是否已更新：
  ```
  pnpm db:sql -- --query "select kind, position('僅以該線上表單受理' in body_md) from legal_document"
  ```

- 驗收指令（①這一層）：`pnpm exec vitest run tests/legal-contact-channel.test.ts`（9 條），以及 `rm -rf .output && pnpm build && grep -rl "copyright@filmnote.tw" .output | wc -l` 期望 0。⚠️ **跑 build 那條之前先確認 `grep -n COPYRIGHT_CONTACT_EMAIL ./.env` 還有值**（顯式路徑，`grep -r` 看不到 `.env`，見踩雷 #240），否則會拿到「因為根本沒值所以綠」的假綠燈——那條斷言要證明的是「有值也不會流進產物」。
- 未登入者可提交侵權通知、但讀不到：

```bash
curl -X POST "$URL/rest/v1/takedown_notice" -H "apikey: $ANON" \
     -H "Prefer: return=minimal" -H 'Content-Type: application/json' -d '{...}'   # 201
curl -s "$URL/rest/v1/takedown_notice?select=*" -H "apikey: $ANON"                    # [] / 401
```

不帶 `Prefer: return=minimal` 會失敗，這是刻意的——沒有 SELECT policy 就拿不到 RETURNING，確保這張表在 API 層是單向的。

- `admin_takedown` 後：該紀錄／作品在公開頁**立即**消失（US-52），**且引用該作品的其他人的公開紀錄與票價也一併消失**（這是提案 1 漏掉的 join，必須實測）。
- `admin_add_strike` 第三次後 `profile_private.service_status = 'terminated'`，該使用者個人頁與全部公開紀錄立即不可讀。
- `admin_restore` 後內容回復、`visibility` 一併還原、該次三振被作廢（不是沉默的半回復）。
- `counter_notice` 填 `forwarded_at` → `litigation_proof_due_at`（+10 工作日）與 `restore_due_at`（+14 工作日）自動算出。

---

### Step 9 — TMDB 六個月刷新排程

**做**：`server/api/cron/tmdb-refresh.get.ts`（驗 `Authorization: Bearer $CRON_SECRET`）取 `next_refresh_at <= now()` 的批次刷新，寫回 `expires_at = now()+180d`、`next_refresh_at = now()+150d`，失敗則指數退避；`tmdb-purge` 第二道防線；`vercel.json` 的 `crons` 兩條。刷新只覆寫 `title_zh_source='tmdb'` 的欄位。

**怎麼確認它對了**

- 把某列 `expires_at` 設成過去 → 重整 `/film/{slug}` → 海報與簡介變 NULL（退回文字卡片）。這證明合規靠的是讀取端 view 的把關，不是「cron 一定會跑」。
- 跑一次 refresh → `state='fresh'`、`expires_at` 往後推；**政府核准的 `title_zh` 沒有被 TMDB 的中文標題覆蓋**（`select title_zh from film where id = …` 前後一致）。
- TMDB 回 429 時整批不失敗，只推遲 `next_refresh_at`。

#### Step 9a — 管理後台的手動觸發（2026-09-07 追加）

**排程沒有被取代**：`vercel.json` 的兩條 `crons` 一個字都沒有動，這一組端點是**附加**的。加它的理由與「cron 能不能用」無關（見下面的數字），而是 ① cron 目前唯一的觀測面是 `console.log`，站上看不出它昨天有沒有追上進度；② 失敗了沒有重試入口，要重跑只能拿 `CRON_SECRET` 去 curl；③ 剛匯入一批作品時要等到隔天 03:00（而且會浮動到 03:59）。

**做**：三支管理端點——`POST /api/admin/tmdb/refresh`、`POST /api/admin/tmdb/purge`、`GET /api/admin/tmdb/status`——與 `/admin` 上的面板（`app/pages/admin/-TmdbMaintenance.vue`）。

**★ 授權形狀，以及為什麼跟 approve / merge 不一樣。** `approve.post.ts` / `merge.post.ts` 從頭到尾用**呼叫者自己的** client，授權整段丟給 RPC，由 `approve_film()` / `merge_films()` 內部的 `is_staff()` 決定——那是最好的形狀，判斷只有一份且寫在資料庫裡。但 TMDB 維護要做的兩件事**只有 `service_role` 做得到**：`tmdb_refresh_due` 這個 view 只 grant 給 `service_role`（`9999_grants.sql:85`），而 `purge_expired_tmdb_cache()` 進門問的是 `is_service_context()` 不是 `is_staff()`（`0005:41`）。也就是說**沒有任何一支 RPC 會替我們問「呼叫者是不是 staff」**。⇒ 這是本專案唯一一處必須在端點自己守門的地方，順序**不可調換**：

1. `serverSupabaseUser(event)` —— 沒登入 401
2. 用**使用者自己的** client（`serverSupabaseClient(event)`）問資料庫 `is_staff()` —— 不是 `true` 就 403
3. **通過 ② 之後**，才去拿 `serviceSupabase()` 幹活

決策本體是純函式 `assertStaffFrom(probe)`（`server/utils/admin-auth.ts`），supabase 的接線留在三支端點裡各寫一次——**那不是重複，是刻意的**：端點檔裡看得到 `serverSupabaseClient(event)` 這個字，讀的人一眼就知道問 `is_staff()` 的是使用者自己的 client；包進共用函式反而會讓最該被看見的事消失。而且 `#supabase/server` 是 Nuxt 模組建出來的別名、**vitest 解析不到**（踩雷 #212），決策與接線分開之後守門才測得到。斷言在 `tests/admin-tmdb-auth.test.ts`（17 條），其中有專門針對「已登入但不是 staff」那一種呼叫者的——§1.1 記載這個 repo 的授權**真的被那種人攻破過**（以他的身分呼叫 `rpc/merge_films` 實測回 204），所以 ② 不是形式。

⚠️ 這是踩雷 #26（「admin 端點不要用 service role 繞過 RLS 做授權判斷」）的**合法例外，而且邊界很窄**：例外的條件是「這件事只有 service_role 做得到，而且沒有任何 RPC 會替我們問 `is_staff()`」。在這個例外裡，`service_role` 仍然**只用來執行工作、絕不用來判斷誰有權限**——`admin-auth.ts` 從頭到尾沒有 import `serviceSupabase`，那是刻意的。要學的是「什麼時候不得不自己守門」以及「守門要長成什麼形狀」，不是「原來可以在端點自己判斷授權」。相關的反直覺後果見踩雷 #217。

**status 的兩個欄位不要看錯：** `due` 是「view 中到期待刷新的**總**列數」（不受 `limit` 影響），配一個分母顯示——只有 `due` 沒有分母時，「0」看起來跟「壞掉了」一樣。`lastFetchedAt` 是 `max(fetched_at)`，它回答的是「最近一次真的有東西被刷新是什麼時候」，**不是「排程上次執行的時間」**：某一輪 cron 若跑到 `due = 0` 就什麼都不會寫，這個時間不會動。這個欄位長得太像「上次執行時間」了，畫面上必須把這句話寫在數字底下。真正的「每一輪有沒有跑、跑出什麼」需要一張執行歷史表，本階段沒做。

**purge 的畫面文案不是修辭。** 六個月條款的第一道防線是讀取端：`film_public` 以 `expires_at > now()` 逐列把關，過期欄位直接變 NULL ⇒ **即使 purge 從來沒被按過，也不會有逾期內容被送出去**。purge 做的是另一件事：不要在資料庫裡留著已無權保存的內容。不講清楚的話，管理者會把非零的數字讀成「沒按就在違規」。⚠️ 後續改版不要把那則說明簡化成「合規清除」。

**時間預算的上限是 60 秒，不是 300 秒。** 預算只決定「要不要再取新工作」，**不會砍掉已經在飛的請求**，詳見踩雷 #209。伺服器端的夾子在 `server/utils/admin-tmdb-options.ts`，UI 的最大選項在 `-TmdbMaintenance.vue`——這是**兩份**數字，刻意沒有共用（讓 `status.get.ts` 去 import `refresh.post.ts` 的常數是 route→route import，在本 repo 無法驗證，而踩雷 #80 記載的正是這一類「靜態檢查全綠、rollup 打包才炸」）。漂移的防護是：選單只給到上限，伺服器仍會再夾一次，而且**把實際生效的 `options` 回給畫面顯示** ⇒ 兩邊哪天分岔了，畫面上「這一輪實際用了預算 N 秒」會直接說出來。

**怎麼確認它對了**

- 未登入 `POST /api/admin/tmdb/refresh` → 401；以**已登入但非 staff** 的帳號 → 403；以 staff → 200 且 `report.options` 回得出實際生效的預算。
- `GET /api/admin/tmdb/status` 的 `due` 與 `select count(*) from tmdb_refresh_due`（service role 直連）相等。
- `pnpm exec vitest run tests/admin-tmdb-auth.test.ts`。

#### ★ Vercel 方案限制：兩組被寫錯過的數字（2026-09-07 查證，出處在下）

這一節存在的理由是：David 這次的需求建立在「免費的 Vercel 不能用 cron job」這個**錯誤前提**上，而那個前提很可能來自 repo 裡一句錯誤的註解。數字寫錯的代價不是不精確，是**會讓人放棄本來做得到的選項**。

**(1) Cron** —— 出處 <https://vercel.com/docs/cron-jobs/usage-and-pricing>（該頁 last_updated 2026-07-15，查證日 2026-09-07）：

| 方案 | 每專案條數 | 最短間隔 | 觸發精度 |
|---|---|---|---|
| Hobby | **100** | 一天一次 | 該小時內（±59 分） |
| Pro / Enterprise | **100** | 一分鐘一次 | 分鐘級 |

而且原文寫著 "Cron jobs are included in **all plans**." ⇒ 「免費方案不能用 cron」不成立；**名額也不是限制**（舊註解寫的「每專案 2 條」是**過期的錯誤數字**，`server/api/cron/tmdb-refresh.get.ts` 的檔頭已經改掉並附上出處）。真正的限制是**間隔與精度**：`0 19 * * *` 實際會落在台北時間 03:00–03:59 之間的任何一刻。

**(2) 函式執行時間** —— 出處 <https://vercel.com/docs/functions/limitations#max-duration>（該頁 last_updated 2026-08-24，查證日 2026-09-07）：啟用 **fluid compute**（新專案預設開啟）時，Node.js runtime 的 Hobby 預設與上限**皆為 300 秒**；Pro / Enterprise 預設 300、上限 800、延長至 1800 秒為 Beta。

⚠️ **但「本專案有沒有啟用 fluid compute」在 repo 裡查不到**——那是 Vercel 專案設定（Settings → Functions → Default Max Duration），沒啟用的舊專案預設低得多。⇒ 把 300 秒當成本專案的事實去推導上限，正是這個 repo 反覆記載的「拿推論當量測」。要調高手動觸發的預算之前，**先去 Vercel 確認 Default Max Duration**，不要只因為「文件寫 300 秒」就改。

⚠️ `server/utils/tmdb-refresh-options.ts:33` 的註解裡還留著一句「Hobby 方案曾是 10 秒」（⚠️ `server/api/admin/tmdb/refresh.post.ts:39` 的引用**也指錯了檔**，說它在 `tmdb-refresh.ts`——兩處要一起改，不然下一輪還會再抄一次錯的路徑），那是**過去式而且沒有出處**（2026-09-08 覆核仍在）。它不影響行為，但看到的人請一併修掉。

---

### Step 10 — 舊 log 資料匯入（US-56/57/58）

**做**：`/app/import` 上傳 CSV/JSON → 走接縫 A 的比對器 → 預覽（已比對／未比對）→ 以 `import_key` 寫入，`unique (user_id, import_key)` 保證冪等。

**怎麼確認它對了**：同一份檔案匯入兩次，`select count(*) from viewing_record where user_id = …` 不變；未比對到的片明列出來且可一鍵建 UGC 作品；只有日期沒有時間的舊資料 `watched_time` 為 NULL。

---

#### ✅ 已完成：David 本人的 169 筆實測匯入

CLI 先行（`pnpm import:mylog`，`scripts/import-mylog.ts`）。`/app/import` 的
上傳 UI 尚未做，但比對、拆分、冪等這三件事已在真實資料上驗證，UI 只需複用
`src/import/**` 的純函式。

**來源**：`https://mechakucha-api.vercel.app/my-log/movie`，169 筆，2014-03 至 2026-07。

**結果**：169 筆來源 → 展開後 **174 筆** viewing_record，指向 **133 部相異作品**，
全部落地、零筆略過。`viewing_record_cost` 169 列、總金額 **5x,xxx 元**。
連跑四次 `--apply`，六個計數全部不變。

片名比對的分佈（**首次匯入**、尚無人工對照表與拆分規則時的 134 個相異片名）：

| 比對路徑 | 片 | 筆 |
|---|---|---|
| 既有片庫（政府 110–113 年）中文片名完全吻合 | 50 | 72 |
| TMDB 比對命中 | 66 | 76 |
| 未命中 → 進 UGC 佇列 | 18 | 21 |

那 18 部未命中中，**16 部 TMDB 其實查得到**，只是片名寫法差一截而未達門檻
（詳下方 ⚠️）；另外 2 部是雙片連映，屬資料語意問題（見 ⑤）。補上人工對照表與
拆分規則後重跑，**未命中降為 0**，人工對照表涵蓋 20 個片名／30 筆紀錄。

**五個實測結論，都與事前假設不同：**

**① 時區偏移的方向與直覺相反。** 上游 `date` 存 UTC 但代表台北牆上時間。
台北 = UTC+8，所以 08:00 以後的場次（含全部晚場）UTC 日期不變，真正會跑掉的是
**午夜場**——台北 00:00 的 UTC 是**前一天** 16:00。169 筆中有 5 筆 00:00 午夜場，
不換算會全部退到前一天。`toTaipeiWallClock()` 用 `Intl` 而非硬寫 +8（台灣 1979 年前
有日光節約時間）。每筆的 `id` 是原始 CSV 列的 base64，解碼後就是答案，
匯入時逐筆交叉驗證——上游哪天改了 `date` 的產生方式會立刻炸出來。

**② `import_key` 不必自己算 hash。** 上游 `id` 就是原始 CSV 列的 base64，
天生確定性。唯一的例外是拆分（見 ⑤），拆出來的用 `<原id>#<序號>`。

**③ 票價欄位的語意要實測才知道。** 169 筆中有 19 筆 `cost ≠ price×tickets+fee−discount`，
因為 `fee` 是**每張**手續費而非每筆（`240,20,2,0,520` → 240×2+20×2）。
一律採用上游的 `cost`，它也是唯一能同時解釋兌換票（0 元）與折扣票的欄位。

**④ 影廳簡稱只能人工對照，不能用演算法。** 15 個口語簡稱與 107 家官方名稱
**零個完全相同**，而子字串比對會出災難性的錯（「林口威秀」的子字串「威秀」
會配到「台北京站威秀影城」）。對照表在 `src/import/venue-aliases.ts`，
每筆附判定依據。其中兩個看似歧義的其實查得出來：「大直美麗華」由 8 筆中 6 筆是
IMAX 場次定為美麗華大直影城（美麗新大直皇家從無 IMAX）；「新竹威秀」由該筆是
2016 年 4DX 場次定為新竹大遠百威秀（巨城館從未設 4DX）。

三家不在 2025 年名冊中——日新威秀（2020-09-08 歇業）、喜滿客京華影城
（2019-11-30 歇業）、AEON THEATUS 心斎橋（日本大阪）。這些是真的去過的地方，
建成 `ugc:` 場所保留歷史，並以 `venue.selectable = false` 擋在選單外
（見 `0002_venue_selectable.sql`）。**新增／編輯紀錄的場所選單必須查
`public.venue_option`，不可直接查 `venue`。**

**⑤ 雙片連映必須拆成多筆紀錄。** 「少女與戰車最終章 1+2」是一次進場看兩話，
TMDB 上四話各自獨立、沒有連映版條目，而一筆 `viewing_record` 只能指向一部作品。
實測 5 筆連映 → 10 筆。三個必須同時做對的細節：票價**全額記在第一筆、第二筆不建
`viewing_record_cost` 那一列**（對半拆會捏造價格，兩筆都記會讓年度總花費翻倍）；
`import_key` 必須互斥否則冪等直接壞掉；備註註明是連映，否則半年後會誤以為重複記錄。
規則在 `src/import/double-features.ts`。

**⚠️ 給後續使用比對器的人：`runtimeOf` 回 null 時最強的驗證訊號會消失。**

片長交叉驗證是比對器唯一能擋住「片名相近但根本是另一部片」的機制，但它只在
片長兩端皆非 null 時生效——任一為 null 會**靜默跳過**而非拒絕比對。政府資料有片長
所以感覺不到，舊 log 沒有片長就踩到了：《Fate stay night Heaven's feel》靠 `zh-prefix`
配到系列**第二部**《Ⅱ.迷途之蝶》，分數 4.5 高於門檻。

**正確的補償方向是收緊而非放寬**：要求 signals 含 `zh-exact` 或 `original-exact`，
否則一律視為未命中，缺口用人工對照表（`src/import/tmdb-overrides.ts`）補。
反過來調鬆門檻，等於在最沒有把握的時候最敢猜。該表的 `reason` 欄記錄每筆
「比對器為什麼沒配到」，是 Step 7 調整門檻時的依據——目前分佈為
`zh-wording` 10、`series-numbering` 3、`zh-has-latin-main-title` 3、
`zh-typo` 1、`zh-too-short` 1、`punctuation` 1。Step 7 的審核 UI 可直接把這張表
當「建議配對」的種子資料。

**新增檔案**：`src/import/{mylog,venue-aliases,tmdb-overrides,double-features}.ts`、
`scripts/import-mylog.ts`、`supabase/migrations/0002_venue_selectable.sql`、
`tests/import.test.ts`（65 個測試）。

**匯入對象一律以 email 精確指定**（`IMPORT_TARGET_EMAIL` 或 `--email`），
不寫死在程式碼裡、也不用「DB 裡唯一一筆 profile」這種假設——多 session 開發時
測試帳號隨時會出現，猜錯就匯到別人身上。

---

### Step 11 — 部署 Vercel

> ## ⚠️ 第一次 `git push` 之前必須先做的三件事
>
> 這個 repo **至今沒有任何 remote，從未 push 過**。以下三件在 push 之前都還可以低成本反悔，
> push 之後就不行了（要 force push、而且別人的 clone 會分岔）。
>
> 1. **重新確認 14MB 的中文字型是否該進版控。**
>    `server/assets/fonts/NotoSansTC-{Regular,Bold}.ttf` 各約 7MB，OG 圖的伺服器端算圖需要它。
>    進版控換到的是「建置不依賴一個會腐爛的 Google Fonts 網址」——而那個網址壞掉的樣子是
>    **OG 圖突然全部變成豆腐格**，一個要等到有人分享連結才會被發現的失敗。
>    決定維持現狀就不必動；要改成建置時下載，**現在改比 push 之後改便宜得多**。
> 2. **確認 git 歷史裡沒有殘留憑證。**
>    2026-09-06 已清過一次（`.env.example` 裡的失效 Google OAuth client secret，
>    以塗銷標記取代而非整行刪除，好讓那個「移除 secret」的 commit 仍然名副其實）。
>    push 前再掃一次：`git cat-file --batch-all-objects --batch-check` 列出全部 blob 後 grep，
>    **不要只掃可達物件**——`refs/original` 與未 gc 的鬆散物件都可能留著。
> 3. **`CRON_SECRET` 的名字。** 見下方環境變數那條，那是唯一一個「名字錯了排程照跑、
>    cron 面板顯示成功、但每次請求都是 401」的設定。

**做**：Framework Preset = Nuxt.js；Build Command 保持 `nuxt build`（**絕不能是 `nuxt generate`**，踩雷 #2）；**不設 `NITRO_PRESET`**（踩雷 #11）；Node 22.x/24.x；環境變數照 2.7；Supabase Redirect URLs 補 `https://*-<team-slug>.vercel.app/**` 與正式網域。

⚠️ **環境變數 `CRON_SECRET` 必須是這個名字**，不能只設 `NUXT_CRON_SECRET`。Vercel 只有在專案環境變數叫 `CRON_SECRET` 時，才會在觸發 cron 時帶上 `Authorization: Bearer <值>`。名字錯了排程照跑、cron 面板顯示成功，但 `/api/cron/*` 每次都回 401 —— 而海報快取會安靜地逾期。

⚠️ **OG 圖的路由必須跑 Node runtime，不能是 Edge。** Vercel Edge 的 bundle 上限是 1MB（Hobby）／4MB（Pro），放不下 6.76MB 的字型。**這件事在本機完全測不出來。**

**怎麼確認它對了**

- 正式站 Google 登入完整走通。
- `curl -I https://filmnote.tw/app` → 有 `x-robots-tag`。
- `curl -I https://filmnote.tw/film/{slug}` 打兩次 → 第二次 `x-vercel-cache: HIT`。
- `curl -I https://filmnote.tw/u/{username}` → **沒有** `x-vercel-cache`。
- **重跑 Step 4 的全部十條驗收，這次打正式站。**（CDN 是新的變因，本機通過不代表線上通過。）
- `/legal/terms` 是 build 時就存在的靜態檔（`prerender: true`）。
- `/` **不是**靜態檔（`isr: 300`）：`curl -I https://filmnote.tw/` 打兩次，第二次應出現 `x-vercel-cache: HIT`。

---

# 6. 法遵要件的落點

## 6.1 ISP 避風港四要件（著作權法 §90-4）

| 要件 | 落點 | 具體內容 |
|---|---|---|
| **① 服務條款告知著作權保護措施，並確實履行** | `app/pages/legal/terms.vue`（SSR，見踩雷 #91：`prerender: true` 實際上沒有生效）<br>`public.legal_document`（kind='terms'）<br>`public.legal_acceptance` | 條款正文含「著作權保護措施」專章。**版本與 `content_sha256` 寫進 `legal_document`**；使用者首次登入後在 `/app` 顯示一次性同意，寫入 `legal_acceptance`。沒有這兩張表，日後無從舉證「已於侵權發生時告知」。 |
| **② 三振條款（三次侵權終止服務）** | `app/pages/legal/terms.vue` 明文條列（第 6 節）<br>`public.copyright_strike` + `admin_add_strike()` + `profile_private.service_status`<br>使用者端狀態依 `SCREENS §15.5` 在 **`/app/settings`**（尚未實作），不是 `app/pages/app/notices.vue` | 條款須明白寫出「三次涉有侵權情事應終止全部或部分服務」。技術落點：第 2 次 `limited`、第 3 次 `terminated`。停權後 `profile_select` 與 `viewing_record_select` 都檢查 `service_status`，公開內容**立即**消失，不需另一支批次工作。 |
| **③ 公告接收侵權通知的聯繫窗口** | `app/pages/legal/copyright.vue`（SSR）<br>`app/components/AttributionFooter.vue`（掛在 `app/layouts/default.vue`，每一個公開頁都有） | 頁面載明**線上受理表單 `/legal/dmca`**、受理程序、所需記載事項（§90-6 及施行辦法）。**必須全站每一頁都能到達。**<br>**不公告電子郵件，也不公告聯絡地址**（2026-09-07 David 裁定）。理由：本服務沒有寄信能力，公告一個收不到信的信箱是做不到的承諾；`filmnote.tw` 這個網域本身實測為 **NXDOMAIN**（2026-09-07 首測、2026-09-08 以 `host filmnote.tw` 與 `host -t MX filmnote.tw` 各覆核一次，兩次皆 `3(NXDOMAIN)`）⇒ 那個位址不但收不到信，連 MX 都不存在。條文（§90-4 第 3 款）要的是「聯繫窗口資訊」，**未指定必須是電子郵件**。<br>⚠️ 舊規格寫的是「窗口電子郵件＋聯絡地址」。**電子郵件那一半不是被判定為錯，是被判定為做不到**——哪天真的有信箱可以收，這條路隨時可以加回來（加回來時要連 §4.2 的墓碑一起處理）。**「聯絡地址」那一半則是從未實作的規格殘留**：頁面上從來沒有過地址，要不要公開一個地址是 David 的事，目前的裁決是不公開，所以這一格不再要求它——留著就是一條永遠不會通過的驗收條件。<br>⚠️ 尚未取得法律意見（見 §8.3 的待決事項）。 |
| **④ 通知／取下／回復通知流程** | 通知：**`app/pages/legal/dmca.vue`**（路徑以 `SCREENS §15.0` 為準，不是 `legal/copyright/notice.vue`）+ `server/api/legal/notice.post.ts` → `public.takedown_notice`<br>取下：`admin_takedown()` 設 `moderation_state='removed'`<br>告知使用者：`takedown_notice.notified_user_at` + `/app/notices`<br>回復通知：**`app/pages/legal/dmca/counter/[noticeId].vue` 尚未實作**（端點 `server/api/legal/counter-notice.post.ts` 已在，入口依 `SCREENS §15.4` 應在內容被取下的地方，不在 `/legal`）→ `public.counter_notice`<br>期限：`business_days_after()` trigger<br>回復：`admin_restore()` | **取下一律是狀態不是 DELETE** —— 刪掉就永遠無法履行 §90-9 的回復義務，這是事後補不回來的 schema 決定。`forwarded_at` 一填，trigger 自動算出 `litigation_proof_due_at`（+10 工作日）與 `restore_due_at`（+14 工作日），各處實作不會漂移。 |

## 6.2 其他法遵落點

| 項目 | 落點 |
|---|---|
| **海報一律熱連結 `image.tmdb.org`，不自行轉存** | `app/components/FilmPoster.vue` 是**唯一**組海報 URL 的地方：`poster_source='tmdb'` → `https://image.tmdb.org/t/p/{size}{path}`；`'ugc'` → Supabase public bucket；`'none'` → 文字卡片。**不要用 `nuxt-og-image` 把 TMDB 海報 pipe 進自己的生成器**——那等同轉存。OG 圖只用純文字卡片或 TMDB 原圖直連。 |
| **海報不得置於付費牆之後**（§90-7 第 2 款） | 本階段**不建立任何 subscription / entitlement 表**。`film_public` view 與 `ugc-poster` bucket 一律對 `anon` 開放。日後若加付費牆，必須撤銷 anon 的 grant——那是一次顯眼、需要 migration、會被 review 看到的決定，不會是誰隨手加個判斷就發生。 |
| **政府開放資料顯名聲明** | `app/layouts/default.vue` 頁尾：「本站部分資料採用文化部影視及流行音樂產業局『電影片分級及相關資訊』與『全國電影院資料』開放資料，依政府資料開放授權條款第 1 版提供。」⚠️ **未盡顯名標示義務者視為自始未取得授權**——這行不可省。 |
| **TMDB attribution** | 同頁尾：TMDB logo（**須 less prominent than 本站標誌**）＋「This product uses the TMDB API but is not endorsed or certified by TMDB.」 |
| **TMDB 快取 ≤ 6 個月** | `film_tmdb_snapshot.expires_at` 預設 180 天；`film_public` view 讀取時 `case when expires_at > now()` 把關；`purge_expired_tmdb_cache()` 為第二道防線。 |
| **Vercel Hobby 商業使用禁令** | 站上**不得**宣傳未來收費、不得放贊助／捐款管道（Hobby 的定義涵蓋此兩者）。收費時同步升級 Vercel Pro + TMDB 商業訂閱。 |
| **DMCA 表單防濫發** | `server/api/legal/notice.post.ts` 必須加 Turnstile 或 rate limit —— `anon` 可 INSERT `takedown_notice` 是法定義務，但**資料庫層完全沒有防護**。 |
| **`memo` 為使用者自由文字且預設公開** | schema 只做長度限制（2000 字），內容審核不在資料庫層，靠 §90-4 的通知／取下流程處理。 |

---

# 7. 已知踩雷點

> **編號規則（2026-09-06 起）。** 本節由多個並行 session 共同維護，而它們看不到彼此。
> 先前大家各自「取尾端的下一號」，實測撞號了——frontend 與 backend 同時寫成 #82。
> 編號一旦發出就會被其他文件引用（如「踩雷 #79」），事後renumber的代價很高，
> 所以改成**由主 session 分配號段**，各自在自己的號段內遞增：
>
> | 號段 | 擁有者 |
> |---|---|
> | #1–#84 | 已發出（歷史，不重新編號） |
> | #85–#99 | frontend（**已用完**，下一段待主 session 分配） |
> | #100–#114 | backend |
> | #115–#129 | design |
> | #130–#144 | adminui（`/admin/**` 與 `/app/import`；主 session 讓出的前段，已用到 #135） |
> | #145–#164 | frontend（第三棒，已收線；號段保留不回收）|
> | #165–#184 | **charts**（2026-09-06 主 session 第三棒配發：圖表、首頁、`/u/`）|
> | #185–#204 | **records**（2026-09-06 配發：`/app/records` 個人紀錄管理）|
> | #205–#249 | **2026-09-07 十二項需求那一波**（十一項並行實作共用一段；條目由協調者代寫、合併後統一發出，所以同一段裡不同條目來自不同 session）|
> | #250+ | 未配 |
>
> **號段內有跳號是正常的，不要為了連號而重排。** 號段用完就跟主 session 要下一段。
>
> ⚠️ **收線的號段不要回頭借用。** 2026-09-07 那一波有兩條線各自提議「借 charts 的 #176–#184」與「借 records 的 #190」——被駁回了：那兩個 session 已經收線，把新條目塞進它們的號段會讓「這一段是誰的」這件事失去意義，而號段本身就是為了讓事後看得出來源。**寧可跳號，不要混用。**

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
| 79 | **★ `@nuxtjs/supabase` 會把來訪者的 session 寫進 `__NUXT_DATA__`，於是「每一條可快取的 SSR 路由」都在外洩身分——與該頁抓了什麼資料無關。** 詳見下方專節 | 2026-09-05 實測（dev 與 production build 皆重現） |
| 80 | **★ `package.json` 的 `imports` 別名（`"#pipeline/*": "./src/*"`）在 Nitro 打包時不補副檔名。** `server/**` 若以 `#pipeline/tmdb/client` 做**值**匯入，執行期會 `ENOENT … open '…/src/tmdb/client'`（沒有 `.ts`）。致命的是 `pnpm typecheck`、`pnpm test`、`pnpm lint` **全綠**——tsc 走 tsconfig `paths` 會補副檔名，vitest 有自己的 `resolve.alias`，只有 rollup 與 vue-tsc 的 Nuxt 子專案不補。⇒ **解法是 `nuxt.config.ts` 的 `alias: { '#pipeline': … }`**（3fdda08 已加），它同時修好打包器與型別檢查兩邊。⚠️ 驗證這一類問題**不能只看 typecheck 綠**，要真的執行到會載入該模組的路徑——本專案同類錯誤已發生三次 | 2026-09-06 實測（Step 9，端點 500 → 加 alias 後以 production build 實跑通過） |
| 130 | **★ 前端頁面 import 到任何含 `node:` 內建模組的 `src/**` 檔案，`pnpm build` 會是 exit 0，但東西不會動——而且 dev 與 prod 的壞法完全不同。** 實測 2026-09-06（`/app/import` import `#pipeline/import/mylog`，該檔頂層有 `import { Buffer } from 'node:buffer'`）：**dev** 是整條路由 500，訊息 `The requested module '/_nuxt/@id/__vite-browser-external:node:buffer' does not provide an export named 'Buffer'`——**光 import 那個模組就炸**，連同檔案裡不碰 Buffer 的純函式一起拿不到；**build** 則是 exit 0，只在 log 留一行 `has been externalized for browser compatibility` 的 WARN，產物編成 `Vt.Buffer.from(e,"base64")` 而 `Vt = {}`（**空物件，不是會 throw 的 Proxy**），要等使用者真的操作到才炸成 `TypeError: Cannot read properties of undefined (reading 'from')`，訊息裡沒有任何 `node:buffer` 的線索。⇒ `src/**` 的純函式要給前端複用，就不能有 `node:` import；`import type` 不受影響（會被完全抹除）。**檢查方式是 grep build log 的 `externalized`，typecheck 與 lint 都不會說話。** | 2026-09-06 實測（Step 10 UI） |
| 131 | **`pages/` 底下可以放非路由檔案，前綴用 `-`（`ignorePrefix`，Nuxt 4 預設值就是 `-`）。** `pages/` 掃的是 `.vue` **和** `.ts`，所以共用的 composable／子元件直接放進去會冒出 `/admin/-admin-shared` 這種路由。加了前綴之後掃描器跳過它，而**顯式相對 import 照樣可用**（那走 Vite 的解析，不看 nuxt 的 ignore 清單）。多 session 並行、共用層屬於別人時，這是把「只屬於這一區的共用碼」留在自己目錄裡的唯一乾淨作法。實測 2026-09-06：production build 只產出 `/admin`、`/admin/films`、`/admin/takedowns`、`/admin/reports` 四條 | 2026-09-06 實測 |
| 91 | **★ `routeRules` 裡帶萬用字元的 `prerender: true` 等於沒有寫，而且 `nuxt build` 根本不會跑預先算繪。** 兩件事疊在一起：① nitro 組預先算繪佇列時明文濾掉含 `*` 的路徑（`filter(([path, o]) => o.prerender && !path.includes("*"))`），所以 `'/legal/**': { prerender: true }` 貢獻 0 條；② Nuxt 4.5.2 的 `nuxt build`（沒有 `--prerender`）與 `nitropack` 的 `build()` **都沒有呼叫** nitro 的 `prerender()`。實測 `pnpm build` 之後 `.output/public/` 裡一個 HTML 都沒有、日誌沒有 `Initializing prerenderer`，而 `nuxt.config.ts` 看起來是設好的。⇒ **這一類設定只能用產物驗收**（`find .output/public -name '*.html'`），看設定檔會得到相反的結論。要真的靜態化就在 `nitro.prerender.routes` 明列具體路徑 | 2026-09-06 實測（`/legal/**`，Step 8） |
| 92 | **Vue 的 whitespace `condense` 在「文字 ↔ 元素」之間留下的是一個空格，不是零。** 前幾棒的教訓（`utils/ticket.ts` 檔頭）講的是**元素 ↔ 元素**之間會被摺掉；反過來這一半同樣會咬人：`…並通知對方。\n<span>不需要註冊…</span>` render 成「並通知對方。 不需要註冊」，中文句子中間多一個看得見的空隙，而 DS §2.5 又禁止手打空格補間距。最惡劣的形式是標點前面：`…你的帳號狀態，\n<a>設定</a>\n。` → 「狀態， 設定 。」。⇒ 中文句子夾行內元素時**整句排成一行**，或把行內元素拉出來自成一段 | 2026-09-06 實測（`/legal/dmca`、`/legal/copyright`） |
| 98 | **★ Vue 對 hydration mismatch 的補救是不對稱的：文字會被改正，屬性不會。** `hydrateElement` 只 patch `on*` 事件，一般 attribute 只在 dev 印一行警告。踩雷 #79 的解法（`strip-auth-on-cacheable.ts` 對 `/`、`/film/**`、`/venue/**`、`/legal/**` 拔 session cookie）讓**已登入者在這幾頁必然 mismatch**，於是導覽列那顆 `v-if="user"` 按鈕變成：**文字換成「我的紀錄」，`href` 卻還停在 `/login`**——已登入的人按下去被丟去登入頁。console 只有一行 `Hydration completed but contains mismatches`，畫面看起來完全正常。⚠️ **把 `to` 改成綁定值讓它進 dynamicProps 沒有用**（實測過）；唯一乾淨的解法是讓兩邊的第一次算繪一致，也就是包 `<ClientOnly>` 並用 fallback 給出伺服器那一版。⇒ 任何「SSR 一律看不到身分、客戶端才知道」的元素都要這樣處理，不只是這一顆 | 2026-09-06 實測（`/`、`/film/*`、`/legal/*` 皆中，`/search` 因為不在拔 cookie 名單裡而正常） |
| 205 | **★★ 正 `z-index` 的 sticky 頂欄，會蓋住所有 `z-index: auto` 的 portal 覆蓋層——而且功能全正常，只有「看起來不對」。** Nuxt UI 4 的 modal／drawer／slideover／dropdownMenu／contextMenu／select／selectMenu／popover／tooltip **九個主題的 overlay 與 content 一個 z-index 都沒有**（`.nuxt/ui/modal.ts` 的 overlay 逐字只有 `fixed inset-0`），而 `UApp` 的 `portal` prop 預設是 `"body"` ⇒ 它們是 body 裡排在 `#__nuxt` 之後、`z-index: auto` 的定位元素。CSS 繪製順序裡「z:auto／0」那一步在「z > 0」之前，所以頂欄一拿到正的 z 就畫在**它們之上**：遮罩蓋住全頁、導覽列浮在遮罩上還亮著，而**對話框照樣打得開、鍵盤照樣能用、console 零錯誤**。reka-ui 全 dist 只有 `Popper/PopperContent.js:231` 會抄 content 算出來的 z（content 沒有 z ⇒ 抄到 `auto`），vaul-vue 零 z-index ⇒ **沒有任何一層會自己救自己**。⇒ 解法是在 `app/app.config.ts` 建一組固定的階（導覽 30 ／ 覆蓋層 50 ／ toast 100，見 `DESIGN_SYSTEM §10`）。⚠️ **用 grep 列舉「要補哪些元件」必漏**：這一輪的計畫 grep 出 9 個實例（UModal／UDrawer／UDropdownMenu），漏掉 `USelect` ×4 與 `USelectMenu` ×6，實際是 19 個。正確做法是**凡是走 portal 的元件全部寫進階裡**，包含目前還沒用到的——未使用的元件不 render，零 CSS 成本；漏掉的成本是下一個人要記得回來補。⚠️ **`app.config.ts` 必須在 `app/` 底下**（Nuxt 4，srcDir 是 `app/`）：放 repo 根是**兩重**靜默失效——(a) 根本不會被載入，(b) 也在 `.nuxt/ui.css` 的 `@source ".../app/**/*"` 之外，連裡面的類別字串都不會生成 CSS。⇒ **z 階驗收的第一條**應該是「開任一 UModal 之後量 `getComputedStyle(document.querySelector('[data-slot=overlay]')).zIndex === '50'`」——這一行同時擋住「檔案放錯位置」「slots 拼錯」「tv extend 沒 merge」三種死法，沒被載入會回 `"auto"` | 2026-09-07 實測（topbar-sticky） |
| 206 | **★★ `document.elementFromPoint()` 在覆蓋層開著時，對堆疊順序永遠說謊。** `reka-ui/dist/DismissableLayer/DismissableLayer.js:88` 在任一 modal 層掛載時把 `document.body.style.pointerEvents` 設成 `"none"`，`Dialog/DialogOverlayImpl.js:36` 再單獨把 overlay 設回 `auto`。而 `elementFromPoint` 做的是**命中測試**、**會跳過 `pointer-events: none` 的元素** ⇒ UModal／UDrawer／UDropdownMenu／USelect 只要開著，導覽列**不論 z-index 多少都命不中**，回傳的一定是 overlay。⇒ 「把 `z-50` 覆寫拿掉就會紅」這個反向斷言**不會紅**：做了跟完全不做都是綠的——而那正是 #205 那條修正最自然的驗法。正解：探針裡先 `document.body.style.pointerEvents = 'auto'`、量完還原（overlay 保有它自己的 inline `pointer-events:auto`，勝負才真的由繪製順序決定）。再加一條**不依賴任何機制的像素交叉驗證**：遮罩是 `bg-elevated/75`，同一個視窗座標在「關著」與「開著」兩張截圖裡必須不同色（亮：rgb(253,249,241) → 約 rgb(239,228,212)；暗：rgb(41,33,26) → 約 rgb(56,46,40)）。兩個像素相同 ⇒ header 畫在遮罩之上 ⇒ 紅 | 2026-09-07 實測（topbar-sticky，審查員查證） |
| 207 | **註解裡寫 Tailwind 類別會被掃進 production CSS，並讓日後的 grep 稽核拿到假命中。** `.nuxt/ui.css` 第 1 行是 `@source ".../app/**/*"`，Tailwind v4 的掃描器是**純文字比對**，HTML／JS **註解裡的類別字串照樣被當成候選**。實測：原本在 layout 的註解裡寫了 `bg-paper-50 dark:bg-paper-950`（用來說明「為什麼**不**用這兩個」），這兩個在 09-06 的 production CSS 裡本來不存在——留著就會生成兩條沒人用的規則，而且會讓「header 是不是用 paper-50」這種 grep 稽核拿到假命中。⇒ 註解裡要提「不該用的類別」時，寫成中文敘述或把 token 拆開，不要留完整的候選字串。判別法：把註解裡反引號包的 token 抽出來，凡是「只在註解、不在程式碼、且 production CSS 尚無對應選擇器」的就是新增的死碼。（`backdrop-blur-sm`／`bg-default/75` 是安全的——它們本來就由 `.nuxt/ui/header.ts`、`table.ts`、`chat-prompt.ts` 帶進產物） | 2026-09-07 實測（topbar-sticky） |
| 208 | **Vue 樣板裡的空白與斷行有三條規則，而「靠縮排留一個空格」是留不住的。** ① **元素↔元素**之間含換行的空白節點會被 `whitespace: 'condense'` **整個刪掉** ⇒ `{{ name }}` 換行後接 `<span>` 留不住那個空格；要穩定得到一個空格，**把它寫進其中一個 span 自己的文字裡**（`<span>{{ name }}</span><span> ({{ city }})</span>`）。② **文字↔元素**之間反而會留一個**看得見的**空格（既有 #92）——中文句子夾行內元素時整句排成一行。③ `whitespace-nowrap` **內部**的空白**不產生軟斷行機會**：三段式那一列的正確形狀是「`<span nowrap>金額</span>` ＋ 純文字節點的分隔斜線 ＋ `<span nowrap>21 場 / 27 張</span>`」；把分隔符關進後面那個 nowrap span 裡看起來一模一樣，但軟斷行機會由**該空白所在 inline box 的 white-space** 決定 ⇒ 整個右側變成一段不可斷的文字，375px 放不下時**直接橫向溢出**（外層 `flex justify-between`、右側 span 有 `min-w-0` 但**沒有** `overflow-hidden`）。⚠️ 反過來把 nowrap 全部拿掉也不行——斷點會落在「27」與「張」之間，那是 `app/utils/ticket.ts` 檔頭記過的「量詞跟數字分家」。**nowrap 只掛原子片段，換行機會只留在分隔符上，而整串必須寫在同一行** | 2026-09-07 實測（venue-dropdown、dashboard-spend-by-year） |
| 209 | **★ 時間預算只決定「要不要再取新工作」，不會砍掉已經在飛的請求——上限不能照函式執行上限去推。** `runTmdbRefresh` 超過預算時是**停止取新工作**，in-flight 的那幾個還要跑完。最壞情況下一個請求要跑完 `TmdbClient` 的整套退避：`maxRetries=5`、429 的退避是 2000·2⁰…2⁴ ＝ 2+4+8+16+32 ＝ **62 秒純睡眠**，再加 6 次 fetch ⇒ `elapsedMs` 最壞是 **budget + 62 秒有餘**。手動觸發的上限因此訂在 60 秒（60+62≈122 秒）而不是逼近 300 秒；被平台砍掉的症狀很難看：回來的是 Vercel 的錯誤頁而不是我們的 JSON。★ 但真正的限制其實不是 Vercel，是**有個人在瀏覽器前面等**——這支端點的設計就是「按一次推進一批，按不完再按」，把預算調到很大等於在跟它自己的設計打架 | 2026-09-07 實測（Step 9a） |
| 210 | **★ `/u/` 的「每年花費」band 與該頁其他部分來自兩個不同的資料來源（今天湊巧同解）。** `/u/[username].vue` 的頁首與紀錄列表走匿名端點 `/api/u/{username}/stats`（逐欄白名單、金額一個都不回）；而那條 band 走 `useUserSpend()`，它打的是 `supabase.rpc('user_year_stats')` 帶**觀看者自己的 session**（security invoker ⇒ RLS 依觀看者求值）。2026-09-07 起 band 的每一列多了**場數與張數**，那兩個數字因此是**觀看者 RLS 視角**的，而同一頁上方的「公開了 174 場」是**匿名視角**的。今天不會出事：實測 174 筆全部 public／visible、0 筆 private，以 anon role 跑同一支 RPC 的 `by_year`，records／tickets 與本人視角**完全相同**。但那是**資料湊巧、不是結構保證**——只要有一筆紀錄設成 private，本人自己看 `/u/` 就會出現「頁首說公開了 173 場、花費 band 那一年說 8 場」。這一輪刻意不處理（要處理就得讓 band 也走匿名端點，而那支端點不回金額）。**改這一塊之前先讀這一條** | 2026-09-07 實測（dashboard-spend-by-year） |
| 211 | **★★ `pnpm typecheck` 是兩支，它們看到的世界不一樣——只跑其中一半會得到相反的結論。** `typecheck` = `typecheck:app`（`nuxt typecheck`，**有 auto-import 的型別**）＋ `typecheck:pipeline`（`tsc -p tsconfig.pipeline.json`，其 `include` 是 `["src", "tests", "scripts", "vitest.config.ts"]`，**不認識 auto-import**）。這一輪三個新測試檔 import 了吃 auto-import 的模組（`createError`／`useRuntimeConfig`／`serviceSupabase`），pipeline 那一半噴一串 `TS2304: Cannot find name …`，**而 app 那一半是綠的**。⇒ 既有慣例是「**被測試 import 的模組必須自足**」——不吃 auto-import、不用 `~/` 別名；`og-card`、`og-cmap`、`mylog-csv`、`app/utils/*` 全都是這樣。**解法是把純函式搬進自足模組，不是去放寬 `tsconfig.pipeline.json`**（放寬之後那兩支 typecheck 就再也擋不住真正的錯）。這一輪因此新增了 `server/utils/tmdb-refresh-options.ts`、`app/utils/avatar.ts`、`app/utils/admin-format.ts`。⚠️ 自足模組對原模組只用 `import type` 就不構成循環相依（執行期會被完全抹除） | 2026-09-08 實測（Step 9a、Google 頭像） |
| 212 | **★ vitest 解析不到 `#supabase/server`——靜態與動態 import 都一樣，這決定了「守門」要怎麼拆。** 實測兩次都失敗：`Error: Missing "#supabase/server" specifier in "filmnote" package`（`vite:import-analysis`）。那是 Nuxt 模組建出來的別名，而 `vitest.config.ts` 只有 `#pipeline` 與 `~`。**動態 `await import(...)` 也一樣**——Vite 在 transform 期就會解析字面量的動態 import，不會等到執行期。⇒ 想讓任何授權邏輯**可被單元測試**，那個模組就不能在任何地方 import `#supabase/server`：把決策放進純函式（`assertStaffFrom(probe)`，見 `server/utils/admin-auth.ts`），supabase 的接線留在端點裡各寫一次。附帶的好處比代價大——端點檔裡看得到 `serverSupabaseClient(event)` 這個字，讀的人一眼就知道「問 `is_staff()` 的是使用者自己的 client」，包進共用函式反而會讓最該被看見的事消失。⚠️ 若日後想改成單一接線點，可以在 `vitest.config.ts` 補一條 alias 指到 `@nuxtjs/supabase` 的 runtime server 檔，但那會讓測試依賴一個 Nuxt 模組的內部路徑 | 2026-09-07 實測（Step 9a） |
| 213 | **★ `oxlint` 對 `.vue` 檔是完全的 no-op——`pnpm lint` 有一半在守元件時是空的。** 實測：把一個引用未定義變數的 `const` 塞進 `app/components/DistributionBars.vue`，`pnpm exec oxlint <該檔>` **零輸出、exit 0**；換成 `;; var probeUnused = 1` 餵給 eslint 則抓到 7 個 error（`style/semi`、`style/semi-spacing`、`style/no-multi-spaces`、`vars-on-top`、`no-var`、`style/max-statements-per-line`、`unused-imports/no-unused-vars`）。`pnpm lint` = `oxlint . && eslint .` ⇒ 對 `app/components/*.vue`、`app/pages/**/*.vue`，**只有 eslint 那一支在守**。不要因為「oxlint 綠了」就以為元件被 lint 過，也不要在 CI 或驗收腳本裡只跑 oxlint 就宣稱元件通過 | 2026-09-07 實測（4-其他可展開） |
| 214 | **★ 字面全形空白 U+3000：`no-irregular-whitespace` 在註解裡是 error，在字串與樣板字串裡合法——同一波三份簡報各答錯一半。** 計畫寫「字面 U+3000 貼進原始碼會被 lint 擋」；審查員實測 `pnpm exec eslint app/utils/stats.ts` exit 0，於是判定「那句話是錯的，兩種寫法都過得了 lint」。**兩邊都不準確**：`pnpm lint` 是 `oxlint . && eslint .`，審查員只跑了後面那一支（#213）。實測 2026-09-07：`pnpm exec oxlint app/utils/stats.ts` 對**貼了字面全形空白的兩行 JSDoc 註解**報 `error eslint(no-irregular-whitespace)`，而同一支檔案**樣板字串裡**的字面 U+3000 一個都沒被報。原因是規則沿用 eslint 的預設選項：**`skipStrings: true`（樣板字串算 string）、`skipComments: false`**。這一輪真的因此紅了四處（已修）。⇒ 規矩：**程式碼裡照樣寫字面 U+3000**（既有的 `slotTitle` 就是），**註解裡不要貼**——要舉例就寫「全形空白」四個字，或寫成 `U+3000`。⚠️ 這一類紅燈很容易找錯人：`git show HEAD:app/utils/stats.ts \| oxlint` 是乾淨的，紅燈是同一波另一條線新加的註解帶進來的 | 2026-09-07 實測（repeat-list-drawer、4-其他可展開）；2026-09-08 協調者覆核 |
| 215 | **多條 session 並行時，`/tmp` 底下的腳本檔名會被別條線整個覆蓋。** 實測 2026-09-07：`/tmp/fn_render.mjs` 跑過三次都正常，第四次突然 `Cannot find package 'vue' imported from /private/tmp/fn_render.mjs`——打開一看，檔案內容已經整個變成另一條線的腳本。#167 記的是「別人改工作樹會給你假紅燈」，這是它的另一面：**別人的暫存檔會給你一個看起來像環境壞掉的錯誤**（找不到套件、路徑不對），很容易讓人去查 `node_modules`。⇒ 驗證腳本一律放 `/tmp/<item_key>/` 底下，不要用 `/tmp/<通用名>.mjs` | 2026-09-07 實測（topbar-sticky） |


### 踩雷 #79 詳述：為什麼 #1 的理由涵蓋不到這個情況

#1 說的是「`/u/**` 不可快取，因為 **RLS 依觀看者而異**，同一個 URL 會 render 出不同 HTML」。那個理由把問題定位在**資料層**：頁面自己去查了會因人而異的東西。照這個理由推論，只要一條路由的 SSR 只讀公開資料，它就可以安全地快取——`/film/**` 正是照這個推論被設計成 ISR 的。

**這個推論是錯的。** 外洩不發生在資料層，發生在**框架的狀態序列化層**。

`dist/runtime/plugins/supabase.server.js` 的最後一段是無條件執行的：

```js
if (useSsrCookies) {
  const [session, user] = await Promise.all([
    serverSupabaseSession(event).catch(() => null),
    serverSupabaseUser(event).catch(() => null),
  ])
  useSupabaseSession().value = session   // ← 完整 session，含 access_token
  useSupabaseUser().value    = user      // ← 含 email、sub
}
```

`useSupabaseSession()` / `useSupabaseUser()` 就是 `useState('supabase_session')` / `useState('supabase_user')`，而 Nuxt 會把**所有** `useState` 序列化進 `__NUXT_DATA__`。這個 plugin 對每一次 SSR 都跑，不管當前路由是什麼、也不管頁面有沒有用到 `useSupabaseUser()`。

實測（`/film/{slug}`，一條 SSR 期間完全不碰使用者身分的 ISR 路由）：

| 造訪者 | `__NUXT_DATA__` 大小 | 內含 |
|---|---|---|
| 匿名 | 411 bytes | — |
| 已登入 | **1847 bytes** | `email`、`sub`、以及一枚 `role=authenticated`、尚有約 59 分鐘效期的**合法 `access_token`** |

該頁的 API（`server/api/film/[slug].get.ts`）用的是刻意 cookie-free 的匿名 client，實測三種請求（匿名／帶 `service_role` Authorization／帶偽造 cookie）回應**逐位元組相同**——資料層完全乾淨。**那救不了它。**

Vercel 的 ISR 以「路徑」為快取單位 ⇒ 第一位登入者造訪 `/film/xxx` 之後，他的 access_token 就被存進 CDN，發給之後每一位訪客，直到快取過期。拿到那枚 token 的人可以直接以他的身分呼叫 API。

**判準因此要改寫**：不是「這個頁面的資料會不會因人而異」，而是「**這個回應會不會被發給第二個人**」。只要答案是會，SSR 期間就不能有任何管道看得到來訪者身分——包括框架自己開的那條。

三種處理方式的取捨：

| 做法 | 問題 |
|---|---|
| `useSsrCookies: false` | 全域生效，`serverSupabaseUser()` 一併失效，而 §5 Step 7 的管理端點正需要它驗身分（踩雷 #26） |
| 在 `render:html` hook 裡把 payload 的那兩個 key 挖掉 | 對已產生的序列化字串做手術，格式一變就靜默失效 |
| **在可快取路由上把 auth cookie 從請求拔掉** ✅ | 讓那段 `if` 拿到 `null`，狀態自然是空的。代價是這些頁面 SSR 一律 render 成未登入的樣子，hydration 後才補上（導覽列閃一下）——對本來就要發給所有人同一份 HTML 的頁面，這正是應該的行為 |

實作見 `server/middleware/strip-auth-on-cacheable.ts`。**該檔的路由清單必須與 `nuxt.config.ts` 裡有 `isr` / `prerender` 的 routeRules 保持一致**——新增任何可快取路由時要同步，漏掉不會有任何錯誤訊息。

驗收方式（不能只看畫面，要掃 payload）：

```bash
pay(){ curl -s "$@" | sed -n 's/.*__NUXT_DATA__[^>]*>\(.*\)<\/script>.*/\1/p'; }
pay -H "Cookie: $REAL_SESSION_COOKIE" "$SITE/film/$SLUG" > /tmp/a
pay                                    "$SITE/film/$SLUG" > /tmp/b
grep -c 'access_token' /tmp/a          # 必須 0
diff /tmp/a /tmp/b                     # 除了 SSR 時戳外必須完全相同
```

⚠️ 驗這條時**務必用真的 session cookie**。手工拼一個假的會被模組拒絕、`$ssupabase_user` 停在 `null`，於是測試「通過」而實際上什麼都沒驗到——本專案第一次就踩了這個假陰性。判斷 cookie 有沒有生效：payload 裡找得到自己的 email 才算數。


## 7.2 Supabase / Auth

| # | 踩雷點 | 來源 |
|---|---|---|
| 13 | **v2 破壞性變更：`useSupabaseUser()` / `serverSupabaseUser()` 回傳 JWT claims 不是 User 物件。`user.id` 不存在，要用 `user.sub`。** 舊教學幾乎全是 v1 寫法。⚠️ **`pnpm typecheck` 抓不到這條**（實測 2026-09-06 再犯一次）：型別上 `user.value.id` 完全合法，執行期才變成 `undefined`，而症狀是 PostgREST 收到 `user_id=eq.undefined` 回 **400 `invalid input syntax for type uuid`**——supabase-js 把錯誤放在 `error` 而 `data` 是 `null`，呼叫端若寫 `data ?? []` 就會拿到一個**空集合當成正常答案**。當時的具體後果：`/app/import` 的匯入前對帳把「已經有 122 筆、這次新增 0 筆」說成「這次新增 122 筆」，也就是**邀請使用者去按一顆會重複匯入的按鈕**。⇒ 新寫的查詢一定要看一次 Network 面板有沒有 4xx，不要只看畫面有沒有東西 | 官方 migration 頁；`serverSupabaseUser.js`；issue #561；2026-09-06 實測 |
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
| 216 | **★★ 踩雷 #13 已經記載過了，但它仍然復發了三次——因為型別檢查不會說話。** `serverSupabaseUser()` 在 `@nuxtjs/supabase` v2 回的是 **JWT claims**（`JwtPayload`，`sub` 是 `RequiredClaims` 的必填欄位），**沒有 `id`**；而 `JwtPayload` 有**索引簽章** ⇒ `user.id` 在型別上完全合法，執行期是 `undefined`，`pnpm typecheck` 一個字都不會說。2026-09-08 的對抗式覆核在 repo 裡找到**三處既有的生產缺陷**：`server/api/admin/films/[id]/approve.post.ts` 與 `server/api/admin/films/merge.post.ts`（稽核日誌的 `by` **永遠不存在**——`JSON.stringify` 會把值為 `undefined` 的鍵**整個丟掉**，所以連「這個欄位是 null」都看不到），以及 **`server/api/legal/counter-notice.post.ts`——那一支讓 §90-9 回復通知整條不可用**（`profile_id=eq.undefined` → PostgREST 400 → 端點 500；就算繞過查重，`.insert()` 也會把那個鍵省掉而撞 NOT NULL）。四處已修成 `user.sub`。⇒ **教訓是「#13 記載過了還是會再犯」，所以處方要換**：① #13 原本的處方（新寫的查詢看一次 Network 有沒有 4xx）靠的是記性，顯然不夠；② **把 `sub` 寫進型別**，讓呼叫點沒有寫錯的機會——這一輪的新端點走的是這條：`StaffProbe.user` 直接宣告成 `() => Promise<{ sub: string } \| null>`，**呼叫點一行轉換都不用寫**（宣告成 `{ id: string }` 再要求三個呼叫點各轉一次 `{ id: c.sub }`，就是給了三個寫錯的機會，而寫錯的症狀是靜默的 `undefined`）。**下筆前先讀 `server/utils/admin-auth.ts` 的檔頭** | 2026-09-08 對抗式覆核（四處實修） |
| 217 | **★ 以 service role 呼叫 `is_staff()` 的後果是 fail-closed，不是 fail-open——而最自然的修法會把門真的打開。** `is_staff()` 查的是 `exists(select 1 from public.profile_private where id = auth.uid() and role in ('moderator','admin'))`（`0001_init.sql:129`），而 service role 的 `auth.uid()` 是 **NULL** ⇒ 回 **false**。實測 2026-09-07：以 service key 呼叫 `POST /rest/v1/rpc/is_staff` 回 `false`（HTTP 200）。所以把授權接成 service role **不會讓所有人變成 staff，而是讓所有人被擋，包括 David**。⚠️ 真正的危險在**下一步**：為了修好那個 403，把判準換成 `is_service_context()`（service role 對它永遠 true），或乾脆把那一步拿掉——**拿掉才是 §1.1 記載的那個洞**（任何登入者都能觸發一次 service role 的工作）。⇒ **看到這種 403 要修的是「接錯了哪個 client」，不是「換一個判準」。** 這一條是實作者自己先把註解寫反、實測才抓到的：不寫下來，下一個人會照著錯的模型推理 | 2026-09-07 實測（Step 9a） |

## 7.3 資料庫 / RLS（本次評審實際找到的）

| # | 踩雷點 | 來源 |
|---|---|---|
| 29 | **只 revoke PUBLIC 或只 revoke anon/authenticated，兩種寫法單獨都不夠。** Postgres 內建預設把 EXECUTE 給 **PUBLIC**，而 Supabase 另外還直接授給 **anon/authenticated**（見 #73）。必須三個對象一起 revoke | judge-leak + 2026-09-05 實測 |
| 30 | **絕不用 `auth.uid() is null` 當「service_role 直連，放行」的判準。** anon 的 `auth.uid()` 同樣是 NULL —— 這條件把守門邏輯對未登入者整組關掉（提案 3 因此讓 anon 可呼叫破壞性 RPC） | judge-practical |
| 31 | **也不能用 `current_user` 判斷特權情境（★ 實測已攻破，非理論風險）。** 在 SECURITY DEFINER 內 `current_user` 是函式擁有者 `postgres`，於是**任何拿得到 EXECUTE 的人**都被判成服務端。實測：一般登入使用者呼叫 `rpc/merge_films` 回 **HTTP 204**，任意兩部作品被合併。改用 `session_user` + PostgREST 的 `request.jwt.claims.role`，見 §1.1「修正 A 的更正」 | judge-practical + 2026-09-05 實測 |
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
| 46 | ~~**`delete from auth.users` 是否為 postgres 可執行需實測。**~~ → ✅ **可以**（實測 2026-09-06，PG 17.6）。`auth.users` 的 owner 是 `supabase_auth_admin`、RLS 開著且零條 policy，但 `postgres` 同時有 DELETE 權限與 `rolbypassrls` ⇒ 一支 owner 為 postgres 的 SECURITY DEFINER 函式刪得掉，**不需要 Edge Function**。已由 `delete_my_account()`（0009）採用，並在 migration 冒煙測試與 `verify-all` 的 `http/account-auth-gone` 兩處各真的刪過一次。⚠️ 靜態的 `has_table_privilege` 只是提示，見 #111 | 2026-09-06 實測 |
| 73 | **★ Supabase 的專案樣板自帶 `ALTER DEFAULT PRIVILEGES … GRANT … TO anon, authenticated, service_role`，涵蓋 tables / sequences / functions 三種物件。** 也就是**每一張新表出生就對 anon 有 `arwdDxtm`（含 DELETE/TRUNCATE），每一支新函式出生就對 anon 有 EXECUTE**，而且是**直接授予 anon**、不經由 PUBLIC ⇒ `revoke … from public` 拿不掉。任何「我沒 grant 所以 anon 讀不到」的推論在 Supabase 上都是錯的，RLS 是唯一還在擋的東西。查證指令：`select pg_get_userbyid(defaclrole), defaclobjtype, defaclacl from pg_default_acl;` | 2026-09-05 實測（新專案即如此） |
| 74 | **`alter default privileges … revoke execute on functions from public` 在 Supabase 上擋不住未來的函式。** 對 anon/authenticated 的 revoke 有效，但 PUBLIC 那份拿不掉——新函式的 `proacl` 會塌回 `NULL`，而 `NULL` 就是內建預設（PUBLIC 有 EXECUTE）。⇒ 不要相信「日後新增的函式預設不可執行」這個保證，改用 migration 結尾的白名單自我檢查 | 2026-09-05 實測（PG 17.6） |
| 75 | **函式的 blanket revoke 必須放在所有 `create function` 之後。** 放在中間的話，後面才建立的函式會重新拿到 #73 那份預設授權。表與序列的 revoke 則相反，要放在 `grant` **之前**，否則會把剛給的權限一起洗掉 | 同上 |
| 81 | **★ 「作品有 `tmdb_id`」不等於「有 `film_tmdb_snapshot` 列」，而待刷新佇列是從快照表 join 出去的。** 實測 2026-09-06：2,480 部帶 `tmdb_id` 的作品只有 2,401 列快照，**79 部從未進過 `tmdb_refresh_due`** ⇒ 永遠沒有海報，而刷新排程回報「全部刷完了」。缺的那批全是舊 log 匯入時 `upsertTmdbFilm()` 建的（`seed_films` 與 `link_film_to_tmdb` 都有補佔位列，只有它漏了）——也就是 David 紀錄實際指到的作品，多刷排行最顯眼的位置。⇒ 這種「少了 N 但沒有錯誤訊息」的不變量要用 trigger 釘在資料庫層（`0004`），不要交給每一個寫入者記得 | 2026-09-06 實測 |
| 84 | **★ SECURITY INVOKER 的 trigger 所呼叫的 helper，必須對「觸發它的那個人」開 EXECUTE。**`9999_grants.sql` 的 blanket revoke 會把 helper 一起收掉，而 trigger 建立時、migration 套用時、`\df` 檢查時**全部正常**——症狀只在真實使用者第一次觸發時出現，形式是一句沒有上下文的 42501。實測案例：`counter_notice_deadlines`（INVOKER）呼叫 `business_days_after()` 算 §90-9 的兩個法定期限，而後者只 revoke 沒 grant ⇒ **使用者提不出回復通知**，且這個洞只有在真的有人被取下、又真的要主張未侵權時才會炸——也就是它最不能壞的時候。⇒ 新增 trigger 時要問「這支是 INVOKER 嗎？它呼叫了誰？那個誰對 anon/authenticated 開了嗎？」 | 2026-09-06 實測（Step 8 驗收） |
| 100 | **★ `set local role` + `set_config('request.jwt.claims',…)` 模擬得了 `is_staff()` 與 RLS，但**模擬不了 `is_service_context()`**。** 它的第一個條件是 `session_user in ('postgres',…)`，而 `SET ROLE` 只改 `current_user`，**`session_user` 直連時永遠是 postgres** ⇒ 凡是 `is_service_context() or is_staff()` 判準的函式（`merge_films`、`link_film_to_tmdb`、`apply_tmdb_snapshot`…）在 db:sql 腳本裡**一律放行**，而那是正確的。危險在於拿它當授權測試：期望被擋 → 回報「破口重現」（其實是測試方法錯）；期望成功 → 得到一個永遠通過的假綠燈。**這類授權只能用真的 PostgREST + 真的使用者 JWT 測。** 實測 2026-09-06：一般登入者 403/42501、匿名 401/42501 | 2026-09-06 實測（Step 7 驗收） |
| 101 | **`serverSupabaseUser()` 只認 cookie，不認 `Authorization: Bearer`。** 拿真實使用者 JWT 直接打自家 `/api/admin/**` 一律 401，看起來像端點壞了。要測必須自組 @supabase/ssr 格式的 session cookie：`sb-<project-ref>-auth-token` = `base64-` + base64(JSON.stringify(session))，session 取自 `POST /auth/v1/token?grant_type=password` 的完整回應 | 2026-09-06 實測 |
| 102 | **★ storage 的「安全」與「bucket 不存在」在 HTTP 上長得一模一樣**（`/object/public/…` 都是 400、`/object/list/…` 都是 `[]`）。BUILD_PLAN §5 Step 7 的驗收指令指向 `ugc-poster-pending`，而那個 bucket **從來不存在**（只在提案 1 的研究文件裡）⇒ 照著跑會全部「通過」，但通過的理由是查無此 bucket。**任何「應該看不到」的測試都要配一組「應該看得到」的對照**：實測時以作者自己的 JWT 列舉同一個前綴必須回得到那個檔案，才證明 `[]` 是 RLS 擋的而不是根本沒東西 | 2026-09-06 實測（Step 7 驗收） |
| 103 | **★ 驗收清單本身會過期，而過期的驗收產生的是「假紅燈」——它會誘使人去改一條其實沒壞的東西。** §5 Step 2 兩條實測：③「不得有 anon 可執行的 SECURITY DEFINER 函式」照字面寫會列出九支**必要**的 policy helper（`is_staff`／`account_is_servable`／`record_is_public`…）然後翻紅，而它們必須是 DEFINER 且必須對 anon 開 EXECUTE，否則全站 403；⑤ 的 `zz_probe` 期望 `has_function_privilege('anon',…)` 為 **false**，但後來的 #74 實測推翻它——那件事在 Supabase 上擋不住，真正守門的是 9999 §3 的顯式白名單。⇒ 斷言要鏡射**現行**的守門機制，不是抄一份舊敘述；期望值與現實相反時，先確認是哪一邊過期 | 2026-09-06 實測（verify-core 首跑） |
| 104 | **斷言的取樣範圍寫太寬 = 永遠紅。** verify-core 的 B2 原本用 `film_identity.key like '%verify%'` 驗「私密作品的 slug 不外洩」，結果把同一支腳本建的**公開**測試片也撈進來，於是永遠紅。假紅燈與假綠燈一樣危險：它指向一條沒壞的 policy。⇒ 「某某東西不該被看到」的斷言一律以**主鍵**取樣，不要用片名／前綴之類會誤中的條件 | 2026-09-06 實測 |
| 105 | **★ 不要把私用區字元／控制字元字面貼進原始碼或 SQL。** 它們在編輯器、終端機、heredoc、剪貼簿之間很容易被吃掉，而**肉眼看不出來已經壞了**。2026-09-06 一天內被吃掉三次：verify-core 的 D1 正則、`defensive.ts` 的 `PRIVATE_USE_RE`（字面版本變成 `[-]`——一個什麼都比對不到的字元類別，tsc 完全不抱怨）、以及測試裡的 PUA 常數。⇒ 一律寫 `\uXXXX`（JS）或碼位比較（SQL 用 `ascii(ch) between 57344 and 63743`）。驗證方式：`od -c` 或 `[hex(ord(c)) for c in val]`，確認那一行**全是 ASCII**。這類壞掉的產物一律靜默——正則不報錯，只是永遠不命中 | 2026-09-06 實測 |
| 106 | **★ 新增 policy 時有兩個獨立的坑，而且症狀完全不同。** ① **policy 內對別張表的子查詢會套用那張表的 policy，可能繞回來。** `film_delete_own_ugc` 要檢查「有沒有 viewing_record 引用」，直接寫 `exists (select 1 from viewing_record …)` ⇒ `record_read` 又 `exists (select 1 from film …)` ⇒ **infinite recursion detected in policy for relation "film"**。解法是包成 SECURITY DEFINER 的 helper（0001 的 helper 全是 DEFINER 正是為此），並記得在 9999 對 `authenticated` 開 EXECUTE（否則是 #84）。② **policy 決定「哪些列」，表級 grant 決定「能不能做這個動作」。** 少了 `grant delete`，policy 寫得再對也只是 `permission denied for table film`。兩個坑在同一支 migration 裡先後炸了兩次 | 2026-09-06 實測（0008） |
| 107 | **satori 缺字重時不做 fake bold，而且不吭聲。** 只載入 Regular 時，`fontWeight: 700` 與 400 渲染出**完全一樣**的輪廓（實測 path 總長 16,243 vs 16,257，差值來自文字本身不同）——沒有警告、沒有錯誤，只是階層消失。⇒ OG 圖要有字重階層就必須真的打包那個字重（本專案 Regular + Bold 共 14MB，那 7MB 是買到東西的）。想省字型就得改用尺寸／顏色拉階層，不能指望它自己變粗 | 2026-09-06 實測 |
| 108 | **★ 原生模組（napi）一定被外部化，而 `.output` 追蹤到的是「建置當下那台機器」的二進位。** 實測：`pnpm build` 後 `.output/server/node_modules/@resvg/` 只有 **`resvg-js-darwin-arm64`**，而 Vercel 跑的是 linux-x64。兩個推論：① `satori` 與 `@resvg/resvg-js` **都**出現在 `.output/server/package.json` 的 dependencies ⇒ 它們必須在**專案的** `dependencies` 而非 `devDependencies`，否則正式環境 `--prod` 安裝時裝不到，症狀是本機全綠、部署後端點 500；② **不要部署本機建好的 `.output`**（`vercel deploy --prebuilt`）——那會把 darwin 的 .node 送上 linux。讓 Vercel 自己建就沒事 | 2026-09-06 實測 |
| 109 | **★ 在較晚的 migration 裡 `create or replace` 一支較早 migration 已經修過的函式，等於把那個修正刪掉——而且完全沒有聲音。** 實測 2026-09-06：`0009` 為了「profile_id 現在可以是 NULL」而重新定義 `apply_three_strikes()`，函式體是照 `0001` 抄的，於是 `0006` 對它做的修正（三振全部撤銷時 `service_status` 要歸回 `active`）被靜默回退。`create or replace` 不會告訴你覆寫了誰，所有靜態檢查照樣全綠，是 `verify-dmca.sql` 的 F 段把它抓出來的。⇒ 要改一支別人改過的函式，**去改定義它的那一支 migration**；非得在後面的 migration 動不可時，用 `pg_get_functiondef()` 讀出現行定義再字串取代（`0008` 對 `seed_films.country`、`0010` 對 `titleOriginal` 都是這樣做的，兩個修正因此會疊加而不是互相覆蓋） | 2026-09-06 實測（0009） |
| 110 | **★ 串在一起的多條防護，若沒有「只有它擋得住」的案例，其中幾條就是裝飾品。** `0009` 的冒煙測試第一版驗「刪帳號不會炸掉別人引用中的作品」：把 `account_purgeable_films` 裡的引用檢查**整段刪掉**，測試**照樣全綠**——因為那部被引用的作品是 `approved`，早在前一個條件 `review_state <> 'approved'` 就被擋掉了，引用檢查從頭到尾沒有被求值過。反過來拿掉 `review_state` 那條也一樣綠（引用檢查接住了）。⇒ 每一條防護都需要一個**只有它擋得住**的案例；最好的證明是逐條把它弄壞一次，看是不是**那一條**變紅。四部作品（已核准被引用／未核准被引用／已核准無人引用／未核准無人引用）才把兩條防護分開 | 2026-09-06 實測（0009） |
| 111 | **★ `public` schema 清乾淨但 `auth.users` 那一列還在 ＝ 殭屍帳號。** 使用者再用 Google 登入會拿到一個「有 session、但沒有 profile」的狀態：`account_is_servable()` 為 false ⇒ 個人頁對外消失、連自己都建不了紀錄，而 `on_auth_user_created` 是 **AFTER INSERT**，不會再補一次（`0001` 那段 backfill 只在套用 migration 當下跑過）。⇒ 帳號刪除**必須**刪掉 `auth.users`，`auth.identities`（Google 的 sub 與 email）才會跟著 CASCADE。另外：`has_table_privilege('postgres','auth.users','delete')` 回 true 只證明**權限**，證不了函式體會不會炸（#103 的家族）——冒煙測試要真的建一列、真的刪一次 | 2026-09-06 實測（0009） |
| 112 | **同一個白名單存在兩份：`9999_grants.sql` §3 與 `verify-core.sql` 的 A3。** 新增一支對 anon 開放 EXECUTE 的 RPC 只改一邊，另一邊會翻紅。**這是設計如此**（migration 一道門、驗收一道門，互為對照），不要為了「只改一處」把其中一份刪掉。實測 2026-09-06：`user_year_counts`（0010）補了 9999 那份，`verify:all` 立刻被 A3 擋下。⇒ 新增這類 RPC 時**兩份都要改**，而且要記得 9999 §2 的 blanket revoke 會先把 grant 收掉——只在別的 migration 裡 `grant … to anon` 而沒補進 9999，重跑 9999 就會靜默撤銷它（實測確認：`has_function_privilege('anon',…)` 從 true 變 false，症狀是端點回沒有上下文的 401） | 2026-09-06 實測（0010） |
| 113 | **NOT NULL + 由 BEFORE trigger 填值的欄位，在自產型別裡會是 `Insert` 的必填欄。** `subject_ref`（0009）由 `fill_subject_ref` trigger 自動補成 `profile_id`，執行期完全不需要寫入端給值，但 `gen-types.ts` 只看「有沒有 default／可不可為 NULL」⇒ TS 端所有 `.insert()` 都會編譯失敗。⇒ **不要為了讓型別好看而拿掉 NOT NULL**：trigger 是給 SQL 層寫入端（`admin_add_strike`）的後盾，型別要求是給 TypeScript 寫入端的**編譯期**提醒，兩層都留著才是對的。忘記帶會變成編譯錯誤，而不是等到某人刪帳號、證據鏈斷掉之後才發現 | 2026-09-06 實測（0009） |
| 114 | **`text[] \|\| '字串常值'` 會被解讀成陣列串接，不是附加一個元素。** PostgreSQL 對未定型的字串常值優先選 `anyarray \|\| anyarray`，於是去解析那句中文訊息當作陣列字面值 ⇒ `malformed array literal`。要命的是**它只在斷言真的要變紅的那一刻才炸**：平常全綠，該報錯時整支腳本 error 掉，而 error 與「有幾條沒過」在輸出上長得不一樣，很容易被當成腳本壞了而不是東西壞了。⇒ 一律寫 `fails := fails \|\| format('…')`（`verify-core.sql` 既有的每一條都是這樣，新加的三條抄漏了）。**新增斷言之後一定要故意把它弄紅一次**，否則測不到這種只在紅燈路徑上的錯 | 2026-09-06 實測（verify-core E3/E4/E5） |
| 115 | **`create or replace` 加參數會產生「重載」而不是取代。** `approve_film` 從 `(uuid, boolean)` 變成 `(uuid, boolean, text)` 時，`create or replace` 會讓**兩支同名函式並存**，而 PostgREST 對 `rpc/approve_film` 回 **300 Multiple Choices**——不是 500，是一個看起來像路由問題的狀態碼。必須先 `drop function public.approve_film(uuid, boolean)`。⚠️ 而 `drop` 會把 `9999_grants.sql` 給過的 EXECUTE 一起帶走 ⇒ **簽名一改，9999 的那一行也必須改**，否則下次重跑 9999 會在 `to_regprocedure` 找不到舊簽名時靜默略過（或直接 raise）。同理適用改回傳型別（那連 `create or replace` 都不允許） | 2026-09-06 實測（0011） |
| 116 | **`eslint --fix` 會做出型別上不等價的改寫，而 `tsx` 不檢查型別 ⇒ `verify:all` 全綠、`pnpm typecheck` 紅。** 實測：`e18e/prefer-array-fill` 把 `Array.from({ length: 64 }, () => 0)` 改成 `Array.from({ length: 64 }).fill(0)`——執行期完全一樣（都是 64 個 0），型別卻從 `number[]` 變成 `unknown[]`，於是 `new Uint8Array([...])` 不再合法。因為 `scripts/**` 是用 tsx 跑的（只去型別、不檢查），所有斷言照樣通過。⇒ **動完 `scripts/**` 或 `server/**` 之後，`verify:all` 與 `pnpm typecheck` 兩個都要跑**；只跑前者會把型別錯誤留到下一個人手上 | 2026-09-06 實測 |
| 117 | **★ 「哪些路由會被快取」不要自己維護第二份清單，向 Nitro 問 `getRouteRules(event)`。** `strip-auth-on-cacheable.ts` 原本寫死一條正則並宣稱「與 nuxt.config 的 routeRules 保持一致」，而 `/legal/**` 改成 `no-store` 之後那句話變成假的。這一次漂移的方向剛好安全（多拔一次 cookie 無害），**下一次未必**——少寫一條的症狀是一枚合法 access_token 被 ISR 寫進 CDN 並發給所有訪客，而畫面完全正常。⚠️ 判斷條件是 `isr \|\| prerender \|\| cache`，**沒有 `swr`**：`NitroRouteRules` 的定義是 `Omit<NitroRouteConfig, 'redirect' \| 'cors' \| 'swr' \| 'static'>`，`swr: true` 在建置期就被正規化成 `cache`，執行期讀 `rules.swr` 永遠是 undefined。照 nuxt.config 的字面去找 `swr` 會得到一個永遠不成立的判斷 | 2026-09-06 實測 |
| 118 | **★ 檔名寫成 `[param].png.get.ts` 時，router param 的鍵是 `param.png` 而不是 `param`。** 實測（把 `event.context.params` 直接回傳出來看）：`GET /api/og/u/clipwww.png` → `{ "username.png": "clipwww.png" }`。於是 `getRouterParam(event, 'username')` 永遠是 `undefined`，`/api/og/u/**` 與 `/api/og/record/**` **對每一個請求都回 400**——在 dev 就成立，不是部署才會出現的問題。它一直沒被發現的原因有兩層：`scripts/og-preview.ts` 直接呼叫 render 函式、完全繞過 HTTP 路由；而 OG 圖壞掉的樣子是**社群分享卡片沒有圖**，站上任何一頁都看不出異狀。⇒ 這類「副檔名黏在參數上」的路由一律從 `event.path` 取最後一段（見 `server/utils/og-route.ts`），不要依賴那個沒有文件保證的鍵名。**而且驗收要驗到「真的是 1200×630 的 PNG」為止**，只看狀態碼分不出 200 回的是圖還是 JSON | 2026-09-06 實測 |
| 119 | **舊 log 的 `import_key` 有一條推不出來、只能從真資料量的規則：完全相同的原始 CSV 列會被上游加 `#1` / `#2` 後綴，而且第一筆也有。** 實測 DB 裡 175 個 import_key：165 個唯一列**沒有**後綴，5 組各出現兩次、兩筆分別是 `#1`/`#2`，五組無例外。那個後綴是**上游 API 產的**（我們的 importer 只是把 `item.id` 原樣當 import_key），所以 CSV 上傳路徑必須自己複製這條規則。不做的話那五組會各自撞上 `unique (user_id, import_key)`，而 `on conflict do update` 之下**不會報錯**，只是總場次少 5。⇒ 任何「與既有資料共用唯一鍵」的新輸入路徑，都要拿真資料做一次往返比對（我第一次跑只有 164/174 吻合，就是這樣抓到的） | 2026-09-06 實測 |
| 120 | **`business_days_after()` / `business_days_between()` 只扣週末，不扣國定假日 ⇒ 算出來的期限比法定期限**早**。** 台灣的行政機關辦公日曆有春節、清明、端午、中秋等連假，真正的工作日比這裡算的少。偏早對平台是保守的（我們比法定期限更早履行 §90-9 的回復義務），所以**不是違法風險**，但它是一個已知的近似值，不要當成權威值對外顯示成「法定期限」。**什麼時候該回來修**：真的有人提出回復通知、而算出來的期限落在連假前後的時候——那時差幾天是有意義的。做對需要行政院人事行政總處每年公告一次的辦公日曆 CSV，而那是一個**會逐年腐爛的外部相依**（本專案已經有政府開放資料 CSV 連結藏在包裝 JSON 裡、`FileName` 欄位還是陷阱的教訓），為一個目前無人使用的功能引入它不划算 | 2026-09-06 裁定（主 session） |
| 121 | **`verify:all` 與 `verify-account-delete.ts` 每跑一次就建 1–2 個 Supabase Auth 帳號，短時間連跑好幾次會撞到節流（HTTP 429），表現成「建立測試帳號失敗」。** 那是**假紅燈**：等一分鐘再跑就過。實測 2026-09-06 連續三次之後出現，症狀是 `http/account-*` 被略過、而且**同一輪的 `http/poster-owner-sees` 也會紅**（它依賴同一批臨時帳號的 storage 物件）——後者看起來像 RLS 壞了，其實是前置沒建起來。⇒ 斷言的失敗訊息一定要把**狀態碼**寫出來，否則分不出「程式壞了」與「上游在節流我們」。已修：訊息現在會標示 429 並提示等一分鐘 | 2026-09-06 實測 |
| 122 | **`user_year_stats(username, null)` 本來就是「全期」視角，不需要另開一支 all_time 函式。** `p_year` 有 `default null`，而 `rec` CTE 的條件是 `p_year is null or extract(year …) = p_year`。實測全期回：174 筆／133 部／250 張／13 個年份／全期多刷 19 部。⇒ 收到「需要一個不分年份的統計」時，**先確認現有的那支支不支援**——多開一支就是多一份會漂移的定義。真正缺的只有兩件：全期尺度下要餵給貢獻圖的 `by_year`，以及 `monthly` 在全期時到底是「十三年的同月份加總（12 格，季節性）」還是「156 個月的時間序列」——**原本只有前者，等於已經替 David 選了一種而沒有人講出來** | 2026-09-06 實測 |
| 123 | **★ 「歷年每月平均」的分母有三個看起來都合理的選項，而選錯了畫出來完全看不出來。** ① 總數 ÷ 12：混淆了曝光不同的月份。② 有資料的年份數（David 是 13）：2014 年一月**在他第一筆紀錄之前**、2026 年十月**還沒發生**，那些格子從來沒有機會發生 ⇒ 一月與十月的平均被系統性低估。③ 有那個月份紀錄的年份數：得到的是「有去的時候平均去幾次」，永遠 ≥ 1，看起來像每個月都有去——三個裡最會騙人的一個。**正解是曝光數**：從第一筆紀錄那個月到 `greatest(最後一筆, 今天)`，這個月份實際經歷過幾次（停止記錄之後的月份是「真的去了 0 次」，那是資訊，不該從分母裡拿掉）。實測 David：三月 13 次、一月 12 次、十月 12 次。⚠️ **這種錯誤守不住靠一致性斷言**：驗 `avg = records / years_observed` 只驗到內部一致，把分母一律改成 13 照樣全綠。要用一個**與實作無關**的不變量——十二個月份的曝光數加總必須等於觀測窗口的月份總數（151），分母寫成 13 會得到 156 而立刻紅 | 2026-09-06 實測 |
| 124 | **★ 一個宣稱「有安全網」的註解，比沒有註解更糟——它會讓人不去補真的那個。** 實測 2026-09-06：`strip-auth-on-cacheable.ts` 的註解寫著「所以 `scripts/verify-ssr-payload.ts` 直接對真的 HTML 斷言…」，而那個檔名**是改名前的**（已改成 `verify-http.ts`），更關鍵的是那支腳本**沒有接進 `verify:all`** ⇒ 那張安全網從來沒有在標準入口跑過。它守的是踩雷 #79（訪客的 access_token 被寫進 CDN 快取），也就是這個專案最貴的外洩。⇒ 兩條規矩：① **註解引用某個檔案時，那個檔案要麼在 `verify:all` 的路徑上，要麼註解要寫明「需要另外手動跑」**；② 重構改檔名時，`grep` 舊檔名是必做的一步——編譯器不會替你檢查註解裡的字串。修法：把斷言抽成可匯出的函式，兩個入口共用同一份，沒有 dev server 時**略過而不是失敗**（合計把略過數單獨列出來，理由裡寫明它守的是什麼） | 2026-09-06 實測 |
| 132 | **★ 表級 GRANT 在 RLS 之前擋，所以一條 `for all` 的 staff policy 可以完全是裝飾品。** 實測 2026-09-06（`information_schema.role_table_grants`）：`takedown_notice` / `counter_notice` / `data_report` 對 `authenticated` **只有 SELECT / INSERT，沒有 UPDATE**，而 `0001` 明明建了 `takedown_staff` / `counter_staff` 兩條 `for all … using (is_staff())`。後果具體而且很貴：staff 勾不了 `takedown_notice.notified_user_at`（§90-4 第 4 款的舉證欄位）、寫不進 `counter_notice.forwarded_at`——而**那正是 `counter_notice_deadlines` trigger 的觸發點**，缺它 `litigation_deadline_at` / `restore_deadline_at` 永遠是 null，`/admin/takedowns` 的「剩餘工作日」沒有任何資料可讀；`data_report.status` 也永遠停在 `open`。⇒ 這是 #106 ② 的同一個家族，但反過來：那次是少了 grant 而 policy 對，這次是 policy 對而**沒有人發現 grant 從來沒給過**，因為沒有 UI 去按那顆鈕。新增 staff-only 的寫入路徑時，policy 與 grant 要一起 review | 2026-09-06 實測（Step 7 UI） |
| 133 | **`review_state = 'pending'` 不等於「待審核」，必須同時要求 `merged_into_film_id is null`。** `merge_films()` 不改 `review_state`（也不該改），所以匯入時建的 UGC 佔位被併掉之後，`review_state` 仍然停在 `pending`。實測 2026-09-06：DB 裡 16 列 `pending`，**16 列全部都已經有 `merged_into_film_id`** ⇒ 少了這個條件，`/admin/films` 的審核佇列會整排都是已經不存在於任何讀取路徑上的殭屍，而且每一筆都按得下去 | 2026-09-06 實測（Step 7 UI） |
| 134 | **★ `import_key` 是原始列的 base64，所以它對「位元組」敏感——語意相同但序列化方式不同的同一份資料，會整批當成新紀錄匯入。** 實測 2026-09-06：拿 DB 裡既有的 169 個 key 反解成 CSV 再匯一次，只因為**沒有備註的列原本只有 10 欄、沒有結尾逗號**而我一律補成 11 欄，**104/169 的 key 就全變了**；另一次是備註裡含換行的那一列沒有依 RFC 4180 加引號，它被拆成三筆、兩個孤兒片段進了 issues。兩次的畫面症狀一樣：對帳說「這次會新增 N 筆」而正確答案是 0。⇒ ① 冪等的前提是**位元組完全相同**，使用者若重新從上游匯出而上游改了任何空白或欄位數，就會拿到整份重複；② 因此對帳畫面**必須**在寫入前先算出「已經有幾筆／這次新增幾筆」給人看——那是唯一會在事前暴露這件事的地方（`/app/import` 第 3 步就是為此存在）；③ 拿既有資料反推測試檔時，反推的正確性要先用「key 完全吻合」斷言過，否則驗到的是自己的產生器 | 2026-09-06 實測（Step 10 UI） |
| 135 | **★ #97 ① 的真正機制不是「有 `file://` 分頁」，是「有任何一個 renderer 卡住的分頁」。** 實測 2026-09-06：`connectOverCDP` 連續逾時，改用裸 CDP 逐一 `Target.attachToTarget` + `Runtime.evaluate` 探測後發現——`file://` 的視覺稿分頁**回應正常**，真正卡住的是另一個 session 開著的一個 `localhost:3000/search` 分頁（`Runtime.evaluate` 逾時）。playwright 會附著**每一個** target，所以一個死掉的 renderer 就讓所有人都連不上，而錯誤訊息只指向 WebSocket，看不出是哪一個分頁。**同一天我自己也製造過兩次**：腳本中途拋錯沒有 `page.close()`，留下的孤兒分頁效果一模一樣。⇒ ① 附著卡住時先用裸 CDP 逐 target 探測找出兇手，不要重試也不要重開瀏覽器；② 每一支腳本都把 `page.close()` 放進 `finally`（**但永遠不要 `browser.close()`**，那會關掉 David 的瀏覽器）；③ 多 session 共用同一個 Chrome 時，關掉「別人的」分頁前先確認它真的是死的 | 2026-09-06 實測 |
| 76 | **`db.<ref>.supabase.co`（direct connection）只有 AAAA 記錄。** 沒有 IPv6 的機器一律 `getaddrinfo ENOTFOUND`，與憑證無關。改用 session pooler `aws-N-<region>.pooler.supabase.com:**5432**`（**5432 是 session mode，6543 才是 transaction mode**），使用者名稱要寫成 `postgres.<ref>`。`inet_server_addr()` 實測是同一台 DB，DDL 與 prepared statement 行為相同 | 2026-09-05 實測 |
| 77 | **`supabase gen types typescript` 即使給了 `--db-url` 仍需要 Docker**（CLI 2.20 / 2.30 / 2.48 實測皆然，錯誤為 `failed to inspect docker image`）。沒有 Docker 的機器要嘛改用 Management API（需 personal access token），要嘛自己從資料庫目錄產生（本專案採後者，見 `scripts/gen-types.ts`） | 2026-09-05 實測 |
| 78 | **自產型別時 `Relationships[].isOneToOne` 不可以是 `null`。** `GenericRelationship` 宣告為 `isOneToOne?: boolean`，一旦出現 `null`，整個 `Database` 就不滿足 `GenericSchema`，於是**所有** `select()` 的列型別靜默塌成 `never`——錯誤訊息只會說「Property 'x' does not exist on type 'never'」，完全指不到根因。SQL 端記得 `coalesce(bool_or(...), false)` | 2026-09-05 實測 |
| 218 | **★★ `profile.avatar_url` 填了值就等於公開——三根管子早就接好了，沒有中間態。** 實查：`anon` 與 `authenticated` 對 `public.profile` 的 SELECT 欄位清單**都含 `avatar_url`**（`information_schema.column_privileges`），`profile_read` policy 對未終止服務者放行；`server/api/u/[username].get.ts` 的逐欄白名單**已經** select 了它並回傳 `avatarUrl`；`app/pages/u/[username].vue` 的 `<UAvatar :src="profile.avatarUrl">` **已經**接好。⇒ 只要有人往那一欄寫一個值，公開個人頁與 `__NUXT_DATA__` 立刻帶著它出去，**不需要任何人再寫一行程式**。2026-09-07 的 Google 頭像因此選擇「值完全不落地、只在 client 從 `useSupabaseUser()` 的 `user_metadata` 讀」——不是偷懶，是唯一在結構上守得住的做法：**讓錯誤的方向是「少一張圖」而不是「洩漏」**。⚠️ 同一個家族還有一件事要記得：`authenticated` 拿到的是 `profile` **整表九欄**的 UPDATE，policy 只驗 `id = auth.uid()` ⇒ **任何登入者現在就能用一句 REST PATCH 自己把那一欄填起來**。這是既有的洞、不是這一輪造成的，但它讓「預設不公開」在今天只是慣例、不是機制 | 2026-09-07 實查（Google 頭像） |
| 219 | **`admin_correct_venue()` 在 migration 裡叫不動；`curated_fields` 只能自己維護，而且它是「永久」的。** `admin_correct_venue()` 活體第一句是 `if not public.is_staff() then raise exception '權限不足' using errcode='42501'`，而 `pnpm db:sql` 是 postgres 直連、`auth.uid()` 為 null ⇒ 實測 `is_staff() = false`，migration 呼叫它必然 42501。要正名只能自己 `update public.venue set name = …, curated_fields = (select array(select distinct unnest(curated_fields \|\| 'name'::text)))`。對照組：`seed_venues()` 第一句問的是 `is_service_context()`，同一條連線回 true ⇒ **冒煙測試呼叫 `seed_venues` 是過得去的**（換一個角色跑，例如 CI 用非 postgres 連線，整支會在那裡全部回滾）。⚠️ 更容易踩的是**語意**：`curated_fields` 是「**永久**放棄上游對這個欄位的更新」，`seed_venues` 的 `case when 'name' = any(curated_fields)` 沒有任何時效 ⇒ **只有「我們決定的、跟上游不同」的值才該進去**；把一個「等於上游 fallback 會產出的值」釘進去，等於在明年政府補上正確資料時**無聲擋掉它**，方向剛好相反。⚠️ 冪等守門也別只看值：`where name is distinct from new_name` 會在「名字已對、鎖沒上」時整列跳過 ⇒ 保護永遠補不上，而斷言（只看 name）全部照樣綠——要寫成 `and (name is distinct from new_name or not ('name' = any(curated_fields)))` | 2026-09-07 實測（venue-dropdown） |
| 220 | **`btrim(name)` 不帶第二個參數只修 ASCII 空白。** 實測 `btrim(E'　') = ''` 為 **false** ⇒ 一個「用全形空白當名字」的列會滑過 `check (btrim(name) <> '')`。要涵蓋就把字元集寫出來（半形空白、全形空白、tab、CR、LF）。順帶：全形空白在 PostgreSQL 的 `E''` 字串裡可以直接寫（實測它等於 `chr(12288)`），所以 `.sql` 檔裡不必貼隱形的字元 | 2026-09-07 實測（venue-dropdown） |

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
| 82 | **★ `UInput` 沒有 IME 組字保護，`USelectMenu` 有。** Vue 原生的 `v-model` 會掛 `compositionstart/end` 並在組字中跳過 `onInput`；Nuxt UI 4.11.0 的 `Input.vue` 自己接 `@input` → `updateInput(value)`，**那層保護不存在**。所以任何用 `UInput` 做「邊打邊查」的地方，注音打「鬼」的四個中間態（ㄍ／ㄍㄨ／ㄍㄨㄟ／ㄍㄨㄟˇ）會各送一次查詢，使用者在選出字之前先看到四次「找不到」。`USelectMenu` 的搜尋框走 reka-ui 的 `ListboxFilter`，那支有 `useComposing()`（`shouldDeferInput`），組字中不更新 `searchTerm`，所以**不必**再擋一次。正解是 `app/composables/useImeGuard.ts` | 2026-09-06 David 以實體注音鍵盤回報；CDP `Input.imeSetComposition` 重現並驗證修復（`/search` 修前 4 次查詢、修後 0 次；`USelectMenu` 修前後皆 0） |
| 83 | **★ Blink 的 implicit form submission 不看 `isComposing`。** 平常「注音選字按 Enter 不會誤送表單」，靠的是**輸入法在 OS 層把 Enter 吃掉**（頁面只收到 `keyCode 229` 的 keydown、沒有 keypress），不是瀏覽器有保護。實測：組字中若送出帶 keypress 的 `keyCode 13`（Windows 微軟注音、Android 軟鍵盤都有前科），`isComposing` 明明是 `true`，表單照樣送出。`UForm` 也救不了——它用的是原生 `<form @submit.prevent>`，送出時機由瀏覽器決定。正解是在表單上掛 `@keydown="blockSubmitWhileComposing"`（`useImeGuard.ts`），三行 | 2026-09-06 實測 Chrome 152 / CDP，三組對照（229 無 keypress→不送；13 有 keypress + composing→**送**；13 無 composing→送） |
| 85 | **★ ECharts 一張圖是「多張 canvas 疊出來」的**（實測日曆圖 3 層：日曆格／series／標籤）。要用像素驗圖表內容時，只掃 `document.querySelector('canvas')` 會得到**假陽性**——我因此花了好幾輪去追一個不存在的 bug（`scatter` 明明畫了卻讀不到）。正解是把同一個容器裡的所有 canvas 合成到一張 offscreen 上，**而且要先填底色**：圖表底是 `transparent`，合成後的透明像素是 `rgba(0,0,0,0)`，會被當成色階最深的那一階 | 2026-09-06 實測 |
| 86 | **★ `visualMap` 不寫 `seriesIndex` 會吃掉每一個 series。** 出席圖疊在 heatmap 上的那個 `scatter`（標記雙片連映）的 `itemStyle.color` 被 visualMap 覆寫成同一階的顏色 ⇒ 點跟格子同色 ⇒ 等於不存在。畫面上完全看不出異常，console 零錯誤。合成三層數像素：不寫 → 最深色 200px、小點 0px；寫 `seriesIndex: 0` → 最深色 152px（小點挖掉 48px）+ 肉眼可見 | 同上 |
| 87 | **`textStyle.fontFamily: 'inherit'` 在 ECharts 是壞的。** 它被串成 canvas 的 `ctx.font = '12px inherit'`，那不是合法的 font shorthand，整串被丟掉、標籤退回瀏覽器預設的 10px sans-serif。零錯誤訊息。必須寫出真的字型堆疊。**另外不要用 ECharts 內建的 `'dark'` theme**：它會塞一個 `backgroundColor: '#100c2a'` 的深紫底 | 同上 |
| 88 | **★ 在 SSR 頁用 `useColorMode()` 在 JS 裡挑顏色再寫成 inline style ⇒ hydration mismatch。** 伺服器端算出來的是亮色、瀏覽器 hydrate 時是暗色，兩份 style 對不起來，而**畫面看起來完全正常**，只在 console 留一行 `Hydration completed but contains mismatches`。`/app` 是 `ssr: false` 所以看不到，同一個元件搬到 `/u/` 就會炸。正解是把亮暗兩個值都印成 custom property、由 CSS 挑。⚠️ **不要用 SFC `<style scoped>` 裡的 `:global(.dark) X` 去挑**——實測沒有生效（暗色下變數仍解析成亮色值），要用 Nuxt UI 註冊的 `@variant dark (&:where(.dark, .dark *))` | 同上 |
| 89 | **★ 任何「使用者自己的東西」都不能查 `*_public` view。** `film_public` 的 where 有 `visibility = 'public'`，所以使用者**自己剛新增、審核中的 UGC 作品不在裡面**——US-17「可立刻用於記錄」只在新增完那一次的交棒成立，之後再想記同一部片就永遠找不到。改查基表由 RLS 把關；但基表沒有 view 的 `merged_into_film_id is null`，要自己補，否則會選到被合併掉的敗方 | 同上 |
| 90 | **UGC 作品 insert 當下就有 slug（觸發器產的），但 `/film/[slug]` 對作者自己也是 404**——那支 API 明確用匿名 client（為了 ISR 安全）。於是待審作品的卡片會出現一個看起來正常、點下去是錯誤頁的連結，而且 **Nuxt 會在 hover 之前就 prefetch 它的 payload**，每張這種卡在 console 留一個 404。只有 `public` + `approved` 才給連結 | 同上 |
| 93 | **Tailwind 的 preflight 讓 `<code>` 仍然是等寬字，什麼都不寫也一樣。** preflight 對 `code, kbd, samp, pre` 下了 `font-family: var(--default-mono-font-family, …)`。`SCREENS §15.1` 特地點名「不要用 Nuxt UI 的 prose，因為它會把 `<code>` 渲染成等寬字」——結果不用 prose、自己寫樣式，一樣是等寬字（實測條款頁上 `docs/SPEC.md`、`profile.username` 全部變成等寬，違反 DS §0）。要顯式加 `font-sans` 蓋掉 | 2026-09-06 實測 |
| 94 | **`34ch` 對中文不是 34 個字，是 17–20 個字。** `ch` 是**當前字型「0」的推進寬度**：Inter ≈ 0.6em、退到蘋方是半形 0.5em ⇒ `34ch` 落在 272–330px。DS §2.4 寫「`max-width: 34ch`（≈560px）」，兩個數字對不起來，而 §2.4 自己的推導是用 em 的（31.5 em ≈ 32 個漢字）。漢字是 1 em 全形 ⇒ 「34 個字」寫成 CSS 是 **`34em`（544px）**。⚠️ 這條的症狀是「看起來只是有點窄」，不會有任何錯誤 | 2026-09-06 實測（`/legal/**` 內文） |
| 95 | **zod 4 的 `z.preprocess()` 推不出輸出型別，會把整個 `UForm` 的 state 型別炸成 `unknown`。** `UForm` 的 `:state` 是 `Partial<z.output<schema>>`；某個欄位用 `z.preprocess()` 之後 `z.output` 那一格是 `unknown`，typecheck 紅在 `:state` 那一行而不是 schema 那一行。改用 `.transform().pipe()` 即可。**同一組的另一半**：`z.literal(true)`（勾選型的法定聲明）會讓「還沒勾」這個合法中間狀態在型別上不存在，`:state` 一樣塞不進去 ⇒ 前端寫 `z.boolean().refine(v => v === true)`，把 `literal(true)` 留給伺服器 | 2026-09-06 實測（`/legal/dmca`） |
| 96 | **Nuxt UI 的 `UCheckbox` 把原生 `<input type=checkbox>` 藏起來，Playwright 的 `.check()` 會逾時 30 秒。** 那個 input 帶 `data-hidden`、`aria-hidden="true"`、`tabindex="-1"`，點擊座標落在頁面容器上，錯誤訊息是「`<div class="mx-auto …">` intercepts pointer events」——看起來像版面把它蓋住了，其實是**選錯元素**。用 `getByRole('checkbox')`（reka-ui 真正可互動的那一個）。⇒ 這類假象會讓人去改版面而不是改測試 | 2026-09-06 實測（Chrome 152 / CDP） |
| 99 | **★★ `text-muted` / `bg-elevated` / `border-default` 這一整組語意色，在 production build 裡是死的——而 dev 完全正常。** `app.config.ts` 的 `neutral: 'paper'` 讓 Nuxt UI 產生 `--ui-text-muted: var(--ui-color-neutral-500)` 這一串，但 **`--ui-color-neutral-*` 自己一個都沒有被定義**（實測 `.output/public/_nuxt/entry*.css`：引用 10 次、定義 0 次）。原因是 Tailwind v4 的 `@theme` 會 tree-shake 沒有被任何 **utility** 用到的變數，而這一串只被另一個自訂屬性讀 —— dev 不 tree-shake，所以**只有 production 掉色**。症狀：文字全部退回黑色、`soft` 的中性按鈕連背景都沒有、`USwitch` 只剩一顆點；而 `pnpm build` 是 exit 0、零警告，dev 的截圖全部是對的。⇒ 解法是在 `main.css` **未分層的 `:root`** 裡把 10 個 `--ui-color-neutral-*` 顯式寫出來（順帶讓 `--color-paper-100…800` 不再被 tree-shake——修之前只有 25/50/900/950 活著）。⚠️ **這一類問題只有量 production 產物才看得到**：驗收「顏色對不對」不能只在 dev 截圖，要 `pnpm build` 之後跑 `node .output/server/index.mjs` 再量一次 | 2026-09-06 實測（frontend 第三棒，`/app/settings` 驗收時發現；§1.6 已為 `--ui-radius` 記過同一個機制，但只修了那一個變數） |
| 97 | **★ 瀏覽器驗證的兩個「看起來像瀏覽器掛了」其實不是。** ① `chromium.connectOverCDP()` 會列舉瀏覽器裡的**每一個** target，只要有人開著一個 `file://` 分頁就整個逾時 30 秒（前一棒記過 file:// 讀不到，這是它的另一面：**別人的分頁會弄壞你的附著**）。② Node 22 的 `fetch()` 打 Chrome 的 `http://127.0.0.1:9222/json/list` **永遠掛著不回**，同一個 URL `curl` 是 0.9ms 回 200；症狀是腳本一行輸出都沒有。⇒ 兩者的解法都是**只連一個分頁的裸 CDP**：用 `node:http`（`agent: false`）取 `/json/list`，再對那一個 target 的 `webSocketDebuggerUrl` 開 WebSocket 發 `Runtime.evaluate` / `Page.captureScreenshot`。不需要 Playwright，也不會被別人的分頁影響 | 2026-09-06 實測（`/legal/dmca` 成功畫面的驗收） |
| 185 | **★ `position: sticky` 黏的是「最近的捲動祖先」，而 `UTable` 的 root 本身就是 `overflow-auto`。** 把 `min-w-*` 掛在 root 上（再由外層 div 負責橫捲）時，pinned 欄會黏在**那個自己已經被外層捲出畫面的盒子**的右緣 ⇒ 使用者看到的是「操作欄根本不在畫面上」，而 `getComputedStyle` 讀到的仍然是 `position: sticky`、看起來完全正常。正解是讓 `UTable` 自己的 root 當捲動容器（最小寬度改掛 `base`，也就是真正的 `<table>`）。⚠️ **這條的真正教訓在檢查機制**：我的第一版檢查「量最內層那個會捲的祖先，看操作欄跟它的距離有沒有變」——對這個 bug 是**綠的**。改成量「把所有會橫捲的祖先都推到兩端，操作欄是否仍在**視窗**內且位置不動」才會紅。故意把它弄壞一次是唯一發現這件事的方法 | 2026-09-06 實測（records，`/app/records` 操作欄固定） |
| 186 | **★ Nuxt UI 的 pinned 欄底色是半透明 `bg-default/75`，而它 computed 出來是 `oklab(... / 0.75)` 不是 `rgba(...)`。** 半透明的固定欄在捲動時會讓底下的欄位透出來疊字。要蓋掉它必須寫 `bg-default!`（important）——來源是元件主題，沒有 important 不保證贏。⚠️ 同樣是檢查機制的問題：用 `/rgba\([^)]+,\s*0?\.\d+\)/` 判斷「有沒有透明度」的檢查**漏掉了它**，因為 Tailwind 4 的顏色是 oklab/oklch。要解析 `/ <alpha>)` 這種斜線語法才抓得到 | 同上 |
| 187 | **`truncate` 需要一個確定的寬度，而 `w-*` 掛在 `<td>` 上只是「建議」。** 九欄的自動配寬會照內容搶寬度：影城欄（長店名）自己漲到 267px，把備註欄壓到 86px——展開後變成一行兩個字、十一行高的一條。`<td>` 的 `w-*` 要配上內層元素的 `max-w-*` 才真的生效。⚠️ 這一類是**量不出來的**（沒有溢出、沒有純白、沒有錯誤），只有把畫面看過一遍才會發現 | 同上 |
| 165 | **★★ DB 那側把一個欄位釘得再牢，都證明不了前端有在用它。** `0003` 為「歷年每月平均」特地做了 `monthly_baseline`（分母是**曝光數**：該月份實際經歷過幾次），`verify-core` 的 H4／H6 把它守得很死。但實測 2026-09-06：**那個欄位在整個前端 `grep` 是空的**——`app/utils/stats.ts` 自己用「該月份總場次 ÷ 年份數」另算了一套，12 個月裡有 5 個偏掉（十月畫 1.85，DB 說 2.00），而 H1–H6 全綠、單元測試也全綠。**單元測試甚至把錯的答案釘住了**（`expect(avg[9]).toBe(1.85)`），所以它是反向的保護。⇒ `backend.md §6e` 早就預言了這個形狀（「一致性斷言只驗到內部一致」），只是預言的是 DB 內部，實際發生在**跨層的接縫**上。跨層的欄位要有跨層的斷言：`verify-all.ts` 的 `frontend/monthly-baseline` 三條拿真實資料跑**真正的前端函式**跟 DB 逐格對帳，並且**證明那組資料分辨得出兩種分母**（沒有第三條的話，資料一變成兩種分母同解就會靜默失去分辨力） | 2026-09-06 實測（charts） |
| 166 | **★ 用字串比對檢查「某個檔案有沒有呼叫某個函式」時，註解會餵飽斷言。** #165 的第三條檢查第一版寫 `src.includes('monthlyBaselineSeries')`，把呼叫整個拿掉之後**照樣綠**——因為同一頁的註解裡就寫著「見 `stats.ts` 的 `monthlyBaselineSeries()`」，而且**註解寫得越詳細越容易中**。⇒ 先 strip 掉 `<!-- -->`／`/* */`／`//` 再比對，而且要求左括號（要的是呼叫不是提及）。⚠️ 這條是**故意把斷言守的東西弄壞一次**才發現的；在那次破壞測試之前它已經「通過」了一輪，合計那行寫著 39／39 | 同上 |
| 167 | **同一個工作樹裡有別的 session 在寫時，`pnpm run lint` 會給你一份不是你造成的紅燈。** 實測 2026-09-06：開工前跑 lint 得到 98 個 `vue/html-indent` 錯誤，兩分鐘後同一個指令 exit 0——`records` 那一棒正好在寫 `app/pages/app/records/index.vue`（mtime 距我執行只差 36 秒）。`verify:all` 已經會對 `supabase/migrations`／`scripts` 的髒工作樹吵一聲，但 **lint 與 test 吃的是 `app/**`，那裡沒有任何警告**。⇒ 拿到紅燈先 `git status` 看檔名是不是自己的，再看 `ls -lT` 的 mtime；重跑一次也是有效的判別法 | 同上 |
| 188 | **★ `position: sticky` 的固定欄只能「疊上去」，沒有辦法「佔位」。** 內容比容器寬時，右側固定欄在**靜止**（`scrollLeft = 0`）狀態就會蓋住當下落在容器右緣的那一欄——那正是使用者預設看到的樣子，讀起來像「那一欄壞掉了」而不是「還有東西在右邊」。⚠️ 直覺的解法「在捲動容器尾端補一段等寬的 `padding-inline-end`」**沒有用**：sticky 的參照是 scrollport 的 padding box，補 padding 只是換成蓋住別的欄（實測：公開狀態 68px + 備註 25px，比原本蓋一欄還糟）。真正能做到「靜止時零遮蔽」的只有兩條路：① 讓資料欄總寬 ≤ 容器寬（＝截掉使用者填的資料）；② **把固定欄 pin 在左邊**——第一欄的自然位置就是左緣，靜止時不需要被拉走，實測遮蔽 0px；代價是往右捲時換成左邊那幾欄被蓋（實測捲到底：日期 47px、作品 45px，**片名少掉開頭幾個字而且沒有任何記號**——截尾有「…」，截頭沒有，列的身分在捲動中消失）。⚠️ **`/app/records` 最後選的是「釘右、接受靜止時被蓋 93px」**（David 2026-09-06 看過兩版後裁決：換取捲動時零遮蔽與影城／作品一個字都不截）。**這三條路都走過了，不要再走一次**；要改之前先讀 `SCREENS §10.5`。⚠️ 量的時候**不要量「固定欄在不在視窗內」**（永遠是綠的），要量「每一個資料欄跟固定欄的矩形重疊寬度」。⚠️ **遮蔽量有公式，別憑感覺**：**遮蔽 = min(表格寬 − 容器寬, 固定欄寬)**，而被蓋住的是**表格座標 `[容器寬 − 固定欄寬, 容器寬]` 這一段**——不必然是最後一個資料欄（375px 下被蓋的是**中間的作品欄**）。⇒ **把某一欄改窄不會讓遮蔽變小**，只會讓表格總寬與橫捲距離變短；只有讓表格寬真的降到容器寬以下才會歸零，而那條路（＝截掉使用者填的資料）已經在上面被否決了。實測 2026-09-07：備註欄 233px → 160px，1280 與 375 兩個寬度的遮蔽**都還是 93px，一模一樣**。這條公式直接擋掉「改窄一點應該就好了吧」這個很自然的誤判 | 2026-09-06 實測（records，`/app/records`）；公式為 2026-09-07 實測補記 |
| 168 | **★★ 踩雷 #88 會在「把元件從 `/app` 搬到 `/u/`」的那一刻復發，而且只有暗色看得到。** `DistributionBars` 用 `useColorMode()` 在 JS 裡挑 hex 再寫進 inline style，在 `ssr: false` 的 `/app` 上完全正常；2026-09-06 搬到 SSR 的 `/u/` 立刻噴 `Hydration style mismatch`（`rendered on server: #685946` vs `expected on client: #A59788`）＋ `Hydration completed but contains mismatches`，而**畫面看起來完全正常**。⚠️ **關鍵在只有一半會紅**：實測 `preference=dark` 35 條警告、`preference=light` **0 條**——只驗亮色會拿到一個乾淨的假象。⇒ 正解與 `YearStrip` 同一招：亮暗兩組值都印成 custom property（常數 ⇒ SSR 與 client 必然相同），由 Nuxt UI 註冊的 `dark:` variant 挑。圖例色塊抽成 `ChartLegendSwatch` 就是為了讓兩頁不會各寫一份——各寫一份的話 `/app` 那份永遠看起來是對的，沒有人會發現 `/u/` 那份是錯的。工具：`scripts/check-hydration.mjs`（**兩種偏好都要跑，而且要整頁 reload**——mismatch 只在 SSR→hydrate 那一刻發生） | 2026-09-06 實測（charts） |
| 169 | **★ 抽屜「開得起來」不等於「列得出東西」，而空抽屜會理直氣壯地說謊。** `/u/` 的 `ensureAllRecords()` 在「本來就載完了」那條路徑上設了 `loadedAll = true` 就 return，**沒有填 `extraRecords`** ⇒ `allRecords` 立刻變成空陣列 ⇒ 點一下圖表之後抽屜是空的、**下面整份紀錄列表也一起消失**，而抽屜印的是「這個時段沒有公開的紀錄」。零錯誤訊息、typecheck 綠、lint 綠、單元測試綠。抓到它的唯一方法是**真的點一格，然後跟 `/app` 的同一格對數字**（`/app` 9 張、`/u/` 0 張）。⇒ 驗收圖表互動時，斷言要是「同一格在兩頁列出同樣多張」，不是「抽屜有沒有打開」。⚠️ 早期版本的旗標與資料分屬兩個 ref 時，**每一條 return 路徑都要寫回資料**，否則旗標會領先資料 | 同上 |
| 170 | **量測報告裡的「我切到暗色了」不是證據。** records 實測到 nuxt-color-mode 的**已存偏好會蓋掉 Emulation 的 `prefers-color-scheme`**（量到 `prefersDark=true` 而 `documentElement.className` 是 light，所有檢查照樣全綠）。走 `$colorMode.preference` 的腳本不受那條影響——**但沒有印出證據的話，那是推論不是量測**。⇒ 任何提到亮／暗的數字都要同時附 `documentElement.className` 與 `getComputedStyle(body).backgroundColor`，並跟 `DS §7` 的規定值（亮 `rgb(248,237,220)`／暗 `rgb(29,22,16)`）比對；切換之後**輪詢等 class 真的變了**再量，不要 sleep 猜。`scripts/screenshot-pages.mjs` 現在一律印這兩個值。⚠️ **多條 session 共用同一顆瀏覽器時，誰切主題誰就污染對方**：開頭記下原本的 preference，收工還原 | 2026-09-06（records 發現機制，charts 補上證據要求） |
| 171 | **★ 「金額是 0 就不用畫」會把一個真實的事實整列吃掉。** `/u/` 的「每年花費」第一版寫 `filter(y => y.spend > 0 \|\| y.isPartial)`，理由是「0 只會是一排空條」。實測 David **2015 年 2 場、票價都記了、合計 NT$0**（兌換票）⇒ 那一列直接消失：**年表上有那一年、花費圖上沒有**，而畫面看起來完全正常。`SCREENS §12.1` 早就寫過同一條（「NT$0 不等於隱藏」），只是當時是講單筆票根的 meta 行，沒有人想到年度合計也適用。⇒ 濾的條件是「那一年有沒有紀錄」（`records > 0`），不是「金額大不大於零」；`amount === 0 && !partial` 顯示「免費」。⚠️ **配套的另一半**：`amount === 0 && partial` **不可以**也寫成「免費」——那是把「沒公開」講成「沒花錢」，是這張圖最不能犯的錯，要寫「NT$0 以上」。⚠️ 順帶：`Math.max(2, …)` 的最小條寬也要對真正的 0 例外，否則右邊寫「免費」、左邊畫一小段條，圖與字互相矛盾 | 2026-09-06 實測（charts） |
| 172 | **驗「因觀看者而異」的東西，用 `browser.newContext()` 開一個乾淨 context，不要清 cookie。** CDP 附著的是使用者自己的瀏覽器，清 cookie／清 localStorage 會把他登出。實測 `chromium.connectOverCDP()` 之後 **`browser.newContext()` 可用**，新 context 沒有 session（`localStorage` 裡沒有 `auth-token`），拿它就能真的用「路人」的眼睛看同一頁；用完 `ctx.close()`，**仍然絕不 `browser.close()`**。⇒ `/u/` 的三種視角（本人／`show_cost` 開的路人／關的路人）因此可以各截一張圖，而不是只靠 RLS 推論。⚠️ 需要暫時翻動真實資料的旗標（例如 `show_cost`）時：**先讀出原值**再還原（硬寫 false 會把本來就開著的帳號關掉）、還原放 `finally`、**結束前再查一次確認真的還原了**。實測一次 SQL 打錯欄位名整支腳本炸掉，`finally` 仍然正確把旗標關了回去——那正是它存在的理由 | 同上 |
| 173 | **★★ `typecheck` / `lint` / `test` / `verify:all` 四個全綠，而 `/u/` 在瀏覽器裡一條 band 都畫不出來。** 把一個匯出的函式從 `app/composables/useUserSpend.ts` 搬到 `app/utils/stats.ts` 之後，**dev server 的模組圖沒有跟著更新**：瀏覽器收到 `SyntaxError: The requested module '…/useUserSpend.ts' does not provide an export named 'spendText'`，整頁 render 失敗。⚠️ **不是瀏覽器快取**——全新的 `browser.newContext()`（空 HTTP 快取）一樣壞；解法是 `touch` 那幾個引用它的元件逼 Vite 重新轉換（或重啟 dev server）。`.nuxt/imports.d.ts` **當下就已經是對的**，所以 typecheck 讀到的是正確的那一份。⇒ **真正的教訓是檢查的缺口**：`verify:all` 的 `u/html-has-content` 檢查的是 **SSR 的 HTML**，而 SSR 完全正常——爆掉的是 client 端。「這一頁在真的瀏覽器裡跑不跑得起來」當時**沒有任何自動檢查在守**。`scripts/check-hydration.mjs` 已擴充成「hydration mismatch ＋ 任何 console error／pageerror 都算失敗」，並用「元件呼叫一個不存在的函式」實測過會紅 | 2026-09-06 實測（charts） |
| 174 | **★ 「最」是一個宣稱唯一性的字，所以門檻也必須是唯一性——「夠大」不夠。** `/app` 與 `/u/` 的時段圖說原本只有一道總筆數門檻（`INSIGHT_MIN = 20`），於是 174 筆的 David 拿到「你最常在週六 10:00 進場，共 9 場」。實測他的前三高是 **週六 14:00 = 9、週六 10:00 = 9、週五 22:00 = 8**——**前兩名並列**，那句話是在並列裡任意挑一個，不是弱而是不成立。⚠️ 只看「尖峰夠不夠大」（z 分數之類）會放行：9 場在 mean 2.6／sd 2.16 之下確實是離群值。⇒ 判準改成 `peakStandsOut()`：**絕對下限 5 場 ＋ 必須 ≥ 1.5 倍第二名**，兩條缺一不可（各自弄壞驗過會紅）。站不出來時改講**跨很多格的穩健聚合**（週末佔比／晚場佔比），都站不出來就給一句純敘述——「沒有特別集中的一格」本身就是一個發現，而且是真的 | 同上 |
| 175 | **★ 聚合型斷言光有「高過平均分佈」還不夠，它必須真的在講多數。** 上面那條的第一版讓「週末晚上」以 lift 1.3 倍過關，畫面上出現「**你 39% 的場次在週五到週日的晚上**」——數學上沒說錯（基準線 30%），但使用者讀到的是「這就是我的樣子」，而 61% 的場次不是那樣。加一道 `AGGREGATE_MIN_SHARE = 50` 之後，同一組資料改講**真的成立**的那一句：「你 **79%** 的場次在週五到週日。」⚠️ **判準是「這句話講出去要是對的」，不是「數學上站得住」。** 順帶記一個自己造的假綠燈：為這條寫的第一版測試只給了 10 筆資料，走的是 `INSIGHT_MIN` 的早退路徑而**根本沒進到聚合分支**——弄壞實作時它照樣綠。凡是測試某個分支，先確認資料真的走得到那個分支 | 同上 |

| 189 | **★ 讀 migration 檔案不等於讀 DB 裡活著的函式定義。** 這個 repo 有 migration 會在**執行時**用 `pg_get_functiondef()` + `replace()` 改寫既有函式（`0008` 對 `seed_films` 的 `country`、`0010` 對 `seed_films` 的 `title_original` 與年份計數，共三處），所以 `0001_init.sql` 裡的函式文字**只是歷史**：0001 寫 `coalesce(rec->>'country','')`，DB 裡活著的是 `nullif(...)`。⇒ 要確認一支函式**現在**到底長什麼樣，唯一可靠的方法是 `select pg_get_functiondef(p.oid) from pg_proc p …` 讀活體；只讀 migration 得到的結論**可能碰巧對**（2026-09-06 就是這樣：「`seed_films` 的 update 路徑不碰 country」這個結論在兩個版本上都成立，但驗法本身是壞的）。⚠️ 這一條的代價是**靜默**的：拿舊定義去推論「重跑 seed 會不會洗掉我的 UPDATE」，猜錯的話資料被覆蓋時不會有任何訊息 | 2026-09-06 實測（records，0014 國別正規化前的前置確認） |
| 221 | **★ `UTooltip` 在觸控裝置上不會開——這是元件層面的設計，不是效能或時序問題；而且主題的 `h-6` + `truncate` 會靜默吃掉多行。** reka-ui 的 `TooltipTrigger`：`handlePointerMove` 第一行就是 `if (event.pointerType === 'touch') return;`；`handlePointerDown` 設 `isPointerDown = true`，而 `handleFocus` 開頭 `if (isPointerDown.value) return;`；`handleClick` 直接呼叫 `onClose()` ⇒ **三條路全堵死，375px 上 tooltip 永遠不出現**。這跟 `SCREENS §10.4` 早就判掉的 `title` 屬性是**同一個失效模式**。⚠️ 加上 `.nuxt/ui/tooltip.ts` 的 `content` 是 `h-6` 固定高、`text` 是 `truncate` ⇒ 多行內容只看得到第一行的一小截，**而且完全沒有錯誤訊息**。⇒ **任何「只有這條路才讀得到」的內容一律用 `UModal` 或 `UPopover(mode='click')`；`UTooltip` 只能當桌機的加值層。** 真要放多行就必須覆寫 `:ui`（`h-auto` 才蓋得掉 `h-6`），或乾脆用 `#content` 插槽自己畫，免得跟主題那個 `truncate` 在 tailwind-merge 裡比大小 | 2026-09-07 實讀 `node_modules/reka-ui/dist/Tooltip/TooltipTrigger.js` 與 `.nuxt/ui/tooltip.ts`（records） |
| 222 | **★ `UAvatar` 的 `$attrs` 在沒有圖時會落到首字母的 `<span>` 上 ⇒ 整頁 grep `referrerpolicy` 是假檢查。** `@nuxt/ui/dist/runtime/components/Avatar.vue` 是 `inheritAttrs: false`：有 `src` 且沒壞掉時 `v-bind="$attrs"` 綁在 `<img>`（所以 `referrerpolicy="no-referrer"` 寫在 `<UAvatar>` 上是**有效**的），**但 else 分支是 `<Slot v-else v-bind="{ ...$attrs, 'data-slot': void 0 }">`**——沒有 `src` 或載入失敗時，同一組屬性會套到那個畫首字母的 `<span>` 上。⇒ 用「整頁 `grep -c referrerpolicy`」當斷言會**兩頭假綠**：整頁一張頭像都沒有時照樣命中，而且全文比對會讓**另一個地方**的頭像替你要驗的那一顆背書。要驗就抽出所有 `<img …>`、篩出 src 指向頭像 host 的那些，斷言「它們**每一個**都含 `referrerpolicy="no-referrer"`」**並且**「這種標籤的數量 ≥ 1」（#102 那條：『看不到』必須配一組『看得到』）。⚠️ 順帶兩件好事，同一支原始碼也證實了：fallback 是 `props.text` 或 alt 的首字母（顯式給 `:text` 就能把行為收回自己手上），以及 `<img>` 有 `@error` ⇒ **URL 壞掉是退回首字母，不是留一張破圖** | 2026-09-07 實讀原始碼（Google 頭像） |
| 223 | **★ `triggerEvent: true` 會順手打開軸標籤的 component tooltip——滑過去冒出一個只寫著「六」或「60」的泡泡。** echarts 6.1.0 的 `lib/util/graphic.js` `setTooltipConfig()` 在 `AxisBuilder.js:935` 被呼叫，位置在 `if (triggerEvent) {…}` 區塊**之外**——也就是對**每一個**軸標籤無條件塞 `ecData.tooltipConfig`。標籤本來是 silent 的所以沒事；一旦為了讓它可點而加上 `triggerEvent`，`TooltipView._tryShow`（330–338）看到 `tooltipConfig != null` 就把它當成 component dispatcher。**修法**：每一條加了 `triggerEvent` 的軸**同時**寫 `tooltip: { show: false }`——`buildTooltipModel`（728–758）會把 axisModel 的 `tooltip` 併進 cascade，第 557 行 `if (!showContent \|\| !show) return` 擋掉；而 `AxisBuilder.isLabelSilent`（337–341）只看 `silent \|\| !(triggerEvent \|\| tooltip.show)`，所以 `show:false` **不會**把標籤變回 silent，**點擊仍然成立**。⚠️ 順帶更正兩則傳說：① 全域的 `tooltip.formatter` **不會**被軸標籤呼叫（`TooltipView.js:521-527` 有明文註解：component tooltip 不共用 series 的 formatter），所以「軸可觸發之後 formatter 會拿到非陣列的 data 而印出髒字串」是假的；② 就算真的拿到 undefined，解構 undefined 是 TypeError 直接拋、不是印出字串。防呆留著無害，但別以為它擋住了什麼 | 2026-09-07 實讀 echarts 6.1.0 原始碼（hour-heatmap） |
| 224 | **★ heatmap 的高度算錯，症狀不是「被切掉」而是每一列悄悄矮 1px。** 時段熱點圖的高度是 `rows.length * 22 + N`；加了底部總和軸之後 N 要從 40 變 60。**忘記改的症狀不是「底部那列總和被切掉」**——SSR render 實測 height=392（未改）時，底部總和照樣畫在 y=374，一個字都沒少。真正發生的是 grid 內部把可用高度重新分給 16 列：`(392−24−26)/16 = 21.375px` vs `(412−24−26)/16 = 22.625px`。⇒ **任何寫成「檢查底部總和沒有被切掉」的驗收步驟，弄壞了也會綠**；會紅的只有拿高度公式的輸出直接下斷言（`hourHeatmapHeight(grid) === '412px'`），以及 `/u/` 骨架的 CLS——而後者原本是一個硬寫的 Tailwind 字面值 `h-[392px]`，沒有任何自動檢查守得住。這一輪把骨架改成綁同一支 `hourHeatmapHeight()`，讓這個漂移類別整個消失 | 2026-09-07 實測（hour-heatmap） |
| 225 | **法遵 markdown 裡的行內碼不要排在換行後的行首，會渲染成「單邊有空隙」。** `app/utils/legal-markdown.ts` 的 `joinSoftWrap` 對軟換行的規則是：接縫兩側只要有一邊是 CJK 或全形標點就**直接相接、不補空格**（中文補空格是錯的）。但 `.md` 原始檔的既有慣例是行內碼兩側各留一個半形空格。兩者相撞的地方是**行首**——上一行結尾是中文、下一行開頭是一段行內碼時，**左邊那個空格被 `joinSoftWrap` 吃掉、右邊的還在**，渲染出來就是單邊貼死、單邊有空隙。⇒ 排版時讓行內碼落在**行中**而不是行首（把斷點移到前一個詞）；也不要為了對稱在行首手打空格，`joinSoftWrap` 先做 `.trim()`，打了也沒用。⇒ 驗法：用 `pnpm exec tsx -e` 直接呼叫 `parseLegalMarkdown()` 把那一節的 inlines 印出來看，不必起 dev server——這是唯一能在改 `.md` 當下看到渲染結果的辦法 | 2026-09-07 實測（受理窗口改表單） |
| 226 | **刪 `v-if`／`v-else` 成對文案時，先刪 script 區的來源，編譯器才會替你指出 template 的殘留。** `/legal/copyright` 的受理窗口原本有兩段成對文案：`v-if="contactEmail"`（提到信箱）與 `v-else`（不提）。要留的是 **`v-else` 那一段**（它的文字本來就是正確版本，只要拿掉 `v-else`）。若刪反了——留 `v-if` 那段、刪 `v-else`——Vue 編譯照樣過（`v-if` 單獨存在合法）、lint 過、test 過，而**頁面上留著一句指向空氣的話**。只有當 `contactEmail` 這個 computed 也被刪掉時，編譯器才會把 template 裡的殘留引用全部指出來。⇒ **刪除順序：先刪 script 區的 computed 與 `useRuntimeConfig()`，再處理 template。** ⚠️ 順手清 `useRuntimeConfig()` 時注意 `app/pages/legal/dmca.vue` 的那一個**是活的**（讀 `siteUrl` 組 origin），刪掉會讓 canonical／OG 的 origin 消失，而 lint 只會警告 `config` 未使用、刪掉之後才是執行期 ReferenceError | 2026-09-07 實測（受理窗口改表單） |
## 7.5 資料匯入（來自 SPEC 實測）

| # | 踩雷點 |
|---|---|
| 65 | 包裝 JSON 與 CSV **皆為 UTF-8 with BOM**，直接 `JSON.parse` 會失敗 |
| 66 | 包裝 JSON 的 `FileName` 是陷阱：只指向**最舊**的年度；逐年 CSV 藏在 `相關檔案` 的 `名稱(URL);…` 字串裡 |
| 67 | CSV **必須以陣列模式解析並偵測欄數**，用 `columns: true` 會靜默錯位（《劇場版IDOLiSH7》原文片名含逗號未被引號包住） |
| 68 | 年份**不可作硬篩**（《紅豬》核准 113 年、TMDB 1992），只加分不懲罰 |
| 69 | TMDB 的 `original_title` 常為母語而非英文（政府給 `Porco Rosso`、TMDB 存 `紅の豚`）→ 必須雙查詢 |
| 70 | **缺少片長交叉驗證會產生假陽性**（《一屍到底》配到 `Making Of One Cut of the Dead`、《貓的報恩》配到 `Batman Returns`） |
| 71 | ~~**TMDB 免費 key 在規模化匯入時會被節流**（實測後跑的批次慢約 6 倍）~~ → ⚠️ **這是推論被寫成了實測。** 當時只量到「批次間變慢」，沒有量 429。兩次實測都推翻它：110–113 年全量匯入 9,076 次請求，重試 0、節流 0（併發≈1）；Step 9 回填 2,479 次請求、**併發 8**，重試 0、節流 0（2026-09-06）。慢的原因至今未確認，但不是 429。**「管線必須可中斷可續跑」這個結論仍然成立**，只是理由不是節流 |
| 72 | **Supabase 免費專案閒置 7 天會自動暫停。** 上線前須以排程 ping 維持活躍 |
| 227 | **★ 只改 `docs/legal/*.md` 而不重跑 `load-legal.mjs`，頁面會顯示舊版而且完全沒有聲音。** `/legal/**` 的正文來自 `legal_document` 表，**不是 markdown 檔**。改完 `.md` 之後**必須**跑 `node --env-file=.env scripts/load-legal.mjs`（Node 22.21.1 支援 `--env-file`；`pg` 是 devDependency；⚠️ **`package.json` 裡沒有對應的 npm script**，不要去找 `pnpm load:legal`）。漏掉的症狀是最壞的那一種：**頁面照常渲染、沒有錯誤、沒有警告，只是內容是舊的**。本輪實測過這個反向斷言——改完三份 markdown 之後再查一次 DB，三個 `content_sha256` 與三個 `position()` 探針**完全沒變**。⇒ 驗法（不需要瀏覽器）：用載入器同一支 `stripInternal` 在本機重算 sha256 前 12 碼，與 `select left(content_sha256,12) from legal_document` 逐一比對，相等才算載入成功。⚠️ **時效性條件**：`legal_doc_immutable`（`0007`）只在該文件**已被同意過**時才擋 update。今天 `legal_acceptance` 三份皆 0 筆所以可以就地 upsert；日後若已有同意紀錄，upsert 會噴 23514，那時**不要繞過**（`legal_acceptance_drift` view 就是拿來抓這件事的），要改成插一列新版本號。｜來源：2026-09-07 實測（受理窗口改表單） |
| 228 | **★「選單裡混進了城市名」不是有人塞了髒字串，是 `name=''` 被樣板算繪出來的——症狀在算繪層、病灶在資料層。** `venue` 有 3 列 `name` 是空字串（政府 CSV 的「事業名稱」欄本來就空：21235165／25116865／54186685），而 `app/pages/app/records/new.vue` 的 item 樣板是 `{{ name }}` 後面接 `<span v-if="city">· {{ city }}</span>` ⇒ 畫面上只剩「· 台北市」；`app/pages/app/import.vue` 的 `[name, city, …].filter(Boolean).join(' · ')` 更糟，連中點都被 filter 吃掉，標籤變成**裸的「台北市」**。排序（`sort_weight` asc → `name` asc）又把它們固定推到四個虛擬場所正下方的第 5、6、7 位。⚠️ **拿螢幕上的字面去 DB 裡查，會查到完全相反的結論**：用「以市／縣／區／鄉／鎮結尾」去 `select … from public.venue` → **0 列**。⚠️ 下游各有各的爛法、沒有任何共用層擋得住，所以**要修在源頭**：`?? '（場所不明）'`（`app/pages/app/index.vue`、`u/[username].vue`）**抓不到 `''`**；`filter(Boolean)` 與 `filter(p => p.length > 0)`（`app/utils/ticket.ts` 的 `venueSegment()`）把整段吃掉；樣板 `{{ name }}` 直接印空。｜來源：2026-09-07 實測（venue-dropdown） |
| 229 | **`venue.raw` 存的不是政府 CSV 原樣，是 parser 的輸出物——而 schema 的欄位註解說的是相反的事。** `scripts/seed-supabase.ts` 寫的是 `raw: v`，而 `v` 就是 `Cinema` 物件本身 ⇒ **任何在 parser 層做的正規化（fallback、trim、台／臺統一…）都會連 `raw` 一起改寫**，而 `seed_venues()` 對 `raw` 的欄位註解逐字寫著「raw 是『上游原樣』，永遠以上游為準：它存在的意義就是留下未經加工的來源」。**這兩件事現在是矛盾的。** ⇒ 要在 parser 補值又想保住證據，就得在 `Cinema` 上多帶一個原始欄位（例如 `govName`）。在那之前，**不要拿 `raw` 當「上游到底寫了什麼」的證據**。｜來源：2026-09-07 實查（venue-dropdown） |

## 7.6 檢查機制本身會失效

> 這一節收的是「**斷言／驗證腳本自己壞掉**」那一類。它們的共同形狀是：檢查存在、名字也對，但**它守的不是它宣稱要守的東西**——於是弄壞被守的東西不會紅（假綠），或是根本沒弄壞卻紅了（假紅）。兩種都會把人推向錯的下一步：假綠讓人以為驗過了，假紅讓人去「放寬斷言」，順手拆掉唯一真的守得住的檢查。
>
> 這個家族在本節之外還有既有的條目，**一起讀**：#165（跨層的欄位要有跨層的斷言）、#166（註解會餵飽字串比對）、#167（別人的工作樹會給你假紅燈）、#175（聚合型斷言的門檻）、#185（量錯了參照系）、#188（量錯了對象）、#189（讀 migration 不等於讀活體）。新條目的編號不連續是號段制度的正常結果，**不要為了連號而重排**。

| # | 踩雷點 | 來源 |
|---|---|---|
| 230 | **★★ 突變測試（「故意弄壞它看會不會紅」）本身有四種自壞法，而每一種看起來都像「這條斷言沒有鑑別力」。** ① **全部都紅**：第一版用 `pnpm exec vitest run <file> --reporter=basic`，而 **vitest 5 沒有 `basic` 這個 reporter** ⇒ 每一次都 exit≠0，8 個變異全部漂亮地報 RED（錯誤訊息 `ERR_LOAD_URL / loadCustomReporterModule` 被 stack trace 淹在幾十行後面，`tail` 看不到）。只因為在變異組**前後各放了一次「未變異、必須 0 failed」的控制組**，才看到控制組也是紅的。② **弄壞法只換掉第一個出現處**：`perl -0pi -e 's/md:top-18/md:top-4/'` **沒加 `/g`**，而第一個出現處在**自己剛寫好的註解**裡，`<nav>` 那行根本沒被動到（#166 說註解會餵飽斷言，這是它的另一面：**註解也會吃掉突變**）；同一天在另一條線是 `String.replace("td: 'w-40', th: 'w-40'", …)` 換到了日期欄而不是備註欄。③ **突變讓它編不過**：刪掉一行 `v-if` 讓底下的 `v-else` 變成孤兒，SFC 編不過，而腳本把 build 輸出丟到 `/dev/null` 又沒檢查 exit code ⇒ harness 載入了**上一個突變留下的 bundle**，印出一份看起來很合理、其實完全屬於上一輪的失敗清單。④ **比對前沒剝 ANSI 色碼** ⇒ 六輪突變全部吐出空字串，看起來像「什麼都沒發生」。⇒ 規矩：**(a)** 一定要有控制組，而且跑在變異組**前後兩次**——「全部都紅」跟「全部都綠」一樣可疑；**(b)** 不要用 exit code 判紅綠，解析 `Tests N failed \| M passed` 那一行（exit≠0 的原因有很多種，只有一種是你要的）；**(c)** 弄壞法的比對字串要**帶上足以定位的鄰居**（`md:sticky md:top-18`、`header: '備註'`），突變下去之後**先確認被改的真的是那一行**，再判斷紅綠；**(d)** 每一輪先刪產物、再檢查 build 的 exit code，而且要選「編得過但語意錯」的突變（例如把條件改成 `true`），不要選「直接編不過」的 | 2026-09-07 實測（四條線各自撞到一種） |
| 231 | **★★ 字串比對斷言的四種假綠與一種假紅——病根都是「錨點沒有落在它宣稱要守的東西上」。** **假綠**：① **錨點落在資料而不是 template**：`grep -c "to: '/legal/" app/components/AttributionFooter.vue` = 4 被拿來守「侵權通知窗口每一頁都到得了」（§6.1③），但那四個命中全在 `<script setup>` 的 `const legalLinks = [...]`；**實測**把整個 `<footer>` template 抽掉，那條 grep 仍然回 4——頁尾一條連結都到不了，檢查全綠。② **前綴同名**：`toContain('<SpendByYear')` 守「儀表板真的 render 了這個元件」，把標籤改名成 `<SpendByYearX`（band 整個消失）**照樣綠**，因為舊名是新名的前綴。③ **pattern 帶了太多上下文**：驗收寫 `grep -rn "copyright@filmnote.tw" docs/` 只有 3 個命中、全在 BUILD_PLAN，因為 `SPEC.md` 與 `SCREENS.md` 寫的是**不帶網域**的 `copyright@` ⇒ 改完三行就一片綠，而**兩份上游規格原封不動留著**——那正是這條斷言最該守的事。④ **註解餵飽**（既有 #166）。**假紅**：⑤ **拿中文散文當錨點**——計畫建議「留一行註解說明為什麼刪掉」，而那行註解逐字含有「管理紀錄」與「已登入」，同一份計畫的驗收又要求那兩個字串命中 0 ⇒ 照著做必然拿到假紅燈，然後下一步幾乎一定是「把斷言放寬」。⇒ 規矩：**(a)** 要守「這東西還在畫面上」，錨點必須落在 **template 行**，而且**先驗證它在檔內唯一**；**(b)** 錨到**程式碼模式**不要錨到中文（`@click="signOut"`、`^const supabase`、帶結構的前綴——散文寫不出來，於是註解可以寫得夠白話而不用閃躲）；**(c)** 接線斷言一律要**邊界**（`/<SpendByYear[\s/>]/`），並配一組正向對照證明它放得過 `<SpendByYearX`；**(d)** 要斷言的常常是**位置關係**而不是「字出現過」（從 `<ChartBand` 到 `title="每年花費"` 之間必須有 `v-if="hasSpend"`）；**(e)** 要守「這個檔根本不該被動」，用 `git status --porcelain -- <path>` 必須無輸出，比任何 grep 都強（純刪除、純空白都會紅，也不會被同一輪別人改別的檔干擾）。⚠️ 附帶一個不對稱，它是這一條的真正賭注：`AttributionFooter` 的 TMDB 那一段被 lint 意外保護到（刪掉會讓 `tmdbLogo`／`TMDB_RATIO` 變孤兒，`unused-imports` = error），但**政府開放資料顯名那一段是純 markup、零 script 相依**——刪掉它 lint／typecheck／test／`verify:all` **全綠**，而 §6.2 寫著「未盡顯名標示義務者視為自始未取得授權」。整個 repo 沒有一條檢查在守它 | 2026-09-07 實測（多條線） |
| 232 | **★「凡是 render X 的頁面都必須出現欄位名 Y」這種跨檔 grep 接線斷言，在這組檔案上兩個方向都壞。** 上一輪計畫本來要在 `verify-all` 寫「凡是 render `<SpendByYear` 的 `.vue`，stripComments 之後必須出現 `tickets`」。實測：`app/pages/u/[username].vue` **全檔零筆 `tickets`**（它的數字是 `useUserSpend()` 的 map 帶進 `spend.byYear` 的）⇒ 這條會**紅在接線完全正確的呼叫端上**，而實作者只有兩條路——把 `/u/` 從清單挖掉（等於寫死清單），或在 `/u/` 塞一個沒有意義的 `tickets` 字樣把它餵綠；另一頭 `app/pages/app/index.vue` 改動之前**就有三處無關的 `tickets`** ⇒ 把 `tickets: y.tickets` 刪掉它**照樣綠**。⇒ **資料接線交給 typecheck，不要用字串比對**：元件 props 的 `tickets: number` 設成必填，哪一端漏了 `vue-tsc` 就會紅，而且不可能被註解餵飽。字串比對只留給 typecheck 摸不到的東西（「這個函式真的被呼叫了」「三段的先後順序」「閘門接在哪個 `v-if` 上」）——這個 repo **沒有元件測試基礎設施**（`tests/` 全是純 `.ts`，無 `@vue/test-utils`／`happy-dom`／`playwright`），那些東西只能掃原始碼 | 2026-09-08 實測（dashboard-spend-by-year） |
| 233 | **★ 冒充的斷言比略過更糟——驗證項的名字必須說得出它守的是什麼。** 計畫本來要加一條 `u/repeat-matches-drawer`。它實際做的事是「拿 `/api/u/{u}/stats` 的 repeats 跟 `/api/u/{u}` 的列表在腳本裡各算一次然後比」——那是**資料層的一致性**，根本沒碰到抽屜。把下面任何一項弄壞它照樣綠：① `@pick` 寫成直接指派而跳過 `await ensureAllRecords()`；② 過濾述詞少了年份條件；③ 過濾 `visible` 而不是 `cards`；④ 忘了傳 `show-year`。名字叫 `matches-drawer` 會讓下一個人以為抽屜被守住了——**而略過至少會印一行 ⏭️**。⇒ 改名成說得出自己守什麼的（`u/repeat-film-id-joins`、`u/repeat-scope-follows-year`），並在區塊註解裡把「弄壞了它照樣綠」的形狀**逐條列出來**。⚠️ 順帶：既有的 `if (peak) { … }` 沒有 else，**資料一變空整條檢查就蒸發**；新加的都配了 `r.skip()` 並寫明各自守的是什麼 | 2026-09-07 實測（repeat-list-drawer） |
| 234 | **★ 只驗長度的斷言擋不住「累加漏了」——JS 陣列會自己長，把一個真的 bug 餵成綠燈。** 想守住「`rowTotals` 的長度必須跟著 `rows.length` 走，不可寫死 16」，寫了 `expect(g.rowTotals.length).toBe(g.rows.length)`。把初始化改成 `Array.from({length: 16})` 之後**測試照樣綠**——因為累加迴圈裡的 `rowTotals[18] = …` 會直接把陣列撐到 19，長度自己就對了。⇒ 對「補滿的陣列」下斷言時，**長度是最弱的一條**；真正會紅的是**跟另一個獨立算出來的量做等式**（`rowTotals.reduce(+) === total`），而且**要在會變的那個列數上驗一次**（16 列的 fixture 分辨不出任何東西）。補完之後兩種形狀的變異（return 時 `slice(0,16)`、累加時加 `y < 16` 守衛）才都紅。⇒ 更一般的形狀：**先想好「這條斷言擋的那個 bug 長什麼樣」，把那個 bug 真的寫出來跑一次**——這一輪 16 個變異裡有 2 個第一次是綠的，兩個都是斷言太弱、不是實作有問題 | 2026-09-07 實測（hour-heatmap） |
| 235 | **★ 用真實資料下斷言，還是可能整條分支都沒走到——`a \|\| b` 的左邊那條特別容易。** `memoIsLong(memo)` 是「含換行 **或** 單行化長度 > 16」。用活體 5 筆含換行的備註去驗「含換行一定給鈕」，全綠；但把**含換行那一條整個拿掉**，斷言**照樣全綠**——因為那 5 筆單行化之後是 65／64／64／54／54 字，全部 > 16，右邊那一條自己就成立了。**真資料不代表覆蓋到分支。** ⇒ 對 `a \|\| b` 這種條件，必須各準備一筆**只滿足其中一邊**的資料（這裡是一筆「短的多行備註」）。⚠️ 這條跟 #234 是同一個家族的兩半：#234 是**斷言本身太弱**，這一條是**餵給斷言的資料太窄**——兩者的症狀一樣（弄壞了不會紅），但修法不同，一個要換斷言、一個要補 fixture | 2026-09-07 實測（records） |
| 236 | **★★ 不開瀏覽器也驗得到的四種 UI 量測——這一波六條線共用一顆 Chrome，誰開誰污染，所以值得整組記下來。** ① **使用者看到的字面字串**（空白、斷行、標點）：`@vue/compiler-dom` 的 `compile(tpl, { mode: 'function' })` ＋ `@vue/server-renderer` 的 `renderToString`，把 tag 濾掉就是畫面上的字——這把「只能開瀏覽器才驗得到」的 UI 字串變成可重跑的量測。② **字串斷言不被註解餵飽**：`compileTemplate({ compilerOptions: { comments: false } })` 產生的 render 函式裡**沒有任何 HTML 註解**，所有字串斷言打在**編譯後**的 render 上而不是 `.vue` 原始碼上（⚠️ 兩個細節：靜態 class 會被 hoist 成 `const _hoisted_N = { class: "…" }`，要順著 id 查回去才對得到是哪一個分支；帶 `to` 的 `UButton` 渲染出來是 `<a href>` **不是** `<button>`，用 `querySelectorAll('button')` 數按鈕會錯）。③ **真的反應式互動**：`vue/compiler-sfc` 的 `parse` + `compileScript({ inlineTemplate: true, genDefaultAs })` 編成 TS 模組 → esbuild bundle（把 `from 'vue'` 換成 node_modules 的絕對路徑，`/tmp` 底下才解析得到，而且要與 harness 共用同一份 vue 實例）→ `createRenderer({ createElement, createText, …, patchProp })` 接一組 **plain object 當節點**（`patchProp` 就寫 `el.props[key] = next`）。拿到的東西是真的：`btn.props.onClick()` 會觸發、換 props 會走 patch（不 remount）、`nextTick` 之後 `v-if` 真的長出來——這一輪用它跑了 32 條斷言、11 次突變。⚠️ Nuxt auto-import 在這裡不存在，要手動補（`computed`／`ref`／`watch`／`useId`）；元件 stub **不能只宣告成模組層的 const**——編譯器已經把它編成 `resolveComponent("UIcon")` 了，要 `app.component('UIcon', stub)`。④ **圖表版面**：`echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })` + `setOption` + `renderToSVGString()`，純 node、不需要 node-canvas、不開瀏覽器、不佔 port，整支測試 33ms（前提是 option 建構要是一支能離開 SFC 的純函式，所以才有 `app/utils/hour-heatmap-option.ts`）。它抓得到「對 option 欄位下斷言」抓不到的東西（後者大半是照抄原始碼的變更偵測器）：`<text>`／`<path>` 的**個數**（少一個標籤 = 被 `axisLabel.interval: 'auto'` 吃掉了，症狀是「那一格看起來是 0 場」、零錯誤訊息）、`transform="translate(x y)"` 的**座標**（右側總和與左側時刻的 y 完全相同，才是「`inverse` 對齊、formatter 沒有 off-by-one」的真證據——拿掉 `inverse` 會讓右邊整組上下顛倒，而**每一個數字看起來都還是合理的**）、`text-anchor` 與原點 x（右緣溢出可以在 CI 裡算）。⚠️ **這四招驗不到的只有 CSS 實際算出來的樣子**：溢出、對比、hover 顏色、焦點環——那些還是得上瀏覽器。全部檔案放 `/tmp`（見 #215 的目錄規矩），repo 一個檔都不多 | 2026-09-07 實測（四條線各建一種） |
| 237 | **★ 型別保護長在不會出錯的那一邊：純函式的參數宣告成可選，等於把 `.vue` 的接線錯誤變成靜默的空抽屜。** 多刷抽屜的過濾述詞第一版設計成 `inRepeatScope(r: { filmId?: string \| null, … })`。這個宣告在 `/app` 那邊**沒有代價**（`records` 是 `computed<MyRecord[]>`，介面裡加了 `filmId: string`，map 忘了帶就是編譯錯誤），但 `/u/` 的 `cards` 是**沒有型別標註的 inline object literal**——忘了加 `filmId`，`r.filmId` 是 `undefined`，`if (!r.filmId) return false`，於是 **`/u/` 的多刷抽屜永遠是空的、標題還理直氣壯寫著「10 次」**，typecheck／lint／test 全綠、console 零錯誤。**保護剛好只長在不會出錯的那一邊。** 改成必填（`filmId: string \| null`——可以是 null 但不能不給）之後，兩個呼叫端都被強制供貨，`/u/` 忘了帶會變成 typecheck 紅燈。⇒ 通則：**寫給 `.vue` 呼叫的純函式，參數不要用 `?`。** 這個 repo 的頁面大量使用未標註型別的 computed literal，`?` 在那裡等於**關掉編譯器** | 2026-09-07 實測（repeat-list-drawer） |
| 238 | **★ `watch` 收合狀態時不可以看 `items.length`——全期與 2016 都是 6 列。** 唯讀 SQL 實測：全期 15 家 ⇒ 5 head +「其他 10 家」= **6 列**；2016 有 7 家 ⇒ 5 head +「其他 2 家」= **6 列**。長度一模一樣。所以 `watch(() => props.items, …)` 必須 watch **陣列參考本身**；任何把它「化簡」成 `props.items.length` 的重構，都會讓「全期展開中 → 切到 2016」這一步不觸發收合——**而那正是這個 watch 唯一要擋的 bug**，也是唯一會讓使用者看到「一個沒有東西解釋它為什麼是開的展開」的路徑。突變確認過：拿掉 watch，那三條斷言立刻紅。⇒ 一般形狀是**「用一個便宜的代理量取代真正的相依，而代理量在真實資料上碰巧同值」**——跟 #165 是同一個家族 | 2026-09-07 實測（4-其他可展開） |
| 239 | **★ 時區相關的斷言，在台灣的機器上測不出時區錯誤。** 實測：把 `stampText()` 的 `timeZone: 'Asia/Taipei'` 拿掉（改吃本機時區），`TZ=Asia/Taipei` 下 14 條測試**全綠**，`TZ=America/New_York` 下才紅 2 條。David 與這個專案的所有開發都在 `Asia/Taipei` ⇒ 這一類斷言在本機是**結構性地無效**：它「看起來在檢查、實際上恆真」。⇒ 凡是把 `timestamptz` 格式化成台北牆上時間的斷言，都必須**在非台灣時區跑過一次才算驗過**；建議 CI 至少跑一輪 `TZ=UTC pnpm test` | 2026-09-07 實測（Step 9a） |
| 240 | **這個 shell 的遞迴 grep 看不到 `.env`——任何拿 `grep -r` 證明 `.env` 狀態的斷言都是假的。** 實測：`grep -rn "COPYRIGHT_CONTACT_EMAIL" . --exclude-dir=node_modules …` 回 4 個檔，**`.env` 不在裡面**；而 `grep -n COPYRIGHT_CONTACT_EMAIL ./.env` 顯式指路，第 19 行明明就在（本 shell 的 `grep` 是 shell-snapshot 裡的一個 function）。⇒ **要驗 `.env` 的內容一律用顯式路徑。** 這一條在「拿掉受理窗口 email」那一項特別要命：`.env` 裡那個值是「`pnpm build` 之後 `.output` 裡不應該再有那個位址」這條斷言的**正向對照**——`.env` 被清空的話，那條斷言會因為「根本沒值」而變綠（見 §5 Step 8 的驗收句） | 2026-09-07 實測（受理窗口改表單） |

---

# 8. 未能驗證事項（執行者必須自行確認）

## 8.1 資料庫（最高優先）

1. ~~**本計畫的 SQL 未在真實 Postgres 上執行過。**~~ → ✅ **2026-09-05 已在真實 Supabase 專案（PostgreSQL 17.6）套用完成**，並對已 seed 的資料重跑驗證冪等（2,669 / 3,116 / 111 三個數字不變）。已確認：`create policy … on storage.objects` 以直連 `postgres` 執行**不需要** `supabase_admin`（踩雷 #45 解除）。**仍未驗證**：`delete from auth.users` 是否為 postgres 可執行（`delete_my_account()` 尚未實作，留待 US-47）。`admin_add_strike()` 與 guard trigger 的互動已不適用——本版沒有 transaction-local bypass 旗標，管制欄位改由 policy 的 `with check` 釘死。
2. ~~**特權情境判定的三個判準需逐一實測。**~~ → ✅ **已實測，且結果推翻了 §1.1 修正 A 的原始寫法**（見該節「修正 A 的更正」）：

   | 呼叫路徑 | `current_user`（DEFINER 內） | `session_user` | `jwt.claims.role` |
   |---|---|---|---|
   | 直連 postgres | `postgres` | `postgres` | *(none)* |
   | PostgREST + publishable key | **`postgres`** | `authenticator` | `anon` |
   | PostgREST + 使用者 JWT | **`postgres`** | `authenticator` | `authenticated` |
   | PostgREST + secret key | **`postgres`** | `authenticator` | `service_role` |

   關鍵：`current_user` 在 SECURITY DEFINER 內**永遠是 `postgres`**，三種呼叫者完全無法區分——這正是踩雷 #31。`service_role` 也**不會**讓 `current_user` 變成 `service_role`。可用的判準只有 `session_user`（區分直連 vs PostgREST）與 `request.jwt.claims.role`（區分 anon / authenticated / service_role）。
3. **Vercel ISR 是否會把 cookie 納入快取 key，官方文件從未明文說明。**「`/u/**` 不可快取」是綜合 Nitro cache 文件與 Vercel ISR 文件推導的工程判斷。**上線前務必實測 Step 4 的第 ③④ 條。**
4. **`viewing_record_select` 的 policy 內含 EXISTS 子查詢**（檢查 film 與 profile 狀態）。需以 `EXPLAIN (ANALYZE, BUFFERS)` 對真實資料量確認是 semi-join 而非逐列求值。若成為瓶頸，備案是反正規化——但那會引入一致性風險且**失敗方向指向外洩**（提案 2 的教訓），非不得已不做。
5. **helper 函式對 anon 開放 EXECUTE 會形成 oracle**（「這個 record 是否公開且已開票價」）。實務上 UUID 不可猜測，且 helper 放在不曝露的 schema——但**這個保護只存在於 Supabase 專案設定（`db-schemas`），不在 SQL 裡**。需確認該設定只有 `public`（與 `graphql_public`）。
6. **未使用 `FORCE ROW LEVEL SECURITY`。** helper 靠「表擁有者不受 RLS 約束」讀真值；開了 FORCE 會失效。代價是任何以 postgres 身分執行的 SQL 完全不受 RLS 保護。需確認這個取捨可接受。
7. **現用 username 對 anon 全可列舉**（公開個人頁的必然結果），可被用來建立全站使用者清單。爬蟲防護要在邊緣層做，schema 層無解。
8. **`resolve_username()` 的舊→新轉向本身就是揭露**——知道舊名就得到新名。這是 US-25 的必然代價；緩解是不可列舉 + 可關閉 + 到期，不是消除。
9. **`grant select on public.film` 含 `created_by`**，公開已審核作品會揭露「誰新增了這部片」。若視為問題需改成逐欄 grant 排除該欄。
10. **`admin_*` RPC 對 `authenticated` 開放 EXECUTE、由函式內部自行把關。** 斷言只能做字串比對（`admin_` 前綴的 definer 函式原始碼必須含權限檢查），不是語意檢查——仍需 code review。

## 8.2 Nuxt / 套件

11. ~~**沒有實際 scaffold 過該組合。**~~ → ✅ **2026-09-05 已完成安裝與 build**，版本全部命中基準（nuxt 4.5.2 / @nuxt/ui 4.11.0 / @nuxtjs/supabase 2.0.10 / tailwindcss 4.3.3 / echarts 6.1.0 / vue-echarts 8.2.0 / typescript 5.9.3 / vue 3.5.42），**無相依衝突**。三個安裝期的坑：

    - **npm 10.9.4 裝不起這棵樹**：arborist 解 `nuxt` 的 peer set 時崩潰（`Cannot read properties of null (reading 'edgesOut')`），與 `overrides` 無關（拿掉照樣崩）。npm 11 正常。本專案最終改用 **pnpm 10.28.2**。
    - **pnpm 與 npm 11 都預設不跑依賴的 install script**：`esbuild` 需要它下載平台 binary、`vue-demi` 需要它切 Vue 2/3 版本。漏了的話 `vue-demi/lib` 整個不存在，`@floating-ui/vue` 與 `@vueuse/core`（Nuxt UI 的相依）會在執行期壞掉。pnpm 用 `pnpm.onlyBuiltDependencies` 明確批准。
    - **`#pipeline/*` 別名必須同時宣告在 `package.json` 的 `imports`**，只寫在 tsconfig 與 vitest.config 是不夠的：`#` 開頭是 Node subpath imports，vitest 走自己的 alias 所以測試全綠，但 `tsx` 跑 CLI 會 `ERR_PACKAGE_IMPORT_NOT_DEFINED`。**測試與正式執行走不同解析路徑，全綠不代表 CLI 能跑。**
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
32. **`takedown_notice` 開放 anon INSERT 是垃圾訊息的靶。** 必須在 Nitro/Edge 端加 Turnstile 或速率限制；資料庫層沒有防護。
33. **`certificate.raw` 永久保留原始 JSON 會放大 DB 體積。** 3,116 列估計數 MB，應無問題，但 **Supabase 免費專案 500MB 上限**需實測確認。
34. **「只提供線上表單、不公告電子郵件與聯絡地址」是否滿足著作權法 §90-4 第 3 款的「公告聯繫窗口」，未取得法律意見。** 條文只寫「聯繫窗口資訊」、未指定形式，而施行辦法要求的記載事項（§90-6）由表單逐欄要求，形式上是足的；但這是 2026-09-07 David 的裁定，不是律師的判斷。**決定的落點在 §6.1③**，要改先讀那一格的理由。

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