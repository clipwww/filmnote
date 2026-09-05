# backend 交接筆記

寫給接手 `server/**`、`supabase/migrations/**`、`scripts/**`、`app/types/database.types.ts` 的人。

SPEC、BUILD_PLAN、git log 裡有的東西這裡一律不重複。這份只寫**當時在我腦中、
不寫下來就會消失**的部分：踩過但還沒進 §7 的坑、刻意沒做的取捨、以及懷疑但沒空驗的事。

---

## 1. 做到哪裡

| 範圍 | 狀態 |
|---|---|
| 舊 log 匯入（Step 10） | ✅ 完成。174 筆落地、四次重跑冪等 |
| `venue_option`（0002） | ✅ 完成並經 anon 實測 |
| `user_year_stats`（0003，Step 6 後端） | ✅ 完成，但**沒有任何 UI 消費過它** |
| schema 文件漂移檢查 | ✅ `scripts/sync-schema-docs.ts` |
| Step 9 TMDB 六個月刷新排程 | ❌ 未開始。**這是後端最該接的下一件事** |

### 下一步（具體到可以直接動手）

**優先序 1：Step 9 的 TMDB 刷新排程。** `film_tmdb_snapshot` 現在有 **2,401 列，
其中 2,400 列 `state='pending'`、`poster_path` 為 NULL**——`seed_films()` 與我的
`upsertTmdbFilm()` 都只寫入 `(film_id, tmdb_id)` 佔位，從沒有人去抓明細。

直接後果：`user_year_stats` 的 `repeats[].poster_path` **永遠是 null**，多刷排行
畫不出海報。前端若照契約接了海報欄位，會看到一整排破圖。這不是前端的 bug。

要做的事：`server/api/cron/tmdb-refresh.post.ts`，讀 `public.tmdb_refresh_due`
這個 view（0001 已備好，且 9999 已 `grant select … to service_role`），逐筆打
`TmdbClient.detail()`，寫回 snapshot，再呼叫 `apply_tmdb_snapshot(film_id)`。
以 `NUXT_CRON_SECRET` 驗證呼叫者。**不要掛 pg_cron**——0001 的註解說明了原因
（免費專案閒置會暫停，cron 不跑而沒有人知道）。

**優先序 2：`/app` 首頁目前是骨架**（見第 5 節），那是 frontend 的範圍，
但如果沒人接手而你身兼二職，它比新功能重要——那是登入後的第一個畫面。

---

## 2. 踩過的坑（還沒進 BUILD_PLAN §7）

### 2.1 ⚠️ 驗證層本身會騙你：node-postgres 把 `date` 解析成 JS Date

一個存著 `2014-03-01` 的 `date` 欄位，經 `console.table` 印出來是
`2014-02-28T16:00:00.000Z`。**看起來就像時區轉換出了錯**，而它其實完全正確。

我差點據此回報「午夜場跑掉了」。這是所有坑裡最危險的一種——**錯的不是程式，
是你用來檢查程式的工具**。`scripts/db.ts` 現在有 `setTypeParser` 壓住了，但：

> **斷言日期／時間時，一律在 SQL 裡 `::text`。** 不要相信任何客戶端的日期呈現。

### 2.2 RLS 要怎麼測（沒有瀏覽器也能測）

這招我到後期才想到，早點知道能省很多時間。`scripts/db.ts` 把整份檔案以單一
simple-query 送出（＝隱式交易），所以可以在裡面 `set local role` 模擬 PostgREST：

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('sub', (select id from public.profile where username='clipwww'),
                    'role','authenticated')::text, true);
