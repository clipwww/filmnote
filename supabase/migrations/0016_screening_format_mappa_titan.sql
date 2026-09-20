-- =============================================================================
-- 0016 — MAPPA 與 TITAN 升格成獨立的放映版本
--        （David 2026-09-20：「MAPPA 跟 TITAN 也是獨立的一種版本，
--          不要歸類為『其他』」）
--
-- 可重複執行（冪等）。
-- =============================================================================
--
-- ── ⚠️ 這推翻了前一輪一個明確寫下來的決定 ────────────────────────────────
--
-- 舊結論（**不刪掉，留著是為了擋住重新推導**，同 `SCREENS §1`、`BUILD_PLAN §4.2`
-- 的處理方式）：`src/import/mylog.ts` 曾白紙黑字寫著「TITAN 與 MAPPA 是威秀的
-- **廳型品牌**而非放映格式（其中一筆的備註寫「TITAN廳初體驗」），所以進
-- hall_label，format_code 記為 other」。
--
-- 新理由：`screening_format` 是 SPEC 明講「會持續長出成員的開放詞彙」，判準是
-- **使用者買票時選的是哪一種放映版本**，而不是它在技術上算不算一套獨立的放映
-- 規格——照後者的判準，4DX 與 Dolby Cinema 同樣只是品牌名。歸進 other 的代價是
-- 實測的：`0003_user_year_stats.sql:207` 的版本分布是
-- `group by coalesce(r.format_code,'other')`，所以那 5 筆在 /app 與 /u/ 的分布圖上
-- 被併成「其他」一桶，兩個相異的版本在圖上看不出來。
--
-- ── ⚠️ 這件事必須做兩層，只做一層是這個 repo 的已知失敗模式 ──────────────
--
--   · **只改這裡（DB）**：既有 5 列變乾淨，但上游沒動 ⇒ David 下次再匯入一次
--     舊 log，MAPPA/TITAN 會**再流進 other**，而且沒有任何檢查會擋。
--   · **只改上游（src）**：新資料乾淨，但既有 5 列**一列都不會變** ⇒
--     分布圖上那個「其他」還在。
--
--   ⇒ 另一半在 `src/import/mylog.ts` 的 `FORMAT_TABLE`（'MAPPA' → mappa、
--     'TITAN' → titan，hall 皆 null），套用點是 `scripts/import-mylog.ts`。
--     值域則由 `tests/import.test.ts` 的「format_code 全部落在 screening_format
--     的值域內」守著。**改動這支 migration 的人請連同上游一起看**，
--     只留一半下次一定會漂回去。
--
-- ── ★ hall_label 要一起清空（這是從資料讀出來的規則，不是偏好）────────────
--
-- 實測 2026-09-20：`imax`(9) + `4dx`(30) + `dolby`(1) 共 39 筆的 hall_label
-- **全部是 null**——既有慣例是「版本已經指明了是哪個廳時，廳別欄就留空」。
-- `app/utils/ticket.ts` 的 `venueSegment()` 會組出「影城名 (廳別)」，
-- `detailSegment()` 再印 `formatLabel` ⇒ 不清空的話那 5 筆會印成
-- 「林口MITSUI OUTLET PARK威秀影城 (MAPPA) MAPPA」，成為全站唯一印兩次的紀錄。
--
-- ── 前端不必改 ──────────────────────────────────────────────────────
-- `app/composables/useScreeningFormats.ts` 從 DB 讀顯示名、RPC 也是
-- `left join public.screening_format s on s.code = r.format_code` 取 label
-- ⇒ 新 code 前端自動就認得。**不要「順手」在前端補一份寫死的對照表**，
-- 那份會在下一個成員長出來時默默過期。
--
-- ── 執行前的實測數字（還原時的基準；以 IMPORT_TARGET_EMAIL 精確指定的帳號）──
--   format_code 分布：digital 129 / 4dx 30 / imax 9 / other 5 / dolby 1
--   全表（不分帳號）符合 `format_code='other' or hall_label is not null` 的列
--   就只有下面這 5 筆，分屬 1 個帳號；hall_label 的 raw 值就是 'MAPPA'/'TITAN'
--   （length 5），**查過沒有大小寫或前後空白的變體**，所以下面用精確比對；
--   若你的環境有變體，把 where 換成 `btrim(upper(hall_label))`。
--
--     35543be1-4749-4173-b9c0-55f428ed8682  2016-09-28  MAPPA
--     74b2241d-466c-474b-830b-fd71987f6a0f  2020-10-01  MAPPA
--     b729f817-18ae-4416-bfc8-b2680eac283b  2021-02-09  TITAN
--     d663e16d-4c2f-44c1-aff4-26a614fdf373  2021-10-16  MAPPA
--     d82d28ca-2d22-48bb-8c62-fbbd60c9c8d8  2023-04-09  MAPPA
--
--   還原：`update public.viewing_record set format_code = 'other',
--          hall_label = upper(format_code) where format_code in ('mappa','titan')`
--   ——這裡的對應是一對一的（`mappa`→`MAPPA`、`titan`→`TITAN`），
--   不像 0014 的國名還原會誤傷本來就正確的列。之後再 delete 那兩個 code。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 先長出 code。
--    ⚠️ 順序不能反：viewing_record_format_code_fkey
--       FOREIGN KEY (format_code) REFERENCES screening_format(code)
--       ⇒ code 不存在時第 2 段會 23503。
--    sort_order 放在 dolby(60) 與 film_35(70) 之間，並且**留空隙**——
--    這張表 SPEC 明講是會持續長出成員的開放詞彙。
--    label 就是品牌名本身：兩者都沒有通行的中文譯名，硬翻會比原文難認。
-- -----------------------------------------------------------------------------
insert into public.screening_format (code, label, sort_order) values
  ('mappa', 'MAPPA', 62),
  ('titan', 'TITAN', 64)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- 2. 既有紀錄就地改寫，hall_label 一併清空（理由見檔頭）。
