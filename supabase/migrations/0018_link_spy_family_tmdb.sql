-- =============================================================================
-- 0018 —《SPY x FAMILY CODE: White》（間諜家家酒）人工指定 TMDB 1062807
--        （David 2026-09-20：「SPY x FAMILY = 間諜家家酒 去查查看為什麼沒有海報」）
--
-- 可重複執行（冪等）：以 tmdb_id is null 為守衛，第二次跑是 no-op。
-- =============================================================================
--
-- ── 為什麼比對不到（實測，不是推測）──────────────────────────────────────
-- 跑 `normalizeTitle()` 的實際輸出：
--
--   政府 title_zh / title_original  "spyxfamilycodewhite"            ← 字母 x
--   TMDB title                      "spy×family間諜家家酒codewhite"   ← × 乘號
--   TMDB original_title             "劇場版spy×familycodewhite"       ← × 乘號 ＋ 前綴
--
-- ★ **片商是用英文片名去登記的**，所以政府資料的「中文片名」跟「原文片名」
--   一字不差都是 `SPY x FAMILY CODE: White`，那一欄裡沒有任何中文。
--
-- 三個障礙疊在一起：① `×`（U+00D7 乘號）≠ `x`（字母）② TMDB 的中文片名中間
-- 插了「間諜家家酒」③ original_title 前面多了「劇場版」。
-- 於是 exact 與 prefix 全部不成立，`scoreCandidate` 只拿到 `year-near` 1.5 分
-- （TMDB 2023-12-22 vs 核准 113 年），低於 SCORE_THRESHOLD = 3 ⇒ 判為未命中。
--
-- ⚠️ **這不是比對器的 bug，是它照設計拒絕猜。** `matcher.ts` 檔頭記載過
--   《Fate stay night Heaven's feel》靠前綴配到系列第二部的事故，結論是
--   「護欄失效時放寬門檻，等於在最沒有把握的時候最敢猜」。這一部正是那條
--   規則正確地擋下來的情況——缺口用人工指定補，而不是調鬆門檻。
--
-- ⚠️ 也**不要**順手把 `×` 正規化成 `x` 就當修好了：實測光修那一個字元救不了
--   這一部（政府 `spyxfamilycodewhite` vs TMDB original `劇場版spyxfamilycodewhite`，
--   「劇場版」卡在前面，前綴比對兩個方向都不成立）。要動 `normalizeTitle`
--   得先量全片庫 2,764 部會有幾部配對改變，那是另一件事。
--
-- ── 交叉驗證（為什麼確定 1062807 是對的）────────────────────────────────
--   TMDB 1062807  劇場版 SPY×FAMILY CODE: White  2023-12-22  **110 分鐘**
--   政府核准資料                                  113 年      **110 分鐘**
--   片長分秒不差，而片長正是 `matcher.ts` 稱為「唯一能擋住片名相近但根本是
--   另一部片」的訊號。這不是靠片名猜的。
--
-- ⚠️ 刪舊識別鍵那一步這裡不需要（本片 tmdb_id 是 null ⇒ 沒有主 tmdb 識別鍵），
--    但 0017 記載的那個陷阱仍然成立：**已經有主 tmdb 識別鍵的片改不動 tmdb_id**。
-- =============================================================================

do $$
declare
  n integer;
  target uuid;
begin
  select id into target from public.film
   where tmdb_id is null and title_zh = 'SPY x FAMILY CODE: White';

  if target is null then
    raise notice '0018：沒有待處理的列（已經套用過，或片名已變）';
    return;
  end if;

  perform public.link_film_to_tmdb(target, 1062807);

  update public.film_tmdb_snapshot
     set next_refresh_at = now(), updated_at = now()
   where film_id = target;

  -- ── 冒煙測試 ────────────────────────────────────────────────────────────
  select count(*) into n from public.film where tmdb_id = 1062807;
  if n <> 1 then
    raise exception '0018 失敗：預期 1 部片指向 1062807，實際 %', n;
  end if;

  select count(*) into n from public.film_identity where key = 'tmdb:1062807';
  if n <> 1 then
    raise exception '0018 失敗：識別鍵 tmdb:1062807 不存在（觸發器沒有建）';
  end if;

  -- ★ 反向斷言：證明檢查分辨得出東西，不是整張表被清空才碰巧綠。
  select count(*) into n from public.film where tmdb_id is not null;
  if n < 100 then
    raise exception '0018 失敗：film 表只剩 % 列有 tmdb_id，上面的檢查是空轉的', n;
  end if;

  raise notice '0018 冒煙測試通過：間諜家家酒已指向 1062807，等待重抓快照';
end $$;
