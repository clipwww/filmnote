-- =============================================================================
-- 0009 — US-47 帳號刪除
--
-- 為什麼這支必須存在：隱私權政策（docs/legal/privacy.md §5）白紙黑字寫著
-- 「你隨時可以刪除帳號與所有資料」，而在這支 migration 之前，這個功能
-- **完全沒有實作**——沒有函式、沒有端點，只有 profile_private 上一個
-- 從來沒有任何東西寫過的 deletion_requested_at 欄位。
-- 那份文件自己的開頭就寫著「條文若與實作不符，以修正實作為優先」。這裡修的是實作。
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 先把法遵證據救起來 —— 這一節必須在 delete_my_account() 之前
--
-- 實測 2026-09-06 的 FK 現況：
--     copyright_strike.profile_id → profile  ON DELETE **CASCADE**
--     counter_notice.profile_id   → profile  ON DELETE **CASCADE**
--
-- 也就是說，在這支 migration 之前，「刪除帳號」會順手把著作權法第六章之一
-- 要求的處理紀錄一起銷毀。§90-4 的避風港要件是「確實履行」，而能證明我們
-- 履行過的東西只有這些列。**被三振的人按一下刪除帳號，證據就沒了。**
--
-- ★ 改成 SET NULL 還不夠。三筆 profile_id 都是 NULL 的三振紀錄，跟三個不同的人
--   各被記一次，在資料上**長得一模一樣**——而 §90-4 第 2 款要證明的正是
--   「同一個人累積三次」。所以另存一個 subject_ref：
--     - 它就是原本的 user uuid，但帳號刪除後 auth.users 那一列已經不在，
--       這個 uuid 不再對應到任何姓名或 email ⇒ 對外是一個純粹的流水號。
--     - 它保住的是**鏈**（哪幾筆屬於同一個主體），不是身分。
--
-- ⚠️ 這一節有法律意涵，已列為卡點請 David 裁定：
--   ① 保留期限。目前是無限期保留。個資法 §11 III 但書允許「因執行職務或業務
--      所必須」而不刪除，但沒說可以永久留著。
--   ② legal_acceptance **刻意仍然 CASCADE**（不在本節處理）。它的內容是
--      「這個人在這個時間點同意了這份文件」，是純粹的個人資料；帳號刪除後
--      既沒有可執行的對象，蒐集目的也已消滅，留著反而不利。
--   ③ takedown_notice.target_url 裡通常含 /u/{username}，那是取下標的本身的
--      證據，不能移除。所以「哪個使用者名稱曾被取下」這件事必然留下痕跡。
-- -----------------------------------------------------------------------------
alter table public.copyright_strike add column if not exists subject_ref uuid;
alter table public.counter_notice   add column if not exists subject_ref uuid;

update public.copyright_strike set subject_ref = profile_id
 where subject_ref is null and profile_id is not null;
update public.counter_notice   set subject_ref = profile_id
 where subject_ref is null and profile_id is not null;

-- BEFORE ROW trigger 在 NOT NULL 檢查之前執行，所以寫入端不必記得帶這個欄位。
-- ★ 這是刻意的：0006 的 admin_add_strike() 只 insert (profile_id, notice_id, note)。
--   若改成要求寫入端自己填 subject_ref，那就等於把「證據會不會留下」交給
--   每一個未來的呼叫端記得——和 §7 #84 / #106 同一個家族的錯。
create or replace function public.fill_subject_ref()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.subject_ref := coalesce(new.subject_ref, new.profile_id);
  if new.subject_ref is null then
    raise exception '% 必須有 profile_id 或 subject_ref（法遵證據不可匿名到無法識別鏈）',
      tg_table_name using errcode = '23502';
  end if;
  return new;
end $$;

drop trigger if exists strike_subject_ref on public.copyright_strike;
create trigger strike_subject_ref before insert on public.copyright_strike
  for each row execute function public.fill_subject_ref();
drop trigger if exists counter_subject_ref on public.counter_notice;
create trigger counter_subject_ref before insert on public.counter_notice
  for each row execute function public.fill_subject_ref();

