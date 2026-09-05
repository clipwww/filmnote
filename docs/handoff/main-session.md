# 交接筆記 — 主 session（協調者）

> 給下一位主 session。你讀得到 `docs/SPEC.md`、`docs/BUILD_PLAN.md`、
> `docs/handoff/{frontend,backend,design}.md`、git log，以及
> `~/.claude/projects/-Users-david-Documents-Github-log/memory/` 的記憶檔。
> **這裡不重複那些。** 只寫協調這件事本身的知識，以及我犯過而你不必再犯的錯。

---

## 1. 你的角色

David 的定義：**溝通窗口、派工者、子 session 的 context 與進度管理者**。

他只跟你對話，不直接跟子 session 講話。子 session 的產出、卡點、提問都由你消化後轉述。
需要他決定的事（美學取向、憑證、資料語意、產品取捨）由你帶回去問，**不代為決定**。

反過來也成立：子 session 看不到你跟他的對話，也看不到彼此。**只有你有全局視野。**
派工前把「已定案的決策」與「不可妥協的約束」寫進 prompt，不要假設它們知道。

---

## 2. 已經運作良好的機制（照用即可）

### 2.1 回報協定

每個子 session 每次回合結束都以固定格式收尾：

```
━━ 回報 ━━
狀態：完成 <什麼> ／ 卡在 <什麼> ／ 需要決定 <什麼>
驗證：<具體驗過什麼；沒驗就寫「未驗證」>
異動：<動了哪些檔案，有無 commit（附 hash）>
卡點：<需要你或 David 處理的事；沒有就寫「無」>
下一步：
━━━━━━━━
```

三條要求寫進去很有效：**不要報喜不報憂**、**「未驗證」要誠實寫**、需要 David 決定的事寫在卡點由你轉達。

實測效果：三個 session 各自**主動**報告了自己的問題——frontend 自陳在共用 DB 上用
`delete ... where memo like 'ZZ%'` 不妥、backend 主動擋下一個誤配並指出比對器的護欄在
缺片長時會靜默失效、frontend 又發現自己 commit 進去的 OAuth secret。**沒有一件是我問出來的。**

⚠️ **不要要求它們回報 `% ctx`。** 我一開始這樣要求，但**子 session 看不到自己的狀態列**
（那是終端 UI 畫的）。context 用量由你從 herdr 讀：

```bash
herdr agent read <name> --source detection --lines 5 | grep -oE '\([0-9]+% ctx\)'
```

### 2.2 檔案所有權

三方併行改同一個 repo，不切開必然互撞。這次的切法：

| 擁有者 | 範圍 |
|---|---|
| frontend | `app/**`（除 `app/types/database.types.ts`） |
| backend | `server/**`、`supabase/migrations/**`、`scripts/**`、`app/types/database.types.ts` |
| 主 session | `src/**`、`tests/**`、`docs/**` |
| **共用，要先過你** | `nuxt.config.ts`、`package.json` |

`package.json` 這條救過一次：backend 想加一行 script，先問了，我才有機會提醒它
不要動 `imports` / `pnpm.onlyBuiltDependencies` / `packageManager` 那三個欄位。

### 2.3 測試帳號紀律

子 session 建測試資料要用可辨識前綴、驗收後清掉、**並在回報的「異動」欄寫出來**。
最後一條是重點——backend 的匯入腳本曾假設「DB 裡只有一筆 profile」，在 frontend 建了
`zzstep4@example.com` 之後就靜默壞掉（匯到別人帳號上）。問題不在假設寫錯，在於**沒有人知道別人建了什麼**。

---

## 3. 瀏覽器測試（這次新開的能力，值得繼續用）

**三個 session 蓋了五個 Step，全部靠 curl 與 SQL 驗證，沒有人用眼睛看過畫面。**
我實際跑一次就找到六個問題，包含個人頁 17,481px 無分頁、海報佔位在 48px 容器裡塞
`p-4` 導致中文片名被擠成直排截斷。**這類問題功能測試永遠抓不到。**

環境在 `/private/tmp/.../scratchpad/browser/`（playwright-core，非專案依賴）。

### 三件必須知道的事

