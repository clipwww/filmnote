-- =============================================================================
-- 0015 — 場所的空名字：人工正名 + 公司全銜保底 + 結構上讓它長不回來
--        （David 2026-09-07：「在哪看的下拉選單裡有幾筆是城市名，那是髒資料」）
--
-- 可重複執行（冪等）。
-- =============================================================================
--
-- ── ★ 先講清楚：那不是「混進來的城市名」──────────────────────────────
--
-- 選單裡看起來叫「台北市」的那幾筆，是**三家真的影城**，它們的 `venue.name`
-- 是**空字串**。`app/pages/app/records/new.vue` 的 item 樣板原本是
-- `{{ name }}` + `<span v-if="city">· {{ city }}</span>`，name 為空時整列就
-- 只剩「· 台北市」；`app/pages/app/import.vue` 的
-- `[name, city, …].filter(Boolean).join(' · ')` 更糟，連中點都被吃掉，
-- 標籤直接變成裸的「台北市」。
--
--   ⚠️ **症狀在算繪層、病灶在資料層。** 實測 `select … from public.venue
--      where name ~ '(市|縣|區|鄉|鎮)$'` → **0 列**。拿著螢幕上的字面去 DB 裡
--      查，會得到「資料沒問題」這個完全相反的結論。（BUILD_PLAN §7）
--
-- 執行前的實測（2026-09-07，還原時的基準）：
--   venue 共 114 列；`btrim(name, E' \u3000\t\r\n') = ''` 的有 **3 列**：
--     21235165  龍子電影事業股份有限公司（首都戲院）  台北市松山區長安東路2段219號2、3樓   1 廳
--     25116865  國元影業股份有限公司                  台北市中山區長春路176號2F、3F、B2、B3  13 廳
--     54186685  映捌玖數位影城有限公司                台北市武昌街2段89號                   4 廳
--   三列的 `curated_fields` 皆為 `{}`（全庫此時 `cardinality(curated_fields) > 0`
--   的列數是 0，這支是第一次真的用到那個機制）。
--   三列的 `viewing_record` 引用數皆為 0 —— 但 `viewing_record_venue_id_fkey`
--   是 `ON DELETE RESTRICT`，一旦有人選了就再也刪不掉，所以要一次做完。
--
-- ── ⚠️ 這件事必須做兩層，只做一層是這個 repo 的已知失敗模式（同 0014）──
--
--   · **只改這裡（DB）**：三列會變乾淨，但上游沒動 ⇒ 下次
--     `pnpm ingest:cinema` + `pnpm seed` 又流回來（`seed_venues()` 對沒有
--     被 `curated_fields` 標記的欄位是直接蓋）。
--   · **只改上游（src）**：新匯入乾淨，但既有的 3 列一列都不會變 ⇒
--     David 看到的畫面原封不動。
--
--   ⇒ 另一半在 `src/gov/cinema.ts`：`name = govName || companyName`
--     （`SCREENS §6` 早就裁決的 `displayName = name || companyName`，
--     這次是真的實作了）。**改動這支的人請連同上游一起看。**
--
-- ── 三種執行順序，結果不同（都要能講得出來）────────────────────────
--
--   1. 先 `pnpm seed` 後跑 0015 ⇒ 名字改對並上鎖。OK
--   2. 先跑 0015 後 `pnpm seed` ⇒ 21235165 已上鎖不被蓋；另兩列會被上游的
--      公司全銜蓋成同一個值（因為上游 fallback 給的就是那個值）。OK
--   3. **只跑 `pnpm ingest:cinema` + `pnpm seed` 而忘了 0015** ⇒ 三列會變成
--      公司全銜（比現在好，但 21235165 不是「首都戲院」），而且**沒有任何
--      錯誤訊息**。這是這一組改動裡唯一會無聲走錯的路。
--
-- ── 為什麼只有一列進 `curated_fields` ─────────────────────────────────
--
-- `curated_fields` 的語意是「**永久**放棄上游對這個欄位的更新」——
-- `seed_venues()` 的 `case when 'name' = any(curated_fields) then venue.name`
-- 是無條件的。所以只有「我們決定的、跟上游不同」的值才該進去：
--
--   · `21235165 → 首都戲院`：**進**。依據是它自己的 company_name 就寫著
--     「（首都戲院）」，是資料內證。這是人工發明的顯示名，上游沒有。
--   · `25116865`、`54186685`：**不進**。David 還沒給名字，這裡填的是公司
--     全銜，跟 `src/gov/cinema.ts` 的 fallback 會產出的值**一模一樣**。
--     釘住它只會在明年政府補上事業名稱時，把正確資料**無聲**擋掉——
--     那正好是這支 migration 想防的失敗形狀，方向相反。
--     ⇒ 之後 David 給了名字，再開一支 migration 把它們也釘進去。
--
-- ── 執行前提 ────────────────────────────────────────────────────────
--
-- §4 的冒煙測試會呼叫 `public.seed_venues()`，而它第一句是
-- `if not public.is_service_context() then raise exception '僅限服務端'`。
-- 實測 `pnpm db:sql`（DATABASE_URL 直連）是 `session_user = postgres`、
-- `is_service_context() = true`，過得去。**換一個角色跑（CI 用非 postgres
-- 連線、或走 Supabase 以外的通道），整支會在那一句 42501 全部回滾。**
--
-- ⚠️ 不要改成呼叫 `public.admin_correct_venue()`：它第一句是
--    `if not public.is_staff()`，而 migration 連線的 `auth.uid()` 是 null
--    ⇒ 實測 `is_staff() = false`，必然 42501。`curated_fields` 只能自己維護。
--
-- ── 還原 ────────────────────────────────────────────────────────────
-- 還原**不能**用「把名字改回空字串」——§3 的 CHECK 會擋。要還原得先
-- `alter table public.venue drop constraint venue_name_not_blank`，
-- 再把三列的 name 設回 '' 並清掉 curated_fields。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. 人工正名（會進 curated_fields，上游洗不掉）
--
--    ⚠️ 冪等守門**不能**只看 name。只看 name 的話，「名字已經對、但鎖沒上」
--       （例如兩次執行之間插了一次 `pnpm seed`，或第一次只跑了半支）會被
--       整列跳過，保護永遠補不上，而 §5 的斷言全部照樣綠。
--    ⚠️ `corrected_by` 留 null：它 references profile，migration 沒有 actor。
-- -----------------------------------------------------------------------------
update public.venue v
   set name            = x.new_name,
       curated_fields  = (select array(select distinct unnest(v.curated_fields || 'name'::text))),
       correction_note = '政府 CSV 的事業名稱為空，依 company_name 的「（首都戲院）」正名（0015）',
       corrected_at    = now(),
       updated_at      = now()
  from (values
    ('21235165', '首都戲院')
  ) as x (id, new_name)
 where v.id = x.id
   and (v.name is distinct from x.new_name
        or not ('name' = any (v.curated_fields)));