do $$ begin
  alter table public.copyright_strike alter column subject_ref set not null;
  alter table public.counter_notice   alter column subject_ref set not null;
exception when others then
  raise exception '無法把 subject_ref 設為 NOT NULL——代表有列的 profile_id 與 subject_ref 都是空的：%', sqlerrm;
end $$;

alter table public.copyright_strike alter column profile_id drop not null;
alter table public.counter_notice   alter column profile_id drop not null;

alter table public.copyright_strike drop constraint if exists copyright_strike_profile_id_fkey;
alter table public.copyright_strike add constraint copyright_strike_profile_id_fkey
  foreign key (profile_id) references public.profile (id) on delete set null;
alter table public.counter_notice drop constraint if exists counter_notice_profile_id_fkey;
alter table public.counter_notice add constraint counter_notice_profile_id_fkey
  foreign key (profile_id) references public.profile (id) on delete set null;

create index if not exists strike_subject_idx  on public.copyright_strike (subject_ref);
create index if not exists counter_subject_idx on public.counter_notice (subject_ref);

comment on column public.copyright_strike.subject_ref is
  '帳號刪除後 profile_id 會被設成 NULL，這一欄保留原本的 user uuid，讓「同一主體累積三次」在資料上仍然成立（§90-4 第 2 款）。auth.users 已不存在 ⇒ 它不對應到任何姓名或 email。';
comment on column public.counter_notice.subject_ref is
  '同 copyright_strike.subject_ref。§90-9 的期限計算與回復義務必須能事後查核。';

-- ⚠️ apply_three_strikes() 刻意**不在這裡重新定義**。
--
-- 本檔第一版為了「profile_id 現在可以是 NULL」而加了一個 null 短路，寫法是照
-- 0001 的函式體改的——而 0006 已經改過同一支函式（撤銷全部三振時要把
-- service_status 歸回 'active'）。0009 跑在 0006 之後，於是那個修正被**靜默回退**，
-- 所有靜態檢查照樣全綠，`create or replace` 不會抱怨你覆寫了誰。
-- 是 verify-dmca.sql 的 F 段（「三振全部撤銷後應回到 active」）把它抓出來的。
-- → §7 #109。
--
-- 而且那個 null 短路根本不需要：profile_id 為 NULL 時
-- `where profile_id = new.profile_id` 配不到任何列（c = 0），
-- `where id = new.profile_id` 也配不到任何列（不更新任何人）。
-- 這支 trigger 在結構上已經是 null-safe 的。
--
-- **在較晚的 migration 裡 create or replace 一支較早 migration 修過的函式，
--   等於把那個修正刪掉。要改就去改定義它的那一支。**

-- -----------------------------------------------------------------------------
-- 2. 拆掉 deletion_requested_at
--
-- 這個欄位從 0001 起就存在，暗示原設計是「先標記、後執行」的兩階段刪除。
-- 兩階段本身沒有錯（誤刪的緩衝是真的有用），但**必須有東西真的會去執行第二階段**。
-- 現況是：沒有任何程式寫過它，也沒有任何排程會去讀它。
-- 那不是一個未完成的功能，那是一個會讓刪除**看起來有做**的欄位——
-- 和 purge_expired_tmdb_cache() 從建立起就沒成功執行過是同一種失敗（§7 #103 家族）。
--
-- 本版採單階段：呼叫即刪除，一個交易內完成。理由：
--   ① 隱私權政策寫的是「**隨時**可以刪除帳號與所有資料」，沒有提到緩衝期。
--      要走兩階段就得同時改那份文件，而現在的方向是修實作、不改文件。
--   ② 兩階段的第二階段只能靠 Vercel Cron，而 Cron 在這個專案裡**從未真的觸發過**
--      （交接筆記第 5 節）。把「資料到底有沒有被刪掉」壓在一個未經實證的機制上，
--      失敗的樣子是：使用者以為刪了，資料還在，而且沒有人會發現。
--   ③ 誤刪的緩衝改由端點的二次確認負責（要求輸入自己的 username），
--      那是同步的、看得見的，不依賴任何排程。
--
-- ⚠️ 這是產品語意決定，已列入回報請 David 覆核。要改回兩階段，把欄位加回來
--    是一行 SQL——但那一行必須跟「真的會執行第二階段的東西」一起進來。
-- -----------------------------------------------------------------------------
alter table public.profile_private drop column if exists deletion_requested_at;