select public.user_year_stats('clipwww', 2024);   -- 以「David 本人」的身分執行
rollback;
```

換成 `set local role anon` 就是未登入者。我就是用這個測出「本人 7,236 元／
anon 0 元」的對照。**不要用 `postgres` 角色測 RLS**——它有 `bypassrls`，
你會看到全部資料然後以為 policy 壞了（或更糟，以為 policy 沒壞）。

### 2.3 `extract(isodow)` 是 1=週一…7=週日，`extract(dow)` 是 0=週日

`user_year_stats` 的 `weekday_hour.weekday` 用的是 **isodow（1–7）**。
前端若照直覺當成 0-indexed，整張熱力圖會平移一天而且不會報錯。

### 2.4 `import_key` 是內容衍生的 ⇒ 上游改一列 = 新的一列，不是更新

`import_key` 直接用上游的 `id`，而那個 `id` 是原始 CSV 列的 base64。所以
**David 只要編輯舊 log 裡的任何一個欄位（改片名、改票價），那一列的 id 就變了**：
重跑匯入會插入一筆新的，舊的變成孤兒留在 DB 裡，年度總花費就多算一次。

`--prune-orphans` 就是為此而生（刪除 DB 中已不存在於來源的 import_key）。
**預設關閉**，因為自動刪線上資料太危險。但常態重跑應該要帶著它，否則
「冪等」只在來源完全沒變時成立。這一點我沒有寫進 Step 10，因為當時還沒想清楚
它其實是個常態需求而非一次性遷移工具。

### 2.5 修正先前的匯入決定，用 `merge_films` 而不是刪掉重建

第一次匯入建了 18 部 UGC 作品，後來人工對照表確認其中 16 部 TMDB 有。
正確的收尾不是砍掉重練——那會讓 `viewing_record.film_id` 懸空（`on delete restrict`
會直接擋下）。`merge_films(loser, winner, reason)` 會搬紀錄、改 `film_identity`
指向、寫 `film_merge_log`，而且因為 `resolve_film()` 會沿著 `merged_into_film_id`
走，**合併本身是冪等的**（第二次跑就沒有敗方可併了）。

### 2.6 PostgREST：`returns jsonb` 回物件，`returns table` 回陣列

`user_year_stats` 宣告 `returns jsonb`，所以 supabase-js 的 `data` 直接就是那個
物件（`data.totals.spend`）。若日後改成 `returns table(...)`，`data` 會變成
只有一個元素的陣列，前端全部要改成 `data[0]`。這個差異沒有任何型別會提醒你。

### 2.7 統計裡 `film` 一定要 LEFT JOIN

`record_read` 讓本人看得到自己指向私密 UGC 作品的紀錄，但 `film_read` 對
其他人不放行那部作品。INNER JOIN 會讓那些紀錄**整筆從聚合中消失**，
總場次少算而且不會有任何錯誤訊息。`user_year_stats` 裡所有 `film` / `venue`
的 join 都刻意是 LEFT。

---

## 3. 刻意沒做的取捨（別再決定一次）

**沒有替統計開 `/api` 端點。** 統計含票價，而票價**因呼叫者而異**——同一個 URL
對不同人是不同的數字。開一支 Nitro route 等於把一個「看起來可以快取」的東西放在
那裡等人快取，第一個造訪者（很可能是 David 本人）的票價就會被送給所有後續訪客。
讓前端直接用自己的 session 打 RPC，這個風險在結構上就不存在。**要開端點前請先想清楚。**

**沒有放寬比對器門檻。** 舊 log 沒有片長，`matchCertificate` 的片長交叉驗證形同關閉
（細節在 `src/match/matcher.ts` 檔頭）。當時的誘惑是把 `SCORE_THRESHOLD` 調低來提高
命中率，但那等於在最沒有把握的時候最敢猜。改成收緊（要求精確訊號）＋
`src/import/tmdb-overrides.ts` 逐筆人工指定 16 部。**那張表的 `reason` 欄是資產**：
它記錄了每一部「為什麼沒配到」，是日後調門檻時唯一有實據的依憑。

**`0002` 沒有沿用 `venue_status='closed'` 來擋選單。** AEON 心斎橋還在正常營業，
它不該進選單的理由是「在日本」不是「歇業」。硬塞同一個 enum 會在資料裡留下一個謊，
而那個謊日後一定會被別的查詢當真。所以另開 `selectable` 欄位。

**沒有動 `package.json` 加 `db:sync-docs` 別名**（共用檔需主 session 核可）。
所以 `scripts/sync-schema-docs.ts` 的說明文字寫的是直接呼叫 tsx。核可後記得兩邊都改。

---

## 4. 懷疑但沒驗證的（最容易失傳的部分）

**`user_year_stats` 在大量資料下的效能完全沒測。** 母體只有 174 筆。函式裡有
八個對 CTE `rec` 的相關子查詢，而 `rec` 被引用多次 ⇒ PG 會**物化**它（這裡大概是好事，
但沒量過）。真正的疑慮是 RLS：`record_read` policy 每一列都要跑
`account_is_servable()` 和一個對 `film` 的 EXISTS。一萬筆紀錄的使用者會發生什麼事，
我不知道。**先量再優化**，別憑直覺加索引。

**TMDB 併發仍未驗證。** 我跑的是 concurrency 4、150 次請求、0 次節流。
`TmdbClient` 的註解說 8 併發未驗證——**現在依然未驗證**，我只是把數字調低繞過去了。
Step 9 要打 2,400 次請求，那才是真正的壓力測試，記得看 `stats.throttled`。

**`spend_is_partial` 對「本人」有語意上的假陽性。** 雙片連映的第二筆刻意沒有
`viewing_record_cost` 列（錢記在同場的第一筆），所以 David 自己看 2024 年會拿到
`partial=true`（3 筆）。目前靠 `is_own` 讓前端改措辭化解（「N 筆未記錄票價」
而非「部分票價未公開」）。**根治需要在 `viewing_record` 加一個「票價併入哪一筆」
的欄位**，那會動到前端的 CRUD，屬產品語意決定——已回報，David 尚未裁決。

**`0002` 的 `selectable` 我只驗了 anon。** 沒有驗 authenticated 走 `venue_option`
會不會因為 RLS 而有不同結果（理論上不會，`venue_read` 是 `using (true)`）。

**注音輸入法的組字中間態。** 主 session 用 CDP 模擬沒有重現「選單被組字中間態清空」
的問題，但那是模擬不是實機。若前端的搜尋框有 debounce + 即時查詢，
**這個坑很可能還在**，只是還沒被觸發。

---

## 5. 未完成／半成品

**`repeats[].poster_path` 目前永遠是 null。** 不是 bug，是 Step 9 沒做（見第 1 節）。
契約欄位已經留好，Step 9 一做完就會自動有值，前端不必改。

**`user_year_stats` 從未被真實 UI 消費過。** 我用 curl 與 SQL 驗到形狀、
權限、時區都正確，但「ECharts 吃不吃得下這個形狀」沒有人驗證過。
`daily` 我刻意給具名欄位（`{date, records, tickets}`）而不是 ECharts calendar
要的 `[date, value]`，理由是不想把圖表函式庫的資料格式綁進 API 契約——
前端 map 一下即可。**如果前端覺得這個決定很煩，那是可以談的**，不是原則問題。

**`/app` 登入後首頁還是骨架**（frontend 範圍，但影響對後端的驗收）：標題「我的紀錄」，
內容是一段裸露的 JSON debug 區塊，**印著使用者 UUID 與 email**，底下一個登出按鈕。
David 的 174 筆紀錄一筆都沒顯示。UUID 不該出現在畫面上。
記錄流程本身（片名雙向搜尋、「找不到片」是流程的一部分、已歇業影城被
`venue_option` 正確過濾、影城帶縣市消歧義）經真實 Chrome 實測是紮實的。

**`.omc/**` 與 `docs/design/.DS_Store` 目前未被 gitignore。** 前者是 session 執行期狀態、
後者是 macOS 垃圾檔，兩者都不該進版控。我沒有自作主張改 `.gitignore`
（不在我的檔案分工內）。建議補上 `.omc/` 與 `.DS_Store` 兩行。

---

## 6. 一句話總結

後端的「正確性」目前都靠 SQL 與 curl 證明，**沒有一項是靠 UI 證明的**。
接手時請把「有沒有人真的看到過這個數字」當成獨立於測試之外的一道驗收。
