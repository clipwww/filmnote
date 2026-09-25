-- =============================================================================
-- 0019 — seed_films() 認得「這筆片名是誰的」
--
-- 授權來源：`BUILD_PLAN §8.3` 2026-09-20 David 的第 1 則裁決（TMDB 直接匯入新片）。
-- 裁決要求 `origin='tmdb'`、`title_zh_source='tmdb'`、`review_state='approved'`，
-- 並且「政府資料日後帶著片名進來時，把 title_zh 與 title_zh_source 一起翻成 'gov'」。
--
-- ★ 裁決框只講了 UPDATE 分支那一條，實查發現要改的是**兩條**：
--
--   ① INSERT 分支根本寫不出 `title_zh_source`。欄位清單裡沒有它 ⇒ 落回欄位預設值
--      `'gov'`（film.title_zh_source not null default 'gov'）。照現狀丟 source='tmdb'
--      進來的結果是 `origin='tmdb'` 但 `title_zh_source='gov'`——**與裁決相反**：
--      群眾翻譯的片名從此被標記成「官方核准的」，而 UPDATE 分支那條
--      `case when title_zh_source = 'gov'` 會因此一直放行。
--
--   ② UPDATE 分支的 `case` 是 source-blind 的。它檢查的是**那一列既有的**來源，
--      完全沒讀進來的 rec 是誰送的 ⇒ TMDB 送來的片名會直接寫進一列
--      `title_zh_source='gov'` 的作品，而且**來源標籤還留著 'gov'**。
--      那是 SPEC 第一條價值主張（片名以官方核准名稱為準）的反方向破口，
--      而且沒有任何錯誤訊息。裁決框沒提這一半，但只做另一半仍然會被打穿。
--
-- ⚠️⚠️ 判別子**不可以**用 `rec->>'source'`。它的語意是「比對器有沒有配到 TMDB」
--   （`src/pipeline/consolidate.ts:82`：`source: outcome.matched ? 'tmdb' : 'gov'`），
--   **不是「這筆片名是誰的」**。政府管線送進來的**政府片名**，只要那部片配對成功
--   `source` 就已經是 'tmdb'（活體 2,480 列 origin='tmdb'）⇒ 拿它當判準會把政府片名的
--   更新路徑整條靜默關掉。所以這裡引進一個**新的、明示的** payload 欄位 `titleZhSource`，
--   而且**缺席時一律維持現行行為**（= 政府管線照樣寫得進去）。
--   契約另一半在 `scripts/seed-supabase.ts` 的 `FilmRow` interface。
--
-- ⚠️ 範圍嚴格限定 `'tmdb'`，**不可以寫成 `<> 'gov'`**：`source_authority` 有四個值
--   ('gov','tmdb','ugc','admin')，`'admin'` 是 0012 的人工修正、**永久脫離政府更新**是
--   刻意的取捨，被這條洗掉不會有任何訊息。
--   `'ugc'` 由 David 2026-09-25 裁決：**與 'tmdb' 同等對待**（政府片名進來就翻成 gov）。
--   套用當下的影響半徑是 0 列：活體 16 列 ugc 全部已合併、沒有 tmdb_id、沒有 gov: 鍵。
--
-- ★ 用「讀出活體定義 → 字串取代 → execute」而不是 create or replace 抄一份函式體。
--   0009 抄了函式體，**靜默回退了 0006 的修正**，靜態檢查全綠（§7 #109）。
--   0008／0010 都用這個手法改過 seed_films，修正會疊加而不是互相覆蓋。
--   ⚠️ replace 沒命中時 PostgreSQL 不會報錯，它會安靜地把原樣寫回去 ⇒ migration 成功、
--   改動沒發生。所以下面**把命中次數當斷言**，不是 1 就 raise exception（§7 #254）。
--
-- 可重複執行（已經改過就跳過）。
-- =============================================================================

