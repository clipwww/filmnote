-- =============================================================================
-- 0011 — adminui 回報的四個後端缺口裡屬於資料層的三個
--
--   ① DMCA 承辦流程：staff 按不動的那幾顆鈕（§90-4 第 4 款、§90-9）
--   ② business_days_between()：「還剩幾個工作日」
--   ③ 駁回理由（film）與回覆理由（data_report）
--   ＋ 審核佇列的單一真相 view（墓碑不該出現在佇列裡）
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 先更正一件事：法定期限**不是** null
--
-- 回報說「counter_notice.forwarded_at 寫不進去 ⇒ trigger 從不觸發 ⇒ 兩個法定
-- 期限永遠是 null」。實測 2026-09-06（begin/rollback 內真的 insert 一筆）：
--
--   received=2026-09-06 03:31:13+00  forwarded=NULL
--   litigation=2026-09-18 03:31:13+00  restore=2026-09-24 03:31:13+00
--
-- 因為 `counter_deadlines` 是 **`before insert or update of forwarded_at`**，
-- INSERT 那次就會觸發，而函式取的是 `coalesce(new.forwarded_at, new.received_at)`
-- ——欄位預設值在 BEFORE ROW trigger 之前就套用了，所以 received_at 有值。
--
-- 真正的缺陷比較細，但沒有比較不嚴重：
--   §90-9 的 10／14 個工作日是從「**轉送**回復通知給著作權人」起算，不是從
--   使用者送出起算。現在算出來的兩個日期錨在 received_at 上 ⇒ 偏早（保守，
--   不至於違法），但**不是法定的那個日期，而且永遠改不掉**——因為沒有人寫得進
--   forwarded_at。更麻煩的是：平台因此**完全無法舉證自己何時轉送過**。
--
-- 同一個家族的另外兩個：
--   · takedown_notice.notified_user_at（§90-4 第 4 款的舉證欄位）沒有人寫得進去。
--     0006 加了欄位、寫了說明，但 admin_takedown() 不碰它，也沒有 UPDATE grant。
--   · data_report **連 staff policy 都沒有**（只有 report_insert / report_read）
--     ⇒ status 永遠停在 'open'。這一條比回報說的更糟：不是 grant 少給，是
--     policy 從來沒建過，補 grant 也不會動。
--
-- ★ 為什麼補 RPC 而不是補 `grant update`：
--   這三張表是法遵證據。`grant update on takedown_notice to authenticated`
--   ＋ `takedown_staff for all` 等於讓任何 staff 改得動 claimant_name、
--   work_description、received_at——也就是**竄改證據**。0001 的註解說
--   「取下是狀態不是 DELETE」，同一個道理適用於內容：只有流程欄位該動。
--   而且 RPC 的時間戳是伺服器端的 now()，客戶端**沒辦法把「我們何時通知使用者」
--   往前補登**。這也和既有的 admin_takedown / admin_add_strike / admin_restore /
--   approve_film / merge_films 五支同一個形狀（踩雷 #26）。
-- -----------------------------------------------------------------------------

