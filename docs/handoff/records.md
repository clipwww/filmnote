# 交接筆記 — records（`/app/records` 個人紀錄管理）

> 這一棒只做一件事：把 `/app/records` 從「全部紀錄」改成**個人紀錄管理**（維護後台）。
> 假設你讀得到 `docs/SPEC.md`、`docs/BUILD_PLAN.md`（尤其 §7 #185–#187）、
> `docs/design/SCREENS.md §10` 與 `git log`，所以這裡**不重複**那些。
> 只寫關掉 session 就會消失的東西。前一棒是 `docs/handoff/frontend.md`，
> 它的 §6（驗證方法）仍然全部有效，我在 §3 補了兩條。

---

## 1. 這一棒做了什麼（David 2026-09-06 的五件）

| 需求 | 落點 |
|---|---|
| 「全部紀錄」→「個人紀錄管理」 | `AppNav.vue`、`records/index.vue` 的 `useSeoMeta` 與 h1（**三處**）。第四處 `app/pages/app/import.vue` 的 CTA 由主 session 改 |
| 日期改 `YYYY/MM/DD HH:mm` | `app/utils/format-datetime.ts` 的 `watchedAtText()`（**只新增**）＋ `tests/format-datetime.test.ts` |
| 備註欄（截斷、可展開） | `records/index.vue` 的 `#memo-cell` + `memoOneLine/memoIsLong/memoPreview/toggleMemo` |
| 公開狀態欄 | `#visibility-cell`，資料是 `MyRecord.isPrivate` |
| 操作欄固定 | `UTable` 的 `:column-pinning="{ right: ['actions'] }"` + 不透明底色 |

⚠️ **`useMyRecords.ts` 一行都沒動**——`memo` 與 `isPrivate` 本來就在 `TicketCardRecord`
型別上（`app/utils/ticket.ts:151-159`）。`/app` 儀表板與這一頁共用它，動它會撞到別條線。

## 2. 三個「看起來像壞掉、其實是對的」

下一棒最可能「修」掉的三件事，理由都寫在程式碼的註解裡，這裡只列清單：

1. **這一頁的日期跟票根卡不一樣**（`2026/07/26 16:00` vs `Jul / 26 Sun / 16:00`）。
   分界線是頁面性質不是資料：回顧頁留票根語彙、維護後台用機器可讀格式。
   ⚠️ 這一條**已經被推翻過一次**——原本的註解寫「跟票根卡一致」，David 明確覆蓋了它。
2. **沒有場次時間的列只印日期，沒有 `--:--`**；**沒有備註的格子完全留白，沒有「—」**。
   兩個都是刻意的：佔位符會變成整欄的雜訊，而且讀起來像「有值但不給你看」。
3. **1280 也橫向捲，操作欄釘右，而且「靜止時備註被蓋 93px」是被接受的代價**（踩雷 #188）。
   三條路都走過、都量過，**不要再走一次**：
   ① 截欄寬讓九欄塞進 1280 → 影城的廳別被吃掉，違反 `SPEC` 核心價值第 2 條（主 session 否決）；
   ② 捲動容器尾端補等寬 padding → **無效**，只是換成蓋住別欄（公開狀態 68px + 備註 25px）；
   ③ 改釘左緣 → 靜止時遮蔽真的 0px，但捲動時日期 47px／作品 45px 被蓋，
      **片名少掉開頭幾個字而且沒有記號**（截尾有「…」、截頭沒有），列的身分在捲動中消失。
   **David 2026-09-06 看過②③兩版之後選釘右**：換取捲動時零遮蔽、影城與作品一個字都不截。
   ⚠️ 檢查裡有一條 `coverWithinKnown`（釘住 93px 這個已知值），
   **它的價值不是永遠綠，是它會說話**：超過 93px 表示有人讓代價變大了；
   變成 0px 也要看一眼（可能是有人改成了被否決的釘左）。

## 3. 驗證方法（補 `frontend.md §6`）

### 3.1 ★ 故意把它弄壞一次——這一輪兩次都抓到我自己的檢查有盲點

兩個 bug 我都「修好了、量到綠燈」，然後把程式改回壞的版本再量一次——**兩次都還是綠的**。
檢查機制本身失效，而不是程式沒修好：

| 我以為在量的 | 實際上量不到 | 修法 |
|---|---|---|
| 「操作欄在捲動時不動」→ 量它跟**最內層捲動容器**的距離 | 距離確實沒變，因為它黏在一個**自己被外層捲出畫面**的盒子上 | 改量「把所有會橫捲的祖先都推到兩端，它是否仍在**視窗**內且位置不動」 |
| 「sticky 格底色不透明」→ 用 `/rgba\(…,0\.\d+\)/` 比對 | Tailwind 4 的半透明是 `oklab(… / 0.75)`，正規式不匹配 ⇒ 綠燈 | 解析 `/ <alpha>)` 這種斜線語法 |

⇒ **修完一定要把它弄壞一次，確認檢查會紅。** 綠燈只證明「檢查沒抓到」，
不證明「東西是對的」。踩雷 #185／#186 記的就是這兩條。