-- -----------------------------------------------------------------------------
-- 3. 哪些自建作品會隨帳號一起消失 —— 唯一真相
--
-- ★ 為什麼要獨立成一支函式，而不是把條件抄在 delete_my_account() 裡：
--   端點必須在刪除**之前**把這些作品的海報從 bucket 移掉（移除海報要走
--   ugc_poster_delete policy，而那條 policy 需要 film 那一列還在、且 created_by
--   還是自己）。也就是說「哪些作品要刪」這組條件至少會被問兩次。
--   抄兩份 = 兩份一定會漂移，而漂移的樣子是「海報留在 bucket 裡沒人記得」。
--   同一個教訓在 og-card 的 safeHero() 已經踩過一次（交接筆記第 7 節第 3 點）。
--
-- ★ 判準的產品語意（這是本次最需要 David 覆核的一條）：
--   - **已核准的 UGC 作品留在公共片庫，只切斷 created_by**（FK 本來就是
--     on delete set null）。一經核准它就對所有人可見，別人可以拿它記錄自己的
--     觀影——那時刪掉就不是收回自己的東西，是把別人的紀錄一起炸掉
--     （viewing_record.film_id 是 on delete restrict，真的會炸）。
--   - **從未核准、也沒有任何人引用的作品跟著刪**。它從來沒進過公共片庫
--     （visibility 只能是 private，見 film_public_requires_approval check），
--     除了作者與 staff 沒有人看得到它，而且它留下來只會變成審核佇列裡一筆
--     沒有作者可以問的待審項目。
--
-- ★ 不開 EXECUTE 給任何角色。它收一個 uuid 參數，一旦對 authenticated 開放，
--   任何人都能拿別人的 uuid 列舉對方的未審核作品 id 與海報路徑。
--   它只被下面兩支 SECURITY DEFINER 函式在內部呼叫（那時 current_user 是 postgres）。
-- -----------------------------------------------------------------------------
create or replace function public.account_purgeable_films(p_user uuid)
returns table (film_id uuid, poster_path text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.ugc_poster_path
    from public.film f
   where p_user is not null
     and f.created_by = p_user
     and f.origin = 'ugc'
     and f.review_state <> 'approved'
     and f.merged_into_film_id is null
     -- ★ 別人的紀錄一筆都不能少。自己的紀錄會在同一個交易裡先被刪掉，
     --   所以這裡只看「不是本人」的引用。
     and not exists (select 1 from public.viewing_record v
                      where v.film_id = f.id and v.user_id is distinct from p_user)
     -- 被合併進來的作品：它的 identity 還指著這一列
     and not exists (select 1 from public.film g where g.merged_into_film_id = f.id)
     -- film_merge_log 的兩個 FK 都是 on delete restrict，會擋下 DELETE
     and not exists (select 1 from public.film_merge_log m
                      where m.loser_id = f.id or m.winner_id = f.id)
$$;

comment on function public.account_purgeable_films(uuid) is
  '帳號刪除時會一併消失的自建作品。account_deletion_preview() 與 delete_my_account() 共用這一份判準——端點要先清海報、函式才刪列，兩邊必須看到同一組作品。不對任何角色開放 EXECUTE。';

-- -----------------------------------------------------------------------------
-- 4. 刪除前的預覽
--
-- ★ 不收任何參數。這是刻意的安全性質：這支函式在結構上**不可能**被指向別人。
--   一支 delete_user(p_uuid) 形態的 API 只要 is_staff() 判斷寫錯一次就是全站災難。
-- -----------------------------------------------------------------------------
create or replace function public.account_deletion_preview()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_username text;
begin
  if v_user is null then
    raise exception '需要登入' using errcode = '42501';
  end if;
  select p.username into v_username from public.profile p where p.id = v_user;
  if v_username is null then
    raise exception '找不到這個帳號' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'username', v_username,
    'records', (select count(*)::integer from public.viewing_record v where v.user_id = v_user),
    'usernames_to_reserve',
      (select count(*)::integer from public.username u where u.profile_id = v_user),
    -- 端點要靠這一份去清 bucket，所以要給 id 不只給筆數
    'films_to_delete', coalesce((
      select jsonb_agg(jsonb_build_object('id', film_id, 'poster_path', poster_path))
        from public.account_purgeable_films(v_user)), '[]'::jsonb),
    'films_to_keep', (
      select count(*)::integer from public.film f
       where f.created_by = v_user
         and f.id not in (select film_id from public.account_purgeable_films(v_user))),
    'strikes_retained', (
      select count(*)::integer from public.copyright_strike s where s.profile_id = v_user),
    'counter_notices_retained', (
      select count(*)::integer from public.counter_notice c where c.profile_id = v_user)
  );