do $$
declare
  src text; patched text; after_src text;
  h1 int; h2 int; h3 int;
  -- 錨點一字不差取自活體 pg_get_functiondef()，**不是**取自 0001_init.sql
  -- （0008／0010 改寫過 INSERT 分支：country／titleOriginal 已是 nullif 而非 coalesce）。
  n1 text := $n1$first_seen_roc_year, origin, review_state, visibility)$n1$;
  n2 text := $n2$(coalesce(rec->>'source','gov'))::public.film_origin, 'approved', 'public')$n2$;
  n3 text := $n3$        title_zh = case when title_zh_source = 'gov' then coalesce(nullif(rec->>'titleZh',''), title_zh) else title_zh end,$n3$;
  r1 text := $r1$first_seen_roc_year, origin, review_state, visibility, title_zh_source)$r1$;
  r2 text := $r2$(coalesce(rec->>'source','gov'))::public.film_origin, 'approved', 'public',
              (coalesce(rec->>'titleZhSource','gov'))::public.source_authority)$r2$;
  -- 兩個 case 的條件必須**逐字相同**，否則會出現「寫了 TMDB 片名卻標成 gov」的組合。
  r3 text := $r3$        title_zh = case
          when title_zh_source = 'gov' and coalesce(rec->>'titleZhSource','gov') = 'gov'
            then coalesce(nullif(rec->>'titleZh',''), title_zh)
          when title_zh_source in ('tmdb','ugc') and coalesce(rec->>'titleZhSource','gov') = 'gov'
               and nullif(rec->>'titleZh','') is not null
            then rec->>'titleZh'
          else title_zh end,
        title_zh_source = case
          when title_zh_source in ('tmdb','ugc') and coalesce(rec->>'titleZhSource','gov') = 'gov'
               and nullif(rec->>'titleZh','') is not null
            then 'gov'::public.source_authority
          else title_zh_source end,$r3$;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'seed_films';

  if src is null then
    raise exception '0019：seed_films 不存在——0001 還沒跑過，不該走到這裡';
  end if;

  if src like '%titleZhSource%' then
    raise notice '0019：seed_films 已經認得 titleZhSource，未改動（可重複執行）';
    return;
  end if;

  h1 := (length(src) - length(replace(src, n1, ''))) / length(n1);
  h2 := (length(src) - length(replace(src, n2, ''))) / length(n2);
  h3 := (length(src) - length(replace(src, n3, ''))) / length(n3);
  raise notice '0019：錨點命中次數 n1=% n2=% n3=%（三個都必須是 1）', h1, h2, h3;

  -- ★ 這三個判斷就是 #254 那條踩雷的守門員：replace 不命中不會報錯。
  if h1 <> 1 or h2 <> 1 or h3 <> 1 then
    raise exception '0019：錨點命中次數不是 1（n1=% n2=% n3=%）——活體定義與預期不同，'
      '**不要**盲目套用。重讀 pg_get_functiondef(''public.seed_films'') 後改錨點。', h1, h2, h3;
  end if;

  patched := replace(replace(replace(src, n1, r1), n2, r2), n3, r3);
  execute patched;

  -- 後置條件：execute 過了不代表改對了（0009 就是「成功但回退」）。重讀一次活體。
  select pg_get_functiondef(p.oid) into after_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'seed_films';
  if after_src not like '%titleZhSource%' then
    raise exception '0019：改寫後的定義裡找不到 titleZhSource——execute 沒有生效';
  end if;
  if after_src like '%' || n3 || '%' then
    raise exception '0019：舊的 source-blind case 還在——replace 沒有真的換掉它';
  end if;
  if after_src not like $chk$%title_zh_source in ('tmdb','ugc') and coalesce(rec->>'titleZhSource','gov') = 'gov'%$chk$ then
    raise exception '0019：gov 翻轉分支不在改寫後的定義裡';
  end if;
  -- `<> ''gov''` 會把 0012 的人工修正洗掉。這條是結構性的保險絲，不是風格檢查。
  if after_src like $chk$%title_zh_source <> 'gov'%$chk$ then
    raise exception '0019：出現了 `title_zh_source <> ''gov''`——那會洗掉 admin 人工修正';
  end if;

  raise notice '0019：seed_films 已改寫（INSERT 寫得出 title_zh_source；UPDATE 認得送來的是誰的片名）';
end $$;

-- -----------------------------------------------------------------------------
-- 冒煙測試 —— 六格矩陣（列的來源 × 送進來的片名是誰的）
--
-- ★ 重點不是「新欄位寫得進去嗎」，是「**該擋的擋住了、該寫的還寫得進去**」。
--   只驗前者的話，把條件寫成「什麼都不寫」也會全綠——那正是 §7 #102／#254 的假綠燈：
--   政府片名的更新路徑被整條關掉，而斷言一片綠。所以每一條「不該被改」的旁邊
--   都配一組「必須被改」的對照。
--
-- ⚠️ 走 pnpm db:sql 直連時 session_user = postgres ⇒ is_service_context() 為真，
--    seed_films() 呼叫得到。走 PostgREST 則需要 service_role。
--
-- 全部在子交易內做完後 raise SMOKE_OK 回滾，一列都不留。
-- -----------------------------------------------------------------------------
do $$
declare
  v_gov uuid; v_tmdb uuid; v_admin uuid; v_ugc uuid; v_blank uuid; v_new uuid;
  t text; s text;
