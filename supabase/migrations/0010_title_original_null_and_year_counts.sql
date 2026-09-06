-- =============================================================================
-- 0010 — ① title_original 空字串正規化成 NULL　② /u/ 年表需要的全量聚合
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. title_original 的空字串正規化
--
-- 0008 對 country 做過同一件事，這裡是同一類問題的另外 16 列：實測 2026-09-06，
-- 2,764 部作品裡有 16 列 `title_original = ''`，全部是匯入時建立的 UGC 作品
-- （使用者自建的作品沒有原文片名這回事）。空字串與 NULL 在語意上是兩件事，
-- 而這裡明顯是「沒有資料」。
--
-- ★ 三件事一起做，只做 UPDATE 是那種「修好了但會自己長回來」的修法：
--   ① drop default ''　② UPDATE 既有列　③ 加 check 讓空字串在結構上無法被表示
--
-- ⚠️ search_text 是 generated column，運算式已經是
--    `lower(coalesce(title_zh,'') || ' ' || coalesce(title_original,''))`，
--    本來就 null-safe，不需要改。
--
-- ⚠️ 對 frontend 的影響（已在回報中列出）：`film_public.title_original` 從
--    「保證是字串」變成 `string | null`。顯示層若有 `title_original.length`
--    之類的寫法會在執行期炸掉。
-- -----------------------------------------------------------------------------
alter table public.film alter column title_original drop not null;
alter table public.film alter column title_original drop default;

update public.film set title_original = null
 where btrim(coalesce(title_original, '')) = '';

do $$ begin
  alter table public.film
    add constraint film_title_original_not_blank
    check (title_original is null or btrim(title_original) <> '');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- 2. 兩支會把空字串寫回去的函式