-- §90-4 第 4 款：轉送通知給使用者。時間戳由伺服器決定，不收參數。
create or replace function public.admin_notify_user(
  p_notice_id bigint,
  p_note text default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_at timestamptz;
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;

  -- 冪等：已經記過就回原本那個時間，不要蓋掉。舉證欄位被重寫成「比較晚」
  -- 的時間對平台不利，被重寫成「比較早」的則是偽造。
  update public.takedown_notice
     set notified_user_at = coalesce(notified_user_at, now()),
         handled_by = coalesce(handled_by, auth.uid()),
         note = coalesce(p_note, note)
   where id = p_notice_id
  returning notified_user_at into v_at;

  if v_at is null then
    raise exception '找不到這件通知（id=%）', p_notice_id using errcode = 'P0002';
  end if;
  return v_at;
end $$;

-- §90-9：轉送回復通知給著作權人。這一步會讓 counter_deadlines trigger
-- 以**正確的錨點**重算兩個法定期限——那正是 trigger 的 `update of forwarded_at`
-- 在等的事件。
create or replace function public.admin_forward_counter_notice(p_counter_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;

  update public.counter_notice
     set forwarded_at = coalesce(forwarded_at, now())
   where id = p_counter_id
  returning forwarded_at, litigation_deadline_at, restore_deadline_at into r;

  if not found then
    raise exception '找不到這件回復通知（id=%）', p_counter_id using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'forwarded_at', r.forwarded_at,
    'litigation_deadline_at', r.litigation_deadline_at,
    'restore_deadline_at', r.restore_deadline_at);
end $$;

-- 資料回報：staff 需要能結案並寫下理由，否則回報者永遠看到 'open'。
alter table public.data_report add column if not exists staff_reply text;
alter table public.data_report add column if not exists handled_by uuid
  references public.profile (id) on delete set null;
alter table public.data_report add column if not exists resolved_at timestamptz;

comment on column public.data_report.staff_reply is
  '結案理由。回報者看得到（report_read policy），所以它是寫給對方看的，不是內部備註。';

-- ★ 這張表原本**一條 staff policy 都沒有**，所以先前不管 grant 怎麼補都不會動。
drop policy if exists report_staff on public.data_report;
create policy report_staff on public.data_report for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- 回報者要看得到結果，否則「已回覆」等於沒回覆。
drop policy if exists report_read on public.data_report;
create policy report_read on public.data_report for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.is_staff()));

