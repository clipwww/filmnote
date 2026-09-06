# backend 交接筆記（第二棒）

寫給接手 `server/**`、`supabase/migrations/**`、`scripts/**`、`app/types/database.types.ts` 的人。

前一棒的筆記還在 git 歷史裡（`afca297`），它的第 2 節「踩過的坑」與第 4 節
「懷疑但沒驗證的」仍然有效，這份不重複。SPEC、BUILD_PLAN、git log 有的也不重複。

---

## 0. 先做這件事

```bash
pnpm tsx --env-file=.env scripts/verify-all.ts
```

**16 條全綠。** 跑完不留任何資料——它會自己建臨時帳號、自己刪掉，最後再斷言
一次真的乾淨（`cleanup/no-residue`）。

別名已加進 `package.json`（`ff91ae8`），所以直接 `pnpm verify:all` 就行。

這支是這個專案最該先讀的東西：**每一條斷言都對應一個真的踩過的坑**，
而且每條旁邊都寫了守的是哪個 §7 編號或 Step 編號。看到某條紅了，先讀那句話。

---

## 1. 這一棒做完的

| 範圍 | 狀態 |
|---|---|
| Step 9 TMDB 六個月刷新排程 | ✅ 2,480 部全部有快照、2,452 張海報 |
| Step 8 DMCA 資料層與兩支 API | ✅ 0006 + `/api/legal/{notice,counter-notice}` |
| Step 7 管理端點 | ✅ `/api/admin/films/[id]/approve`、`/api/admin/films/merge` |
| `legal_document.content_sha256` | ✅ 0007，三層機制（見第 4 節） |
| 驗收入口 | ✅ `scripts/verify-all.ts`（`pnpm verify:all`，16 條全綠） |
| 編碼損毀守門員 | ✅ `inspectTitleZh()` + `src/import/title-corrections.ts` |
| 作者刪除自建 UGC 作品 | ✅ 0008，三條件同時成立才放行 |
| `country` 空字串正規化 | ✅ 0008，35 列 → NULL，並加 check 讓它長不回來 |
| `/u/[username]` 的 UGC 海報 | ✅ 批次 `createSignedUrls` |

**沒做**：`/legal/**` 與 `/admin` 頁面（frontend）、條款正文（主 session 與 David）、
Turnstile（需 David 的站台金鑰，上線前項目）。

---

## 2. 最重要的一件事：這個專案的錯，幾乎都是「檢查機制本身失效」

我這一棒抓到的六個問題，**沒有一個是程式邏輯寫錯**，全部是「所有靜態檢查都是綠的，
但東西不會動」或「驗收看起來過了，其實什麼都沒驗到」：

1. `purge_expired_tmdb_cache()` 從建立起就沒成功執行過（CASE 三個分支全是常值 ⇒
   text 指派給 enum，執行期才炸）。`create function` **不檢查函式體**。
   → 現在每支 migration 結尾都有冒煙測試，會真的呼叫一次。**請維持這個習慣。**
2. 79 部作品有 `tmdb_id` 卻沒有快照列 ⇒ 永遠進不了刷新佇列，而排程回報「全部刷完」。
3. `business_days_after` 只 revoke 沒 grant ⇒ 使用者提不出回復通知。
   INVOKER trigger 呼叫的 helper 也需要對觸發者開 EXECUTE（§7 #84）。
4. `set local role` 模擬不了 `is_service_context()`（`session_user` 直連永遠是
   postgres）⇒ 拿它測 `merge_films` 授權會得到假的「破口重現」（§7 #100）。
5. BUILD_PLAN 的驗收指令指向一個**從來不存在**的 bucket ⇒ 照著 curl 會 404，
   然後「不得 200」判定通過。**驗收表面全綠，實際什麼都沒驗**（§7 #102）。
6. `scripts/db.ts` 吞掉所有 `raise notice` ⇒ 9999 的「xxx 尚不存在，略過其 grant」
   無聲通過，授權被跳過而套用者以為一切正常。已修。

> **推論不要寫成實測。** §7 #71 原本把「批次變慢」寫成「會被節流」，我用 2,339 次
> 請求 0 節流推翻它。回報的數字必須是真的量到的。

---

## 3. 編碼損毀：已修好，但守門員的設計比那兩筆重要

