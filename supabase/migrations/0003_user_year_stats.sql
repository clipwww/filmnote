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
--   ② `monthly` 在全期時是**季節性**（12 個月份桶，跨年度加總）——主 session
--      2026-09-06 裁決，`/app` 與 `/u/` 一致。同一個名字的圖在兩頁有兩種語意，
--      使用者切過去會以為資料錯了。
--   ③ `monthly_baseline`：設計稿的「歷年每月平均」虛線。**不受 p_year 影響**，
--      所以單一年份的基準線與全期的季節性序列是同一組數字。
--
-- ── 效能的形狀（母體 174 筆，量不出東西，所以講清楚假設）──────────────────
-- 所有聚合都從**同一個 `rec` CTE** 出發，而 rec 是一次
-- `viewing_record ⋈ target` 的掃描（走 `viewing_record (user_id)` 的索引）。
-- 十一組聚合各自對 rec 做一次 group by，**不會各自回去掃 viewing_record**。
-- ⇒ 成本是 O(該使用者的紀錄數)，與年份數、與全站紀錄數無關。
-- 一萬筆時 rec 是一萬列，十一次 in-memory group by——那個量級不需要優化。
--
-- **實測 2026-09-06**（母體 174 筆、片庫 2,764 部）：
--   `explain (analyze, buffers)` → Execution Time **9.96 ms**、shared hit **2,334**。
--   `public.viewing_record` 在整支函式裡**只出現一次**（rec_all），所以那 2,334 個
--   buffer 主要來自 countries / venues / repeats 對 film 的 join，
--   而那是**片庫大小**的函數、不是使用者紀錄數的函數 ⇒ 使用者長到一萬筆時
--   這個數字不會跟著長十倍。前一棒寫的「效能從未量測」這一條可以劃掉了。
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
--
-- ★ 這裡刻意分成 rec_all / rec 兩層，而不是把 p_year 寫進 where：
--   「歷年每月平均」那條基準線**必須跨全部年份**算，即使呼叫端指定了年份
--   （設計稿 `mockups/dashboard.html` 的圖說是「整年 N 場，比歷年平均的 X 場
--   多／少」）。分成兩層之後，全期序列與單一年份的基準線**用的是同一組數字**，
--   而不是兩套會漂移的計算——兩套一定會在某次修改後給出不一致的值，
--   而那種不一致沒有人會發現，因為沒有人會把兩頁的數字擺在一起看。
--   `viewing_record` 仍然只掃一次。
rec_all as (
  select r.id, r.film_id, r.venue_id, r.watched_on, r.watched_time,
         coalesce(r.ticket_count, 1) as ticket_count,
         r.format_code,
         c.amount as cost
    from public.viewing_record r
    join target t on t.id = r.user_id
    -- left join：票價被 RLS 擋掉時保留紀錄本身，只是 cost 為 NULL。
    -- inner join 會讓「沒公開票價」連場次都消失，統計直接失真。
    left join public.viewing_record_cost c on c.record_id = r.id
),
rec as (
  select * from rec_all
   where p_year is null or extract(year from watched_on)::integer = p_year
),
-- 年份清單不受 p_year 影響——前端要用它畫年度切換器（US-42）。
years as (
  select distinct extract(year from watched_on)::integer as y from rec_all
),
-- ── 「歷年每月平均」的分母 ───────────────────────────────────────────────
--
-- ⚠️ **平均線是「每月平均」不是「總數除以 12」，而分母也不是「有資料的年份數」。**
--
--   David 的資料是 2014-03-01 起。用 13（有資料的年份數）當分母的話：
--     · 一月被除了 13 次，但 2014 年一月**在他開始記錄之前**，那一格從來沒有
--       機會發生 ⇒ 一月的平均被系統性低估。
--     · 八月同理：2026 年八月在資料範圍之外（最後一筆是 2026-07-26）。
--
--   所以分母用**曝光數**：從第一筆紀錄那個月到現在，這個月份實際經歷過幾次。
--   實測 David：三月 13 次、一月 12 次（2014-01 在起點之前）、八月 13 次
--   （2014-08 到 2026-08 都已經過了）。
--
--   窗口的結尾用 `greatest(最後一筆, 今天)`：使用者停止記錄之後經過的月份
--   是**真的去了 0 次**，那是資訊，不該從分母裡拿掉。
--   （反過來說，用「有那個月份紀錄的年份數」當分母會得到「有去的時候平均去幾次」
--   ——那個數字永遠 ≥ 1，看起來像每個月都有去，是三個選項裡最會騙人的一個。）
span as (
  select date_trunc('month', min(watched_on))::date as m0,
         greatest(date_trunc('month', max(watched_on))::date,
                  date_trunc('month', current_date)::date) as m1
    from rec_all
),
exposure as (
  select extract(month from g)::integer as m, count(*)::integer as years_observed
    from span, generate_series(span.m0, span.m1, interval '1 month') g
   group by 1
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

  -- ── 月度：季節性（12 個月份桶，跨年度加總）─────────────────────────
  --
  -- ★ 主 session 2026-09-06 裁決：全期的「每個月」＝季節性，`/app` 與 `/u/` 一致。
  --   走勢已經由年表（band 1）在說，而 156 個點在 375px 上讀不出來；
  --   季節性回答的是年表與熱點圖都碰不到的一個維度——「我夏天看比較多嗎」。
  --   ⇒ 上面的 `monthly` 在 p_year is null 時**就是**那個季節性序列
  --     （group by 月份，rec 已經涵蓋全部年份），不需要另一個欄位。
  --
  -- `monthly_baseline` 是設計稿裡那條虛線「歷年每月平均」。
  -- ★ 它**不受 p_year 影響**（來自 rec_all）：單一年份時它是對照基準，
  --   全期時它與 monthly 的形狀一致而數值是平均——同一組數字的兩種用途。
  'monthly_baseline', coalesce((
    select jsonb_agg(jsonb_build_object(
             'month', e.m,
             -- 分母：這個月份實際經歷過幾次（見上方 exposure 的推理）
             'years_observed', e.years_observed,
             'records', coalesce(a.n, 0),
             'avg_records', round(coalesce(a.n, 0)::numeric / e.years_observed, 2),
             'avg_tickets', round(coalesce(a.tk, 0)::numeric / e.years_observed, 2),
             'avg_spend', round(coalesce(a.sp, 0)::numeric / e.years_observed, 2),
             'spend_is_partial', coalesce(a.unknown, 0) > 0) order by e.m)
      from exposure e
      left join (select extract(month from watched_on)::integer m,
                        count(*)::integer n, sum(ticket_count)::integer tk,
                        coalesce(sum(cost), 0)::numeric(12, 2) sp,
                        (count(*) - count(cost))::integer unknown
                   from rec_all group by 1) a on a.m = e.m), '[]'::jsonb),

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
