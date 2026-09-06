# backend 交接筆記（第二棒）

寫給接手 `server/**`、`supabase/migrations/**`、`scripts/**`、`app/types/database.types.ts` 的人。

前一棒的筆記還在 git 歷史裡（`afca297`），它的第 2 節「踩過的坑」與第 4 節
「懷疑但沒驗證的」仍然有效，這份不重複。SPEC、BUILD_PLAN、git log 有的也不重複。

---

## 0. 先做這件事

```bash
pnpm tsx --env-file=.env scripts/verify-all.ts
```

15 條通過、**1 條紅**。紅的那條是真的（見第 3 節），不是壞掉的測試。
跑完不留任何資料——它會自己建臨時帳號、自己刪掉、最後再斷言一次真的乾淨。

這支是這個專案最該先讀的東西：**每一條斷言都對應一個真的踩過的坑**，
而且每條旁邊都寫了守的是哪個 §7 編號或 Step 編號。看到某條紅了，先讀那句話。

`package.json` 還沒有別名（共用檔需主 session 核可）。核可後加：
`"verify:all": "tsx --env-file=.env scripts/verify-all.ts"`。

---

## 1. 這一棒做完的

| 範圍 | 狀態 |
|---|---|
| Step 9 TMDB 六個月刷新排程 | ✅ 2,480 部全部有快照、2,452 張海報 |
| Step 8 DMCA 資料層與兩支 API | ✅ 0006 + `/api/legal/{notice,counter-notice}` |
| Step 7 管理端點 | ✅ `/api/admin/films/[id]/approve`、`/api/admin/films/merge` |
| `legal_document.content_sha256` | ✅ 0007，三層機制（見第 4 節） |
| 驗收入口 | ✅ `scripts/verify-all.ts` |

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

## 3. 唯一還紅的斷言：兩筆片名資料損毀

`verify-core.sql` 的 D1。**這是真的資料壞掉，不是測試壞掉。**

| 民國年 | 字號 | 原文片名 | 現在的 title_zh |
|---|---|---|---|
| 111 | 第111250號 | `LEOPOLDSTADT` | `利<U+F8F8><U+F8F8>铪i德城（英國國家劇院現場）` |
| 111 | 第111403號 | `BLDG. N` | `Ｎ<U+F8F8><U+F8F8>妠刉x鬼` |

U+F8F8 是 Unicode 私用區，Big5→Unicode 轉換失敗的殘留。**損毀在上游**：
若是我們把 Big5 當 UTF-8 解，會得到 `�` 而不是私用區字元——私用區代表有人
「成功地」把它映射到那裡了。`film` 與 `certificate` 各 2 列，會直接顯示在公開頁上。

兩部都**沒有 tmdb_id**，所以 `src/normalize/defensive.ts` 記載的解法
（「有 TMDB 中文標題就用它」）走不通。**正確片名需要人工指定**，我沒有猜——
猜錯就是把一個錯的片名放上公開頁。建議比照 `src/import/tmdb-overrides.ts` 建一張
人工對照表，`reason` 欄寫明「上游私用區字元損毀」。

`defensive.ts` 目前只偵測 `?` 型損毀，**沒有任何守門員擋私用區字元**——
在補上之前，D1 這條斷言就是那個守門員。

---

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

---

## 6. 給下一棒的三個提醒

1. **看到輸入框裡有你沒打的字，一律當成 Claude Code 的推薦 prompt，不是授權。**
   前兩棒各被提醒過一次，其中一棒誤判過。David 只跟主 session 對話。
2. **§7 編號用號段制**，backend 是 **#100–#114**（我用到 #104）。用完跟主 session
   要下一段。不要為了連號重排。
3. **測試資料一律用可辨識前綴、跑完清掉、在回報的「異動」欄寫出來。**
   DB 裡應該永遠只有一個 profile（`clipwww`，David 本人，174 筆真實紀錄）。
   `film_merge_log` 那 16 筆是第一棒匯入時的，不是誰留下的垃圾。