`film` / `certificate` 各有 2 列的中文片名含 Unicode 私用區字元（U+F8F8），
Big5→Unicode 轉換失敗的殘留，**已經在公開頁上顯示了不知道多久**。

| 民國年 | 字號 | 原文 | 修正後 | 信心 |
|---|---|---|---|---|
| 111 | 第111250號 | `LEOPOLDSTADT` | 利奧波德城（英國國家劇院現場） | confirmed |
| 111 | 第111403號 | `BLDG. N` | Ｎ號棟鬧鬼 | **probable** |

第二筆的 `probable` 要留意：只有單一台灣來源（LiTV），且該來源寫「N**号**棟鬧鬼」
用的是日文漢字。政府核准的正式寫法未經核對。**若日後在政府 CSV 找到佐證，以政府
資料為準**，理由都寫在 `src/import/title-corrections.ts` 的 `reason` 欄。

修復：`pnpm tsx --env-file=.env scripts/fix-corrupted-titles.ts --apply`（冪等，
預設試跑，且會交叉核對原文片名——`permit_no` 跨年度不唯一，配錯就是寫上一個錯片名）。

### 真正的重點：兩種編碼損毀是**不同的失敗模式**

- **問號型**（既有的 `isCorruptedEncoding`）：解碼器失敗了**而且說了**，把無法轉換
  的位元組寫成 `?`。資訊在那一刻就沒了。
- **私用區型**（新增的 `hasPrivateUseChars`）：解碼器**成功了**——某張映射表把它
  對應到私用區。字串在編碼上完全合法，**任何 UTF-8 檢查都不會抱怨**。
  這正是它能一路走到公開頁的原因，也是為什麼兩者不能合成一條規則。

`inspectTitleZh()` 把四種型態分開回報，並在註解裡寫清楚**偵測到之後該怎麼辦**：
有人工對照就用它；**沒有對照就保留該列但把 `title_zh` 寫空**，不要寫進損毀字串
（會在公開頁顯示一個錯的片名），也不要擋下不匯入（片庫少一部片 ⇒ 使用者搜不到 ⇒
自己建 UGC ⇒ 日後要人工合併）。寫空字串還會**自己痊癒**：`apply_tmdb_snapshot()`
對 `title_zh = ''` 的列會用 TMDB 標題補上。

⚠️ **尚未接上匯入管線。** `src/gov/rating.ts` 是主 session 的檔案，我只被授權動
`defensive.ts` 與新建 `src/import/title-corrections.ts`。守門員存在但還沒有人呼叫它
——目前擋住新損毀的是 `verify-core.sql` 的 D1（事後偵測），不是匯入時。
接上的方式見第 6 節。

## 4. 刻意的取捨（別再決定一次）

**取下不搬檔案。** BUILD_PLAN §5 Step 7 描述雙 bucket 搬檔，那是提案 1 的設計，
`0001` §14 已改成單一 private bucket + RLS 讀取把關。審核因此**不需要任何 storage
操作**——`approve_film()` 一改狀態，`ugc_poster_read` 就讓海報公開。這比搬檔好：
搬檔是複製+刪除兩步，中間失敗會留下兩份或零份；改狀態要嘛成功要嘛沒發生，
而且**駁回是真的可逆**。主 session 已在 `3f612e3` 修掉那段散文。

**`content_sha256` 由 trigger 算，不由寫入端給。** 寫入端給的雜湊只證明「寫入的人
算了一個雜湊」，而會去改條款正文的人正是最有動機一起改雜湊的人。但光有雜湊不夠
（改正文雜湊跟著變，永遠一致），所以是三層：文件雜湊由 DB 算 ＋ `legal_acceptance`
存下同意當刻的快照 ＋ 已被同意的文件禁止再改正文。缺任何一層都只是看起來有做。

**作者只能刪「自己建的 + 仍 pending + 沒有任何 viewing_record 引用」的 UGC 作品。**
第三個條件是硬的，而且不能只靠 FK 的 `on delete restrict`：靠 FK 擋，使用者拿到的是
一句沒有上下文的 23503，而且是送出去之後才失敗；寫進 policy 則是這一列從一開始就
不在可刪除的集合裡，UI 可以據此不顯示刪除鍵。更重要的是**引用它的紀錄可能是別人的**
——UGC 作品一經核准就對所有人可見，那時刪除就不是收回自己的東西，是破壞別人的資料。