### 3.2 有些東西量不出來，只能看

備註欄被自動配寬壓成 86px、展開後變成「一行兩個字、十一行高」的一條——
沒有橫向溢出、沒有純白、console 零錯誤、所有數字都是綠的。**是截圖看出來的**（踩雷 #187）。
⇒ 每一輪至少把 1280 與 375 的圖各看一眼，不要只讀數字。

### 3.3 驗證腳本

這一棒的腳本**刻意沒有進 `scripts/`**（那個目錄不屬於前端這條線，而且 `verify:all`
會偵測它的未提交變更）。它們在 session 的 scratchpad 裡，作法照 `frontend.md §6.2`：
`node:http`（`agent:false`）取 `/json/list` → 對**自己開的那一個分頁**開 WebSocket →
`Runtime.evaluate` / `Page.captureScreenshot`。要重建的話關鍵只有四點：

- `PUT /json/new?<url>` 開自己的分頁，收工用 `GET /json/close/<targetId>`。
  ⚠️ **絕對不要 `browser.close()`**，那是 David 的瀏覽器。
- 明暗用 `Emulation.setEmulatedMedia` 的 `prefers-color-scheme` + reload，
  **不要自己 `classList.add('dark')`**。
- 點擊一律 `el.click()`（背景分頁沒有指標命中測試，§6.3）；
  **鍵盤則要用真的 `Input.dispatchKeyEvent`**——鍵盤走焦點不走命中測試，背景分頁有效，
  這也是唯一能證明「鍵盤真的能展開備註」的方法。
- ⚠️ `el.click()` 之後**同一個 tick 讀不到新的 DOM**（Vue 非同步更新）。
  第一版就是這樣得到「點了沒反應」的假陰性，差點去追一個不存在的 bug。
- ⚠️ **明暗不能只靠 `Emulation.setEmulatedMedia`**：David 的瀏覽器裡會留著
  `nuxt-color-mode` 偏好（另一條線也在同一顆瀏覽器上切主題），偏好會蓋掉媒體查詢
  ⇒ 量到「亮色的暗色」而且**每一項檢查都是綠的**。實測：`prefersDark=true` 但
  `documentElement.className='light'`。正解是明確寫 color-mode 自己的儲存
  （`localStorage['nuxt-color-mode']` + 同名 cookie）再 reload，**量完還原原本的值**，
  並且在報告裡印出 `htmlClass` 當作「這一輪真的是暗色」的證據。
- ⚠️ **不要在檢查裡假設欄位的位置**（「日期＝第 0 欄」「固定欄＝最後一格」）。
  這一輪把操作欄移到最前面之後，兩個假設同時失效：日期檢查變紅（量到操作欄的空字串）、
  sticky 檢查量成備註欄（alpha=0、pass=false，全是假的）。一律用表頭文字定位。

## 4. 資料上的事實（查過，不要再用推的）

- 174 筆全部有 `watched_time`（**沒有** null 的列）、全部是 `public`（**沒有** private）。
  所以「無時間」與「私密」兩種呈現**在真實資料上看不到**，要驗必須自己造。
- `memo`：101 筆是空的（58%）、73 筆有值、平均 14.3 字、最長 67 字、**5 筆含換行**
  （2024-03-09 的四筆連映拆分、2023-11-04 那筆）。要驗展開就切到 2024。
- ⚠️ **要指定「David 的資料」用 `.env` 的 `IMPORT_TARGET_EMAIL`**（已驗證：精確命中
  1 個 `auth.users`，對到 `profile.username = 'clipwww'`）。
  **不要用 harness 給的 `david.chien@athena.com.tw`**——那是他的 commit 署名信箱，
  跟登入信箱是不同的兩個，拿它去查會得到 0 筆而不是錯誤。
  **值不要寫進版控**（repo 是 public），用 `--env-file=.env` 讀。
- 測試資料一律 `zz` 前綴、驗完立刻刪、在回報寫出來。這一輪建過一筆
  （`watched_time` null + `private` + 含換行的長備註），已刪，刪後複查 174/0/0/0。

## 5. 沒做、或沒驗到的事

1. **真實觸控裝置沒測過**（同前一棒 §5-7）。375px 的固定欄與備註展開都是 CDP 量的，
   慣性捲動、以及「手指按住固定欄捲動」的行為沒有人看過。
2. **公開狀態欄的視覺重心待 David 裁決**。目前兩態同字重（實測全部都是公開，
   把「公開」做醒目等於整欄都在喊）。他若要「公開態加重」，改 `#visibility-cell` 即可。
3. **`moderation_state` 沒有進這一欄**。被 admin 取下的紀錄 `visibility` 會被寫成
   `private`，於是在這一欄長得跟「我自己設為私密」一模一樣。降級態本來就還沒做
   （`frontend.md §5-8`），但這一欄讓它變得**看得見**了——做取下降級態時記得一起處理。
4. **備註展開狀態不會記憶**，換年份／篩選後全部收起（`expandedMemos` 用 record id 存，
   不會錯亂，只是不持久）。目前沒有需求要它持久。