-- -----------------------------------------------------------------------------
-- 2. 保底：退回公司全銜（**不**進 curated_fields，理由見檔頭）
--
--    寫的是**字面值**而不是 `v.company_name`：字面值看得出當初決定了什麼，
--    也讓「上游的 company_name 換了」這件事在下一次 seed 時自然浮出來。
--
--    守門只看「name 是不是空的」：一旦上游哪天真的補上了事業名稱，
--    這支重跑也不會把它蓋回公司全銜。
-- -----------------------------------------------------------------------------
update public.venue v
   set name       = x.new_name,
       updated_at = now()
  from (values
    ('25116865', '國元影業股份有限公司'),
    ('54186685', '映捌玖數位影城有限公司')
  ) as x (id, new_name)
 where v.id = x.id
   and btrim(v.name, E' \u3000\t\r\n') = '';

-- -----------------------------------------------------------------------------
-- 3. 結構上讓空名字長不回來
--
--    這個 repo 的傾向是大聲失敗。全庫沒有任何「使用者新增場所」的寫入路徑
--    （`pg_proc` 裡碰 `insert into public.venue` 的只有 `seed_venues` 與
--    `admin_correct_venue` 兩支），所以唯一會撞上這道 CHECK 的是 seed 管線，
--    而那本來就該吵。上游端另有 `assertNameUsable()` 會先以看得懂的訊息
--    （帶統編與地址）擋下來，不會讓人只看到一個 23514。
--
--    ⚠️ 用 `btrim(name, E' \u3000\t\r\n')` 而不是裸的 `btrim(name)`：
--       裸的只修 ASCII 空白，一個「全形空白當名字」的列會滑過去
--       （實測 `btrim(E'\u3000') = ''` 為 false）。
-- -----------------------------------------------------------------------------
do $$ begin
  alter table public.venue add constraint venue_name_not_blank
    check (btrim(name, E' \u3000\t\r\n') <> '');
