-- =============================================================================
-- 0014 — 國別「中華民國」統一成「台灣」
--        （David 2026-09-06：「國別：中華民國 = 台灣。有些資料會是中華民國的
--          都統一改用台灣」）
--
-- 可重複執行（冪等）。
-- =============================================================================
--
-- 這**不是外觀問題**。`/app` 與 `/u/` 的國別分布圖直接 group by 這個欄位
-- （`0003_user_year_stats.sql:199` 的 `group by f.country`），所以同一個國家的
-- 兩種寫法會**裂成兩條長條**。實測 2026-09-06，David 自己的 174 筆紀錄上就有
-- 「台灣 2」與「中華民國 1」各一條。
--
-- 跟 `src/normalize/city.ts` 擋的是同一件事（台北市 25 筆 vs 臺北市 5 筆，
-- 「不正規化會讓同一個縣市在統計中裂成兩筆」）——同一個問題換一個欄位又發生一次。
--
-- ── ⚠️ 這件事必須做兩層，只做一層是這個 repo 的已知失敗模式 ──────────────
--
--   · **只改這裡（DB）**：既有 403 + 436 列會變乾淨，但上游沒動 ⇒
--     下次匯入新年度的政府 CSV、或 David 再匯入一次舊 log，
--     「中華民國」會**再流進來**，而且沒有任何檢查會擋。
--   · **只改上游（src）**：新資料乾淨，但既有的 403 + 436 列**一列都不會變** ⇒
--     分布圖上那兩條長條還在。
--
--   ⇒ 另一半在 `src/normalize/country.ts`，套用點是
--     `src/gov/rating.ts`（政府 CSV 解析）與 `src/import/mylog.ts`（舊 log 匯入，
--     那條路徑不經過政府資料、由 `/app/import` 直接 insert `film.country`）。
--     **改動這支 migration 的人請連同上游一起看**，只留一半下次一定會漂回去。
--
-- ── 這支只做這一件事 ─────────────────────────────────────────────────
-- 不順手統一別的國名：政府資料的國名有它自己的體系（香港、韓國、俄羅斯…），
-- 動了會製造新的、跟歷史資料對不起來的分類。
-- 空字串仍然走 `0008` 定下的 `'' → null` 規則，這裡不碰空值。
--
-- ── 執行前的實測數字（還原時的基準）───────────────────────────────────
--   film.country        中華民國 403 ／ 台灣 2
--   certificate.country 中華民國 436 ／ 台灣 0
-- ⚠️ 還原**不能**用「把台灣改回中華民國」——那 2 筆本來就是台灣，會被誤傷。
--    要還原必須用執行前匯出的 id 清單 `where id = any(...)`。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. film.country
-- -----------------------------------------------------------------------------
update public.film
   set country = '台灣', updated_at = now()
 where country in ('中華民國', '臺灣');

-- -----------------------------------------------------------------------------
-- 2. certificate.country
--    （`film.country` 有一部分是從這裡經 `consolidate.ts` 帶過去的，
--      兩邊都要改，否則下一次重跑 pipeline 會把舊寫法帶回 film 上。）
-- -----------------------------------------------------------------------------
update public.certificate
   set country = '台灣'
 where country in ('中華民國', '臺灣');

-- -----------------------------------------------------------------------------
-- 3. 冒煙測試（0005 的教訓：跑完了不代表結果是對的）
--    包在有 EXCEPTION 子句的區塊裡 ⇒ 隱含 savepoint，測試自己造的資料會回滾。
-- -----------------------------------------------------------------------------
do $$
declare n_film integer; n_cert integer; n_tw integer;
begin
  -- ① 兩張表都不得再有任何台灣的舊寫法
  select count(*) into n_film from public.film where country in ('中華民國', '臺灣');
  select count(*) into n_cert from public.certificate where country in ('中華民國', '臺灣');
  if n_film <> 0 or n_cert <> 0 then
    raise exception '0014 失敗：仍有舊寫法（film %、certificate %）', n_film, n_cert;
  end if;

  -- ② 對照組：證明①分辨得出東西，而不是因為欄位空了才通過
  select count(*) into n_tw from public.film where country = '台灣';
  if n_tw = 0 then
    raise exception '0014 失敗：film 一列「台灣」都沒有，UPDATE 恐怕沒有寫進去';
  end if;
  raise notice '0014：film 的「台灣」現在有 % 列', n_tw;

  -- ③ 0008 的 check 仍然成立（空字串在結構上寫不進去）。
  --    這一段自己開一個有 EXCEPTION 的子區塊 ⇒ 隱含 savepoint，測試資料自己回滾。
  --    ⚠️ 只捕捉 check_violation：若因為別的理由失敗（例如欄位變動），
  --    讓它往外炸，不要用一個「碰巧通過」的測試騙自己。
  begin
    insert into public.film (title_zh, country, origin, visibility, review_state)
    values ('__smoke__0014', '', 'ugc', 'private', 'pending');
    raise exception '0014 失敗：country = '''' 竟然寫得進去（0008 的 check 不見了）';
  exception when check_violation then
    raise notice '0014：film_country_not_blank 仍然有效';
  end;

  raise notice '0014 冒煙測試通過';
end $$;
