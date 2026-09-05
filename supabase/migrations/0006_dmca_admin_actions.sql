-- =============================================================================
-- 0006 — 取下／三振／回復三支 admin RPC（Step 8、著作權法 §90-4 第 4 款）
--
-- §90-7 的免責前提在 §90-4，而那些機制**必須在侵權發生時已經建置**，事後無法
-- 回溯適用。這是整份計畫裡唯一「晚做就永遠補不回來」的東西。
--
-- 0001 已經建好六張法遵表與兩個 trigger。這一支補的是缺的那一半：
--   ① takedown_notice.notified_user_at —— §90-4 要求「轉送通知給使用者」，
--      沒有這個欄位就無從舉證何時告知過。
--   ② takedown_action —— 取下前的狀態快照（見下方「為什麼需要它」）。
--   ③ admin_takedown() / admin_add_strike() / admin_restore()
--   ④ 修好 apply_three_strikes() 的一個 bug：撤銷三振無法讓帳號回到 active。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 為什麼取下**不必**去改「其他人引用同一部作品的紀錄」
--
-- BUILD_PLAN §5 Step 8 要求「引用該作品的其他人的公開紀錄與票價也一併消失」，
-- 並註明那是提案 1 漏掉的 join。實際查證 0001：那個 join **已經在讀取端**：
--   - `record_read` policy 的第三個分支要求
--     `exists (select 1 from film f where f.id = film_id and f.moderation_state = 'visible' …)`
--   - 票價靠 `record_is_public()`，它是 `viewing_record join film` 的 INNER JOIN，
--     同樣檢查 `f.moderation_state = 'visible'`
--
-- 所以把 film 標成 removed，其他人的公開紀錄與票價會**自動**消失，不需要另一支
-- 批次工作，也不需要去動別人的資料列。這一點必須實測而不是相信註解——驗證見
-- `scripts/verify-dmca.sql`。
--
-- ★ 反過來說：任何日後新增的「公開讀取路徑」都必須自己帶上這個 film 的檢查。
--   漏掉的症狀是取下後內容還在，而且沒有任何錯誤訊息。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 為什麼需要 takedown_action（而不是只把 moderation_state 翻回來）
--
-- 驗收要求「admin_restore 後內容回復、visibility 一併還原，不是沉默的半回復」。
-- 若不記錄取下前的狀態，回復只能用猜的，而猜錯的方向是**會外洩**的那一邊：
-- 一部 `visibility='private'` 的待審 UGC 作品被取下後，若回復時一律設成
-- `'public'`，就等於把一部從未公開過的作品公開了。那不是半回復，是新的破口。
--
-- 所以取下時逐列拍下 (visibility, moderation_state)，回復時原樣寫回。
-- 這張表同時也是 §90-9 的舉證材料：誰、在什麼時候、對哪一列做了什麼。
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. §90-4 的「告知使用者」時點
-- -----------------------------------------------------------------------------
alter table public.takedown_notice
  add column if not exists notified_user_at timestamptz;

comment on column public.takedown_notice.notified_user_at is
  '§90-4 第 4 款：將通知轉送給使用者的時點。★ 刻意不由 admin_takedown() 自動填 —— '
  '寄出通知是站外行為，程式無從得知它真的發生過。自動填只會產生一個看起來已經'
  '履行、實際沒有的紀錄，而這正是日後要拿來舉證的欄位。';