exception when duplicate_object then null; end $$;

comment on constraint venue_name_not_blank on public.venue is
  '名字不得為空白。空字串會一路流到「在哪看」的下拉選單，被樣板算繪成只剩城市名（2026-09-07）。上游的保底在 src/gov/cinema.ts 的 name = govName || companyName。';

-- -----------------------------------------------------------------------------
-- 4. 冒煙測試（0005 的教訓：跑完了不代表結果是對的）
--
--    用丟棄用的 id `99999998`，不拿三列真資料當白老鼠。
--    ⚠️ 那個 id 不是隨便挑的：`venue_id_shape` 限定 `^[0-9]{8}$`
--       或 `virtual:%` / `ugc:%`，寫成 `smoke-0015` 會直接 23514。
-- -----------------------------------------------------------------------------
do $$
declare v_name text;
begin
  -- ① 先造一列「已被人接管」的資料
  insert into public.venue (id, kind, name, city, curated_fields)
  values ('99999998', 'cinema', '__smoke__0015原名', '台北市', array['name']);

  -- ② 模擬一次匯入，想把名字蓋掉
  perform public.seed_venues(jsonb_build_array(
    jsonb_build_object('id', '99999998', 'name', '__smoke__0015被覆蓋', 'city', '台北市')));

  -- ③ 斷言 A：curated_fields 含 'name' ⇒ 名字不動
  --    ⚠️ 只比對 name 一欄。同一次呼叫會順手把 raw 設成 null、
  --       company_name / address / phone 清成 ''，整列比對會為了無關的
  --       欄位變動而紅。
  select name into v_name from public.venue where id = '99999998';
  if v_name <> '__smoke__0015原名' then
    raise exception '0015 失敗：curated_fields 沒擋住匯入，名字變成「%」', v_name;
  end if;

  -- ④ 斷言 B（對照組，**不能省**）：把鎖拿掉，同一個呼叫必須改得動。
  --    沒有這條的話，`seed_venues` 整個壞掉（例如 payload 的 key 拼錯、
  --    根本沒更新到那一列）時，③ 也會綠。
  update public.venue set curated_fields = '{}' where id = '99999998';
  perform public.seed_venues(jsonb_build_array(
    jsonb_build_object('id', '99999998', 'name', '__smoke__0015被覆蓋', 'city', '台北市')));

  select name into v_name from public.venue where id = '99999998';
  if v_name <> '__smoke__0015被覆蓋' then
    raise exception '0015 失敗：對照組沒過——沒有鎖的時候名字竟然也沒被改（現在是「%」），③ 的綠燈不算數', v_name;
  end if;

  -- ⑤ §3 的 CHECK 真的擋得住空名字。
  --    自己開一個有 EXCEPTION 的子區塊 ⇒ 隱含 savepoint，測試資料自己回滾。
  --    ⚠️ 只捕捉 check_violation：因為別的理由失敗就讓它往外炸，
  --       不要用一個「碰巧通過」的測試騙自己。
  begin
    update public.venue set name = '' where id = '99999998';
    raise exception '0015 失敗：name = '''' 竟然寫得進去（venue_name_not_blank 不見了）';
  exception when check_violation then
    raise notice '0015：venue_name_not_blank 擋住了空字串';
  end;

  -- ⑥ 連全形空白也要擋（裸的 btrim() 抓不到，這條就是在守那個差別）
  begin
    update public.venue set name = E'\u3000' where id = '99999998';
    raise exception '0015 失敗：name = 全形空白 竟然寫得進去（btrim 的字元集寫窄了）';
  exception when check_violation then
    raise notice '0015：venue_name_not_blank 也擋住了全形空白';
  end;

  delete from public.venue where id = '99999998';
  raise notice '0015 冒煙測試通過';
end $$;

-- -----------------------------------------------------------------------------
-- 5. 本體斷言
-- -----------------------------------------------------------------------------
do $$
declare
  n_blank integer; n_total integer; n_opt3 integer;
  v_name text; v_curated text[];
begin
  -- ① 全庫不得再有空白名字
  select count(*) into n_blank from public.venue
   where btrim(name, E' \u3000\t\r\n') = '';
  if n_blank <> 0 then
    raise exception '0015 失敗：仍有 % 列的 name 是空白', n_blank;
  end if;

  -- ② 對照組：證明①分辨得出東西，而不是因為表被清空才通過
  select count(*) into n_total from public.venue;
  if n_total < 114 then
    raise exception '0015 失敗：venue 只剩 % 列（基準 114），①的綠燈不算數', n_total;
  end if;

  -- ③ 人工正名真的寫進去了，而且**鎖上了**
  select name, curated_fields into v_name, v_curated
    from public.venue where id = '21235165';
  if v_name <> '首都戲院' then
    raise exception '0015 失敗：21235165 的名字是「%」，不是「首都戲院」', v_name;
  end if;
  if not ('name' = any (v_curated)) then
    raise exception '0015 失敗：21235165 的 curated_fields 沒有 name ⇒ 下次 seed 會把正名無聲洗掉';
  end if;

  -- ④ 保底那兩列有名字，而且**沒有**被鎖住（鎖住才是錯的，理由見檔頭）
  select name, curated_fields into v_name, v_curated
    from public.venue where id = '25116865';
  if v_name <> '國元影業股份有限公司' then
    raise exception '0015 失敗：25116865 的名字是「%」', v_name;
  end if;
  if 'name' = any (v_curated) then
    raise exception '0015 失敗：25116865 不該進 curated_fields（那是公司全銜保底，不是人工正名）';
  end if;

  select name, curated_fields into v_name, v_curated
    from public.venue where id = '54186685';
  if v_name <> '映捌玖數位影城有限公司' then
    raise exception '0015 失敗：54186685 的名字是「%」', v_name;
  end if;
  if 'name' = any (v_curated) then
    raise exception '0015 失敗：54186685 不該進 curated_fields（那是公司全銜保底，不是人工正名）';
  end if;

  -- ⑤ 三列**仍然在選單裡**。
  --    這條擋的是「有人圖快把它們 selectable=false 或 merge 掉」——那個做法
  --    會讓①②③④全部變綠，而它正是 `0002` 檔頭明文禁止的事
  --    （selectable 的語意被鎖定成「歷史用：已歇業、海外」）。
  select count(*) into n_opt3 from public.venue_option
   where id in ('21235165', '25116865', '54186685');
  if n_opt3 <> 3 then
    raise exception '0015 失敗：venue_option 裡只剩 % 列（應為 3）——這三家沒有歇業也沒有重複登記，不該從選單消失', n_opt3;
  end if;

  raise notice '0015：venue % 列、空白名字 0 列、21235165 已鎖、另兩列以公司全銜保底', n_total;
end $$;