--    不設 updated_at：`vr_touch` 這個 before update trigger 已經會呼叫
--    touch_updated_at()，手動再寫一次是多餘的（0014 動的 film 沒有這個 trigger）。
--    冪等：跑第二次時 hall_label 已經是 null，where 命中 0 列。
-- -----------------------------------------------------------------------------
update public.viewing_record
   set format_code = 'mappa', hall_label = null
 where format_code = 'other' and hall_label = 'MAPPA';

update public.viewing_record
   set format_code = 'titan', hall_label = null
 where format_code = 'other' and hall_label = 'TITAN';

-- -----------------------------------------------------------------------------
-- 3. 冒煙測試（0005 的教訓：跑完了不代表結果是對的）
--    包在有 EXCEPTION 子句的區塊裡 ⇒ 隱含 savepoint，測試自己造的資料會回滾。
--    ⚠️ ①用的是**資料述詞**而不是「全表 other 的筆數 = 0」：別的帳號可能握有
--       合法的 other 紀錄，拿總數當斷言會在那一天變成假紅燈。
-- -----------------------------------------------------------------------------
do $$
declare n_left integer; n_other integer; n_codes integer; n_mappa integer; n_titan integer;
begin
  -- ① 不得再有任何一列把 MAPPA/TITAN 記在廳別欄
  select count(*) into n_left from public.viewing_record
   where btrim(upper(hall_label)) in ('MAPPA', 'TITAN');
  if n_left <> 0 then
    raise exception '0016 失敗：仍有 % 列的 hall_label 是 MAPPA/TITAN', n_left;
  end if;

  -- ② 對照組：證明①分辨得出東西，而不是整個 other 分類被刪掉才碰巧綠
  select count(*) into n_other from public.screening_format where code = 'other';
  if n_other <> 1 then
    raise exception '0016 失敗：screening_format 的 other 不見了（找到 % 列）', n_other;
  end if;

  -- ③ 新 code 真的長出來，而且真的被 viewing_record 參照到
  --    （只 insert code 而 UPDATE 沒寫進去的話，①也會綠——要這一條才分得出來）
  select count(*) into n_codes from public.screening_format where code in ('mappa', 'titan');
  if n_codes <> 2 then
    raise exception '0016 失敗：screening_format 少了 mappa/titan（只找到 % 個）', n_codes;
  end if;
  select count(*) into n_mappa from public.viewing_record where format_code = 'mappa';
  select count(*) into n_titan from public.viewing_record where format_code = 'titan';
  if n_mappa = 0 or n_titan = 0 then
    raise exception '0016 失敗：viewing_record 參照不到新 code（mappa %、titan %）', n_mappa, n_titan;
  end if;
  raise notice '0016：mappa % 列、titan % 列', n_mappa, n_titan;

  -- ④ 結構對照組：外鍵本身仍然有效（不是因為約束不見了，什麼都寫得進去才通過）。
  --    自己開一個有 EXCEPTION 的子區塊 ⇒ 隱含 savepoint，改動自己回滾。
  --    ⚠️ 只捕捉 foreign_key_violation：因別的理由失敗時讓它往外炸，
  --    不要用一個「碰巧通過」的測試騙自己。
  if exists (select 1 from public.viewing_record) then
    begin
      update public.viewing_record
         set format_code = '__smoke__0016'
       where id = (select id from public.viewing_record order by id limit 1);
      raise exception '0016 失敗：format_code 竟然指得到不存在的 code（外鍵不見了）';
    exception when foreign_key_violation then
      raise notice '0016：viewing_record_format_code_fkey 仍然有效';
    end;
  else
    raise exception '0016 失敗：viewing_record 一列都沒有，③④ 兩組斷言等於沒跑';
  end if;

  raise notice '0016 冒煙測試通過';
end $$;