-- -----------------------------------------------------------------------------
-- 2. 取下動作紀錄
-- -----------------------------------------------------------------------------
create table if not exists public.takedown_action (
  id bigint generated always as identity primary key,
  notice_id bigint not null references public.takedown_notice (id) on delete cascade,
  subject_kind text not null check (subject_kind in ('film','record')),
  film_id uuid references public.film (id) on delete cascade,
  record_id uuid references public.viewing_record (id) on delete cascade,
  -- 取下前的狀態。回復時原樣寫回，不是寫死成 public/visible。
  prev_visibility public.visibility not null,
  prev_moderation_state public.moderation_state not null,
  acted_at timestamptz not null default now(),
  acted_by uuid references public.profile (id) on delete set null,
  restored_at timestamptz,
  restored_by uuid references public.profile (id) on delete set null,
  note text,
  constraint takedown_action_subject check (
    (subject_kind = 'film'   and film_id is not null and record_id is null) or
    (subject_kind = 'record' and record_id is not null and film_id is null))
);
create index if not exists takedown_action_notice_idx on public.takedown_action (notice_id);
-- 同一個標的在尚未回復前不得重複取下：否則第二次會把「已經是 removed」
-- 拍成快照，回復時就永遠回不到原本的 visible。
create unique index if not exists takedown_action_open_film
  on public.takedown_action (film_id) where restored_at is null and film_id is not null;
create unique index if not exists takedown_action_open_record
  on public.takedown_action (record_id) where restored_at is null and record_id is not null;

comment on table public.takedown_action is
  '取下前的狀態快照。存在的理由是回復必須「原樣寫回」而不是寫死成 public/visible'
  '——後者會把從未公開過的私密作品publish 出去。同時是 §90-9 的舉證材料。';

-- -----------------------------------------------------------------------------
-- 3. 修好 apply_three_strikes()：撤銷三振後帳號回不到 active
--
-- 原版的 CASE 是：
--     case when c >= 3 then 'terminated' when c = 2 then 'limited' else service_status end
-- ELSE 分支保留現值 ⇒ 一個被 terminated 的帳號，撤銷到只剩 1 次三振時，
-- 會停在 'terminated'。admin_restore() 撤銷三振後帳號永遠復不了活，
-- 而且沒有任何錯誤訊息——正是驗收清單說的「沉默的半回復」。
--
-- 改成完全映射：c>=3 → terminated、c=2 → limited、c<=1 → active，
-- 並在不再終止時清掉 suspended_at。
-- ⚠️ 這等於宣告 service_status 完全由三振次數導出。日後若要有「與三振無關的
--    人工停權」，必須另開欄位，不能借用這一個——借用會被下一次撤銷洗掉。
-- -----------------------------------------------------------------------------
create or replace function public.apply_three_strikes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c integer;
begin
  select count(*) into c from public.copyright_strike
   where profile_id = new.profile_id and revoked_at is null;
  update public.profile_private set
    strike_count = c,
    service_status = (case when c >= 3 then 'terminated'
                           when c = 2 then 'limited'
                           else 'active' end)::public.service_status,
    suspended_at = case when c >= 3 then coalesce(suspended_at, now()) else null end,
    updated_at = now()
   where id = new.profile_id;
  return null;
end $$;

