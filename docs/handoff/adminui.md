# 交接筆記 — adminui（`/admin/**` 與 `/app/import`）

> 負責 `app/pages/admin/**` 與 `app/pages/app/import.vue`，共用層屬於 frontend。
> 假設你讀得到 `SPEC` / `BUILD_PLAN` / `docs/design/**` / `git log`，這裡**不重複**。
> 只寫關掉 session 就會消失的東西。
>
> `BUILD_PLAN §7` 的 **#130–#135** 是這一棒發的，號段還剩 #136–#144。

---

## 1. 現況

| 路由 | 狀態 |
|---|---|
| `/admin`（→ `/admin/films`） | 可用 |
| `/admin/films` | **完成**。審核佇列、相似作品提示、合併（並排比對＋交換左右＋核准紀錄） |
| `/admin/takedowns` | **完成**，除了「已收到訴訟證明」（見 §4） |
| `/admin/reports` | **完成**（唯讀 → 0011 之後可結案） |
| `/app/import` | **完成**。JSON＋CSV、影城對照、片名對照、TMDB 查詢、對帳、冪等寫入 |

三個佇列都以真的 staff 身分算繪並操作過（截圖在該次 session 的 scratchpad，未進版控）。

---

## 2. 這一棒最重要的一件事：`import_key` 對位元組敏感（踩雷 #134）

`import_key` 是**原始列的 base64**，所以冪等的前提是「位元組完全相同」。
實測把沒有備註的列從 10 欄補成 11 欄（一個結尾逗號），**104/169 個 key 全變了**，
而畫面會說「新增 104 筆」——**它不會報錯，只會安靜地把十二年的紀錄變成兩份**，
觸發條件（上游改匯出格式）完全在我們控制之外。

所以 `/app/import` 第 3 步是**硬約束**，不是裝飾：

- 任何寫入之前，先顯示 **既有 N ／ 本次新增 M ／ 本次略過 K**，三個數字要加得回總數。
- M 異常接近總筆數而使用者**已經匯過東西**時，跳 error 色警報說明「這通常是格式變了」。
- 判準在 `driftWarning`：`prior >= 10 && matched * 2 < min(prior, importable)`。
  第一次匯入不示警——那時全部都是新的才正常。

**不要把這段拿掉換成一份清單讓使用者自己數。** 這是唯一會在事前暴露這件事的地方。

---

## 3. 三個佇列的不變量（拿掉任何一個都會出事）

1. **審核佇列一律查 `film_review_queue` view（0011），不要自己組 `review_state` 條件。**
   `merge_films()` 不改敗方的 `review_state`（也不該改），所以匯入時建的 16 部 UGC 佔位
   被併掉之後仍停在 `pending`。少了 `merged_into_film_id is null`，佇列會整排都是
   **按得下去的墓碑**，而那 16 部全是片庫裡已有正確版本的片名——按「通過」會把重複
   作品放進公共片庫，而合併正是為了消除它們。

2. **「片庫裡有沒有像的？」是提示，不是判定。** 每一列旁邊都有一顆不可逆的
   「合併到這一部…」，所以**會亂建議的提示比沒有提示危險**。兩個實測踩過的坑：
   - 拉丁字**不可以切片**（`slice(0,3)` 會產生 `min`/`fat` 這種命中所有片名的碎片）。
     切片只對 CJK 做，拉丁只用長度 ≥ 4 的整個字。
   - **`limit()` 沒有排序等於隨機取樣**。原本 `.or(...).limit(8)` 讓《沙丘：第二部》
     一次都沒出現過，畫面上卻列著《哈利波特》《魔戒二部曲》。現在撈 40 列、
     在前端按命中權重排序、低於 `SIMILAR_MIN_SCORE`（4）就老實說查不到。

3. **前端絕不自己算工作日。** 期限走 `counter_deadlines` trigger，剩餘天數走
   `business_days_between()`（0011）。兩份定義一定會在國定假日那題分岔，而分岔的
   那個會出現在法定期限上。⚠️ DB 那兩支**只扣週末不扣國定假日**（backend 自己標的），
   期限偏早、對平台保守，但不是法定的那個數字。

---

## 4. 還沒做完的，以及為什麼

- **「已收到訴訟證明」按不下去。** `notice_status` 有 `litigation_notified`，但
  0001–0011 全部 grep 過，**除了 enum 定義沒有任何地方寫得進它**。維持 disabled
  並在畫面上寫明原因——不要做成看起來能按然後默默失敗。
