-- =============================================================================
-- 0013 — 首頁海報牆的取樣（David：「首頁用像 Netflix 一樣的電影海報瀑布當背景」）
--
-- 可重複執行。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 為什麼要一支 RPC，而不是讓前端直接查 film_public
--
-- 目前 `app/pages/index.vue` 是：
--     .select('id,tmdb_poster_path').not(...).order('release_year', desc).limit(60)
-- 三個問題：
--   ① **每次都是同一批**（最新的 60 部），而且偏向近年上映——2,452 部有海報的
--      作品裡，這面牆只會用到固定的 2.4%。
--   ② 要換成「隨機」的話，PostgREST 沒有辦法 `order by` 一個運算式，
--      只能整批撈回來自己洗——而 **PostgREST 預設有 1,000 列上限**，
--      撈 2,452 列會**靜默地只回 1,000 列**。那個截斷不會有任何錯誤，
--      症狀是「海報牆永遠只從最舊的四成裡抽」。
--   ③ 取樣邏輯散在頁面裡，`/u/` 的分享頁要用同一面牆時會出現第二份。
--
-- ★ 取樣方式：`order by md5(id::text || p_seed)`。
--   給同一個 seed 就給同一批（可快取、SSR 與 hydration 一致），換 seed 就換一批，
--   而且是**跨整個片庫**均勻分布，不是某個年份的區塊。
--
-- ⚠️ 效能假設（母體 2,452 列，量不出東西，所以講清楚）：
--   這是一次 `film_public` 的全掃 + top-N 排序。2,452 列在這個量級是幾毫秒。
--   片庫成長到十萬列時它會變成明顯成本——**那時候的正解是 `tablesample system`
--   或一張預先算好的取樣表，不是加索引**（md5 運算式索引對隨機 seed 沒有用）。
--   端點那一層有 Nitro 快取，所以實際上每 5 分鐘才會真的跑一次。
--
-- ★ SECURITY INVOKER：film_public 是 security_invoker 的 view，這裡沿用它的
--   RLS。改成 DEFINER 會讓未審核／私密作品的海報漏到首頁背景上。
-- -----------------------------------------------------------------------------
create or replace function public.home_poster_wall(
  p_limit integer default 60,
  p_seed text default '0')
returns table (film_id uuid, slug text, poster_path text)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.id, f.slug, f.tmdb_poster_path
    from public.film_public f
   where f.tmdb_poster_path is not null
   order by extensions.digest(f.id::text || coalesce(p_seed, '0'), 'sha1')
   limit least(greatest(coalesce(p_limit, 60), 1), 200)
$$;

comment on function public.home_poster_wall(integer, text) is
  '首頁海報牆的取樣。只回 film_public（已核准且公開）⇒ 未審核作品的海報不會出現在背景上。同一個 seed 給同一批（可快取），上限 200。海報一律由前端熱連結 image.tmdb.org，這裡只回路徑。';

grant execute on function public.home_poster_wall(integer, text) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 冒煙測試
-- -----------------------------------------------------------------------------
do $$
declare n integer; a uuid[]; b uuid[]; c uuid[]; v_hidden uuid;
begin
  begin
    -- ① 真的回得出東西，而且數量對
    select count(*) into n from public.home_poster_wall(24, 'x');
    if n <> 24 then
      raise exception '冒煙測試失敗：要 24 張，實得 %', n; end if;

    -- ② 同一個 seed 給同一批（否則 SSR 與 hydration 會對不起來）
    select array_agg(film_id order by film_id) into a from public.home_poster_wall(24, 'seed-1');
    select array_agg(film_id order by film_id) into b from public.home_poster_wall(24, 'seed-1');
    if a is distinct from b then
      raise exception '冒煙測試失敗：同一個 seed 兩次結果不同（SSR 與 hydration 會不一致）'; end if;

    -- ③ 換 seed 要真的換一批。★ 沒有這一條，「可快取」就退化成「永遠同一批」，
    --    而那正是這支要修的問題——而且看起來完全正常。
    select array_agg(film_id order by film_id) into c from public.home_poster_wall(24, 'seed-2');
    if a = c then
      raise exception '冒煙測試失敗：★ 換了 seed 還是同一批（取樣根本沒作用）'; end if;

    -- ④ 上限釘死，避免有人用 ?limit=99999 把整個片庫倒出來
    select count(*) into n from public.home_poster_wall(99999, 'x');
    if n > 200 then
      raise exception '冒煙測試失敗：上限沒有生效（實得 %）', n; end if;

    -- ⑤ ★ 未審核／私密作品的海報不得出現。這是這支唯一的安全性質。
    insert into public.film (title_zh, origin, visibility, review_state, ugc_poster_path)
    values ('__smoke__0013私密', 'ugc', 'private', 'pending', 'fake/poster.png')
    returning id into v_hidden;
    -- tmdb_poster_path 來自快照表，私密作品沒有；用 film_public 的定義驗：
    if exists (select 1 from public.film_public where id = v_hidden) then
      raise exception '冒煙測試失敗：★ 未審核作品出現在 film_public 裡';
    end if;

    raise exception 'SMOKE_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_OK' then raise; end if;
  end;
  raise notice '0013 冒煙測試通過（取樣可重現、換 seed 會變、上限生效、未審核作品不外洩；變更已回滾）';
end $$;