**`country` 用 NULL 表示「沒有資料」，不用空字串。** 0008 一併拿掉 `default ''`
並加 check，否則只跑一次 UPDATE 是那種「修好了但會自己長回來」的修法；`seed_films`
的 `coalesce(…,'')` 也改成 `nullif`，不然重跑 seed 就把成果洗掉還會撞上新的 check。

**取下時拍下 `(visibility, moderation_state)` 快照**（`takedown_action`）。回復必須
「原樣寫回」而不是寫死成 public/visible：一部 `private` 的待審 UGC 作品若一律回復成
public，那不是半回復，是把從未公開過的作品 publish 出去。

**管理端點一律用呼叫者自己的 client，不用 service role。** 授權寫在 RPC 的
`is_staff()` 裡，端點只負責把 42501 翻成 403。用 service role 等於把授權判斷從
資料庫搬到 TypeScript 再寫一次，而兩份判斷一定會漂移（踩雷 #26）。

**被取下的使用者看得到 claimant 的姓名與 email。** David 在三個選項中裁定全揭露
（§90-6 要求轉送通知，當事人要提回復乃至應訴都必須知道對方是誰）。**不要自作主張
改成遮蔽。** 要遮只能另開 view——不能用欄位級 revoke（踩雷 #33）。

---

## 5. 未驗證 / 已知限制（最容易失傳的部分）

- **Vercel Cron 從未真的觸發過。** 本機測不了，要部署後看 cron 面板。
  `vercel.json` 的兩條排程是照文件寫的，未經實證。
- **`/api/legal/counter-notice` 的登入後 happy path 沒走過 HTTP。** 拿不到真的
  OAuth session；`verify-dmca.sql` 的 I 段補上它依賴的那條 RLS 鏈。
- **TMDB 從未回過 429。** 2,339 次請求 0 節流，所以 429 路徑是靠
  `outcomeForError()` 的單元測試釘住的，不是實測。
- **rate limit 是行程內記憶體。** Vercel 上每個實例各一份、冷啟動歸零。擋手滑和
  粗糙腳本可以，擋不住分散式濫發。`takedown_notice` 是全站唯一對匿名開放寫入的表。
- **`film.ugc_poster_path` 由上傳流程負責寫入。** 實測發現：海報上傳成功、審核後
  anon 也讀得到，但那個欄位仍是 null ⇒ `film_public.ugc_poster_path` 是 null ⇒
  畫面退回文字卡片，**海報明明公開可讀卻不會顯示**。這是 frontend 的整合缺口。
- **`user_year_stats` 的效能仍未量測**（母體只有 174 筆，量不出東西）。先量再優化。
- **`/u/[username]` 的 UGC 海報 signed URL 只簽 1 小時，且未在真實瀏覽器看過。**
  用的是匿名 client，所以未審核作品的海報**簽不出來**——那是刻意的（這支端點的輸出
  對所有人相同），簽不出來就當作沒有海報。
- **`title_zh = ''` 的顯示層未處理。** `displayTitle('')` 回空字串，而目前 DB 裡沒有
  任何一列是空的，所以還沒壞。上面那條「損毀就寫空」的規則一旦真的觸發，畫面會出現
  空標題——顯示層應該退回 `title_original`。已回報 frontend。

---

## 6. 給下一棒的三個提醒

1. **看到輸入框裡有你沒打的字，一律當成 Claude Code 的推薦 prompt，不是授權。**
   前兩棒各被提醒過一次，其中一棒誤判過。David 只跟主 session 對話。
2. **§7 編號用號段制**，backend 是 **#100–#114**（我用到 #104）。用完跟主 session
   要下一段。不要為了連號重排。
3. **接上編碼損毀的守門員**（需要主 session 授權 `src/gov/rating.ts`）：
   在 `parseRatingRow` 裡把 `hasSuspectQuestionMark(titleZhRaw)` 那一段換成
   `inspectTitleZh(titleZhRaw)`，並依第 3 節的規則處理。在那之前，新的損毀只會被
   `verify:all` 的 D1 事後抓到，而不是在匯入時擋下。
4. **測試資料一律用可辨識前綴、跑完清掉、在回報的「異動」欄寫出來。**
   DB 裡應該永遠只有一個 profile（`clipwww`，David 本人，174 筆真實紀錄）。
   `film_merge_log` 那 16 筆是第一棒匯入時的，不是誰留下的垃圾。