end $$;

-- -----------------------------------------------------------------------------
-- 5. delete_my_account()
--
-- 順序是這支函式的全部重點，每一步都有一個「不這樣做會怎樣」：
--
--   ① username 先進隔離。profile 一被刪，username 那幾列就 CASCADE 消失，
--      屆時舊網址的 301 會指向一個不存在的人，而那個名字會立刻可以被別人註冊
--      ——外面還在流傳的 /u/{name} 連結就會指到另一個人身上。
--      改成 kind='reserved' + profile_id=null：resolve_username() 因為 join 不到
--      profile 而回 NULL（301 自然停掉、404），rename_username() 也擋掉重新註冊。
--      released_at 記下進隔離的時間，日後若決定「N 天後釋出」有依據可用。
--   ② 自己的紀錄先刪（票價 CASCADE 跟著走），否則 ③ 會被 film_id 的
--      on delete restrict 擋下來。
--   ③ 才刪那些從未進公共片庫、沒有任何人引用的自建作品。
--   ④ 留下來的作品海報還在 bucket 裡，但 storage.objects.owner 不該繼續指著
--      一個已經不存在的人。
--   ⑤ 最後才刪 auth.users。這一步不能省——public schema 清乾淨但登入系統那一列
--      還在的話，使用者再用 Google 登入會拿到一個「有 session、但沒有 profile」
--      的殭屍狀態：account_is_servable() 為 false ⇒ 個人頁看不到、紀錄建不了，
--      而 on_auth_user_created 是 AFTER INSERT，不會再補一次。
--      刪掉之後再登入會走一次完整註冊，拿到新的 uuid 與新的 username（舊名已隔離）。
--      auth.identities / sessions / refresh_tokens 全部 CASCADE，Google 的 sub
--      與 email 也一併消失——那是「所有資料」這句話裡最不能漏掉的部分。
--
-- ★ 一樣不收參數。刪除的對象永遠是呼叫者自己。
-- ★ SECURITY DEFINER 是必要的：delete from auth.users 需要 postgres
--   （auth.users 的 owner 是 supabase_auth_admin，且 RLS 開著、零條 policy）。
--   實測 2026-09-06：postgres 有 DELETE 權限且 rolbypassrls=true。
--   但那只是 has_table_privilege 的靜態答案——本檔第 7 節會真的刪一次。
-- -----------------------------------------------------------------------------
create or replace function public.delete_my_account()
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user     uuid := (select auth.uid());
  v_username text;
  v_names    integer := 0;
  v_records  integer := 0;
  v_films    integer := 0;
  v_kept     integer := 0;
  v_posters  integer := 0;