1. **Google 會擋 Playwright 啟動的 Chrome**（`navigator.webdriver=true`）。
   解法是請 David 自己啟動帶除錯埠的 Chrome，你用 CDP **附著**上去——附著不會加自動化旗標：

   ```bash
   open -na "Google Chrome" --args \
     --remote-debugging-port=9222 \
     --user-data-dir="$HOME/.filmnote-test-chrome"
   ```

   **那個 profile 現在留著且已登入**，直接 `chromium.connectOverCDP('http://127.0.0.1:9222')` 即可。

2. **CDP 附著時不要呼叫 `browser.close()`**——那會把 David 的瀏覽器關掉。
   直接 `process.exit(0)` 斷開附著就好。我犯過一次。

3. **用 admin API 鑄 session 注入瀏覽器會被分類器擋下，那是對的，不要繞。**
   那個模式在形態上與憑證濫用相同。要登入就請 David 用上面的附著法。

### 讀 herdr pane 時的陷阱

`herdr agent read --source recent-unwrapped` 會**濾掉 ANSI 顏色**，於是「推薦 prompt」
（Claude Code 自己產生的建議輸入）看起來跟使用者實際輸入的一模一樣。我誤判過一次。
要分辨就用 `--format ansi`。

---

## 4. 我犯過的錯（不要重蹈）

| 錯誤 | 教訓 |
|---|---|
| 憑記憶寫套件版本，全部猜舊（`@antfu/eslint-config` 實際是 9.5.1，我寫 5.5.1） | **用 `npm view <pkg> version` 查，不要猜** |
| `npm install 2>&1 \| tail -5` ——安裝失敗但 exit code 被 `tail` 吃掉，顯示成功 | 需要 exit code 時**不要 pipe**，或用 `PIPESTATUS` |
| 把「Python 原型批次間慢 6 倍」推論成「TMDB 累積節流」並寫進程式碼註解與 SPEC 當事實。正式匯入 9,076 次請求實測**重試 0、節流 0** | **推論不要寫成實測。** 我從未量測過 429，只是把「變慢」等同於「被節流」 |
| 偵測登入時用 `sb-.*-auth-token` 正則，把 PKCE 的 `...-auth-token-code-verifier` 也匹配進去，誤報登入成功 | session cookie 要用精確樣式 + 長度判斷（code-verifier 只有 55–159 bytes，真 session > 200 bytes） |
| `~/` → `#pipeline/` 別名只轉一半，vitest 全綠但 `tsx` 執行 CLI 直接爆 | **測試與正式執行走不同解析路徑，全綠不代表能跑。** 改別名後要實測模組載入與 CLI 端到端 |

最後一條的反向版本我也犯過：補了 `package.json` 的 `imports` 卻沒把殘留的 `~/` 轉完。
**同一類錯誤我犯了兩次，方向相反。**

---

## 5. 還欠 David 的事

1. **注音實機測試**——只有他的手指能做。frontend 列為「繁中產品的高風險點」，
   且多了一個顧慮：表單改用 `<UForm>` 後，**注音選字中按 Enter 會不會誤觸送出**。
   debug Chrome 還開著，他有空打一次「鬼媽媽」即可。
2. **git 歷史裡的失效 OAuth secret**（commit `418d9bd` 之前）。舊 secret 他已刪除，
   所以是死值，但仍建議第一次 push 前清掉——免得後人翻到 `GOCSPX-...` 誤以為有效而追。
   三個 session 已關閉，現在改寫歷史是安全的。**要先問他**（會改 commit hash）。

---

## 6. 目前最該接的三件事

排序依據是「不做的話後面每一步都更貴」：

1. **Step 9 TMDB 刷新排程**（backend）——`film_tmdb_snapshot` 2,401 列中 2,400 列是
   `pending`、海報全 NULL。不做的話全站沒有海報，而且前端接了海報欄位會看到一整排破圖。
2. **`/app` 還是骨架**——登入後第一個畫面，目前印著使用者 UUID 與 email 的 JSON debug 區塊，
   174 筆紀錄一筆都沒顯示。
3. **設計系統 CSS 落地**（`DESIGN_SYSTEM §1.6` → `app/assets/css/main.css` + `app/app.config.ts`）
   ——十分鐘的事，但不做的話後面每一頁都要重畫。design 的交接筆記 §1 有驗收方式。
