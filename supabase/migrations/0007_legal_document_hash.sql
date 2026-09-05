-- =============================================================================
-- 0007 — legal_document.content_sha256（§90-4 第 1 款的舉證基礎）
--
-- §6.1 ① 要求「版本與 content_sha256 寫進 legal_document」。0001 只建了
-- id / kind / version / effective_at / body_md，沒有雜湊。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 由 trigger 算，不由寫入端給。理由不是方便，是它防不了它該防的事：
--
-- 寫入端給的雜湊，只證明「寫入的人算了一個雜湊」。要偽造只需要改 body_md 的
-- 同時改雜湊——而會去改條款正文的人，正是最有動機一起改雜湊的人。
-- 由資料庫算則沒有這個縫：任何人送進來的值都會被覆寫掉。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 但光有雜湊還不夠 —— 雜湊自己不會記得「以前是什麼」
--
-- content_sha256 若永遠等於當下 body_md 的雜湊，那它偵測不到任何竄改：改了
-- 正文，雜湊跟著變，兩者永遠一致。它能舉證的前提是**外面有一份當時的副本**。
--
-- 所以真正的機制是三層，缺一層就只是看起來有做：
--   ① legal_document.content_sha256  —— 由 trigger 算，寫入端無法指定
--   ② legal_acceptance.content_sha256 —— 使用者按下同意的**那一刻**的快照，
--      同樣由 trigger 從文件複製，前端不能傳。日後正文若被改動，
--      acceptance 的雜湊與 document 的雜湊就對不起來，竄改因此**可被偵測**。
--   ③ 已被同意過的文件禁止再改 body_md / kind / version —— 讓那件事**根本
--      不會發生**，而不是事後才發現。改版請新增一列（unique (kind, version) 已在）。
--
-- ★ 為什麼不用 generated column：`convert_to(text, name)` 在 PG 是 **STABLE**
--   不是 IMMUTABLE（實測 pg_proc.provolatile = 's'），generated column 只收
--   IMMUTABLE 運算式。可以包一層謊報 IMMUTABLE 的 wrapper 繞過去，但那是在
--   規劃器面前說謊換一點語法糖，不值得。trigger 的保證一模一樣。
--
-- 可重複執行。
-- =============================================================================

alter table public.legal_document
  add column if not exists content_sha256 text;
alter table public.legal_acceptance
  add column if not exists content_sha256 text;

-- -----------------------------------------------------------------------------
-- 1. 文件雜湊：一律由資料庫算，覆寫任何送進來的值
-- -----------------------------------------------------------------------------
-- 包一層只是為了讓兩支 trigger 用同一個定義，不是為了改變 volatility。
create or replace function public.sha256_utf8(p_text text)
returns bytea language sql stable set search_path = '' as $$
  select sha256(convert_to(coalesce(p_text, ''), 'UTF8'));
$$;

create or replace function public.legal_document_hash()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- 不看 new.content_sha256 是刻意的：無條件覆寫 ⇒ 寫入端指定的值一律無效。
  new.content_sha256 := encode(public.sha256_utf8(new.body_md), 'hex');
  return new;
end $$;

drop trigger if exists legal_doc_hash on public.legal_document;
create trigger legal_doc_hash before insert or update on public.legal_document
  for each row execute function public.legal_document_hash();

-- 既有列補算（trigger 只對之後的寫入生效）
update public.legal_document set body_md = body_md where content_sha256 is null;

-- -----------------------------------------------------------------------------
-- 2. 同意紀錄快照：按下同意那一刻的雜湊，前端不能傳
-- -----------------------------------------------------------------------------
create or replace function public.legal_acceptance_snapshot()
returns trigger language plpgsql set search_path = '' as $$
begin
  select d.content_sha256 into new.content_sha256
    from public.legal_document d where d.id = new.document_id;
  if new.content_sha256 is null then
    raise exception '找不到 legal_document % 或其雜湊尚未計算', new.document_id
      using errcode = '23503';
  end if;
  return new;
end $$;

drop trigger if exists legal_accept_snapshot on public.legal_acceptance;
create trigger legal_accept_snapshot before insert on public.legal_acceptance
  for each row execute function public.legal_acceptance_snapshot();