begin
  if v_user is null then
    raise exception '需要登入' using errcode = '42501';
  end if;

  select p.username into v_username from public.profile p where p.id = v_user;
  if v_username is null then
    raise exception '找不到這個帳號' using errcode = 'P0002';
  end if;

  -- ① 舊名進隔離（必須早於 profile 被 CASCADE 掉）
  update public.username
     set kind = 'reserved', profile_id = null, released_at = now()
   where profile_id = v_user;
  get diagnostics v_names = row_count;

  -- ② 自己的紀錄（viewing_record_cost 是 on delete cascade）
  delete from public.viewing_record where user_id = v_user;
  get diagnostics v_records = row_count;

  -- ③ 從未進公共片庫、沒有任何人引用的自建作品
  delete from public.film f
   where f.id in (select p.film_id from public.account_purgeable_films(v_user) p);
  get diagnostics v_films = row_count;

  select count(*) into v_kept from public.film f where f.created_by = v_user;

  -- ④ 留下來的海報：切斷 owner
  update storage.objects
     set owner = null, owner_id = null
   where bucket_id = 'ugc-poster' and owner = v_user;
  get diagnostics v_posters = row_count;

  -- ⑤ 登入系統那一列。CASCADE 帶走 profile / profile_private / legal_acceptance；
  --    第 1 節改過的兩個 FK 讓法遵證據留下來（profile_id 變 NULL、subject_ref 保留）。
  delete from auth.users where id = v_user;
  if not found then
    raise exception 'auth.users 沒有 % 這一列，刪除未完成', v_user using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'deleted_at', now(),
    'username', v_username,
    'records_deleted', v_records,
    'films_deleted', v_films,
    'films_kept_anonymised', v_kept,
    'usernames_reserved', v_names,
    'posters_disowned', v_posters
  );
end $$;

comment on function public.delete_my_account() is
  'US-47。不收參數 ⇒ 只能刪呼叫者自己。單階段、單交易。海報 blob 的移除由端點在呼叫本函式之前完成（見 server/api/account/delete.post.ts）。';

-- -----------------------------------------------------------------------------
-- 6. 授權
--    9999_grants.sql 才是權威；這裡再寫一次是為了讓第 7 節的冒煙測試
--    不依賴 9999 的執行順序（沿用 0008 的做法）。
-- -----------------------------------------------------------------------------
revoke execute on function public.account_purgeable_films(uuid) from public, anon, authenticated;
grant execute on function public.delete_my_account(),
  public.account_deletion_preview() to authenticated;

-- -----------------------------------------------------------------------------
-- 7. 冒煙測試
--
-- 0005 的教訓：create function 不檢查函式體。這一節真的建兩個拋棄式帳號、
-- 真的走一次刪除，然後逐條斷言。包在有 EXCEPTION 子句的區塊裡 ⇒ 隱含 savepoint，
-- 跑完全部回滾，一列都不留。
--
-- ★ 為什麼要**兩個**帳號：整個設計最貴的那條保證是「別人的紀錄一筆都沒少」。
--   只用一個帳號測，那條保證根本沒有被驗到——而它壞掉的樣子是別人的資料消失。
--
-- ★ 為什麼要**三部**作品（這是本檔第一版的假綠燈，記在這裡免得下一棒又踩）：
--   第一版只有「已核准＋被 B 引用」與「未核准＋沒人引用」兩部。我把
--   account_purgeable_films 裡那條 `not exists (viewing_record …)` 整段刪掉，
--   冒煙測試**照樣全綠**——因為那部被引用的作品是 approved，早就被前一個條件
--   `review_state <> 'approved'` 擋掉了，引用檢查從頭到尾沒有被求值過。
--   兩條防護串在一起時，只測到其中一條，另一條就是裝飾品。
--   第三部（未核准、卻被別人引用）專門用來讓引用檢查成為唯一擋下它的東西。
--   同樣地，第四部（已核准、但沒有任何人引用）讓 `review_state <> 'approved'`
--   成為唯一擋下它的東西——實測把那一條拿掉時，只有它會變紅。
--   **兩條防護串在一起時，每一條都需要一個只有它擋得住的案例。**
-- -----------------------------------------------------------------------------
do $$
declare
  v_a uuid := extensions.gen_random_uuid();   -- 要被刪的人
  v_b uuid := extensions.gen_random_uuid();   -- 旁觀者
  v_venue text;
  v_shared uuid;      -- A 建立、已核准、B 拿去記錄的作品
  v_orphan uuid;      -- A 建立、未核准、沒人引用的作品
  v_cited uuid;       -- A 建立、未核准、**被 B 引用**的作品（只有引用檢查擋得住它）
  v_listed uuid;      -- A 建立、已核准、**沒人引用**（只有 review_state 檢查擋得住它）
  v_name_a text;
  v_strike bigint;
  v_res jsonb;
  n integer;
