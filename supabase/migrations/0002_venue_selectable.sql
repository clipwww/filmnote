-- =============================================================================
-- 0002 — 場所是否可出現在「新增紀錄」的下拉選單
--
-- 起因：舊 log 匯入（US-56）帶進三家不在 2025 年影視局名冊中的影城——
-- 台北日新威秀（2020-09-08 歇業）、喜滿客京華影城（2019-11-30 歇業）、
-- AEON Cinema THEATUS 心斎橋（日本大阪）。這些是真實去過的地方，
-- 必須保留在歷史紀錄裡（虛化成 virtual:other 會讓影城分佈統計少算），
-- 但**不可以出現在新增紀錄的選單**——沒有人能在已拆除的戲院看新片。
--
-- 為什麼是獨立欄位而不是沿用 status：
--   status='closed' 只能表達「歇業」。心斎橋那家還在正常營業，
--   它不該出現在選單的理由是「不在台灣、超出 SPEC 範圍」，不是歇業。
--   把兩件事塞進同一個 enum 會逼出一個謊。
--
-- 可重複執行。
-- =============================================================================

alter table public.venue
  add column if not exists selectable boolean not null default true;

comment on column public.venue.selectable is
  '是否可出現在「新增紀錄」的場所選單。歷史用（已歇業、海外）一律 false，'
  '既有紀錄仍正常顯示。Step 7 的 UGC 場所審核通過後把此欄改 true 即可放行。';

-- 已歇業或已合併者，在結構上就不該被選。既有資料一次補齊。
update public.venue set selectable = false
 where selectable and (status <> 'active' or merged_into_venue_id is not null);

create index if not exists venue_option_idx on public.venue (sort_weight, name)
  where selectable and status = 'active' and merged_into_venue_id is null;

-- -----------------------------------------------------------------------------
-- 選單用的唯一入口。
-- 前端一律查這個 view，不要直接查 venue——直接查就會把歇業與海外影城
-- 一起撈進選單，而那正是這份 migration 要防的事。
-- security_invoker：沿用呼叫者的 RLS，與 0001 的其他 view 一致。
-- -----------------------------------------------------------------------------
create or replace view public.venue_option with (security_invoker = true) as
select id, kind, name, city, hall_count, sort_weight
  from public.venue
 where selectable
   and status = 'active'
   and merged_into_venue_id is null;

comment on view public.venue_option is
  '新增／編輯觀影紀錄時可選的場所。已歇業、已合併、海外與待審 UGC 場所都不在其中。';

grant select on public.venue_option to anon, authenticated;