- **`/admin/reports` 的「受理，我會去修」不叫「照著改」。** 系統不會幫你改片名：
  `film.title_zh` 的權威來源是影視局開放資料，人工覆蓋會被下次更新洗掉。
  覆蓋層（用 `source_authority` 既有的 `admin` 值讓 seed 停止覆寫）主 session 已採納
  但尚未實作。**在那之前不要提供任何直接改片名的入口。**
- **駁回之後作者端仍然看不到任何東西**（已派給 frontend）。三個實測發現：
  ① 被駁回的作品在 `/app/records/new` 的片名選單裡**完全沒有標記**（pending 顯示
  「審核中」，rejected 什麼都不顯示，看起來像正常的片庫作品）——`filmLabel()` 在
  `app/composables/useFilmSearch.ts`；② `film_usable_by()` 只看 `moderation_state` /
  `merged_into_film_id` / `visibility`，**完全沒有看 `review_state`**，所以作者可以
  繼續用它記新紀錄——主 session 裁決**這不是 bug，不要去擋**（駁回是「不進公共片庫」，
  不是「你沒看過這部片」），要補的是告知；③ 審核者被強制填的 `review_note`
  目前**沒有任何畫面讀它**。
- **影城對照表維持 localStorage、留在匯入流程內**（主 session 裁決，`SCREENS §17` 結案）。
  不另開 `/app/settings/venues`。

---

## 5. 環境陷阱（會浪費你半小時的那種）

- **`connectOverCDP` 卡住時，兇手是「某個 renderer 死掉的分頁」，不一定是 `file://`**
  （踩雷 #135，修正 #97 ①）。playwright 附著**每一個** target，一個死掉的 renderer
  就讓所有人都連不上，而錯誤訊息只指向 WebSocket。**用裸 CDP 逐 target
  `Target.attachToTarget` + `Runtime.evaluate` 探測**找出兇手，不要重試也不要重開瀏覽器。
  自己的腳本一定要把 `page.close()` 放進 `finally`（**但永遠不要 `browser.close()`**）。
- **`useSupabaseUser()` 的使用者 id 是 `sub` 不是 `id`**（踩雷 #13）。`user.value.id`
  **typecheck 是綠的**，執行期才變成 `undefined`，症狀是 PostgREST 回 400 而
  supabase-js 把錯誤放在 `error`、`data` 是 `null`——呼叫端寫 `data ?? []` 就會把
  空集合當成正常答案。我因此讓對帳畫面說了謊（「新增 122 筆」而正確答案是 0）。
  **新查詢一定要看一次 Network 面板有沒有 4xx，不要只看畫面有沒有東西。**
- **`pages/` 底下要放非路由檔案就用 `-` 前綴**（`ignorePrefix`，Nuxt 4 預設值）。
  `pages/` 掃 `.vue` **和** `.ts`。顯式相對 import 不受影響。
- **`src/import/**` 必須維持瀏覽器可載入**：`node:` 內建模組一律不行（踩雷 #130）。

---

## 6. 拿真實資料造測試檔的方法（比結論更值得留）

`viewing_record.import_key` 解 base64 就是**原始 CSV 列**，所以可以在**完全不寫入**的
前提下，造出與 David 真實匯入同規模（169 筆／134 片名／15 影城）的測試檔來驗版面。

⚠️ **但反推的正確性要先斷言過，否則你驗到的是自己的產生器。** 我踩了兩次：
備註含換行那一列沒依 RFC 4180 加引號（被拆成三筆）、以及沒有備註的列多補了一個
結尾逗號（104 個 key 全變）。**先斷言「產生的 key 與 DB 完全吻合」再拿去驗 UI。**

反過來，那個壞掉的檔案現在是**驗格式漂移警報的最好素材**——留一份。

---

## 7. 測試資料紀律

`/admin` 的每一個動作都會改到別人的資料，所以測試一律自己建、用 `zzadmin` 前綴、
驗完刪掉、並在回報的「異動」欄寫出來。這一棒建了 3 部作品／1 筆紀錄／1 件侵權通知
＋回復通知／1 筆資料回報，全部刪乾淨，DB 回到期初基線（records 174 / profiles 1 /
ugc 16 / merges 16 / notices 0 / reports 0）。

**那 16 部墓碑不是垃圾，是匯入的歷史，不要拿它們練習，也不要「順手清掉」。**