begin
  begin
    select id into v_venue from public.venue order by id limit 1;
    if v_venue is null then
      raise notice '0009 冒煙測試略過：沒有任何 venue'; return;
    end if;

    -- auth.users 只有 id 是 NOT NULL 且無預設（實測 2026-09-06）。
    -- email 給值是為了讓 handle_new_user() 產出的 username 通過
    -- profile_username_shape（必須以 [a-z0-9] 開頭結尾）——底線開頭的 email
    -- 會讓那個 trigger 的 insert 失敗，而它整段包著 exception handler，
    -- 失敗的樣子是**靜默地沒有 profile**。
    insert into auth.users (id, email) values
      (v_a, 'zzsmoke0009a@example.invalid'),
      (v_b, 'zzsmoke0009b@example.invalid');

    select p.username into v_name_a from public.profile p where p.id = v_a;
    if v_name_a is null then
      raise exception '冒煙測試前置失敗：handle_new_user() 沒有替 A 建立 profile';
    end if;

    -- A 的兩部自建作品
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0009共用', 'ugc', 'public', 'approved', v_a) returning id into v_shared;
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0009孤兒', 'ugc', 'private', 'pending', v_a) returning id into v_orphan;
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0009被引用', 'ugc', 'private', 'pending', v_a) returning id into v_cited;
    -- 已進公共片庫但還沒有人記錄過。它是片庫的一部分，不是個人物品——
    -- 刪掉等於從所有人的搜尋結果裡拿走一部片。
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0009已上架', 'ugc', 'public', 'approved', v_a) returning id into v_listed;

    -- A 自己的紀錄（指向孤兒作品，證明 ② 一定要在 ③ 之前）
    insert into public.viewing_record (user_id, film_id, venue_id, watched_on)
    values (v_a, v_orphan, v_venue, current_date - 2);
    -- B 的紀錄，指向 A 建立的那部已核准作品
    insert into public.viewing_record (user_id, film_id, venue_id, watched_on)
    values (v_b, v_shared, v_venue, current_date - 1);
    -- B 的紀錄，指向 A 那部**未核准**的作品。
    -- 現實中 record_insert policy 的 film_usable_by() 會擋下這一筆，但這裡是 postgres
    -- （bypassrls）刻意造出來的——因為 approve_film(false) 可以把已核准的作品打回
    -- pending，屆時 B 的紀錄就會真的指著一部 pending 作品。那時唯一擋在
    -- 「刪帳號」與「B 的紀錄消失」之間的，就是引用檢查那一條。
    insert into public.viewing_record (user_id, film_id, venue_id, watched_on)
    values (v_b, v_cited, v_venue, current_date - 1);

    -- A 的舊名（模擬改過名）
    insert into public.username (name, profile_id, kind, released_at)
    values ('zzsmoke0009old', v_a, 'historical', now());

    -- A 的一筆三振紀錄（法遵證據）
    insert into public.copyright_strike (profile_id, note)
    values (v_a, '__smoke__0009') returning id into v_strike;
    if not exists (select 1 from public.copyright_strike where id = v_strike and subject_ref = v_a) then
      raise exception '冒煙測試失敗：subject_ref 的 trigger 沒有自動填值';
    end if;

    -- ── 預覽 ────────────────────────────────────────────────────────────
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_a, 'role', 'authenticated')::text, true);

    v_res := public.account_deletion_preview();
    if (v_res->>'records')::int <> 1 then
      raise exception '冒煙測試失敗：預覽的紀錄數應為 1，實得 %', v_res->>'records';
    end if;
    if jsonb_array_length(v_res->'films_to_delete') <> 1
       or (v_res->'films_to_delete'->0->>'id')::uuid <> v_orphan then
      raise exception '冒煙測試失敗：預覽應只列出孤兒作品，實得 %', v_res->'films_to_delete';
    end if;
    if (v_res->>'films_to_keep')::int <> 3 then
      raise exception '冒煙測試失敗：應保留 3 部（已核准被引用／未核准被引用／已核准無人引用），實得 %',
        v_res->>'films_to_keep';
    end if;

    -- ── 真的刪一次 ──────────────────────────────────────────────────────
    v_res := public.delete_my_account();

    -- ★ 最貴的那條：B 的兩筆紀錄與 A 建的那兩部被引用的作品都必須完好
    select count(*) into n from public.viewing_record where user_id = v_b;
    if n <> 2 then
      raise exception '冒煙測試失敗：★ 別人的紀錄被刪掉了（剩 %／2 筆）', n;
    end if;
    select count(*) into n from public.film where id in (v_shared, v_cited);
    if n <> 2 then
      raise exception '冒煙測試失敗：★ 別人引用中的作品被刪掉了（剩 %／2 部）', n;
    end if;
    -- 已上架但還沒人引用的那部：沒有任何 FK 會擋它，只有 review_state 那一條會。
    if not exists (select 1 from public.film where id = v_listed) then
      raise exception '冒煙測試失敗：★ 已進公共片庫的作品被刪掉了（片庫少一部片）';
    end if;
    if exists (select 1 from public.film where id in (v_shared, v_cited, v_listed) and created_by is not null) then
      raise exception '冒煙測試失敗：保留的作品仍指向已刪除的作者';
    end if;

    -- 該消失的都消失了
    if exists (select 1 from auth.users where id = v_a) then
      raise exception '冒煙測試失敗：★ auth.users 那一列還在（登入系統仍認得這個人）';
    end if;
    if exists (select 1 from public.profile where id = v_a) then
      raise exception '冒煙測試失敗：profile 還在';
    end if;
    if exists (select 1 from public.profile_private where id = v_a) then
      raise exception '冒煙測試失敗：profile_private 還在';
    end if;
    if exists (select 1 from public.viewing_record where user_id = v_a) then
      raise exception '冒煙測試失敗：本人的紀錄還在';
    end if;
    if exists (select 1 from public.film where id = v_orphan) then
      raise exception '冒煙測試失敗：未核准且無人引用的自建作品沒被刪掉';
    end if;

    -- username 進隔離，且 301 真的停掉
    select count(*) into n from public.username
     where name in (v_name_a, 'zzsmoke0009old') and kind = 'reserved' and profile_id is null;
    if n <> 2 then
      raise exception '冒煙測試失敗：舊名沒有全部進隔離（實得 %／2）', n;
    end if;
    if public.resolve_username(v_name_a) is not null then
      raise exception '冒煙測試失敗：★ 已刪除帳號的舊名還會 301 到某個地方';
    end if;

    -- 法遵證據留下來了，而且鏈還在
    select count(*) into n from public.copyright_strike
     where id = v_strike and profile_id is null and subject_ref = v_a;
    if n <> 1 then
      raise exception '冒煙測試失敗：★ 三振紀錄隨帳號一起消失了（§90-4 的證據）';
    end if;

    -- 回傳值不是裝飾品，它是端點回給使用者的那份摘要
    if (v_res->>'records_deleted')::int <> 1 or (v_res->>'films_deleted')::int <> 1
       or (v_res->>'usernames_reserved')::int <> 2 then
      raise exception '冒煙測試失敗：回傳摘要與實際不符 %', v_res;
    end if;

    -- ── 未登入時必須擋下來 ──────────────────────────────────────────────
    perform set_config('request.jwt.claims', '', true);
    begin
      perform public.delete_my_account();
      raise exception '冒煙測試失敗：★ 未登入也能呼叫 delete_my_account()';
    exception when insufficient_privilege then null;
    end;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0009 冒煙測試通過（含 auth.users 真的被刪、別人的紀錄完好、三振證據保留；變更已回滾）';
end $$;