create or replace function public.admin_resolve_report(
  p_report_id bigint,
  p_status text,
  p_reply text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then
    raise exception '權限不足' using errcode = '42501'; end if;
  if p_status not in ('accepted', 'rejected') then
    raise exception 'status 只能是 accepted 或 rejected（實得 %）', p_status
      using errcode = '23514';
  end if;
  -- 駁回一定要寫理由。沒有理由的駁回，回報者只會再回報一次同一件事。
  if p_status = 'rejected' and coalesce(btrim(p_reply), '') = '' then
    raise exception '駁回必須填寫理由' using errcode = '23514';
  end if;

  update public.data_report
     set status = p_status, staff_reply = p_reply,
         handled_by = auth.uid(), resolved_at = now()
   where id = p_report_id;
  if not found then
    raise exception '找不到這筆回報（id=%）', p_report_id using errcode = 'P0002';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. business_days_between —— 「還剩幾個工作日」
--
-- adminui 說「前端絕不自己算工作日」。那個判斷是對的：工作日邏輯散到前端就會有
-- 兩份定義，而它們**一定**會在國定假日那題上分岔。
--
-- ⚠️ 誠實話：`business_days_after`（0001）與這一支都**只扣週末，不扣國定假日**。
--   台灣的行政機關辦公日曆有春節、清明、端午、中秋等，真正的「工作日」比這裡
--   算出來的少 ⇒ 這兩支算出來的期限**偏早**。偏早對平台是保守的（我們比法定
--   期限更早履行），所以不是違法風險，但它是個已知的近似值，不要當成權威。
--   要做對需要一張國定假日表（行政院人事行政總處每年公告一次 CSV）。已列卡點。
--
-- ★ 回傳的是**還剩幾個工作日**：未來回正數、今天回 0、已逾期回負數。
--   逾期不回 0 是刻意的：前端要能分辨「今天到期」與「已經遲了三天」。
-- -----------------------------------------------------------------------------
create or replace function public.business_days_between(
  p_from timestamptz,
  p_to timestamptz)
returns integer language plpgsql immutable set search_path = '' as $$
declare
  d date := (p_from at time zone 'Asia/Taipei')::date;
  e date := (p_to   at time zone 'Asia/Taipei')::date;
  sign_ integer := 1;
  n integer := 0;
begin
  if d = e then return 0; end if;
  if d > e then sign_ := -1; d := (p_to at time zone 'Asia/Taipei')::date;
                             e := (p_from at time zone 'Asia/Taipei')::date; end if;
  while d < e loop
    d := d + 1;
    if extract(isodow from d) < 6 then n := n + 1; end if;
  end loop;
  return n * sign_;
end $$;

comment on function public.business_days_between(timestamptz, timestamptz) is
  '從 p_from 到 p_to 之間的工作日數（正=未來、0=同日、負=已逾期）。⚠️ 只扣週末，不扣國定假日 ⇒ 是保守的近似值。與 business_days_after() 共用同一套（不）假設，兩支不會分岔。';

-- -----------------------------------------------------------------------------
-- 3. 駁回理由
--
-- approve_film(false) 之後作者不知道為什麼被駁回，也就不知道怎麼改。
--
-- ★ 加參數不能用 `create or replace`——那會產生一支**重載**而不是取代，
--   兩支同名函式並存時 PostgREST 會 300 Multiple Choices。必須先 drop。
--   drop 會連帶把 9999 給過的 grant 一起帶走，所以本檔結尾要重新 grant。
-- -----------------------------------------------------------------------------
alter table public.film add column if not exists review_note text;
comment on column public.film.review_note is
  '審核意見。駁回時必填——作者看得到（film_read policy 讓作者讀得到自己的作品），所以它是寫給對方看的。核准時清空，避免舊的駁回理由留在已核准的作品上。';

drop function if exists public.approve_film(uuid, boolean);
create or replace function public.approve_film(
  p_film uuid,
  p_approve boolean default true,
  p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_staff() then raise exception '權限不足' using errcode = '42501'; end if;
  if p_approve then
    update public.film set review_state = 'approved', visibility = 'public',
           review_note = null, updated_at = now()
     where id = p_film and merged_into_film_id is null;
  else
    -- 沒有理由的駁回等於沒有告知。視覺稿要求顯示理由，而 UI 不該自己編一個。
    if coalesce(btrim(p_note), '') = '' then
      raise exception '駁回必須填寫理由' using errcode = '23514';
    end if;
    update public.film set review_state = 'rejected', visibility = 'private',
           review_note = p_note, updated_at = now()
     where id = p_film;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4. 審核佇列的單一真相
--
-- 實測 2026-09-06：`review_state = 'pending'` 有 19 列，其中 **16 列的
-- merged_into_film_id 不是 null**——那是匯入時被 merge_films() 併掉的敗方。
-- `merge_films` 不改 review_state（也**不該**改：它沒有被駁回，也沒有被核准，
-- 「被合併」是另一個維度的狀態，硬塞進 review_state 只會製造第二個真相）。
--
-- 所以修法不是去改 merge_films，是把「什麼叫待審」寫成一個地方——
-- 與 0002 的 venue_option 同一個模式：前端一律查它，不要自己組條件。
-- 少任何一個條件的症狀都很具體：少了 merged 就是整排按得下去的殭屍，
-- 少了 origin='ugc' 就會撈到政府資料。
-- -----------------------------------------------------------------------------
create or replace view public.film_review_queue with (security_invoker = true) as
select f.id, f.slug, f.title_zh, f.title_original, f.country, f.release_year,
       f.ugc_poster_path, f.created_by, f.review_note, f.created_at, f.updated_at
  from public.film f
 where f.review_state = 'pending'
   and f.merged_into_film_id is null
   and f.origin = 'ugc';

comment on view public.film_review_queue is
  '待審核的 UGC 作品。★ 一律查這支，不要自己在前端組 review_state 條件——被 merge_films 併掉的敗方 review_state 仍停在 pending（16 列實測），少了 merged 條件會讓佇列整排都是按得下去的殭屍。security_invoker ⇒ 仍走 film_read policy（staff 才看得到別人的 private 作品）。';

-- 佇列索引也一起收斂，否則索引掃到的還是含墓碑的那一批。
drop index if exists public.film_review_queue_idx;
create index if not exists film_review_queue_idx on public.film (created_at)
  where review_state = 'pending' and merged_into_film_id is null;

-- -----------------------------------------------------------------------------
-- 5. 授權（9999 才是權威；這裡再寫一次讓第 6 節的冒煙測試不依賴執行順序）
-- -----------------------------------------------------------------------------
grant execute on function public.admin_notify_user(bigint, text),
  public.admin_forward_counter_notice(bigint),
  public.admin_resolve_report(bigint, text, text),
  public.approve_film(uuid, boolean, text) to authenticated, service_role;
grant execute on function public.business_days_between(timestamptz, timestamptz) to authenticated;
grant select on public.film_review_queue to authenticated;

-- -----------------------------------------------------------------------------
-- 6. 冒煙測試
-- -----------------------------------------------------------------------------
do $$
declare
  v_staff uuid; v_notice bigint; v_counter bigint; v_report bigint; v_film uuid;
  v_before timestamptz; v_after timestamptz; r jsonb; blocked boolean;
begin
  begin
    select id into v_staff from public.profile order by created_at limit 1;
    if v_staff is null then raise notice '0011 冒煙測試略過：沒有 profile'; return; end if;
    -- 冒煙測試自己把這個人變成 staff（全部會回滾）
    update public.profile_private set role = 'admin' where id = v_staff;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);

    -- ── business_days_between ────────────────────────────────────────────
    -- 2026-09-07 週一 → 09-12 週六：數的是 08 二、09 三、10 四、11 五，共 4。
    -- （第一版把它寫成 5 而變紅——是**期望值**錯不是函式錯。留著這個註解，
    --   免得下一個人看到 4 就去改函式。）
    if public.business_days_between('2026-09-07T00:00:00+08', '2026-09-12T00:00:00+08') <> 4 then
      raise exception '冒煙測試失敗：週一→週六應為 4 個工作日，實得 %',
        public.business_days_between('2026-09-07T00:00:00+08', '2026-09-12T00:00:00+08');
    end if;
    -- 跨一個週末：09-07 週一 → 09-14 週一＝ 二三四五 ＋ 下週一 ＝ 5
    if public.business_days_between('2026-09-07T00:00:00+08', '2026-09-14T00:00:00+08') <> 5 then
      raise exception '冒煙測試失敗：跨週末的週一→週一應為 5 個工作日，實得 %',
        public.business_days_between('2026-09-07T00:00:00+08', '2026-09-14T00:00:00+08');
    end if;
    -- 週五 → 下週一：中間隔週末，只有 1 個工作日
    if public.business_days_between('2026-09-11T00:00:00+08', '2026-09-14T00:00:00+08') <> 1 then
      raise exception '冒煙測試失敗：週五→下週一應為 1 個工作日，實得 %',
        public.business_days_between('2026-09-11T00:00:00+08', '2026-09-14T00:00:00+08');
    end if;
    if public.business_days_between('2026-09-14T00:00:00+08', '2026-09-11T00:00:00+08') <> -1 then
      raise exception '冒煙測試失敗：逾期必須回負數（前端要分得出「今天到期」與「遲了三天」）';
    end if;
    if public.business_days_between('2026-09-14T09:00:00+08', '2026-09-14T23:00:00+08') <> 0 then
      raise exception '冒煙測試失敗：同一天應為 0';
    end if;
    -- ★ 與 business_days_after 必須是同一套假設，否則兩支會在期限上分岔
    if public.business_days_between(
         '2026-09-07T00:00:00+08',
         public.business_days_after('2026-09-07T00:00:00+08', 10)) <> 10 then
      raise exception '冒煙測試失敗：★ business_days_between 與 business_days_after 對不起來';
    end if;

    -- ── DMCA 承辦流程 ────────────────────────────────────────────────────
    insert into public.takedown_notice
      (claimant_name, claimant_email, work_description, target_url, statement_good_faith)
    values ('__smoke__0011','s@example.invalid','__smoke__0011 內容夠長夠長夠長',
            'https://example.invalid/smoke', true)
    returning id into v_notice;

    v_after := public.admin_notify_user(v_notice, '__smoke__0011 已轉送');
    if v_after is null then
      raise exception '冒煙測試失敗：admin_notify_user 沒有寫入 notified_user_at';
    end if;
    -- 冪等：再呼叫一次不得把舊時間蓋掉（舉證欄位被改寫＝偽造或對己不利）
    if public.admin_notify_user(v_notice) is distinct from v_after then
      raise exception '冒煙測試失敗：★ 重複呼叫改寫了 notified_user_at';
    end if;

    -- ★ received_at 要刻意往前挪。`now()` 在同一個交易裡是**固定的交易起始時間**，
    --   所以直接插入的話 forwarded_at 會等於 received_at，兩組期限一模一樣，
    --   「轉送之後期限有沒有往後移」那條斷言就永遠測不出東西——
    --   而它剛好是這一整段的重點。（第一版就是這樣紅的。）
    insert into public.counter_notice (notice_id, profile_id, reason, received_at)
    values (v_notice, v_staff, '__smoke__0011 我沒有侵權', now() - interval '3 days')
    returning id into v_counter;
    select litigation_deadline_at into v_before from public.counter_notice where id = v_counter;
    if v_before is null then
      raise exception '冒煙測試失敗：INSERT 時就應該算出期限（本檔第 1 節的更正）';
    end if;

    r := public.admin_forward_counter_notice(v_counter);
    if r->>'forwarded_at' is null then
      raise exception '冒煙測試失敗：forwarded_at 沒有寫進去';
    end if;
    -- ★ 錨點換成 forwarded_at 之後，期限必須真的往後移
    if (r->>'litigation_deadline_at')::timestamptz <= v_before then
      raise exception '冒煙測試失敗：★ 轉送之後法定期限沒有重算（trigger 沒被觸發）';
    end if;
    if public.business_days_between(now(), (r->>'restore_deadline_at')::timestamptz) <> 14 then
      raise exception '冒煙測試失敗：回復期限距今應為 14 個工作日，實得 %',
        public.business_days_between(now(), (r->>'restore_deadline_at')::timestamptz);
    end if;

    -- ── data_report ──────────────────────────────────────────────────────
    insert into public.data_report (reporter_id, subject_kind, subject_key, body)
    values (v_staff, 'film', '__smoke__0011', '__smoke__0011 片名錯了') returning id into v_report;
    blocked := false;
    begin
      perform public.admin_resolve_report(v_report, 'rejected', '   ');
    exception when check_violation then blocked := true;
    end;
    if not blocked then
      raise exception '冒煙測試失敗：★ 沒有理由的駁回竟然通過（回報者只會再回報一次同一件事）';
    end if;
    perform public.admin_resolve_report(v_report, 'accepted', '__smoke__0011 已修正');
    if not exists (select 1 from public.data_report
                    where id = v_report and status = 'accepted'
                      and staff_reply = '__smoke__0011 已修正' and resolved_at is not null) then
      raise exception '冒煙測試失敗：data_report 沒有真的結案';
    end if;

    -- ── 駁回理由 ─────────────────────────────────────────────────────────
    insert into public.film (title_zh, origin, visibility, review_state, created_by)
    values ('__smoke__0011作品', 'ugc', 'private', 'pending', v_staff) returning id into v_film;
    if not exists (select 1 from public.film_review_queue where id = v_film) then
      raise exception '冒煙測試失敗：待審作品沒有出現在 film_review_queue';
    end if;
    blocked := false;
    begin
      perform public.approve_film(v_film, false, null);
    exception when check_violation then blocked := true;
    end;
    if not blocked then
      raise exception '冒煙測試失敗：★ 沒有理由的駁回竟然通過';
    end if;
    perform public.approve_film(v_film, false, '__smoke__0011 片名有錯字');
    if not exists (select 1 from public.film
                    where id = v_film and review_state = 'rejected'
                      and review_note = '__smoke__0011 片名有錯字') then
      raise exception '冒煙測試失敗：駁回理由沒有存下來';
    end if;
    -- 核准要清掉舊的駁回理由，否則已核准的作品上會掛著一句「片名有錯字」
    perform public.approve_film(v_film, true);
    if (select review_note from public.film where id = v_film) is not null then
      raise exception '冒煙測試失敗：核准後舊的駁回理由沒有清掉';
    end if;

    -- ★ 墓碑不得出現在佇列裡（那 16 列實測的形狀）
    -- visibility 也要一起壓回 private——merge_films() 就是這樣做的，而且
    -- film_public_requires_approval check 也不允許「public 且非 approved」。
    update public.film set review_state = 'pending', visibility = 'private',
      merged_into_film_id =
        (select id from public.film where id <> v_film and merged_into_film_id is null limit 1),
      merged_at = now() where id = v_film;
    if exists (select 1 from public.film_review_queue where id = v_film) then
      raise exception '冒煙測試失敗：★ 已被合併的作品仍出現在審核佇列（整排按得下去的殭屍）';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0011 冒煙測試通過（工作日、DMCA 兩支承辦 RPC、回報結案、駁回理由、佇列 view；變更已回滾）';
end $$;
