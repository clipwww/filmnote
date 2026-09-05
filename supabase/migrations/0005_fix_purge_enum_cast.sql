-- =============================================================================
-- 0005 — `purge_expired_tmdb_cache()` 從來沒有成功執行過（型別轉換）
--
-- 症狀（2026-09-06 首次真正呼叫時才發現）：
--   ERROR: column "state" is of type public.tmdb_cache_state
--          but expression is of type text
--
-- 原因：0001 的那句是
--     state = case when state = 'gone' then 'gone' else 'pending' end
--   兩個分支都是字串常值，CASE 於是解析成 `text`，而 `text` 到 enum 沒有
--   隱含轉換 ⇒ 整支函式在**執行期**失敗。同一份 0001 裡另外兩處 CASE
--   （`link_film_to_tmdb` 的 origin、`admin_add_strike` 的 service_status）
--   的 ELSE 分支是 enum 欄位本身，常值會被推成該 enum，所以那兩處是對的。
--   只有這一處三個分支全是常值。
--
-- 為什麼拖到現在才炸：
--   `create function` 不檢查函式體的型別（plpgsql 的 SQL 只在第一次執行時
--   才被 parse）。migration 套用成功、函式存在、`\df` 看得到、grant 也給了
--   ——**每一項靜態檢查都是綠的**，只有真的呼叫它才會失敗。而在 Step 9 之前
--   從來沒有人呼叫過它。合規的「第二道防線」因此一直是個空殼。
--
--   ★ 這正是「函式存在」不等於「函式會動」。往後新增 SECURITY DEFINER 的
--     維護函式，migration 裡就該直接呼叫一次（見下方第 2 節）。
--
-- 影響範圍：只有這一支。讀取端的第一道防線（`film_public` 的
-- `expires_at > now()`）一直是好的，所以沒有逾期內容被送出去過。
--
-- ★ 0001 的原始那一行也已同步改成帶轉型的版本，讓從零部署不會再出現這個
--   壞掉的中間狀態。本檔是給**已經套用過舊版 0001** 的資料庫用的。
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 修正版
-- -----------------------------------------------------------------------------
create or replace function public.purge_expired_tmdb_cache()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not public.is_service_context() then raise exception '僅限服務端' using errcode = '42501'; end if;
  update public.film_tmdb_snapshot set
    title_zh=null, title_original=null, overview=null, poster_path=null, backdrop_path=null,
    runtime_minutes=null, release_date=null, tw_release_date=null, genre_ids=null, payload=null, etag=null,
    -- ★ 顯式轉型。少了它，三個常值分支會讓 CASE 解析成 text 而執行期失敗。
    state = (case when state = 'gone' then 'gone' else 'pending' end)::public.tmdb_cache_state,
    next_refresh_at = least(next_refresh_at, now())
  where expires_at <= now() and (payload is not null or poster_path is not null or overview is not null);
  get diagnostics n = row_count; return n;
end $$;

-- -----------------------------------------------------------------------------
-- 2. 冒煙測試 —— 讓「函式體 parse 不過」在 migration 階段就失敗
--    直連的 postgres 角色滿足 is_service_context()（session_user 判斷），
--    所以這裡真的會走進 UPDATE 而不是在權限檢查就返回。
--    沒有到期列時回 0，這句仍然會 parse 整個函式體——那正是重點。
-- -----------------------------------------------------------------------------
do $$ declare purged integer;
begin
  purged := public.purge_expired_tmdb_cache();
  raise notice 'purge_expired_tmdb_cache() 冒煙測試通過，清除 % 列', purged;
end $$;