-- -----------------------------------------------------------------------------
-- 3. 已被同意過的文件不得再改內容
--
--    §90-4 第 1 款要舉證的是「**當時**已告知」。就地改正文會讓所有既存的
--    legal_acceptance 靜默地指向一份它們的主人從未看過的文字。
--    改版＝新增一列（unique (kind, version) 保證版本號不會被重用）。
-- -----------------------------------------------------------------------------
create or replace function public.legal_document_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (new.body_md is distinct from old.body_md
      or new.kind is distinct from old.kind
      or new.version is distinct from old.version)
     and exists (select 1 from public.legal_acceptance a where a.document_id = old.id) then
    raise exception '文件 %（%/%）已有使用者同意過，不得再改內容；請新增一個版本',
      old.id, old.kind, old.version using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists legal_doc_immutable on public.legal_document;
-- ★ before update 且排在 legal_doc_hash 之後（名稱字母序：legal_doc_hash <
--   legal_doc_immutable），順序不影響結果——這支只讀不寫。
create trigger legal_doc_immutable before update on public.legal_document
  for each row execute function public.legal_document_immutable();

-- -----------------------------------------------------------------------------
-- 4. 竄改偵測：acceptance 的快照與文件現值對不起來就列出來
--    正常情況回 0 列。上線後應納入定期檢查。
-- -----------------------------------------------------------------------------
create or replace view public.legal_acceptance_drift with (security_invoker = true) as
select a.profile_id, a.document_id, d.kind, d.version,
       a.content_sha256 as accepted_sha256, d.content_sha256 as current_sha256, a.accepted_at
from public.legal_acceptance a
join public.legal_document d on d.id = a.document_id
where a.content_sha256 is distinct from d.content_sha256;

comment on view public.legal_acceptance_drift is
  '同意當下的雜湊與文件現值不符者。有列出現＝有人繞過 legal_doc_immutable 改了'
  '已被同意的條款正文（例如以 postgres 直連），該筆同意已不足以舉證。';

-- -----------------------------------------------------------------------------
-- 5. 冒煙測試 —— 0005 的教訓：create function 不檢查函式體
--    包在有 EXCEPTION 子句的區塊裡（隱含 savepoint），跑完全部回滾。
-- -----------------------------------------------------------------------------
do $$
declare v_doc bigint; v_hash text; v_hash2 text; v_user uuid; v_snap text; v_blocked boolean := false;
begin
  begin
    insert into public.legal_document (kind, version, body_md, content_sha256)
    values ('terms', '__smoke__0007', '第一版正文', 'deadbeef')   -- ★ 故意傳一個假雜湊
    returning id, content_sha256 into v_doc, v_hash;

    if v_hash = 'deadbeef' then
      raise exception '冒煙測試失敗：寫入端指定的雜湊沒有被覆寫';
    end if;
    if v_hash <> encode(public.sha256_utf8('第一版正文'), 'hex') then
      raise exception '冒煙測試失敗：雜湊值不正確（%）', v_hash;
    end if;

    -- 尚無人同意 ⇒ 可以改，且雜湊要跟著變
    update public.legal_document set body_md = '第二版正文' where id = v_doc
      returning content_sha256 into v_hash2;
    if v_hash2 = v_hash then
      raise exception '冒煙測試失敗：正文改了但雜湊沒變';
    end if;

    select id into v_user from public.profile order by created_at limit 1;
    if v_user is not null then
      insert into public.legal_acceptance (profile_id, document_id) values (v_user, v_doc)
        returning content_sha256 into v_snap;
      if v_snap <> v_hash2 then
        raise exception '冒煙測試失敗：同意快照沒有從文件複製（% vs %）', v_snap, v_hash2;
      end if;

      -- 已被同意 ⇒ 再改要被擋下
      begin
        update public.legal_document set body_md = '偷改的第三版' where id = v_doc;
      exception when check_violation then v_blocked := true;
      end;
      if not v_blocked then
        raise exception '冒煙測試失敗：已被同意的文件竟然還能改正文';
      end if;
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0007 冒煙測試通過（雜湊覆寫／快照／不可改三條都實際跑過，變更已回滾）';
end $$;
