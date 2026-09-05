-- =============================================================================
-- 0004 — 有 tmdb_id 的作品一定要有快照列（Step 9 的前置條件）
--
-- 起因（實測 2026-09-06，Step 9 動工前的第一次清點）：
--   `film` 有 2,480 部帶 tmdb_id 的作品，但 `film_tmdb_snapshot` 只有 2,401 列。
--   **79 部沒有快照列**，而且全部是 origin='tmdb'、title_zh_source='tmdb'
--   ——也就是舊 log 匯入（Step 10）時由 `upsertTmdbFilm()` 建出來的那批。
--
-- 為什麼這是個必須修的洞而不是無害的缺漏：
--   `tmdb_refresh_due` 是從 `film_tmdb_snapshot` **join** 出去的。沒有快照列的
--   作品因此永遠不會出現在待刷新佇列裡，於是永遠沒有海報，而刷新排程會回報
--   「全部刷完了」。這是最難發現的那種錯——沒有錯誤訊息，只有一個少了 79 的數字。
--   更糟的是這 79 部正是 David 174 筆紀錄比對到的那批，也就是多刷排行最可能
--   出現的作品：`user_year_stats` 的 `repeats[].poster_path` 會恰好在最顯眼的
--   地方是 null。
--
-- 為什麼用 trigger 而不是去修 `upsertTmdbFilm()`：
--   寫入 `film.tmdb_id` 的地方有四個（`seed_films`、`link_film_to_tmdb`、
--   匯入腳本、以及日後前端的 UGC 補綁）。前兩個本來就會補快照列，第三個漏了。
--   逐一去修等於把不變量交給每一個呼叫者記得，而這次的教訓正是「有人不記得」。
--   改成資料庫層保證：**film 有 tmdb_id ⇒ 一定有 snapshot 列**，在結構上無法漏掉。
--
-- 為什麼佔位列只寫 (film_id, tmdb_id)：
--   其餘欄位的 default 就是正確的初始值——`state='pending'`、
--   `next_refresh_at = now()`（立刻進佇列）。內容欄位保持 NULL，讀取端 view
--   看到的就是「沒有 TMDB 內容」，退回文字卡片。合規在這一刻也是成立的。
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 佔位列的 trigger
--    SECURITY DEFINER：呼叫者（含 authenticated 的 UGC 補綁）對
--    film_tmdb_snapshot 沒有 INSERT 權限，也不該有。
-- -----------------------------------------------------------------------------
create or replace function public.film_ensure_tmdb_snapshot()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.tmdb_id is not null then
    insert into public.film_tmdb_snapshot (film_id, tmdb_id)
    values (new.id, new.tmdb_id)
    on conflict (film_id) do nothing;

    -- 換綁 TMDB id 的情形：校正並排回佇列。寫成獨立一句而不是 ON CONFLICT
    -- DO UPDATE，是因為那需要在 WHERE 裡指名既有列，而在 search_path = '' 下
    -- 那個名字要怎麼限定並不顯而易見——一句 UPDATE 沒有這個疑慮。
    -- ★ `tmdb_id` 相同時什麼都不做：覆寫 state 會把一列還新鮮的快取打回
    --   pending，白跑一次 TMDB 請求。
    update public.film_tmdb_snapshot
       set tmdb_id = new.tmdb_id, next_refresh_at = now()
     where film_id = new.id and tmdb_id <> new.tmdb_id;
  end if;
  return null;
end $$;

drop trigger if exists film_ensure_snapshot on public.film;
create trigger film_ensure_snapshot after insert or update of tmdb_id on public.film
  for each row execute function public.film_ensure_tmdb_snapshot();

-- -----------------------------------------------------------------------------
-- 2. 既有資料的補件
--    ★ 排除已合併的作品：`tmdb_refresh_due` 也把它們排除，替它們建佔位列只會
--      製造永遠不會被刷新、也沒有人讀的列。
-- -----------------------------------------------------------------------------
insert into public.film_tmdb_snapshot (film_id, tmdb_id)
select f.id, f.tmdb_id
from public.film f
where f.tmdb_id is not null
  and f.merged_into_film_id is null
  and not exists (select 1 from public.film_tmdb_snapshot s where s.film_id = f.id)
on conflict (film_id) do nothing;

-- -----------------------------------------------------------------------------
-- 3. 自我檢查 —— 補件漏了就讓 migration 失敗，而不是留一個少了 N 的數字
-- -----------------------------------------------------------------------------
do $$ declare missing integer;
begin
  select count(*) into missing
    from public.film f
   where f.tmdb_id is not null and f.merged_into_film_id is null
     and not exists (select 1 from public.film_tmdb_snapshot s where s.film_id = f.id);
  if missing > 0 then
    raise exception '仍有 % 部帶 tmdb_id 的作品沒有快照列', missing;
  end if;
end $$;

comment on function public.film_ensure_tmdb_snapshot() is
  '保證「film 有 tmdb_id ⇒ film_tmdb_snapshot 有對應列」。少了這個不變量，'
  '作品不會進 tmdb_refresh_due，於是永遠沒有海報而排程回報一切正常。';