begin
  begin
    -- ── 準備四種來源的探針列。tmdb_id 落在 9999xxxxx 區段（TMDB 實際 id 遠小於此）。
    insert into public.film (tmdb_id, title_zh, title_zh_source, country, origin, review_state, visibility)
    values (999900001, 'zz0019政府片名', 'gov', '台灣', 'tmdb', 'approved', 'public') returning id into v_gov;
    insert into public.film (tmdb_id, title_zh, title_zh_source, country, origin, review_state, visibility)
    values (999900002, 'zz0019群眾翻譯', 'tmdb', '日本', 'tmdb', 'approved', 'public') returning id into v_tmdb;
    insert into public.film (tmdb_id, title_zh, title_zh_source, country, origin, review_state, visibility)
    values (999900003, 'zz0019人工修正', 'admin', '台灣', 'tmdb', 'approved', 'public') returning id into v_admin;
    insert into public.film (tmdb_id, title_zh, title_zh_source, country, origin, review_state, visibility)
    values (999900004, 'zz0019使用者自建', 'ugc', '台灣', 'ugc', 'approved', 'public') returning id into v_ugc;
    insert into public.film (tmdb_id, title_zh, title_zh_source, country, origin, review_state, visibility)
    values (999900005, 'zz0019群眾翻譯B', 'tmdb', '日本', 'tmdb', 'approved', 'public') returning id into v_blank;

    -- ═══ U1 §2.4.1 的破口：TMDB 的片名**不可以**寫進政府核准的片名 ════════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900001', 'tmdbId', 999900001,
      'titleZh', 'zz0019TMDB想蓋掉的名字', 'titleZhSource', 'tmdb', 'source', 'tmdb')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_gov;
    if t <> 'zz0019政府片名' then
      raise exception '0019 冒煙失敗：★ U1 政府核准片名被 TMDB 蓋掉了（實得 %）', t;
    end if;
    if s <> 'gov' then
      raise exception '0019 冒煙失敗：U1 政府列的 title_zh_source 被改成 %', s;
    end if;

    -- ═══ U2〔反向對照〕同一列、同一支函式，**政府**片名必須照樣寫得進去 ═══════
    --     少了這一組，U1 在「整條更新路徑被關掉」時也是綠的（§2.4.2 的假綠燈）。
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900001', 'tmdbId', 999900001, 'titleZh', 'zz0019政府改名了')));
    select title_zh into t from public.film where id = v_gov;
    if t <> 'zz0019政府改名了' then
      raise exception '0019 冒煙失敗：★ U2 對照組——政府片名竟然寫不進去，'
        '整條政府更新路徑被關掉了（實得 %）', t;
    end if;

    -- ═══ U4 TMDB 列 + TMDB 片名：維持現狀不動（沒有裁決，刻意不擴大） ═════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900002', 'tmdbId', 999900002,
      'titleZh', 'zz0019TMDB刷新', 'titleZhSource', 'tmdb', 'source', 'tmdb')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_tmdb;
    if t <> 'zz0019群眾翻譯' or s <> 'tmdb' then
      raise exception '0019 冒煙失敗：U4 TMDB 列被 TMDB 片名改動了（% / %）——'
        '這一格沒有裁決，這一輪刻意維持現狀', t, s;
    end if;

    -- ═══ U3 §8.3 的裁決本體：政府片名進來時，值與來源**一起**翻成 gov ═════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900002', 'tmdbId', 999900002, 'titleZh', 'zz0019政府核准名')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_tmdb;
    if t <> 'zz0019政府核准名' then
      raise exception '0019 冒煙失敗：★ U3 政府片名沒有覆蓋 TMDB 片名（實得 %）——'
        '那一列會被永遠鎖在群眾翻譯上', t;
    end if;
    if s <> 'gov' then
      raise exception '0019 冒煙失敗：★ U3 片名翻過去了但 title_zh_source 還是 %——'
        '下一次 TMDB 刷新會把它再蓋回去', s;
    end if;

    -- ═══ U8 只有標籤沒有值：不可以把來源翻成 gov ═══════════════════════════════
    --     少了這條，「翻轉」會退化成「把 TMDB 的片名重新標記成官方的」。
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900005', 'tmdbId', 999900005, 'titleZh', '')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_blank;
    if t <> 'zz0019群眾翻譯B' or s <> 'tmdb' then
      raise exception '0019 冒煙失敗：★ U8 空片名竟然造成翻轉（% / %）——'
        'TMDB 的片名被標記成官方核准的了', t, s;
    end if;

    -- ═══ U5／U6 §2.5：admin 人工修正兩種 payload 都不可以碰 ═══════════════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900003', 'tmdbId', 999900003, 'titleZh', 'zz0019政府想改回去')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_admin;
    if t <> 'zz0019人工修正' or s <> 'admin' then
      raise exception '0019 冒煙失敗：★ U5 admin 人工修正被政府 payload 洗掉了（% / %）', t, s;
    end if;
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900003', 'tmdbId', 999900003,
      'titleZh', 'zz0019TMDB想改', 'titleZhSource', 'tmdb', 'source', 'tmdb')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_admin;
    if t <> 'zz0019人工修正' or s <> 'admin' then
      raise exception '0019 冒煙失敗：★ U6 admin 人工修正被 TMDB payload 洗掉了（% / %）', t, s;
    end if;

    -- ═══ U9 ugc 列 + TMDB 片名：不可以動（先跑，U7 之後這一列就不是 ugc 了） ═══
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900004', 'tmdbId', 999900004,
      'titleZh', 'zz0019TMDB想改ugc', 'titleZhSource', 'tmdb', 'source', 'tmdb')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_ugc;
    if t <> 'zz0019使用者自建' or s <> 'ugc' then
      raise exception '0019 冒煙失敗：★ U9 ugc 列被 TMDB 片名改動了（% / %）', t, s;
    end if;

    -- ═══ U7 David 2026-09-25：ugc 列 + 政府片名 ⇒ 值與來源一起翻成 gov ═════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900004', 'tmdbId', 999900004, 'titleZh', 'zz0019政府改ugc')));
    select title_zh, title_zh_source::text into t, s from public.film where id = v_ugc;
    if t <> 'zz0019政府改ugc' or s <> 'gov' then
      raise exception '0019 冒煙失敗：★ U7 ugc 列沒有被政府片名翻成 gov（% / %）', t, s;
    end if;

    -- ═══ I1 §2.4.0：新建的列必須是 origin=tmdb + title_zh_source=tmdb ═════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'tmdb:999900006', 'tmdbId', 999900006, 'titleZh', 'zz0019新匯入',
      'titleOriginal', 'ZZ0019 NEW', 'titleZhSource', 'tmdb', 'source', 'tmdb')));
    select id into v_new from public.film where tmdb_id = 999900006;
    if v_new is null then
      raise exception '0019 冒煙失敗：I1 新作品沒有被建出來';
    end if;
    select title_zh_source::text into s from public.film where id = v_new;
    if s <> 'tmdb' then
      raise exception '0019 冒煙失敗：★ I1 新匯入的列 title_zh_source 是 % 而不是 tmdb——'
        '群眾翻譯的片名被標記成官方核准的了（§8.3 的裁決反了）', s;
    end if;
    if (select origin::text from public.film where id = v_new) <> 'tmdb'
       or (select review_state::text from public.film where id = v_new) <> 'approved' then
      raise exception '0019 冒煙失敗：I1 新匯入的列 origin／review_state 不符裁決';
    end if;

    -- ═══ I2〔反向對照〕政府管線不帶 titleZhSource ⇒ 必須維持 gov ══════════════
    perform public.seed_films(jsonb_build_array(jsonb_build_object(
      'id', 'gov:zz0019', 'titleZh', 'zz0019政府新片', 'source', 'gov')));
    select public.resolve_film('gov:zz0019') into v_new;
    if v_new is null then
      raise exception '0019 冒煙失敗：I2 政府新片沒有被建出來';
    end if;
    if (select title_zh_source::text from public.film where id = v_new) <> 'gov' then
      raise exception '0019 冒煙失敗：★ I2 對照組——政府管線建的列不再是 gov，'
        '新欄位的預設值改壞了現行行為';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0019 冒煙測試通過：U1 擋住 TMDB 蓋政府片名／U2 政府片名照樣寫得進去／'
    'U3 U7 政府來時 tmdb／ugc 值與來源一起翻 gov／U4 U9 TMDB 片名不動 tmdb／ugc 列／U5 U6 admin 不被碰／'
    'U8 空片名不翻標籤／I1 新列是 tmdb／I2 政府列仍是 gov（變更已回滾）';
end $$;