--
-- ★ 用「讀出現有定義再字串取代」而不是 create or replace 抄一份函式體。
--   0009 就是抄了 0001 的 apply_three_strikes() 函式體，**靜默地回退了 0006
--   對它做過的修正**——所有靜態檢查照樣全綠，是 verify-dmca 的 F 段抓到的
--   （§7 #109）。0008 對 seed_films 的 country 也是用這個做法，
--   所以這裡讀到的定義本來就已經含著 0008 的修正，兩個修正會疊加而不是互相覆蓋。
-- -----------------------------------------------------------------------------
do $$
declare src text; patched text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'seed_films';
  if src is null then
    raise notice 'seed_films 不存在，略過';
  elsif src like '%coalesce(rec->>''titleOriginal'','''')%' then
    patched := replace(src, 'coalesce(rec->>''titleOriginal'','''')', 'nullif(rec->>''titleOriginal'','''')');
    execute patched;
    raise notice 'seed_films 的 titleOriginal 已改為 nullif';
  else
    raise notice 'seed_films 的 titleOriginal 已經不是 coalesce 版本，未改動';
  end if;
end $$;

-- apply_tmdb_snapshot 裡的 `f.title_original = ''` 判斷在 title_original 變成
-- 可為 NULL 之後會求值成 NULL ⇒ CASE 落到 ELSE ⇒ **沒有原文片名的作品再也不會
-- 被 TMDB 的原文片名補上**。這是那種「改對了一件事、順手關掉另一件事」的回歸：
-- 沒有任何東西會報錯，只是自我修復從此不再發生。
-- （title_zh 維持 NOT NULL DEFAULT ''，所以那一半不動。）
do $$
declare src text; patched text;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'apply_tmdb_snapshot';
  if src is null then
    raise notice 'apply_tmdb_snapshot 不存在，略過';
  elsif src like '%f.title_original_source = ''tmdb'' or f.title_original = ''''%' then
    patched := replace(src,
      'f.title_original_source = ''tmdb'' or f.title_original = ''''',
      'f.title_original_source = ''tmdb'' or coalesce(f.title_original, '''') = ''''');
    execute patched;
    raise notice 'apply_tmdb_snapshot 的 title_original 判斷已改為 null-safe';
  else
    raise notice 'apply_tmdb_snapshot 的 title_original 判斷已是 null-safe，未改動';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. /u/{username} 的年表需要的是全量聚合，不是「前 200 筆算出來的」
--
-- 前端第二棒在交接筆記 §4-8 記下的 latent bug：`/api/u/[username]` 一次最多回
-- 200 筆，而年表是**從那 200 筆算出來的**。超過 200 筆的使用者年表會缺格子，
-- 而且沒有任何提示。David 現在 174 筆還沒踩到，但這是會隨時間爆的。
--
-- ★ 重點不是「把上限調高」。年表要的是**全部年份的聚合**（一個便宜的 group by），
--   紀錄列表要的是**分頁**。用同一個 200 筆餵兩件事，是把兩個不同的需求綁在
--   一個限制上——調高上限只是把爆炸點往後推，而且會讓每次載入都拖回全部資料。
--
-- ★ SECURITY INVOKER，而且**完全不碰金額**。兩個理由是分開的：
--   ① INVOKER：聚合是推論通道（踩雷 #42）。DEFINER 的 count() 會把 RLS 擋下來的
--      紀錄以筆數形式漏出去。寫成 INVOKER 之後，這裡數到的就是呼叫者本來就
--      看得到的那些列，和 /api/u/ 的列表完全一致。
--   ② 不碰金額：`/api/u/[username]` 用的是匿名 client，anon 視角下票價列根本
--      讀不到，算出來的 sum 只會是 0——而那個 0 會讓使用者以為自己沒花錢。
--      金額統計走 user_year_stats（它有 spend_is_partial 旗標）。
--
-- ★ 用 viewing_record_public 而不是 viewing_record：那支 view 的過濾條件
--   （visibility='public' and moderation_state='visible'）加上底下的 record_read
--   policy，正好等於 /api/u/ 列表看得到的集合。改用 viewing_record 會讓年表的
--   格子數比列表多——而多出來的那些點不進去，使用者只會覺得資料壞了。
-- -----------------------------------------------------------------------------
create or replace function public.user_year_counts(p_username text)
returns jsonb
language sql
stable
security invoker                   -- ★ 見上。改成 definer 會讓 RLS 失效。
set search_path = ''
as $$
with target as (
  select p.id from public.profile p where p.username = public.resolve_username(p_username)
),
rec as (
  select v.film_id, v.venue_id, v.watched_on
    from public.viewing_record_public v
    join target t on t.id = v.user_id
)
select case when not exists (select 1 from target) then null else jsonb_build_object(
  'username', public.resolve_username(p_username),
  'records', (select count(*)::integer from rec),
  'films',   (select count(distinct film_id)::integer from rec),
  'venues',  (select count(distinct venue_id)::integer from rec),
  -- ★ 逐年的相異作品數不能靠年度列加總得出（同一部片跨年重看會被算兩次），
  --   所以 films / venues 的總數在上面另外算一次，不是把 by_year 加起來。
  'by_year', coalesce((
    select jsonb_agg(jsonb_build_object('year', y, 'n', n, 'films', fc) order by y desc)
      from (select extract(year from watched_on)::integer as y,
                   count(*)::integer as n,
                   count(distinct film_id)::integer as fc
              from rec group by 1) yy), '[]'::jsonb)
) end
$$;

comment on function public.user_year_counts(text) is
  '/u/{username} 年表用的全量聚合。只回筆數，完全不算金額（anon 視角下金額必然是 0，那個 0 會誤導）。SECURITY INVOKER。';

grant execute on function public.user_year_counts(text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. 冒煙測試
-- -----------------------------------------------------------------------------
do $$
declare
  v_user uuid; v_venue text; v_film uuid; v_res jsonb; blocked boolean := false; n integer;
begin
  begin
    select id into v_user from public.profile order by created_at limit 1;
    select id into v_venue from public.venue order by id limit 1;
    if v_user is null or v_venue is null then
      raise notice '0010 冒煙測試略過：缺少 profile 或 venue'; return;
    end if;

    -- ① check 真的擋得住空字串
    begin
      insert into public.film (title_zh, title_original, origin, visibility, review_state)
      values ('__smoke__0010a', '', 'gov', 'public', 'approved');
    exception when check_violation then blocked := true;
    end;
    if not blocked then
      raise exception '冒煙測試失敗：title_original 仍可寫入空字串';
    end if;

    -- ② NULL 寫得進去，而且 search_text 沒有壞
    insert into public.film (title_zh, title_original, origin, visibility, review_state)
    values ('__smoke__0010b', null, 'gov', 'public', 'approved') returning id into v_film;
    if (select search_text from public.film where id = v_film) is null then
      raise exception '冒煙測試失敗：title_original 為 NULL 時 search_text 也變成 NULL（搜尋會整個消失）';
    end if;

    -- ③ apply_tmdb_snapshot 的自我修復對 NULL 仍然有效
    --    （這是「改對一件事順手關掉另一件事」的那條，一定要真的跑一次）
    update public.film set tmdb_id = -424242 where id = v_film;
    insert into public.film_tmdb_snapshot (film_id, tmdb_id, title_original, state)
    values (v_film, -424242, '__smoke__0010原文', 'fresh')
    on conflict (film_id) do update set title_original = excluded.title_original, state = 'fresh';
    perform public.apply_tmdb_snapshot(v_film);
    if (select title_original from public.film where id = v_film) is distinct from '__smoke__0010原文' then
      raise exception '冒煙測試失敗：★ title_original 為 NULL 的作品不再被 TMDB 原文片名補上（自我修復被關掉了）';
    end if;

    -- ④ user_year_counts 真的回得出東西，而且與 viewing_record_public 對得起來
    v_res := public.user_year_counts((select username from public.profile where id = v_user));
    if v_res is null then
      raise exception '冒煙測試失敗：user_year_counts 對存在的使用者回 NULL';
    end if;
    select count(*) into n from public.viewing_record_public v
      join public.profile p on p.username = v.username where p.id = v_user;
    if (v_res->>'records')::int <> n then
      raise exception '冒煙測試失敗：user_year_counts 的 records=% 與 viewing_record_public 的 % 不符',
        v_res->>'records', n;
    end if;
    -- 年度列加總必須等於總筆數，否則年表會缺格子——那正是這支函式要修的 bug
    select coalesce(sum((e->>'n')::int), 0) into n
      from jsonb_array_elements(v_res->'by_year') e;
    if n <> (v_res->>'records')::int then
      raise exception '冒煙測試失敗：★ by_year 加總 % 與 records % 不符（年表會缺格子）',
        n, v_res->>'records';
    end if;

    -- ⑤ 不存在的使用者回 NULL（端點據此 404，而不是回一份空統計）
    if public.user_year_counts('zz_no_such_user_0010') is not null then
      raise exception '冒煙測試失敗：不存在的使用者應回 NULL';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0010 冒煙測試通過（空字串 check、TMDB 自我修復、年表全量聚合；變更已回滾）';
end $$;