-- -----------------------------------------------------------------------------
-- 4. admin_takedown —— 把標的標成 removed，並拍下取下前的狀態
--
-- 回傳實際取下的標的數。已經處於未回復取下狀態的標的會被略過（冪等）。
-- -----------------------------------------------------------------------------
create or replace function public.admin_takedown(
  p_notice_id bigint,
  p_film_id uuid default null,
  p_record_id uuid default null,
  p_note text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0; v_actor uuid := auth.uid();
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;
  if p_film_id is null and p_record_id is null then
    raise exception '必須指定 p_film_id 或 p_record_id 其中之一' using errcode = '22023'; end if;
  if not exists (select 1 from public.takedown_notice where id = p_notice_id) then
    raise exception '找不到侵權通知 %', p_notice_id using errcode = '23503'; end if;

  if p_film_id is not null then
    insert into public.takedown_action
      (notice_id, subject_kind, film_id, prev_visibility, prev_moderation_state, acted_by, note)
    select p_notice_id, 'film', f.id, f.visibility, f.moderation_state, v_actor, p_note
      from public.film f
     where f.id = p_film_id
       and not exists (select 1 from public.takedown_action a
                        where a.film_id = f.id and a.restored_at is null);
    if found then
      update public.film set moderation_state = 'removed', updated_at = now() where id = p_film_id;
      n := n + 1;
    end if;
  end if;

  if p_record_id is not null then
    insert into public.takedown_action
      (notice_id, subject_kind, record_id, prev_visibility, prev_moderation_state, acted_by, note)
    select p_notice_id, 'record', r.id, r.visibility, r.moderation_state, v_actor, p_note
      from public.viewing_record r
     where r.id = p_record_id
       and not exists (select 1 from public.takedown_action a
                        where a.record_id = r.id and a.restored_at is null);
    if found then
      update public.viewing_record set moderation_state = 'removed' where id = p_record_id;
      n := n + 1;
    end if;
  end if;

  update public.takedown_notice set
    status = 'actioned', actioned_at = now(), handled_by = v_actor,
    target_film_id = coalesce(target_film_id, p_film_id),
    target_record_id = coalesce(target_record_id, p_record_id),
    note = coalesce(p_note, note)
   where id = p_notice_id;

  return n;
end $$;

-- -----------------------------------------------------------------------------
-- 5. admin_add_strike —— 記一次三振，回傳該使用者目前未撤銷的三振次數
--
-- service_status 由 apply_three_strikes() trigger 導出，這裡不直接寫。
-- 第 3 次之後 account_is_servable() 轉 false ⇒ 個人頁與全部公開紀錄立即不可讀，
-- 不需要另一支批次工作。
-- -----------------------------------------------------------------------------
create or replace function public.admin_add_strike(
  p_profile_id uuid,
  p_notice_id bigint default null,
  p_note text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare c integer;
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;

  insert into public.copyright_strike (profile_id, notice_id, note)
  values (p_profile_id, p_notice_id, p_note);

  select count(*) into c from public.copyright_strike
   where profile_id = p_profile_id and revoked_at is null;
  return c;
end $$;

-- -----------------------------------------------------------------------------
-- 6. admin_restore —— 原樣回復，並作廢該通知造成的三振
--
-- 「不是沉默的半回復」在這裡有三個具體意思：
--   ① visibility 與 moderation_state **都**寫回取下前的值
--   ② 該通知造成的三振全部 revoke，且 trigger 會重算 service_status
--      （第 3 節那個 bug 不修的話，這一步等於沒做）
--   ③ 通知本身轉成 'restored'，且若有回復通知就填上 restored_at（§90-9 舉證）
--
-- 回傳實際回復的標的數。
-- -----------------------------------------------------------------------------
create or replace function public.admin_restore(
  p_notice_id bigint,
  p_note text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer := 0; v_actor uuid := auth.uid(); a record;
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;

  for a in select * from public.takedown_action
            where notice_id = p_notice_id and restored_at is null
  loop
    if a.subject_kind = 'film' then
      update public.film set visibility = a.prev_visibility,
             moderation_state = a.prev_moderation_state, updated_at = now()
       where id = a.film_id;
    else
      update public.viewing_record set visibility = a.prev_visibility,
             moderation_state = a.prev_moderation_state
       where id = a.record_id;
    end if;
    update public.takedown_action set restored_at = now(), restored_by = v_actor
     where id = a.id;
    n := n + 1;
  end loop;

  -- 作廢這次通知造成的三振。UPDATE 會觸發 strike_apply，service_status 重算。
  update public.copyright_strike set revoked_at = now()
   where notice_id = p_notice_id and revoked_at is null;

  update public.counter_notice set restored_at = now()
   where notice_id = p_notice_id and restored_at is null;

  update public.takedown_notice set
    status = 'restored', handled_by = v_actor, note = coalesce(p_note, note)
   where id = p_notice_id;

  return n;
end $$;

-- -----------------------------------------------------------------------------
-- 7. RLS
-- -----------------------------------------------------------------------------
alter table public.takedown_action enable row level security;
drop policy if exists takedown_action_staff on public.takedown_action;
create policy takedown_action_staff on public.takedown_action for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- -----------------------------------------------------------------------------
-- 7b. 被取下的使用者讀得到「針對自己的那一件通知」
--
-- 沒有這條 policy，§90-4 第 4 款的回復通知流程在結構上跑不起來：使用者看不到
-- 通知，就無從知道要對哪一件提出回復通知。0001 只有 takedown_staff 一條 SELECT
-- policy，一般登入者看到的是 0 列。
--
-- ⚠️ 這條 policy 會讓被取下的使用者看到 claimant_name / claimant_email。那是
--    刻意的，也是法定的：§90-6 要求服務提供者將通知**轉送**給使用者，而使用者
--    要提回復通知、乃至日後應訴，都必須知道主張權利的是誰。
--    ★ 不可以改用欄位級 revoke 來遮蔽聯絡資訊——踩雷 #33：對 SELECT 做欄位級
--      revoke 會讓 PostgREST 的 `select=*` 直接 403。要遮就得另開 view。
-- -----------------------------------------------------------------------------
drop policy if exists takedown_affected_user on public.takedown_notice;
create policy takedown_affected_user on public.takedown_notice for select to authenticated
  using (exists (select 1 from public.viewing_record r
                  where r.id = target_record_id and r.user_id = (select auth.uid()))
      or exists (select 1 from public.film f
                  where f.id = target_film_id and f.created_by = (select auth.uid())));

-- -----------------------------------------------------------------------------
-- 8. 冒煙測試 —— 讓「函式體 parse 不過」在 migration 階段就失敗
--
-- 0005 的教訓：`create function` 不檢查函式體，plpgsql 裡的每一句 SQL 要到
-- **真的被執行**時才 prepare。`purge_expired_tmdb_cache()` 因此從建立到被發現
-- 壞掉之間，通過了每一項靜態檢查。所以這裡真的把三支都跑一遍。
--
-- ★ 整段包在有 EXCEPTION 子句的 block 裡 —— 那會建立隱含 savepoint，最後
--   主動 raise 讓區塊內的所有變更回滾。跑完不留任何資料。
-- -----------------------------------------------------------------------------
do $$
declare
  v_film uuid; v_notice bigint; v_staff uuid; v_took integer; v_restored integer;
  v_vis public.visibility; v_mod public.moderation_state;
begin
  begin
    -- 借一個既有 profile 暫時當 staff（區塊結束時連同一切回滾）
    select id into v_staff from public.profile order by created_at limit 1;
    if v_staff is null then
      raise notice '冒煙測試略過：DB 內沒有任何 profile';
      return;
    end if;
    update public.profile_private set role = 'admin' where id = v_staff;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

    -- 刻意用 private/pending 的 UGC 作品：回復若寫死成 public，這裡就會現形
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0006', 'ugc', 'private', 'pending', v_staff) returning id into v_film;

    insert into public.takedown_notice
      (claimant_name, claimant_email, work_description, target_url, statement_good_faith)
    values ('smoke', 'smoke@example.invalid', 'smoke', 'https://example.invalid/smoke', true)
    returning id into v_notice;

    v_took := public.admin_takedown(v_notice, v_film, null, 'smoke');
    select visibility, moderation_state into v_vis, v_mod from public.film where id = v_film;
    if v_took <> 1 or v_mod <> 'removed' then
      raise exception '冒煙測試失敗：admin_takedown 沒有把作品標成 removed（took=%, mod=%）', v_took, v_mod;
    end if;

    if public.admin_add_strike(v_staff, v_notice, 'smoke') <> 1 then
      raise exception '冒煙測試失敗：admin_add_strike 回傳值不是 1';
    end if;

    v_restored := public.admin_restore(v_notice, 'smoke');
    select visibility, moderation_state into v_vis, v_mod from public.film where id = v_film;
    if v_restored <> 1 or v_mod <> 'visible' or v_vis <> 'private' then
      raise exception '冒煙測試失敗：admin_restore 沒有原樣回復（n=%, vis=%, mod=%）', v_restored, v_vis, v_mod;
    end if;
    if exists (select 1 from public.copyright_strike
                where notice_id = v_notice and revoked_at is null) then
      raise exception '冒煙測試失敗：admin_restore 沒有作廢三振';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0006 冒煙測試通過（三支 RPC 全部實際執行過，變更已回滾）';
end $$;
