-- =============================================================================
-- 0003 — 年度統計 RPC（Step 6、US-34～43）
--
-- ★ SECURITY INVOKER，不可改成 DEFINER。
--
-- 聚合是推論通道（踩雷 #42）。DEFINER 會讓函式以擁有者身分讀表，RLS 整個
-- 讓開——此時一個寫錯的 WHERE 不會回 403，而是安靜地把全站資料算進總計倒
-- 給呼叫者。INVOKER 則讓 RLS 逐列把關：呼叫者看不到的紀錄本來就進不了聚合，
-- 正確性不必倚賴這支函式的 WHERE 寫對。
--
-- 這個選擇有代價：票價要看 viewing_record_cost 的 RLS 臉色，所以總花費對不同
-- 觀看者會是不同的數字。那不是 bug，是規格——但**前端必須知道自己拿到的是不
-- 是全部**，否則會把「只算得到一半」顯示成「這就是全部」。故回傳
-- `totals.spend_is_partial`。
--
-- 時區：schema 刻意用 watched_on date + watched_time time 存台北牆上時間
-- （0001 §8）。所以「星期幾」「幾點」直接從這兩欄取，**不做 at time zone**——
-- 那會把已經正確的牆上時間再轉一次，得到偏移 8 小時的熱力圖。
--
-- 可重複執行。
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 全期視角（p_year = null）—— David 要的「不分年份的全部統計」
--
-- ★ 這支**本來就支援**：p_year 有 `default null`，而 rec CTE 的條件是
--   `p_year is null or extract(year …) = p_year`。實測 user_year_stats('clipwww', null)
--   回的就是全期：174 筆／133 部／250 張／13 個年份／全期多刷 19 部。
--   所以不需要另開一支「all_time」函式——**多一支就是多一份會漂移的定義**。
--
-- 全期尺度下有兩件事語意會變，2026-09-06 補上：
--   ① `by_year`：全期貢獻圖要餵的東西。日層級在全期尺度畫不出來（96% 空格）。
--   ② `monthly` vs `monthly_series`：見下方註解。原本只有前者，等於已經替
--      David 選了「季節性」那一種而沒有人講出來。
--
-- ── 效能的形狀（母體 174 筆，量不出東西，所以講清楚假設）──────────────────
-- 所有聚合都從**同一個 `rec` CTE** 出發，而 rec 是一次
-- `viewing_record ⋈ target` 的掃描（走 `viewing_record (user_id)` 的索引）。
-- 十一組聚合各自對 rec 做一次 group by，**不會各自回去掃 viewing_record**。
-- ⇒ 成本是 O(該使用者的紀錄數)，與年份數、與全站紀錄數無關。
-- 一萬筆時 rec 是一萬列，十一次 in-memory group by——那個量級不需要優化。
-- ⚠️ 會爆掉的寫法是「每一組聚合各自 join 回 viewing_record」，那會變成
--    十一次索引掃描。改動這支時請維持「單一 rec、多次 group by」的形狀。
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.user_year_stats(
  p_username text,
  p_year integer default null      -- null = 不分年度，涵蓋全部
)
returns jsonb
language sql
stable
security invoker                   -- ★ 見檔頭。改成 definer 會讓 RLS 失效。
set search_path = ''
as $$
with target as (
  select p.id
    from public.profile p
   where p.username = public.resolve_username(p_username)
),
-- RLS 在這裡生效：呼叫者看不到的紀錄不會出現，後面所有聚合自動正確。
rec as (
  select r.id, r.film_id, r.venue_id, r.watched_on, r.watched_time,
         coalesce(r.ticket_count, 1) as ticket_count,
         r.format_code,
         c.amount as cost
    from public.viewing_record r
    join target t on t.id = r.user_id
    -- left join：票價被 RLS 擋掉時保留紀錄本身，只是 cost 為 NULL。
    -- inner join 會讓「沒公開票價」連場次都消失，統計直接失真。
    left join public.viewing_record_cost c on c.record_id = r.id
   where p_year is null or extract(year from r.watched_on)::integer = p_year
),
-- 年份清單不受 p_year 影響——前端要用它畫年度切換器（US-42）。
years as (
  select distinct extract(year from r.watched_on)::integer as y
    from public.viewing_record r join target t on t.id = r.user_id
),
totals as (
  select count(*)::integer                                      as records,
         count(distinct film_id)::integer                       as films,
         coalesce(sum(ticket_count), 0)::integer                 as tickets,
         coalesce(sum(cost), 0)::numeric(12, 2)                  as spend,
         count(cost)::integer                                    as spend_known_records,
         (count(*) - count(cost))::integer                       as spend_unknown_records,
         count(*) filter (where watched_time is null)::integer   as records_without_time
    from rec
)
select case when not exists (select 1 from target) then null else jsonb_build_object(
  'username', public.resolve_username(p_username),
  'year', p_year,
  'is_own', exists (select 1 from target t where t.id = (select auth.uid())),
  'available_years', coalesce((select jsonb_agg(y order by y desc) from years), '[]'::jsonb),

  'totals', (select jsonb_build_object(
      'records', t.records,
      'films', t.films,
      'tickets', t.tickets,
      'spend', t.spend,
      'spend_currency', 'TWD',
      -- ★ 前端據此決定要顯示總額還是「部分票價未公開」
      'spend_is_partial', t.spend_unknown_records > 0,
      'spend_known_records', t.spend_known_records,
      'spend_unknown_records', t.spend_unknown_records,
      'records_without_time', t.records_without_time
    ) from totals t),

  -- 貢獻圖（US-34）。ECharts calendar 吃 [date, value]，這裡給具名欄位，
  -- 前端自行 map，避免把圖表函式庫的資料格式綁進 API 契約。
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object(
             'date', to_char(watched_on, 'YYYY-MM-DD'),
             'records', n, 'tickets', tk) order by watched_on)
      from (select watched_on, count(*)::integer n, sum(ticket_count)::integer tk
              from rec group by watched_on) d), '[]'::jsonb),

  -- 星期 × 時段熱力圖（US-35）。weekday 用 ISO：1=週一 … 7=週日。
  -- watched_time 為 NULL 的舊資料進不了這張圖，其筆數見 totals.records_without_time。
  'weekday_hour', coalesce((
    select jsonb_agg(jsonb_build_object(
             'weekday', wd, 'hour', hr, 'records', n) order by wd, hr)
      from (select extract(isodow from watched_on)::integer wd,
                   extract(hour from watched_time)::integer hr,
                   count(*)::integer n
              from rec where watched_time is not null
             group by 1, 2) w), '[]'::jsonb),

  -- 月度趨勢（US-36）
  'monthly', coalesce((
    select jsonb_agg(jsonb_build_object(
             'month', m, 'records', n, 'tickets', tk,
             'spend', sp, 'spend_is_partial', unknown > 0) order by m)
      from (select extract(month from watched_on)::integer m,
                   count(*)::integer n, sum(ticket_count)::integer tk,
                   coalesce(sum(cost), 0)::numeric(12, 2) sp,
                   (count(*) - count(cost))::integer unknown
              from rec group by 1) mo), '[]'::jsonb),

  -- 影城分布（US-37）
  'venues', coalesce((
    select jsonb_agg(jsonb_build_object(
             'venue_id', venue_id, 'name', name, 'city', city,
             'kind', kind, 'records', n) order by n desc, name)
      from (select r.venue_id, v.name, v.city, v.kind::text as kind, count(*)::integer n
              from rec r left join public.venue v on v.id = r.venue_id
             group by 1, 2, 3, 4) vv), '[]'::jsonb),

  -- 國別分布。film 讀不到時（他人的私密 UGC 作品）歸為空字串，前端顯示「未分類」。
  'countries', coalesce((
    select jsonb_agg(jsonb_build_object('country', country, 'records', n)
                     order by n desc, country)
      from (select coalesce(f.country, '') as country, count(*)::integer n
              from rec r left join public.film f on f.id = r.film_id
             group by 1) cc), '[]'::jsonb),

  -- 版本分布
  'formats', coalesce((
    select jsonb_agg(jsonb_build_object(
             'code', code, 'label', label, 'records', n) order by n desc, code)
      from (select coalesce(r.format_code, 'other') as code,
                   coalesce(max(s.label), '其他') as label,
                   count(*)::integer n
              from rec r
              left join public.screening_format s on s.code = r.format_code
             group by 1) ff), '[]'::jsonb),

  -- ── 全期視角專用（p_year is null 時才有內容）─────────────────────────
  --
  -- ★ 為什麼按年而不是按日：全期跨 2014–2026 十三年，日層級在單一年份就已經
  --   96% 是空的（design 實測，那是它把貢獻圖改成「週」解析度的理由）。
  --   `daily` 仍然照給——它的長度由**相異日期數**決定（實測 174 筆 → 165 筆），
  --   不會隨年份數膨脹，所以留著讓前端自己選解析度是划算的。
  --   但全期尺度下真正畫得出東西的是這一組。
  --
  -- ⚠️ p_year 不是 null 時這一欄是空陣列，不是缺鍵。前端不必分兩種形狀處理。
  'by_year', case when p_year is not null then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
             'year', y, 'records', n, 'films', fc, 'tickets', tk,
             'spend', sp,
             -- ★ 逐年各自帶旗標。全期的 spend_is_partial 會把十三年混在一起
             --   （只要有任何一年有未公開票價就是 true），那個 true 對前端沒有用；
             --   要標示「這一年的總額不完整」只能逐年判斷。
             'spend_is_partial', unknown > 0) order by y desc)
      from (select extract(year from watched_on)::integer y,
                   count(*)::integer n, count(distinct film_id)::integer fc,
                   sum(ticket_count)::integer tk,
                   coalesce(sum(cost), 0)::numeric(12, 2) sp,
                   (count(*) - count(cost))::integer unknown
              from rec group by 1) yy), '[]'::jsonb) end,

  -- ★ 月度有兩種完全不同的意思，全期尺度下必須分開給（見 0013 的說明）：
  --   · monthly        —— 十三年的「同月份」加總，12 格。回答「我幾月比較常看片」。
  --   · monthly_series —— 156 個月的時間序列。回答「我這些年看片量的走勢」。
  --   p_year 給了年份時兩者等價（都是那一年的 12 個月），此時 series 為空陣列。
  'monthly_series', case when p_year is not null then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
             'month', m, 'records', n, 'tickets', tk,
             'spend', sp, 'spend_is_partial', unknown > 0) order by m)
      from (select to_char(watched_on, 'YYYY-MM') as m,
                   count(*)::integer n, sum(ticket_count)::integer tk,
                   coalesce(sum(cost), 0)::numeric(12, 2) sp,
                   (count(*) - count(cost))::integer unknown
              from rec group by 1) ms), '[]'::jsonb) end,

  -- 多刷排行（US-41）。只列同一年內看過兩次以上的。
  'repeats', coalesce((
    select jsonb_agg(jsonb_build_object(
             'film_id', film_id, 'title_zh', title_zh, 'slug', slug,
             'poster_path', poster_path, 'records', n) order by n desc, title_zh)
      from (select r.film_id, f.title_zh, f.slug, s.poster_path, count(*)::integer n
              from rec r
              left join public.film f on f.id = r.film_id
              left join public.film_tmdb_snapshot s on s.film_id = r.film_id
             group by 1, 2, 3, 4
            having count(*) > 1) rr), '[]'::jsonb)
) end
$$;

comment on function public.user_year_stats(text, integer) is
  '年度觀影統計。SECURITY INVOKER——聚合結果一律受呼叫者的 RLS 限制，'
  '故 totals.spend 只涵蓋呼叫者看得到的票價，是否完整見 totals.spend_is_partial。'
  '星期與時段直接取自 watched_on / watched_time，不做時區轉換。'
  'p_year 為 null 時涵蓋全部年度。查無此使用者（或帳號不可服務）回傳 NULL。';
