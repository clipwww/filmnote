-- =============================================================================
-- 0017 — 兩部片配到 TMDB 的「空殼條目」，改指向真正的作品
--        （David 2026-09-20：「你的名字在 TMDB 有海報呀 為什麼我這沒有呀？」）
--
-- 可重複執行（冪等）：以舊 tmdb_id 為守衛，第二次跑是 no-op。
-- =============================================================================
--
-- ── 病灶 ──────────────────────────────────────────────────────────────────
-- TMDB 上有一類**空殼條目**：只有標題，沒有上映日、片長 0、沒有簡介、常常沒有海報。
-- 它們在片名上可以是一字不差的精確吻合，於是拿到跟真片一樣的分數。
--
--   《你的名字。》核准資料的原文片名是英文 `YOUR NAME.`（不是 `君の名は。`）
--     · 553301「Your Name」空殼 → original-exact 5 分
--     · 372058「你的名字」真片  → zh-exact      5 分
--     ⚠️ 真片拿不到 year-near：它是 2016 年的片，而那筆核准是 113 年的**重映**，
--        差 8 年遠超過 ±1 的容忍。
--
--   《潛艦危機倒數》／`U235` 完全同型：1391860 空殼 5 分 vs 554022（Torpedo,
--   2019）zh-exact 5 分。
--
-- `ingest-rating.ts` 先搜原文片名再搜中文片名、以 Map 合併 ⇒ **空殼先進候選集**；
-- 而舊的 `reduce((a, b) => b.score > a.score ? b : a)` 是嚴格大於、平手保留先出現的
-- ⇒ 空殼贏。勝負完全由搜尋結果的順序決定。
--
-- ── ⚠️ 這件事必須做兩層，只做一層是本 repo 的已知失敗模式 ───────────────────
--   · 只改這裡（DB）：這兩部會修好，但**下次重跑匯入又會配回空殼**。
--   · 只改上游：新資料乾淨，但既有這兩列一列都不會變。
--   ⇒ 另一半在 `src/match/matcher.ts` 的 `preferPopulated()`（平手時偏好有上映日的
--     候選）。★ 它刻意**不是加分**：加分會抬升所有有上映日的候選、可能把原本低於
--     SCORE_THRESHOLD 的配對推過門檻；平手比較則分數完全不變 ⇒ 門檻判定不變
--     ⇒ 能改變的結果只有平手那些。回歸測試在 `tests/matcher.test.ts`
--     （含兩條對照斷言，並已故意弄壞驗證過會紅）。
--
-- ── 執行前的實測數字（2026-09-20，還原時的基準）─────────────────────────────
--   全片庫 2,764 部中，快照 state='fresh' 但 release_date is null 且 runtime 0 的
--   共 **3 部**：本檔處理的兩部，加上《亞洲》／`Asia`（1360866）。
--   ⚠️ 第三部**刻意不動**：TMDB 上找不到更好的候選（搜 `Asia` 的前幾名沒有一部
--      對得上「亞洲」這個中文片名），硬改等於用猜的換掉一個已知錯誤。
--      而且它 0 人看過，不影響任何人的畫面。
--
--   另有 25 部是 state='fresh'、有上映日、但 TMDB 上就是沒有海報——
--   **那不是配對錯誤，不要一起「修」。**
-- =============================================================================

do $$
declare
  n integer;
begin
  -- ① ★ 順序不可以反：先刪掉舊的主 tmdb 識別鍵。
  --
  --    `film_identity_sync` 觸發器（AFTER UPDATE OF tmdb_id）會插入
  --    `tmdb:<新id>` 且 `is_primary = true`，**但它不會移除舊的那一列**，
  --    而舊的那一列同樣是 is_primary ⇒ 撞上部分唯一索引
  --      film_identity_one_primary ON (film_id, kind) WHERE is_primary
  --    ⇒ `link_film_to_tmdb` 直接丟 unique_violation。
  --
  --    ⚠️ 這不只影響這支 migration：**任何「把配錯的 tmdb_id 改掉」的路徑都會踩到**
  --      （`link_film_to_tmdb` 是 admin 端重新配對的唯一入口）。
  --      實測 2026-09-20：不先刪就是 film_identity_one_primary 違反。
  --
  --    順帶：舊鍵本來就該消失。它指向的是一個垃圾條目，留著會讓日後的
  --    `seed_films()` 把新資料掛回同一個錯誤 id 上。
  delete from public.film_identity
   where key in ('tmdb:553301', 'tmdb:1391860');

  -- ② 你的名字。 553301（空殼）→ 372058（君の名は。, 2016-07-01）
  --    新的 `tmdb:372058` 識別鍵由觸發器自動建立，這裡不手動插入
  --    （手動插入會再撞一次同一個索引，因為觸發器已經建好了）。
  perform public.link_film_to_tmdb(id, 372058)
    from public.film where tmdb_id = 553301;

  -- ③ 潛艦危機倒數 1391860（空殼）→ 554022（Torpedo, 2019-10-23）
  perform public.link_film_to_tmdb(id, 554022)
    from public.film where tmdb_id = 1391860;

  -- ④ 快照裡還留著空殼的內容（全是 null）與一個 2027 年的 expires_at。
  --    退回 pending 並把 expires_at 拉到過去，讓它在重抓之前不會被當成有效快取。
  --    ⚠️ film_public 是以 expires_at 把關、不看 state，所以作品不會因此消失。
  update public.film_tmdb_snapshot s
     set state = 'pending',
         title_zh = null, title_original = null, overview = null,
         poster_path = null, backdrop_path = null,
         runtime_minutes = null, release_date = null, tw_release_date = null,
         payload = null, etag = null, attempts = 0, last_error = null,
         expires_at = now() - interval '1 day',
         next_refresh_at = now(),
         updated_at = now()
   from public.film f
  where f.id = s.film_id and f.tmdb_id in (372058, 554022);

  -- ── 冒煙測試：驗不到預期結果就整支回滾 ──────────────────────────────────
  select count(*) into n from public.film where tmdb_id in (553301, 1391860);
  if n <> 0 then
    raise exception '0017 失敗：還有 % 部片指向空殼 id', n;
  end if;

  select count(*) into n from public.film where tmdb_id in (372058, 554022);
  if n <> 2 then
    raise exception '0017 失敗：預期 2 部片指向新 id，實際 %', n;
  end if;

  -- ★ 反向斷言：證明這個檢查分辨得出東西。
  --   「空殼 id 消失了」如果是因為整張表被清空，上面那條也會綠。
  select count(*) into n from public.film where tmdb_id is not null;
  if n < 100 then
    raise exception '0017 失敗：film 表只剩 % 列有 tmdb_id，上面的檢查是空轉的', n;
  end if;

  select count(*) into n from public.film_identity where key in ('tmdb:372058', 'tmdb:554022');
  if n <> 2 then
    raise exception '0017 失敗：新的 tmdb 識別鍵只有 % 個', n;
  end if;

  raise notice '0017 冒煙測試通過：兩部片已改指向真作品，快照退回 pending 等待重抓';
end $$;
