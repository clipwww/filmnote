# 電影日記 SaaS：資料來源可行性調研 🎬

> 調研日期：**2026-09-05**　｜　調研對象：把本專案的「看電影紀錄」模組發展為台灣在地化的 Letterboxd-like SaaS
> 所有條款與定價均以**當日擷取之官方一手頁面**為準。API 條款與定價變動頻繁，實作前請重新確認。
> 本文所有「已驗證」項目皆附來源 URL；無法取得者一律標示「**未能驗證**」並說明查證過程。

---

## 1. TL;DR

1. **兩個問題都有解，而且比預期樂觀。** 電影 metadata 用 **TMDB**，且商業使用是**合法且可自助訂閱**的（$149/月，適用年營收 &lt; 100 萬美元者）；台灣影城清單則有**免費、可商用的政府開放資料**直接可用。
2. **TMDB 免費 key 明確禁止營利使用**——條款白紙黑字把「向使用者收費的 App」列為商業使用。但這不是死路：TMDB 官方人員於 2026 年多次公開確認有 $149/月的自助商業方案，**Letterboxd 本身就是 TMDB 的公開使用者**。這是「付錢就能合法」的問題，不是「做不到」的問題。
3. **台灣本地片名有官方權威來源**：文化部影視局「電影片分級及相關資訊」（中文片名＋**原文片名**＋國別＋片長＋級別＋分級證明字號）與國影中心「全國電影票房統計數據」（片名＋上映日＋發行商，**週更**），兩者皆為「政府資料開放授權條款第 1 版」，條文明訂「**不限目的**」利用，商業使用完全合法，唯一義務是顯名標示。
4. **影城資料是本次調研最大的好消息**：影視局「全國電影院資料」CSV 直接給出全台 **107 家影城、932 廳**，含**統一編號**（天然穩定主鍵）、廳數、地址、電話，免費可商用。全台影城只有一百多家，「一次性建檔 + 年度更新 + UGC 回報」完全可行，**根本不需要 Google Places**（且 Google 條款明文禁止儲存商家名稱與地址）。
5. **唯一真正無解的是「場次 (showtimes)」**——這是最貴、最難、最易壞的部分。**MVP 應該直接放棄場次**，改為「使用者選影城 + 手動輸入時間」，這對「觀影日記」的核心價值幾乎沒有損失。

---

## 2. 快速決策表

### A. 電影 metadata

| 方案 | 台灣/zh-TW 覆蓋 | 商業 SaaS 授權 | 成本 | 推薦度 |
|---|---|---|---|---|
| **TMDB** | ✅ 佳（zh-TW 片名、TW 上映日、TW 分級皆已實測驗證） | ✅ **明確可行**（須訂閱商業方案） | **$149/月**（年營收 &lt; $1M） | ⭐⭐⭐⭐⭐ **主力** |
| **影視局「電影片分級及相關資訊」** | ✅ 權威（官方核准片名） | ✅ **明確可行**（不限目的） | 免費 | ⭐⭐⭐⭐⭐ **台灣主鍵來源** |
| **國影中心「全國電影票房統計數據」** | ✅ 權威（週更上映片單） | ✅ **明確可行** | 免費 | ⭐⭐⭐⭐⭐ **新片偵測** |
| **Wikidata** | ⚠️ 中（見 §3.5） | ✅ CC0，最自由 | 免費 | ⭐⭐⭐ 輔助對照 |
| **OMDb API** | ❌ 差 | ❌ **明確禁止**（CC BY-**NC**） | — | ⭐ 不要用 |
| **IMDb 免費 Datasets** | ❌ 無中文 | ❌ **明確禁止**（非商業限定） | — | ⭐ 不要用 |
| **IMDb 商業（AWS Data Exchange）** | ⚠️ 未查 | ✅ 可行 | **$150,000/年起** | ⭐ 價格不現實 |
| **Trakt.tv** | ❌ 差 | ⚠️ **灰色**（條款寫個人非商業，客服說可商用） | 免費 | ⭐⭐ 僅匯入相容性 |
| **JustWatch** | ⚠️ 未查 | ⚠️ 僅企業簽約，無自助管道 | 洽談 | ⭐⭐ 未來擴充 |
| **豆瓣** | ✅ 中文佳 | ❌ 無合法取得管道（API 已停止公開發放） | — | ⭐ 排除 |

### B. 影城與場次

| 方案 | 覆蓋台灣 | 可永久儲存？ | 成本 | 推薦度 |
|---|---|---|---|---|
| **影視局「全國電影院資料」** | ✅ 107 家 / 932 廳 | ✅ **可**（政府開放授權） | 免費 | ⭐⭐⭐⭐⭐ **主力** |
| **OpenStreetMap** (`amenity=cinema`) | ✅ 133 筆（實測） | ✅ 可（ODbL，需注意 share-alike） | 免費 | ⭐⭐⭐⭐ 補經緯度 |
| **Overture Maps / FSQ OS Places** | ⚠️ 台灣覆蓋未實測 | ✅ 可（CDLA-P 2.0 / Apache 2.0） | 免費 | ⭐⭐⭐ 備援 |
| **Google Places API (New)** | ✅ 佳 | ❌ **明確禁止**儲存商家名稱/地址 | 按量計費 | ⭐ 不適合建檔 |
| **場次資料（各方案）** | 見 §4 | — | 高 | ⭐ **MVP 放棄** |

---

## 3. A. 電影 metadata 資料來源

### 3.1 TMDB — 推薦主力，但**必須付費**

#### 3.1.1 zh-TW 在地化覆蓋（實測驗證 ✅）

我實際抽驗了兩部片，證實 TMDB 對台灣的在地化是**真的可用**，而非只是欄位存在：

| 驗證項目 | 《Inside Out 2》(id 1022789) | 《周處除三害》(id 1046090) |
|---|---|---|
| zh-TW 片名 | 腦筋急轉彎2 | 周處除三害 |
| zh-CN 片名 | 头脑特工队2 | 周處除三害 |
| zh-HK 片名 | 玩轉腦朋友 2 | 周處除三害 |
| TW 上映日 | 2024-06-13（Theatrical） | 2023-10-06（Theatrical） |
| TW 分級 | `0+`（＝普遍級） | `15+`（＝輔15級） |
| zh-TW 簡介 | ✅ 有 | ✅ 有（另有 tagline「命到盡頭，以惡除惡」） |

**關鍵發現**：TMDB 的 `zh-TW` / `zh-CN` / `zh-HK` 是**三個獨立條目**，台灣譯名不會被中國譯名污染（「腦筋急轉彎」vs「头脑特工队」是最好的證明）。`release_dates` 端點確實有 `iso_3166_1: "TW"` 的條目，且**帶有台灣分級**，可直接對應到你的資料模型。

- 來源：[themoviedb.org/movie/1022789/translations](https://www.themoviedb.org/movie/1022789/translations)、[/releases](https://www.themoviedb.org/movie/1022789/releases)、[movie/1046090/translations](https://www.themoviedb.org/movie/1046090/translations)、[/releases](https://www.themoviedb.org/movie/1046090/releases)（擷取 2026-09-05）
- 官方文件亦確認 `/movie/{id}/translations` 範例含 `iso_639_1:"zh"` + `iso_3166_1:"TW"`，`/movie/{id}/release_dates` 範例含 `"iso_3166_1":"TW"`：[developer.themoviedb.org/reference/movie-translations](https://developer.themoviedb.org/reference/movie-translations)、[movie-release-dates](https://developer.themoviedb.org/reference/movie-release-dates)
- ⚠️ **注意**：這是抽樣驗證，**不代表長尾小眾片、影展片的 zh-TW 覆蓋率同樣完整**。這正是需要「政府開放資料 + UGC」補位的原因（見 §6）。

#### 3.1.2 Rate limit（現況）

官方 rate-limiting 頁（`dateModified: 2025-10-20`）原文：

> "📘 Legacy Rate Limits: As of December 16, 2019, we have disabled the original API rate limiting (40 requests every 10 seconds.) ... While our legacy rate limits have been disabled for some time, we do still have some upper limits in place to prevent abuse of the service. Which are somewhere in the **40 requests per second** range. This limit could change at any time so be respectful of the service..."

> 中譯：2019-12-16 起已停用原本「每 10 秒 40 次」的舊限制。但仍有防濫用的隱性上限，**大約每秒 40 次請求**，且隨時可能調整。

TMDB 員工 Travis Bell (STAFF) 於 2026-04-01 補充：

> "The only restriction in place is an **IP based rate limit of around 40 requests per second**. This is not an API key based rate limit, it's only rate limited by the requesting IP address."

> 中譯：唯一的限制是**以 IP 為單位、約每秒 40 次**的速率限制；這不是以 API key 計算，而是以請求來源 IP 計算。

- 來源：[developer.themoviedb.org/docs/rate-limiting](https://developer.themoviedb.org/docs/rate-limiting)、[themoviedb.org/talk/69cbf4f91b914f0e9542a772](https://www.themoviedb.org/talk/69cbf4f91b914f0e9542a772)（擷取 2026-09-05）

#### 3.1.3 商業授權 — **本次調研最關鍵的一節**

**(a) 標準（免費）授權明文排除商業使用。** API Terms of Use（最後更新 2023-10-20）原文：

> "The license in Paragraph 1.A above **does not permit any commercial use** of TMDB, the TMDB APIs, or TMDB Content. Selling, leasing, or sublicensing the TMDB APIs, access to the TMDB APIs, or TMDB Content, or **deriving revenues from the use or provision of** TMDB, the TMDB APIs, or TMDB Content, for commercial or monetary gain, directly or indirectly, is, for the purposes of these terms and conditions, considered a commercial use and is only permitted under a **separate written agreement** between You and TMDB."

> 中譯：上述免費授權**不允許任何商業使用**。出售、出租、轉授權 TMDB API 或內容，或直接/間接**從 TMDB 內容的使用中獲取營收**，均構成商業使用，**只有在另立書面協議下才被允許**。

**(b) 條款明文列舉的「商業使用」情境，幾乎是為本專案量身訂做的反面教材：**

> "**Charging users a fee for Your Application**, or a 3rd party's Application, that includes some form of integration with, or use of, TMDB, the TMDB APIs, or TMDB Content."
>
> "Operating a website that **generates revenue through charging users for access to content**, or through recommend content, such as **movies**, television shows and music, in connection with, or due, to Your use of TMDB..."

> 中譯：向使用者收費、且整合了 TMDB 內容的 App → 商業使用。營運一個透過向使用者收費取得內容存取權（明確舉例「**電影**」）的網站 → 商業使用。

**→ 結論：「會員可訂閱付費的電影日記 SaaS」100% 落入 TMDB 定義的商業使用。免費 developer key 不能用。**

**(c) 但是——商業方案是自助的，而且不貴。** TMDB 員工 Travis Bell (STAFF) 的近期公開發言：

- 2026-02-06：「If you decide in the future to monetize your project (ads, or other paid features) then you will need to upgrade to our paid subscription which is **$149/mo**.」
- 2026-04-01：「$149/month for entities with **less than $1 million in annual revenue**」；超過 $1M 需洽業務取得客製報價。
- 2026-07-07：「If you are earning revenue from our service and/or data, then it counts as commercial.」「our **$149/mo** plan would be the correct one.」「**Signing up is completely self serve** if you decide to continue.」

> 中譯：只要你的專案有營收（廣告、付費功能、一次性買斷都算），就必須升級到 **$149/月** 的付費訂閱；年營收低於 100 萬美元者適用此價；**訂閱流程完全自助**。

- 來源：[talk/697df2a0576e95a402e4e71e](https://www.themoviedb.org/talk/697df2a0576e95a402e4e71e)（2026-02-06）、[talk/69cbf4f91b914f0e9542a772](https://www.themoviedb.org/talk/69cbf4f91b914f0e9542a772)（2026-04-01）、[talk/6a47e0462281f2fc02b86a4b](https://www.themoviedb.org/talk/6a47e0462281f2fc02b86a4b)（2026-07-07）
- ⚠️ **矛盾點**：官方 FAQ 頁（最後更新 2025-10-07）仍寫「請聯繫 sales@themoviedb.org」，未提及自助訂閱或 $149 價格（[developer.themoviedb.org/docs/faq](https://developer.themoviedb.org/docs/faq)）。自助訂閱頁 `https://www.themoviedb.org/subscribe` 需登入（我實測回傳 **HTTP 401**），故**「$149/月」這個數字我只能透過 STAFF 論壇發言驗證，未能從公開定價頁逐字確認**。實作前請登入自行核對。

**(d) 其他必須遵守的義務：**

| 義務 | 原文 | 中譯 |
|---|---|---|
| 標誌與聲明 | "You must use the TMDB logo to identify Your use of TMDB... must be **less prominent** than the logos or marks that primarily describe or identify Your Application" | 必須顯示 TMDB 標誌，且其視覺重要性須**低於**你自家品牌標誌 |
| 免責字樣 | "This [website, program, service, application, product] uses TMDB and the TMDB APIs but is **not endorsed, certified, or otherwise approved** by TMDB." | 必須加註「本產品使用 TMDB API，但未經 TMDB 背書或認證」 |
| **快取上限** | 禁止 "Cache, for **longer than 6 months**, any information obtained through or from TMDB or the TMDB APIs." | **禁止快取超過 6 個月** — 這直接影響你的同步排程設計 |
| 禁止衍生 | "Make derivatives of the TMDB APIs or TMDB Content" | 不得製作衍生物 |
| 禁止 AI 訓練 | "Training or validating a machine learning or artificial intelligence system... using TMDB content" | 不得用 TMDB 內容訓練/驗證 AI 模型 |

- 來源：[themoviedb.org/api-terms-of-use](https://www.themoviedb.org/api-terms-of-use)（Last updated: October 20, 2023；擷取 2026-09-05）

> **⚠️ 架構警訊**：「6 個月快取上限」意味著你**不能**把 TMDB 資料當成永久本地資料庫。你的同步排程必須至少每 6 個月刷新一次所有已快取的 TMDB 內容，或設計成「本地只存 TMDB id + 你自己的資料，metadata 於顯示時取用並定期刷新」。這也是為什麼**台灣官方開放資料（可永久保存）應該作為主鍵骨幹**，TMDB 作為可刷新的裝飾層。

#### 3.1.4 Letterboxd 確實使用 TMDB

Letterboxd 官方「Film data」頁面聲明：

> "All film-related metadata used in Letterboxd, including actor, director and studio names, synopses, release dates, trailers and poster art is supplied by **The Movie Database (TMDB)**. Letterboxd uses the TMDB API but is not endorsed or certified by TMDB."

且其補完機制是：**使用者要新增遺漏的電影或修正錯誤，必須到 TMDB 上編輯**，變更會在約 30 小時內同步到 Letterboxd。

- 來源：[letterboxd.com/about/film-data/](https://letterboxd.com/about/film-data/)、[Letterboxd 支援文件](https://support.letterboxd.com/hc/en-us/articles/15269025512847-Where-does-Letterboxd-get-its-film-data-from)
- ⚠️ **未能逐字驗證**：letterboxd.com 對自動化抓取回傳 **HTTP 403**（我以 WebFetch 嘗試兩個 URL 皆被擋），上述引文取自搜尋引擎對該官方頁面的摘錄。建議用瀏覽器自行複核。
- 💡 **推論（非事實）**：Letterboxd 有 Pro/Patron 付費訂閱，卻公開使用 TMDB API，**合理推測其已與 TMDB 簽有商業協議**。這反向佐證了「付費商業授權 → 可做 Letterboxd-like 產品」這條路是通的。

#### 3.1.5 自動化同步的兩個關鍵端點（架構用）

| 端點 | 用途 | 限制 |
|---|---|---|
| **Daily ID Exports** `https://files.tmdb.org/p/exports/{type}_ids_MM_DD_YYYY.json.gz` | 每日全量 ID 清單（movie / tv_series / person / collection / keyword 等），JSON Lines 格式 | 每日 UTC 07:00 產出、08:00 可取；保留 3 個月；官方稱「There is currently **no authentication** on these files」 |
| **Movie Changes** `GET /3/movie/changes?start_date=&end_date=&page=` | 增量同步：回傳期間內有異動的 movie id | **一次最多查 14 天**；每頁 100 筆；需 Bearer token |

- 來源：[developer.themoviedb.org/docs/daily-id-exports](https://developer.themoviedb.org/docs/daily-id-exports)、[reference/changes-movie-list](https://developer.themoviedb.org/reference/changes-movie-list)（擷取 2026-09-05）

---

### 3.2 OMDb API — ❌ 授權上直接排除

- 官方首頁逐字聲明：「All content licensed under **CC BY-NC 4.0**.」——**NC = NonCommercial（非商業）**。付費訂閱 SaaS 屬商業使用，**授權條款本身即禁止**。
- 另一段逐字聲明：「all content and images on the site are contributed and maintained by our users」「**This site is not endorsed by or affiliated with IMDb.com.**」——OMDb 官方刻意撇清與 IMDb 的關係，並宣稱資料由使用者維護。
- 免費層：「FREE! (**1,000 daily limit**)」；Poster API「is only available to patrons」。
- 來源：[omdbapi.com](https://www.omdbapi.com/)、[omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)（擷取 2026-09-05）
- ⚠️ **未能驗證**：Patreon 各級距的具體金額與每日額度（`patreon.com/join/omdb` 遭 Cloudflare 阻擋）。網路流傳的「$1 = 10 萬次/日」等數字**未經官方頁面證實**。

> **結論：不要用。** 即使升級 Patreon 也只是提高請求次數，並未改變 CC BY-NC 這條資料授權。

### 3.3 IMDb — ❌ 免費版禁止商業；商業版價格不現實

**免費 Datasets（datasets.imdbws.com）**：

> "Subsets of IMDb data are available for access to customers for **personal and non-commercial use**."

IMDb Conditions of Use 進一步強化：

> "The IMDb Services or any portion of such services **may not be reproduced, duplicated, copied, sold, resold, visited, or otherwise exploited for any commercial purpose** without express written consent of IMDb."

> 中譯：未經 IMDb 書面明示同意，不得為任何商業目的重製、複製、販售或以其他方式利用 IMDb 服務。

- 來源：[developer.imdb.com/non-commercial-datasets/](https://developer.imdb.com/non-commercial-datasets/)（301 導向 [data.imdb.com/non-commercial-datasets/](https://data.imdb.com/non-commercial-datasets/)）、[imdb.com/conditions/](https://www.imdb.com/conditions/)

**商業版：IMDb Essential Metadata（透過 AWS Data Exchange）** — 兩個獨立產品頁交叉驗證，定價一致：

> 12-month contract — "Product Access" — **$150,000.00 / 12 months**
> Usage-based — "Usage per 100 bytes" — **$0.00000093**
> "Final price subject to specific licensed use case."

- 來源：[AWS Marketplace – IMDb Essential Metadata (API)](https://aws.amazon.com/marketplace/pp/prodview-wdqq4hg3bcbws)、[(Bulk data)](https://aws.amazon.com/marketplace/pp/prodview-yeuyizioqmfsy)（擷取 2026-09-05）

> **結論：$150,000/年的門檻對個人 SaaS 完全不現實。** 但 **IMDb ID (`tt` 開頭) 本身只是識別碼**，可透過 TMDB 的 `external_ids` 合法取得並用於跨系統對照。

### 3.4 Trakt.tv — ⚠️ 灰色地帶

- 官方 Terms 原文：「Trakt grants you a limited... right to access and use the Site and the other Services to which you have subscribed for your **personal, non-commercial use**.」
- 但 Trakt 工作人員在官方論壇回覆：「There is **no restriction** to use the Trakt API for commercial use.」
- **書面條款與客服口頭說法直接矛盾。** 若要商用，必須以 email 取得書面確認，不能依賴論壇貼文作為法律依據。
- Trakt 的圖像資料本身亦來自 TMDB / TVDB / Fanart.tv，等於繞一圈仍要面對 TMDB 條款。
- 來源：[app.trakt.tv/terms](https://app.trakt.tv/terms)、[forums.trakt.tv/t/asking-about-api-commercial-uses-on-free-plan/99367](https://forums.trakt.tv/t/asking-about-api-commercial-uses-on-free-plan/99367)
- **建議用途**：僅作為「使用者從 Trakt 匯入紀錄」的相容性用途，不作為 metadata 來源。

### 3.5 Wikidata / Wikipedia — CC0，最自由的對照表

- **Wikidata 內容為 CC0**（公眾領域捐棄），是所有方案中授權最寬鬆的，可自由商用、無需標示。Wikipedia **條文文字**則是 CC BY-SA 4.0（具傳染性），因此**只可取用「事實」（片名、ID、日期），不要整段複製條文敘述**。
- 關鍵屬性：`P345` = IMDb ID、`P4947` = TMDB movie ID、`P577` = 發行日期。可用 SPARQL 一次撈出 TMDB↔IMDb↔中文片名的對照。
- 定位：**輔助對照層**，用於補 TMDB 缺漏的 zh-TW 片名、以及建立跨系統 ID 映射。不建議當主要 metadata 來源（覆蓋率與即時性都不如 TMDB）。
- 詳見 §5 對 SPARQL 端點使用政策的說明。

### 3.6 政府開放資料 — **台灣在地資料的權威骨幹（本次最大收穫）**

#### 3.6.1 「電影片分級及相關資訊」— 官方核准片名主檔 ⭐

| 項目 | 內容 |
|---|---|
| 資料集頁 | [data.gov.tw/dataset/59820](https://data.gov.tw/dataset/59820) ／ [opendata.culture.tw/.../584](https://opendata.culture.tw/frontsite/barrierFree/openDataDetail/584) |
| 提供機關 | 文化部影視及流行音樂產業局 (BAMID) |
| 更新頻率 | **每 1 年**（詮釋資料最後更新 2026/06/03） |
| 授權 | **政府資料開放授權條款-第 1 版**（免費，可商用） |
| 涵蓋 | 民國 104 年（2015）～ **113 年（2024）**，共 10 個年度 CSV |
| 資料量 | 113 年檔案 **805 筆** |

**實測欄位（我實際下載 113 年 CSV 驗證）**：

```
年度, 分級證明字號, 級別, 中文片名, 原文片名, 國別, 語言, 出品公司, 映演時間
113, 局影外第113002號, 輔12, 愛愛愛上你, ANYONE BUT YOU, 美國, 英語,
     SONY PICTURES RELEASING INTERNATIONAL CORPORATION., 1 時 43 分 24 秒
```

**為什麼這個資料集是關鍵**：

- **`原文片名` 欄位 100% 填充率**（805/805 筆實測）→ 這讓「台灣片名 → TMDB」的比對不必依賴中文模糊比對，可直接用**原文片名 + 年度**去打 TMDB `search/movie`，準確率遠高於中文 fuzzy match。這解決了你最擔心的 ID 對照難題。
- **`分級證明字號` 是天然穩定主鍵**（如 `局影外第113001號`），且前綴自帶片源分類：實測 113 年為 `局影外`（外片）656、`局影本`（國片）112、`局影港`（港片）26、`局影陸`（陸片）11。
- **`國別` 欄位可直接對應你現有的 `area` 欄位**（實測 top10：美國 193、日本 182、中華民國 112、韓國 76、法國 36…）。
- `級別` 實測分布：普 303、護 180、輔12 145、輔15 134、限 43。

**⚠️ 已知缺陷（實測發現，務必納入工程規劃）**：

1. **最新僅到 113 年（2024）**，查證日尚無 114 年（2025）資料 → 年度資料**有 1 年以上落差**，無法用於當期新片。當期新片請改用票房資料集（見下）。
2. **跨年份 schema 不一致**：104–109 年是 7 欄且「中文片名/外文片名」**合併在同一欄以換行分隔**；110 年起才拆成 9 欄獨立欄位。匯入需寫年度別清洗邏輯。
3. **`分級證明字號` 格式三變**：104–108 年為純數字 `104001`；109 年起為 `第109001號`；113 年為 `局影外第113001號`。
4. `映演時間` 是文字格式（`1 時 45 分 30 秒`），非數字分鐘數，需解析。
5. 無獨立「發行商」欄位（僅「出品公司」，且常混入國別文字如 `匈牙利 RELAY MOTION KFT.`）；無逐日核准日期。
6. **下載機制非標準**：`data.gov.tw` 上列的 URL（`https://www.bamid.gov.tw/OpenData.aspx?SN=E10C6A5C3B9BD8C8`）回傳的只是一層「包裝 JSON」，真正的逐年 CSV 連結藏在該 JSON 的 `相關檔案` 欄位字串中、以分號分隔。爬蟲需多解析一層。

#### 3.6.2 「全國電影票房統計數據」— 週更的當期上映片單 ⭐

| 項目 | 內容 |
|---|---|
| 資料集頁 | [data.gov.tw/dataset/94224](https://data.gov.tw/dataset/94224) |
| 提供機關 | 文化部（資料來源：行政法人國家電影及視聽文化中心 TFAI） |
| 更新頻率 | **每 7 日**（週更；詮釋資料最後更新 2026-07-07 14:42） |
| 格式 / 端點 | JSON — `https://boxofficetw.tfai.org.tw/OpenData/statistic/since2016` |
| 授權 / 費用 | **政府資料開放授權條款-第 1 版** / **免費** |
| 涵蓋起始 | 2016-01-01 起 |

**官方欄位定義**（我從 data.gov.tw metadata API 逐字取得）：

```
country          國別地區          name         電影名稱
releaseDate      上映日期          issue        發行單位
produce          製作單位          theaterCount 上映戲院數量
tickets          票房              ticketChangeRate 票房變動率
amounts          金額              totalTickets 總票房
totalAmounts     總金額
```

- 驗證方式：`GET https://data.gov.tw/api/v2/rest/dataset/94224`（HTTP 200，可正常取得，含完整 `resourceField` 定義）
- **這個資料集補足了分級資料集的時效缺口**：週更、含 `releaseDate`（台灣上映日）、`issue`（發行商）、`country`（國別）——正好是你 `MovieRecordVM` 缺的東西。

> **⚠️ 重大實作障礙（實測）**：`boxofficetw.tfai.org.tw` 網域有 **Cloudflare Bot 防護**。我以 `curl`（含瀏覽器 User-Agent）與 WebFetch 分別嘗試，**均回傳 HTTP 403「Attention Required! | Cloudflare」**。
> 這代表**排程機器直接抓取可能會被擋**。正式串接前必須實測（可能需要真實瀏覽器渲染、residential IP、或聯繫 `box.admin@tfai.org.tw` 申請白名單）。這是本方案最大的技術不確定性。

#### 3.6.3 政府資料開放授權條款第 1 版 — **商業使用完全合法** ✅

條文原文（中華民國 104 年 7 月 27 日訂定）：

> **二、授與權利**
> (一)各機關所提供之開放資料，**授權使用者不限目的、時間及地域、非專屬、不可撤回、免授權金進行利用**，利用之方式包括重製、散布、公開傳輸、公開播送、公開口述、公開上映、公開演出、編輯、改作，**包括但不限於開發各種產品或服務型態之衍生物**。
> (三)使用者依本條款規定利用開放資料，**無須另行取得各資料提供機關之書面或其他方式授權**。
>
> **三、課予義務**
> (二)使用者利用依本條款提供之開放資料，及後續之衍生物，**應以符合附件所示「顯名聲明」要求之方式，明確標示原資料提供機關之相關聲明；未盡顯名標示義務者，視為自始未取得開放資料之授權**。

**附件顯名聲明範本**：

```
提供機關／單位 [年份] [開放資料釋出名稱與版本號]
此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，
使用者於遵守本條款各項規定之前提下，得利用之。
政府資料開放授權條款：https://data.gov.tw/license
```

**對本專案的意義**：

1. 「**不限目的**」在文義上包含商業目的，且明列「開發各種產品或服務型態之衍生物」→ **付費 SaaS 使用政府開放資料完全合法，無需申請。**
2. 唯一硬性義務是**顯名標示**，且違反的後果很重：「視為自始未取得授權」。→ 產品頁面務必放上出處聲明。
3. 條款第四條(二)明示**與 CC BY 4.0 相容**。
4. 第六條免責：政府**不保證資料正確性、不負賠償責任**。→ 資料錯誤的風險由你承擔，需設計 UGC 糾錯機制。
5. 第五條：機關**得隨時停止提供**，使用者不得請求賠償。→ 這是真實的長期風險，務必自行保存歷史快照。

- 來源：[data.gov.tw/license](https://data.gov.tw/license)（擷取 2026-09-05）

#### 3.6.4 其他台灣資料集（已查證的坑）

| 資料集 | 結論 |
|---|---|
| [data.gov.tw/dataset/6010](https://data.gov.tw/dataset/6010)「電影」 | ⚠️ **名稱誤導**。這是文化部「藝文活動/展演」系統的電影類別（`cloud.culture.tw/.../SearchShowAction`），實質是**影展與放映活動節目表**，**不是**片名主檔。雖然是 data.gov.tw 最熱門資料集之一，但不要誤用。 |
| [data.gov.tw/dataset/7731](https://data.gov.tw/dataset/7731)「國家文化資料庫-電影」 | ⚠️ 疑似停更（詮釋資料僅到 2023-07-27），且頁面未提供直接下載 URL。**是否已下架未能確認**。 |
| 國家電影及視聽文化中心 (TFAI) | 官網有 Cloudflare 防護，多數頁面**未能驗證**。其[開放博物館](https://openmuseum.tw/museum/tfai)為策展式陳列，非結構化 API。 |
| TFAI 開放博物館授權 | ⚠️ **逐件不同授權**（PDM/CC0/CC BY/CC BY-NC/權利不明混雜）。CC BY-NC 系列明確「不得為商業使用」。若要用館藏劇照/海報，**必須逐筆檢查授權標示**，不可假設全站可商用。來源：[openmuseum.tw/howto](https://openmuseum.tw/howto) |
| 經濟部商業登記 | 無現成的「電影片映演業」專屬資料集，但可用「公司登記基本資料」API 以營業項目代碼篩選（含**負責人**欄位，可補影視局名單之缺）。⚠️ **確切營業項目代碼未能驗證**（[gcis.nat.gov.tw/cod/](https://gcis.nat.gov.tw/cod/) 為 JS 應用，無法程式化查詢）。 |

---

## 4. B. 台灣電影院與場次資料來源

### 4.1 影城清單 — ✅ **已解決，而且免費**

#### 4.1.1 影視局「全國電影院資料」（主力方案）

| 項目 | 內容 |
|---|---|
| 資料集頁 | [data.gov.tw/dataset/22213](https://data.gov.tw/dataset/22213) |
| 提供機關 | 文化部影視及流行音樂產業局 |
| 更新頻率 | **每 1 年**（詮釋資料更新 2026-08-25） |
| 授權 / 費用 | **政府資料開放授權條款-第 1 版** / 免費 |
| 涵蓋 | 2016 ～ **2025** 年，共 10 個逐年 CSV |
| 入口 | `https://www.bamid.gov.tw/OpenData.aspx?SN=E6C57FC155564DEB`（回傳包裝 JSON，真正 CSV 連結在 `相關檔案` 欄位） |

**我實際下載並解析 2025 年 CSV 的結果**：

```
欄位：事業名稱, 公司名稱, 統一編號, 廳數, 地址, 電話
筆數：107 家    總廳數：932 廳    編碼：UTF-8 with BOM

範例：
國賓大戲院,國賓企業股份有限公司,15324301,3,台北市成都路88號,(02)23611223
台北信義威秀影城,威秀影城股份有限公司信義分公司,16431011,15,台北市信義區松壽路18號2、3樓， 20號3樓,(02)87805566
南港LaLaport威秀影城,威秀影城股份有限公司南港分公司,60745583,17,臺北市南港區經貿二路131號5、6樓,(02)27851688
```

**縣市分布（實測）**：台北市 25(+臺北市 5)、新北市 13、台中市 13、高雄市 10、桃園市 9、台南市 7(+臺南市 2)、嘉義市 3、新竹市/南投縣/雲林縣/屏東縣/宜蘭縣/花蓮縣/金門縣 各 2、基隆市/新竹縣/苗栗縣/彰化縣/台東縣/澎湖縣 各 1。

**交叉驗證** ✅：影視局統計月報「統計至 114 年 12 月底止…電影片映演業 **104 家 932 廳**」——**廳數 932 完全吻合**我從 CSV 算出的總和，家數略有出入（統計基準不同）。這給了我們對資料正確性的高度信心。
- 來源：[stat.moc.gov.tw 電影片映演業統計](https://stat.moc.gov.tw/ImportantPointer_LatestDownload.aspx?sqno=30)（⚠️ 該 PDF 使用 CID 字型，我**未能**在本機解析出內文，數字取自搜尋引擎對該 PDF 的索引內容，建議自行下載複核）

**為什麼這個資料集解決了你的問題**：

1. **全台只有 107 家影城** → 「一次性建檔」的工作量是**一個下午**，不是一個工程專案。「人工維護會擺爛」的擔憂在這個量級根本不成立。
2. **`統一編號` 是天然穩定主鍵** → 比用影城名稱字串比對可靠得多，且可與經濟部商業登記 API 串接補上負責人等資訊。
3. **`事業名稱`（對外營業名稱，如「國賓大戲院」）與 `公司名稱`（登記法人全銜，如「國賓企業股份有限公司」）分離** → 你的 UI 應顯示 `事業名稱`，內部用 `統一編號` 當 key。

**⚠️ 已知資料品質問題（實測）**：

- **縣市名稱不一致**：「台北市」與「臺北市」混用（25 vs 5 筆）、「台南市」與「臺南市」混用 → 匯入時必須正規化。
- ~~**部分欄位空白**：威秀等連鎖店的 `公司名稱`、`統一編號`、`電話` 有空值。~~ **【2026-09-05 複核修正：此描述有誤】** 對 2025 年 CSV 重新實測，`事業名稱`/`公司名稱`/`統一編號`/`廳數`/`地址`/`電話` **全部 107 筆皆無空值**，且 `統一編號` **零重複**。連鎖店每家分店都有獨立統編與分公司登記名（如 `台北信義威秀影城` → `16431011` / 威秀影城股份有限公司信義分公司）。→ **`統一編號` 可直接當主鍵，無需 fallback 策略。**
- **名稱有前後空白**：實測 2025 年共 2 筆 —— `台中大遠百威秀影城 `（尾端多一空格）與 ` in89駁二電影院`（開頭多一空格）。匯入時一律 `.trim()`。
- **無經緯度** → 需自行地理編碼（見下）。
- **無「廳別」層級資料**（沒有各影廳名稱、座位數、是否 IMAX/4DX）→ 你 `MovieRecordVM` 的 `version`（3D/IMAX）欄位仍需靠 UGC 或影城官網。
- **跨年份 schema 不穩定**：2016 年有 `縣市`+`備註`（8 欄）；**2020 年反而拿掉地址與電話**、改成 `設立年份`（7 欄）；2025 年 6 欄。→ 只用最新年度即可，不要試圖合併所有年度。
- **無「負責人」欄位**（所有年度皆無）。

#### 4.1.2 補經緯度：OpenStreetMap（建議）

政府 CSV 只有地址沒有座標。補救方案：

**OSM 實測數據**：以 Overpass API 實際查詢台灣境內 `amenity=cinema`，得 **nodes 102 + ways 30 + relations 1 = 133 筆**（查詢時間 2026-09-05）。

```overpassql
[out:json][timeout:60];
area["ISO3166-1"="TW"][admin_level=2]->.taiwan;
(
  node["amenity"="cinema"](area.taiwan);
  way["amenity"="cinema"](area.taiwan);
  relation["amenity"="cinema"](area.taiwan);
);
out center tags;
```

**ODbL 授權對 SaaS 的影響（重要，且是好消息）**：

ODbL 的 share-alike 只綁定「**Derivative Database**」。官方條款 4.5：

> "**4.5 Limits of Share Alike.** (a) … **You are not required to license Collective Databases under this License if You incorporate this Database or a Derivative Database in the collection**…; (b) Using this Database… as part of a Collective Database to create a Produced Work **does not create a Derivative Database**…; and (c) **Use of a Derivative Database internally within an organisation is not to the public**…"

OSMF 官方社群指引進一步明確化：

> "An OSM dataset and a non-OSM dataset combined in a single database will be considered **independent** (and thus form a **Collective Database** rather than a Derivative Database) so long as the data used for a particular data type is either all OSM or all non-OSM within the same regional cut."

> 中譯：只要「同一地區＋同一種資料類型」不是 OSM 與非 OSM 混雜，就視為獨立的 Collective Database，**不觸發 share-alike**。

- 來源：[opendatacommons.org/licenses/odbl/1-0/](https://opendatacommons.org/licenses/odbl/1-0/)、[OSMF Collective Database Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)、[Horizontal Map Layers Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Horizontal_Map_Layers_-_Guideline)

> **實務結論**：**你不需要開源整個資料庫。** 但為了安全，建議：把 OSM 來源的座標存在**獨立欄位/獨立表**（如 `cinema_geo_osm`），與政府資料來源的 `cinema`（名稱/地址/統編）分開，不要互相融合改寫；對外公開時附上 `© OpenStreetMap contributors`。
> **更保守的替代方案**：直接對 107 筆地址做一次性地理編碼，把座標視為自己產生的資料，完全繞開 ODbL。107 筆在任何 geocoder 的免費額度內都做得完。

#### 4.1.3 ❌ Google Places API — **不能用來建檔**

Google Maps Platform Terms of Service §3.2.3 原文：

> "**(a) No Scraping.** Customer will not export, extract, or otherwise scrape Google Maps Content for use outside the Services. For example, Customer will not: … **(iii) copy and save business names, addresses, or user reviews**…"
>
> "**(b) No Caching.** Customer will not cache Google Maps Content except as expressly permitted under the Maps Service Specific Terms."
>
> "**(d) No Re-Creating Google Products or Features.** … **(iii) use the Google Maps Core Services in a listings or directory service**…"
>
> "**(e) No Use With Non-Google Maps.** … **(i) display or use Places content on a non-Google Map**…"

Maps Service Specific Terms §14（Places API 專屬）：

> "**14.3 Caching.** Customer may temporarily cache latitude and longitude values from the Places API for up to **30 consecutive calendar days**, after which Customer must delete the cached latitude and longitude values."

Places 政策頁：

> "…the **place ID** … is **exempt from the caching restrictions**. You can therefore store place ID values **indefinitely**."

> 中譯總結：**(a)(iii) 明文禁止「複製並儲存商家名稱、地址」**；經緯度只能快取 **30 天**；**只有 place_id 可永久儲存**；且禁止把 Places 內容顯示在非 Google 地圖上，並禁止用於「名錄/目錄型服務」。

- 來源：[cloud.google.com/maps-platform/terms/](https://cloud.google.com/maps-platform/terms/)、[maps-service-terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)、[Places 政策](https://developers.google.com/maps/documentation/places/web-service/policies)（擷取 2026-09-05）

> **結論：一個「電影院資料庫」正是 Google 條款點名禁止的 "listings or directory service"。** 幸好我們有政府開放資料，完全不需要冒這個險。

#### 4.1.4 其他 POI 來源（備援）

| 來源 | 授權 | 可永久儲存 | 台灣覆蓋 |
|---|---|---|---|
| **Foursquare OS Places** | **Apache 2.0**（"The Foursquare OS Places dataset… is licensed under the Apache License, Version 2.0"） | ✅ 可 | ⚠️ **未能驗證**（官方僅稱 200+ 國家） |
| **Overture Maps Places** | CDLA-Permissive 2.0 / Apache 2.0，約 7,400 萬筆（2026-08 版） | ✅ 可 | ⚠️ **未能驗證**（未實測 DuckDB 查詢） |
| **Mapbox** | 明文禁止 "develop a general database of points-of-interest… or addresses"；POI Results 只能配合 Mapbox 地圖 | ❌ 受限 | — |
| **HERE / TomTom** | ⚠️ **未能驗證**（條款頁 404 或無 Places 專屬條款） | ? | — |

- 來源：[opensource.foursquare.com/places-notice-txt/](https://opensource.foursquare.com/places-notice-txt/)、[docs.overturemaps.org/guides/places/](https://docs.overturemaps.org/guides/places/)、[Mapbox Product Terms (Oct 1, 2025) PDF](https://cdn.prod.website-files.com/609ed46055e27a02ffc0749b/68dddd2815cb3d82685f0096_Mapbox%20Product%20Terms%20(October%201,%202025).pdf)

---

### 4.2 場次 (showtimes) — ❌ **最難、最貴、MVP 應直接放棄**

#### 4.2.1 國際商業供應商：**沒有一家能公開確認覆蓋台灣**

| 供應商 | 台灣覆蓋 | 取得方式 | 驗證狀態 |
|---|---|---|---|
| **MovieGlu** | ⚠️ **未能驗證**。官方僅稱 "we cover over **125 countries**"，**沒有公開國家清單**；API 文件的 `territory` header 範例只給 `"UK"`，且說明「evaluation API 只能存取你申請 key 時選定的那個國家」→ 唯一確認方式是申請 key 或問業務 | 全 "Contact us"，五種計價類型皆無公開數字，48 小時內回覆 | 已驗證「無公開台灣證據」 |
| **Gracenote (Nielsen)** | ❌ **明確不含台灣**。官方文件原文：「Returns a list of showtimes for specified movie in local **US and Canadian** theatres」，地理參數只收美加郵遞區號/經緯度 | 有 R&D / Commercial 兩級，可自助註冊 | ✅ 已驗證僅美加 |
| **Internet Video Archive (IVA)** | ❌ 產品定位為 "**North American** movie showtimes" | 已併入 Fabric Data；文件需登入（HTTP 401） | 部分驗證 |
| **Fandango API** | ❌ 僅美加，用 5 碼美國郵遞區號篩選 | — | ✅ 已驗證 |
| **International Showtimes API** | ⚠️ **未能驗證**。宣稱 120+ 國家、25,000+ 影城，territories 頁只列大區塊（含 "**East Asia**"），**未點名台灣** | 需 API key 才能查 Countries endpoint | 未能驗證 |
| **TMDB** | ❌ **不提供場次**（FAQ 全文無 showtimes/cinema/theater 字樣） | — | ✅ 已驗證 |
| **Google 電影場次** | ❌ 獨立站 google.com/movies 已於 **2016 年 11 月**關閉，此後只在搜尋結果面板呈現，**從未開放第三方 API** | — | ✅ 已驗證 |

- 來源：[movieglu.com/about/](https://movieglu.com/about/)、[movieglu.com/pricing/](https://movieglu.com/pricing/)、[developer.movieglu.com](https://developer.movieglu.com/)、[Gracenote movie_showtimes 文件](https://developer.tmsapi.com/docs/read/data_v1_1/movies/movie_showtimes)、[developer.themoviedb.org/docs/faq](https://developer.themoviedb.org/docs/faq)、[TechCrunch: Google quietly shutters standalone Google Showtimes site (2016-11-07)](https://techcrunch.com/2016/11/07/google-quietly-shutters-standalone-google-showtimes-movie-site/)

#### 4.2.2 台灣各院線自家端點（實測 robots.txt 與頁面結構）

| 院線 | robots.txt 實測結果 | 頁面結構 | 難度 |
|---|---|---|---|
| **秀泰** showtimes.com.tw | ✅ HTTP 200，**明確允許**：`User-agent: *` / `Allow: /`，僅 `Disallow: /ticketing/cart/`、`/member/` 等交易頁 | 🌟 **SSR + 內嵌 schema.org JSON-LD** | **最低** |
| **威秀** vscinemas.com.tw | ❌ HTTP 403（Akamai edgesuite），**連 robots.txt 都拿不到**，首頁與場次頁同樣 403 | 無法評估 | **最高** |
| **國賓** ambassador.com.tw | ⚠️ HTTP 302 導向無關頁（**無 robots.txt 檔**）；訂票子網域 404 | SSR HTML，場次時間直接寫在 HTML，無 JSON-LD、無明顯 AJAX | 中 |
| **新光** skcinemas.com | ⚠️ HTTP 200 但回傳的是**首頁本身**（**無 robots.txt 檔**） | ASP.NET MVC；有 `api.skcinemas.com` 子網域但連線失敗 | 中 |
| **in89** in89cinemax.com | ⚠️ 同上，回傳首頁（**無 robots.txt 檔**）。舊網域 in89.com.tw 已 301 | Vue.js CSR，HTML 中只有 `{{stage.theater_film_name}}` 樣板變數，**API 端點藏在編譯後 JS 中** | 中高 |
| **美麗華** miramarcinemas.tw | ⚠️ HTTP 302 導向 404 頁（**無 robots.txt 檔**） | 老式 SSR，時間字串直接在 HTML | 中 |
| **Cinemark 台灣** cinemark.com.tw | — | ❗ **該網域已不是影城網站**（回傳 Palo Alto GlobalProtect VPN 登入頁 / Cloudflare 403） | — |

> 🔎 **重要市場情報**：**Cinemark／喜滿客在台灣已無營運中影城**——最後一間西門町「絕色影城」於 **2024-03-31 結束營業**。可從資料源清單直接排除。（⚠️ 此為多家台灣媒體報導交叉比對，**未逐字核對原始新聞**）

**秀泰的 JSON-LD 實測範例**（2026-09-05 實際抓到）：

```json
{"@context":"https://schema.org","@type":"ScreeningEvent",
 "name":"愛你致死不渝","startDate":"2026-09-04T14:20:00+08:00",
 "videoFormat":"數位 英語",
 "url":"https://www.showtimes.com.tw/ticketing/cart/selectTicketTypes/4771056",
 "workPresented":{"@type":"Movie","name":"愛你致死不渝"},
 "location":{"@type":"MovieTheater","name":"台中站前秀泰影城","address":"台中市東區南京路76號"}}
```

> 秀泰把 `ScreeningEvent` 結構化資料主動放進頁面，**本意就是給機器讀的（SEO）**，且 robots.txt 明確允許。這是全台唯一「半公開場次資料源」。但**只有秀泰**——你無法用單一院線的場次撐起一個全國性產品。

#### 4.2.3 聚合站與售票平台

| 站點 | robots.txt 實測 | 結論 |
|---|---|---|
| **開眼 atmovies.com.tw** | HTTP 200，但**只定義 Mediapartners-Google / Googlebot / GrapeshotCrawler 三種 UA，沒有 `User-agent: *` 區塊** | 對未具名爬蟲無明文限制（**但這不等於法律授權**）。無公開 API。使用條款頁多次嘗試皆 404，**未能驗證** |
| **Yahoo 奇摩電影** | 舊網域 301 導向 `tw.news.yahoo.com/entertainment/`。`tw.tv.yahoo.com/robots.txt` **明文封鎖** `ClaudeBot`、`Claude-Web`、`GPTBot`、`ChatGPT-User`、`PerplexityBot`、`Scrapy` 等 `Disallow: /`，並封鎖 `/_td_api`、`/_remote` 等內部 API 路徑 | ❌ **態度最保守，明確拒絕** |
| **ibon** ticket.ibon.com.tw | HTTP 200，`Disallow` 交易控制頁，`Sitemap: https://ticket.ibon.com.tw/api/Sitemap/Activities`（實測回傳有效 XML） | 有電影售票分類，但**無開發者 API 文件**；部分頁面有 Cloudflare 挑戰 |
| **KKday** | ❌ Cloudflare Turnstile 攔截（連 robots.txt 都拿不到） | 無電影票 API |
| **Klook** | ✅ 明文**允許** GPTBot / ClaudeBot 等，甚至提供 `/llms.txt` | 但**未發現電影票垂直產品或 API** |
| **FamiPort** | ❌ HTTP 500 伺服器錯誤 | **未能驗證** |

---

## 5. C. 法律與授權風險摘要

### 5.1 台灣著作權法：事實不受保護，但「整批複製」有實刑風險

**第 9 條**（不得為著作權之標的）：

> 「下列各款不得為著作權之標的：一、憲法、法律、命令或公文。…三、標語及**通用之符號、名詞、公式、數表、表格、簿冊或時曆**。四、**單純為傳達事實之新聞報導**所作成之語文著作。…」

**第 7 條**（編輯著作）：

> 「就資料之**選擇及編排具有創作性**者為編輯著作，以獨立之著作保護之。編輯著作之保護，對其所收編著作之著作權不生影響。」

- 來源：[全國法規資料庫 著作權法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0070017)（擷取 2026-09-05）

**分析**：片名、上映日、場次時間這類**單純事實**本身不受著作權保護。但**編輯著作**保護「選擇及編排」的創作性——若你整批鏡像複製對方的資料庫結構，風險就出現了。

> ⚠️ **必讀判例：新北地院 111 年度智訴字第 8 號（2025-06-24）** — Lawsnote（七法）爬取「法源」法規資料庫逾 **50 萬筆**，法院認定創作性門檻極低、100% 重製構成侵權且不符合理使用，判**有期徒刑 4 年 + 2 年**、民事賠償逾 **新台幣 1 億 545 萬元**。
> **這是台灣近年最嚴厲的資料庫爬取判決，直接推翻了「事實資料隨便爬沒事」的直覺。** 關鍵差異在「**整庫、系統性、100% 重製**」。
> （來源：理律法律事務所、聯合新聞網報導；⚠️ **未取得判決書原文逐字核對**）

### 5.2 公平交易法第 25 條：**對本案最實際的風險**

> 「除本法另有規定者外，事業亦不得為其他足以影響交易秩序之**欺罔或顯失公平**之行為。」

**關鍵案例：公處字第 111070 號（2022-09-01）**「愛食記 v. 飢餓黑熊」：

> 「被處分人**抄襲他人美食網站經蒐集、整理及對應至特定餐廳之食記資料，混充為自身美食網站及 App 內容，榨取他人努力成果**，為足以影響交易秩序之顯失公平行為，違反公平交易法第 25 條規定。」處新臺幣 5 萬元罰鍰。

- 來源：[公平交易委員會](https://www.ftc.gov.tw/)處分書（擷取 2026-09-05）

**分析（最重要的一點）**：此案「非難者並非著作權侵權，而係抄襲網路連結」——**即使不構成著作權侵權，只要「榨取他人努力成果」＋「具競爭關係」，就可能違反公平法第 25 條**。

> **對你的意義**：爬取威秀/開眼（與觀影日記 App **非直接競爭關係**）的公平法風險相對低；但若你未來擴充訂票導流功能，就會與售票平台形成競爭關係，風險立刻上升。**反過來說，爬取「另一個台灣觀影日記 App」的使用者資料，風險最高。**

### 5.3 robots.txt 與 ToS 的法律效力

| 判例 | 結論 |
|---|---|
| **hiQ v. LinkedIn** | 第九巡迴（2019、2022）認定 CFAA「未經授權」不適用於公開網站爬取。但**故事沒有停在這裡**：2022-12-06 以**協議判決 (stipulated judgment)** 收場，hiQ 被判 **50 萬美元**，責任基礎確立為加州普通法的 **trespass to chattels 與 misappropriation**，另有禁制令。⚠️ 多數網路摘要停在「hiQ 贏了 CFAA」是**誤導**的。 |
| **Van Buren v. United States, 593 U.S. 374 (2021)** | 最高法院 6:3 限縮 CFAA「逾越授權存取」，僅指存取原本完全無權限的區域，不涵蓋「有權限但目的不當」。 |
| **Ryanair v. PR Aviation, CJEU C-30/14** | 歐盟法院認定：若資料庫既不受著作權也不受特殊權利保護，則**契約自由優先**，網站可用 ToS 有效限制擷取。 |
| **台灣有無 sui generis 資料庫權？** | ⚠️ **未能以官方一手來源驗證**。依學者章忠信「著作權筆記」個人網站說法，台灣**未採歐盟式特殊資料庫權**，非原創性資料庫只能靠契約、公平交易法或編輯著作保護。建議以智慧財產局文件複核。 |

**綜合風險排序（由高到低）**：
1. 🔴 **爬取有明確技術防護的站**（威秀 Akamai、Yahoo TW 明文擋 bot）→ 繞過防護會強化「惡意」認定
2. 🟠 **整庫、系統性、高頻複製**（Lawsnote 案的教訓）
3. 🟡 **與資料源具競爭關係**（公平法第 25 條）
4. 🟢 **低頻、少量、遵守 robots.txt、標示來源、不混充為自有內容**

### 5.4 各資料源的「能不能拿去做付費 SaaS」總表

| 資料源 | 判定 | 依據 |
|---|---|---|
| 台灣政府開放資料（分級/票房/影城） | ✅ **明確可行** | 「不限目的…包括但不限於開發各種產品或服務型態之衍生物」；唯一義務＝顯名標示 |
| TMDB（**付費商業訂閱**） | ✅ **明確可行** | 需 $149/月商業方案；須遵守 attribution、6 個月快取上限 |
| TMDB（免費 developer key） | ❌ **明確禁止** | 「Charging users a fee for Your Application…」即屬商業使用 |
| Wikidata | ✅ **明確可行** | CC0，等同公共領域 |
| OpenStreetMap | ✅ 可行（附條件） | ODbL；用 Collective Database 結構＋attribution 即可，不需開源全庫 |
| Foursquare OS Places / Overture | ✅ 可行 | Apache 2.0 / CDLA-Permissive 2.0 |
| Wikipedia **條文文字** | ⚠️ 灰色 | CC BY-SA 4.0 具傳染性；只取事實不取敘述即可規避 |
| Trakt.tv | ⚠️ **灰色** | 書面 ToS 寫「personal, non-commercial」，客服論壇說可商用——**矛盾未解** |
| 爬取院線場次 | ⚠️ **灰色**（秀泰相對低風險） | 見 §5.1–5.3 |
| OMDb | ❌ **明確禁止** | CC BY-**NC** 4.0 |
| IMDb 免費 Datasets | ❌ **明確禁止** | "personal and non-commercial use" |
| Google Places 建檔 | ❌ **明確禁止** | "copy and save business names, addresses" |
| 豆瓣 | ❌ 無合法管道 | API 回傳 `invalid_apikey`，需洽 bd-team@douban.com |
| 繞過 Akamai/Cloudflare 抓威秀/Yahoo | ❌ **高風險，不建議** | 見 §5.3 |

### 5.5 ⚠️ 海報與劇照的著作權風險（初版遺漏，2026-09-05 補）

> **這是整份報告中唯一「政府開放資料與 TMDB 商業授權都解決不了」的法律風險。**

#### 5.5.1 問題核心：沒有人把海報授權給你

前面確立的兩條合法路徑，**都不涵蓋海報圖片本身**：

| 授權 | 涵蓋 | **不涵蓋** |
|---|---|---|
| 政府資料開放授權條款第 1 版 | CSV 中的**文字欄位**（片名、國別、片長、影城地址…） | **完全沒有圖片**。分級與電影院資料集不含任何海報。 |
| TMDB 商業訂閱 $149/月 | 存取 API 與 TMDB Content 的**權利** | **海報的著作權**——TMDB 並不擁有它，因此無法轉授權給你。 |

電影海報在台灣著作權法下屬**美術著作**（或攝影著作），著作權人是片商／發行商，**不是 TMDB，也不是上傳者**。

**TMDB 官方論壇的自承**（Image Licenses 討論串，moderator lineker）：

> "if a photographer disagreed with his/her image being used here **we would have to take it down**."

同串版主 Samara 進一步表示：除非圖片具創用 CC 授權，否則未經權利人許可使用他人圖片即構成侵害；並提醒使用者須遵守所在國法律（歐盟尤嚴）。**該討論串後段出現實際案例：有使用者因在自己網站上使用 API 圖片，收到德國著作權人的高額請款。**

- 來源：[TMDB Talk — Image Licenses](https://www.themoviedb.org/talk/58b57d9c9251410ada00aad6)、[Clarification on non-commercial vs commercial use of TMDb images](https://www.themoviedb.org/talk/697df2a0576e95a402e4e71e)（擷取 2026-09-05）

> **結論：付了 TMDB $149/月，你買到的是「合法存取資料的權利」，不是「合法使用海報的權利」。** 這兩件事在初版報告中被混為一談。

#### 5.5.2 三種風險來源，風險程度不同

| 來源 | 說明 | 風險 |
|---|---|---|
| **(a) 熱連結 TMDB 圖片** (`image.tmdb.org`) | 圖片實際由 TMDB 伺服器送出，你只是嵌入 | 🟡 **最低**。你未重製、未散布圖檔。業界普遍做法。 |
| **(b) 自行下載後轉存到你的 CDN** | 你成為重製與公開傳輸的行為人 | 🟠 **中**。且同時受 TMDB「快取 ≤ 6 個月」條款拘束。 |
| **(c) 使用者上傳海報**（那 20% 找不到的片） | 你成為 ISP，承接使用者的侵權行為 | 🔴 **最高**，但**有法定避風港可用**（見下）。 |

> ⚠️ TMDB 條款另明文禁止「使用 TMDB 作為橫幅廣告、圖形的圖片託管服務」（"Use TMDB as an image hosting service for banner advertisements, graphics, etc."）。正常的海報顯示不在此列，但不要拿 TMDB CDN 當你自己的圖床。
> 來源：[TMDB API Terms of Use](https://www.themoviedb.org/api-terms-of-use)

#### 5.5.3 台灣的法定避風港：著作權法第六章之一

針對 (c) UGC 上傳，台灣著作權法設有 **ISP 民事免責事由**（俗稱避風港）。你的產品屬第四類「**資訊儲存服務提供者**」。

**第 90 條之 7（資訊儲存服務提供者免責要件）** ——條文原文：

> 有下列情形者，資訊儲存服務提供者對其使用者侵害他人著作權或製版權之行為，**不負賠償責任**：
> 一、對使用者涉有侵權行為**不知情**。
> 二、**未直接自使用者之侵權行為獲有財產上利益**。
> 三、經著作權人或製版權人通知其使用者涉有侵權行為後，**立即移除**或使他人無法進入該涉有侵權之內容或相關資訊。

**第 90 條之 4（適用前提，四項義務）** ——條文原文：

> 符合下列規定之網路服務提供者，適用第九十條之五至第九十條之八之規定：
> 一、以契約、電子傳輸、自動偵測系統或其他方式，**告知使用者其著作權或製版權保護措施**，並確實履行該保護措施。
> 二、以契約、電子傳輸、自動偵測系統或其他方式，告知使用者**若有三次涉有侵權情事，應終止全部或部分服務**。
> 三、**公告接收通知文件之聯繫窗口資訊**。
> 四、執行第三項之通用辨識或保護技術措施。

**第 90 條之 9（通知／取下／回復通知程序）**：取下後須轉送使用者；使用者可提出回復通知；著作權人於**10 個工作日**內未提出訴訟證明者，服務提供者應於**14 個工作日**內回復內容。

- 來源：[全國法規資料庫 著作權法第90條之4](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=J0070017&flno=90-4)、[第90條之7](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=J0070017&flno=90-7)、[第90條之9](https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=J0070017&flno=90-9)（擷取 2026-09-05）

#### 5.5.4 兩個必須現在就知道的陷阱

**⚠️ 陷阱一：第 90 條之 4 的四項義務必須「事前」建置，不能事後補。**

避風港不是自動適用的。若在侵權發生時你尚未：①告知使用者著作權保護措施、②告知三振條款、③公告接收通知的聯繫窗口——**你根本不符合適用前提，第 90 條之 7 的免責完全用不上**。

> → **這四項是 Phase 1 的法務前置作業，不是 Phase 3 的「等長大再說」。** 成本極低（服務條款條文 + 一個 `copyright@` 信箱 + 一頁公告），但漏掉的後果是整個避風港失效。

**⚠️ 陷阱二：付費訂閱制與「未直接獲有財產上利益」的緊張關係。**

第 90 條之 7 第 2 款要求「**未直接自使用者之侵權行為獲有財產上利益**」。對免費廣告制平台，實務上一般認為廣告收益非「直接」來自個別侵權行為；但**訂閱制 SaaS 若把海報顯示放在付費牆之後，是否構成「直接獲有財產上利益」，在台灣尚無明確實務見解**。

> → **這是真正需要律師意見的一點，我無法從條文推斷答案。** 保守設計：**海報顯示不設付費牆**，付費功能鎖在統計分析、匯出、社群等「與海報無關」的價值上。這樣既降低第 2 款的爭議，也不影響你的商業模式——你的差異化本來就是視覺化圖表，不是海報。

#### 5.5.5 建議的降險設計（按優先序）

1. **80% 有 TMDB 的片 → 一律熱連結 `image.tmdb.org`，不要轉存。** 風險最低，且省下全部儲存與頻寬成本。
2. **20% 找不到的片 → 海報上傳設為「選填」**，並在 UI 明示「請勿上傳您無權使用的圖片」。缺海報就用片名文字卡片，不影響核心功能。
3. **建立避風港四要件**（Phase 1 必做）：服務條款寫入著作權政策與三振條款、頁尾公告 `copyright@yourdomain` 聯繫窗口、實作取下流程。
4. **UGC 海報限縮尺寸**（如長邊 ≤ 500px），降低替代市場效果，在合理使用的權衡上較有利。
5. **禁止對已比對到 TMDB 的作品上傳海報**——沒有必要，只增加曝險。
6. **全站頁尾放置權利聲明**：海報與劇照著作權屬各該權利人所有。

---

## 6. D. 建議架構與 MVP 路線圖

> **本節已於 2026-09-05 依實測數據全面重寫。** 兩項前提改變：(1) 票房資料集經使用者決定**排除於產品範圍外**；(2) TMDB zh-TW 覆蓋率實測完成（§8.6），端到端可用率為 **80.0%** 而非原先假設的「近乎全自動」。

### 6.1 核心設計原則

> **TMDB 是主要入口，政府開放資料是校正層與影城主檔，UGC 是不可省略的第三支柱。**

⚠️ **這與本報告初版的分工相反，原因如下。** 初版主張「政府資料當骨幹、TMDB 當裝飾層」，該結論成立的前提是「週更票房資料集可用來偵測新片」。票房移出範圍後：

- 分級資料**最新僅到 113 年（2024）**，年更且有 1 年以上落差
- 使用者記錄的絕大多數是**剛看完的新片**
- → **最高頻的使用路徑上，政府資料完全缺席**

因此各層的真實職責是：

| 層 | 職責 | 為何是它 |
|---|---|---|
| **TMDB**（主要入口） | 使用者搜尋片名的第一線；海報、簡介、演職員、ID | 唯一涵蓋當期新片的來源。實測主流商業片命中 **98.4%** |
| **政府開放資料**（校正層） | ①110–113 年的**中文片名權威校正表** ②國別/片長/級別 ③**影城主檔** | 官方核准片名，可**永久保存**、免費可商用。TMDB 的中文標題實測僅 **84.4%** 與官方一致 |
| **UGC**（補完層） | 補那 20%：動漫劇場版、演唱會電影、數位修復重映 | 這三類的觀眾恰好最願意補資料 |

兩條硬性條款仍然約束架構：政府資料「不限目的、不可撤回」→ **可永久存**；TMDB「禁止快取超過 6 個月」→ **不能當永久資料庫，必須排程刷新**。

### 6.2 資料流

```
┌─ 使用者記錄一次觀影 ────────────────────────────────────────┐
│  輸入片名 →  TMDB /search/movie?language=zh-TW              │
│                     │                                        │
│         ┌───────────┴───────────┐                            │
│         ▼ 命中(~89%)             ▼ 未命中(~11%)               │
│   建立 film 記錄              「找不到？手動新增」            │
│   tmdb_id 為外部鍵             片名+年份+海報上傳             │
│         │                      → 進補完佇列                   │
│         ▼                             │                       │
│  ┌─ 政府資料校正（若該片在 110–113 年片庫中）──┐              │
│  │  · 中文片名 ← 官方核准名（覆寫 TMDB 的 16%）│              │
│  │  · 國別 / 片長 / 級別 ← 官方值              │◄─────────────┘
│  │  · permit_no 回填                          │
│  └────────────────────────────────────────────┘
│         │                                                     │
│         ▼  選擇影城（下拉，107 家，統一編號為鍵）              │
│         ▼  手填日期時間 / 影廳 / 版本 / 票價                   │
└──────────────────────────────────────────────────────────────┘

┌─ 離線排程 ──────────────────────────────────────────────────┐
│  年度：抓影視局分級 CSV（新年度釋出時）→ 批次比對 → 校正片庫  │
│  年度：抓影視局電影院 CSV → diff 影城 → 人工確認              │
│  ≤6個月：TMDB 快取刷新（條款硬性要求）                        │
│  每日：TMDB /movie/changes 增量同步已收錄片目                 │
└──────────────────────────────────────────────────────────────┘
```

> 註：初版資料流中的「國影中心週更票房 → 新片偵測」已移除。新片偵測改由**使用者搜尋行為本身**驅動——使用者查得到就直接建檔，查不到就進 UGC 佇列。這反而更省事：不需要預先匯入全台片庫，按需長出即可。

### 6.3 電影 ID 對照策略（依實測重寫）

⚠️ **初版此節的核心主張「用原文片名 + 年度即可繞開中文 fuzzy match」經實測證實過於樂觀。** 實際踩到兩個坑：

1. **年份不能當硬篩** —— 重映片的核准年 ≠ TMDB 上映年（《紅豬》核准 113 年、TMDB 1992；《千禧曼波》核准 113 年、TMDB 2001）。初版建議的 `search/movie?query=&year=` 會直接誤殺全部重映片。
2. **TMDB 的 `original_title` 常是母語，不是英文** —— 政府給 `Porco Rosso`，TMDB 存 `紅の豚`；政府給 `Ponyo on the Cliff by the Sea`，TMDB 存 `崖の上のポニョ`。單靠原文片名對不上。

**實測驗證有效的比對演算法**（v2，§8.6.1）：

```
① 雙查詢：以「原文片名」與「中文片名」分別打 /search/movie?language=zh-TW，候選取聯集
② 正規化：NFKC → 剝除版本標註 → 去標點空白
     版本標註 = (中文版|國語版|日文版|數位修復版|4K|經典重映|加長版|前篇|後篇|IMAX版…)
     ⚠️ 實測 113 年有 60 筆(7.5%) 片名內嵌此類標註，不剝除必然誤配
③ 評分：原文精確 +5 ／ 中文精確 +5 ／ 中文前綴 +3 ／ 上映年落在 ±1 年 +1.5
     ⚠️ 年份「只加分、不懲罰」——這是與初版最關鍵的差異
④ 片長交叉驗證：將「映演時間」(1 時 45 分 30 秒) 解析為分鐘，
     若與 TMDB runtime 差 > 5 分且無片名精確吻合 → 判定誤配，退回未命中
⑤ 總分 < 3 → 標記 unmatched，進 UGC 佇列（不要硬猜）
```

**片長驗證不是可選項。** 移除它會產生假陽性：《一屍到底》被配到 "Making Of One Cut of the Dead"、《貓的報恩》被配到 *Batman Returns*。實測 v1（無片長驗證）的韓國片「命中率」93.4% 中含大量誤配，v2 加入後降至誠實的 77.6%。

**⚠️ Schema 必須兩層（實測發現，初版遺漏）**

實測 113 年 805 筆中，`分級證明字號` **零重複**（可當主鍵），但 `中文片名` **有 56 組重複**——同一部片會因國語版／日語版／2D／3D 分開核准（《SPY x FAMILY CODE: White》3 張、《沙丘：第二部》2 張）。

> **805 張證明書 ≠ 805 部電影。** 若把證明書當作品，「本月看了幾部片」會重複計數。

```
film（作品）                          certificate（核准紀錄）
├─ id          PK, 內部 UUID          ├─ permit_no   PK ← 分級證明字號
├─ tmdb_id     UNIQUE, NULLABLE ★     ├─ film_id     FK → film.id
├─ imdb_id     NULLABLE               ├─ 年度 / 級別 / 版本標註
├─ title_zh    ← 政府優先, TMDB 次之   └─ 國別 / 語言 / 出品公司 / 映演時間
├─ title_orig
└─ source      enum(tmdb|gov|ugc)     ※ 一部 film 對多筆 certificate
```

★ **`tmdb_id` 必須可為 NULL**：實測 20% 的片在 TMDB 找不到，這些片只能存在於你自己的庫中。若把 `tmdb_id` 設為必填或主鍵，這 20% 直接無法入庫——**這是最容易在 schema 階段犯下、事後極難補救的錯誤。**

**三層 ID 對照表**：

| ID | 來源 | 性質 |
|---|---|---|
| `film.id` | 自建 UUID | 🔑 **你的主鍵**，唯一 100% 存在的識別碼 |
| `permit_no`（分級證明字號） | 政府開放資料 | 台灣核准紀錄鍵，永久可存，**非作品鍵** |
| `tmdb_id` | TMDB | 國際對照鍵，**可為空**（ID 本身非「內容」，可永久存） |
| `imdb_id` | TMDB `external_ids` | 跨系統對照，可為空 |

**匯入必須防禦性解析**（實測踩到的源頭資料損毀）：

| 問題 | 實測量 | 處理 |
|---|---|---|
| 原文片名被 Excel 誤判為日期（《福田村事件》= `Sep-23`） | 1/805 | 偵測 `^[A-Z][a-z]{2}-\d{2}$` 樣式 → 改用中文片名查詢 |
| 原文片名編碼損毀（`?????????????`） | 1/805 | 偵測全問號 → 改用中文片名查詢 |
| 原文片名拼寫錯誤（`INVISILBLE`、`GRIME STORY`） | ≥2/805 | 無法自動修，落入 UGC 佇列 |
| 事業名稱前後空白、地址「台/臺」混用 | 影城 CSV | 一律 `.trim()` + 全形正規化 |

**Wikidata 的定位（初版結論仍成立）**：實測全站有 `P4947`(TMDB id) 且具明確 `zh-tw` 標籤者僅 **10,438 筆（3.7%）**。→ **不能當中文片名來源**，僅用於 ID 交叉驗證。中文片名的權威來源是政府開放資料。

### 6.4 影城策略：「一次性建檔 + 年度校正 + UGC 回報」

**為什麼這招對影城有效、對場次無效**：

| 面向 | 影城 | 場次 |
|---|---|---|
| 資料筆數 | **107 家**（固定） | 每天數千筆 |
| 變動頻率 | 一年幾家開關 | **每天全部重來** |
| 官方開放資料 | ✅ 有（年更） | ❌ 完全沒有 |
| 壞掉的後果 | 少一家影城 | **整個功能報廢** |
| 維護成本 | 一年一次跑腳本 | 每天監控 7+ 個爬蟲 |

**具體做法**：

1. 一次性匯入 2025 年 CSV（107 筆）。✅ **實測資料品質優於初版描述**：`事業名稱`/`公司名稱`/`統一編號`/`廳數`/`地址`/`電話` **六欄全部零空值**，`統一編號` **零重複**——可直接當主鍵，**不需要任何 fallback 策略**（初版誤稱威秀等連鎖店統編為空，已於 §4.1.1 更正）。
2. 正規化：縣市「臺/台」統一、`事業名稱` 去前後空白（實測 2 筆：`'台中大遠百威秀影城 '`、`' in89駁二電影院'`）、`廳數` 轉數字（實測總和 932，與影視局統計月報吻合）。
3. 對 107 筆地址做**一次性**地理編碼補經緯度（量小，任何 geocoder 免費額度都夠；或用 OSM 的 133 筆 `amenity=cinema` 做比對）。**切勿用 Google Places 建檔**（§4.1.3，條款明文禁止儲存商家名稱地址、禁止用於名錄服務）。
4. 每年跑一次排程抓最新年度 CSV，**diff 出新增/消失的影城**，人工確認後更新。
5. UI 提供「回報影城資訊有誤 / 這家已歇業 / 少了這家」→ 進審核佇列。
6. 影廳層級（IMAX/4DX/幾廳）**完全靠 UGC**——你現有的 `version` 欄位本來就是使用者自填。

### 6.5 場次：**MVP 明確放棄**（結論不變）

**理由（全部有據）**：
1. 沒有任何國際供應商能公開確認覆蓋台灣（§4.2.1）
2. 唯一技術友善的本地來源只有秀泰一家（§4.2.2），撐不起全國產品
3. 威秀有 Akamai 防護、Yahoo 明文擋 bot，繞過的法律風險最高（§5.3）
4. 場次爬蟲是**每天都可能壞**的東西——這正是你最擔心的「總有一天會擺爛」

**替代設計（對觀影日記幾乎無損）**：

```
使用者記錄一次觀影：
  ① 搜尋片名        ← TMDB + 政府校正 + UGC 兜底（~100% 可完成）
  ② 選擇影城        ← 下拉選單，107 家（已解決）
  ③ 手動填日期時間   ← DateTimePicker，預設「現在」
  ④ 填影廳/版本/票價 ← 自由輸入（沿用現有 version/cost/tickets 欄位）
```

> **關鍵洞察**：Letterboxd 本身**也沒有場次功能**。「我看了什麼」是回顧性行為，不是「我要買票」的前瞻性行為。場次是「找電影看」產品（如開眼）的核心，不是「記錄看過什麼」產品的核心。

### 6.6 MVP 路線圖（依實測重寫）

#### Phase 0 — 動手前的最後驗證（約 3 天）

初版的三項中，**兩項已結案**：

- [x] ~~抽樣 100 部實測比對命中率~~ → ✅ **已完成，且未抽樣，直接跑完 805 筆**：命中 89.4%、端到端可用 80.0%（§8.6）
- [x] ~~測試票房 API 是否被 Cloudflare 擋~~ → ✅ **已排除於產品範圍外**；核心的分級與電影院資料實測 HTTP 200 無防護（§8.5）
- [ ] 🔴 **登入 `themoviedb.org/subscribe` 確認 $149/月商業方案存在且可自助訂閱** —— 唯一仍會影響可行性的未知數。我實測該頁回傳 401 無法代查，數字全部來自 TMDB 員工論壇發言。

新增（皆非阻塞，但影響 Phase 1 範圍）：

- [ ] 用同一套 v2 比對器跑 **104–112 年**分級資料，量測早期年度覆蓋率（老片與修復片比例更高，命中率預期低於 89.4%）
- [ ] 抽測 TMDB **演職員（cast/crew）中文化程度** —— §8.6 只測了片名與簡介
- [ ] 確認商業方案的實際 rate limit（免費 key 實測 8 執行緒約 3,200 次呼叫未觸發 429）

#### Phase 1 — MVP：**UGC 從第一天就是一等公民**

⚠️ **與初版最大的差異**：初版把 UGC 排在 Phase 2。實測 20% 未命中率意味著**上線第一天就有五分之一的搜尋會落空**——UGC 補完流程若不在 MVP，產品直接不可用。

- **片庫**：匯入 110–113 年分級資料（schema 已統一的年份），跑 v2 比對器建立 `film` ↔ `certificate` 兩層結構
- **影城**：匯入 107 家 + 一次性地理編碼
- **TMDB 串接**（商業訂閱）：搜尋、海報、演職員，加上必要的 attribution 與 logo
- 🔴 **「找不到這部片」流程（不可省略）**：
  - 搜尋無結果時，**不顯示錯誤**，顯示「手動新增這部片」
  - 表單：片名（中/原文）＋ 年份＋ 海報上傳（選填）＋ 國別
  - 建立 `film` 記錄（`tmdb_id = NULL`、`source = 'ugc'`），使用者立即可完成記錄
  - 後台佇列：定期重試 TMDB 比對（新片常在上映後才被建檔），命中則自動回填 `tmdb_id` 並合併
  - 選配：引導使用者去 TMDB 新增該片（Letterboxd 做法），形成正向循環
- **觀影紀錄 CRUD**：片名 → 影城 → 手填時間 → 版本/票價/心得
- **沿用現有視覺化**（月度折線、貢獻圖、時段熱力圖）作為差異化賣點 —— 這是你相對 Letterboxd 的既有優勢，不要丟掉
- 🔴 **ISP 避風港四要件（法務前置，漏了事後無法補救，§5.5.3–5.5.4）**：
  - 服務條款寫入著作權保護措施告知 ＋ **三振條款**（三次侵權終止服務）
  - 頁尾公告 **接收侵權通知的聯繫窗口**（如 `copyright@`）
  - 實作**通知／取下／回復通知**流程（10 / 14 個工作日時限）
  - 海報一律**熱連結 `image.tmdb.org`**，不自行轉存；UGC 海報設為選填、限縮尺寸
  - ⚠️ **海報顯示不要放在付費牆後**——避免觸及第 90 條之 7 第 2 款「直接獲有財產上利益」的爭議（§5.5.4 陷阱二）

#### Phase 2 — 自動化與資料品質

- **年度排程**：新年度分級 CSV 釋出 → 批次比對 → **以官方片名校正既有 `title_zh`**（實測 TMDB 中文標題僅 84.4% 與官方一致）
- **TMDB 增量同步**：`/movie/changes`（≤14 天窗口）+ Daily ID Exports 全量對帳
- 🔴 **TMDB 快取刷新排程（≤6 個月，條款硬性要求，非選配）**
- **UGC 審核後台**：合併重複作品、處理誤配回報
- **未命中佇列自動重試**：針對 `source='ugc'` 且 `tmdb_id IS NULL` 的作品定期重打 TMDB

#### Phase 3 — 社群化

- 追蹤／動態牆／評分、清單、年度回顧
- 匯入：Letterboxd CSV、Trakt（**降低轉換門檻的關鍵**）

#### Phase 4 — 場次（只有在有商業誘因時才做）

- 先只做秀泰（robots.txt 允許 + JSON-LD）當 PoC
- 或直接與院線談官方合作——比爬蟲更可持續，也是唯一能長久的路

### 6.7 三個最容易犯的架構錯誤（實測歸納）

1. **把 `tmdb_id` 設為必填或主鍵** → 20% 的片永遠無法入庫，且事後極難補救。
2. **把證明書當作品**（用 `permit_no` 當 film PK）→ 56 組重複片名導致統計重複計數。
3. **比對時把年份當硬篩** → 誤殺全部重映片與經典數位修復（《紅豬》《風之谷》《千禧曼波》《戀戀風塵》）。
4. **以為付了 TMDB $149/月就取得海報使用權** → 兩者是不同的東西。TMDB 不擁有海報著作權，無法轉授權（§5.5.1）。

---

## 7. E. 成本估算

### 7.1 資料成本（每月，USD）

| 項目 | 1,000 MAU | 10,000 MAU | 說明 |
|---|---|---|---|
| **TMDB 商業訂閱** | **$149** | **$149** | 年營收 < $1M 皆同價；rate limit 是 IP-based ~40 req/s，與 MAU 無關 |
| 政府開放資料（分級/票房/影城） | $0 | $0 | 免費，僅需顯名標示 |
| OpenStreetMap / Overpass | $0 | $0 | 一次性查詢 |
| Wikidata SPARQL | $0 | $0 | 免費，注意速率政策 |
| 地理編碼（107 筆） | ~$0 | ~$0 | 一次性，免費額度內 |
| **資料成本小計** | **$149** | **$149** | |

> 🎯 **這是本方案最漂亮的地方：資料成本在 $1M 年營收之前是「平的」**。從 1,000 MAU 到 10,000 MAU，資料成本完全不變（約 NT$4,800/月）。損益兩平只需要**約 40–50 個月費 NT$100 的付費會員**。

### 7.2 若堅持要做場次（對照組）

| 項目 | 估計 |
|---|---|
| MovieGlu / Gracenote 等商業供應商 | ⚠️ **未能驗證**（全為 "Contact us"，無公開定價），且**台灣覆蓋本身就未經確認** |
| 自建爬蟲（7+ 院線） | 開發 2–4 週 + **持續維護成本**（每次改版就壞）+ 法律風險 |

> 這個對照本身就是「MVP 放棄場次」的最佳論證。

### 7.3 圖片儲存與 CDN（初版僅一句帶過，2026-09-05 補實算）

**先講結論：儲存成本可以忽略，真正的成本是法律曝險與審核人力。**

**(a) 有 TMDB 的片（實測 80.0%）→ 熱連結 `image.tmdb.org`，成本 $0。**
不轉存就沒有儲存費、沒有頻寬費，也避開 TMDB「快取 ≤ 6 個月」條款與 §5.5.2 的 (b) 類風險。

**(b) UGC 上傳海報（那 20%）→ 實算**

以 Cloudflare R2 為基準（**egress 完全免費**，這對圖片服務是決定性優勢）：

| 項目 | 費率 |
|---|---|
| 標準儲存 | **$0.015 / GB-月** |
| Class A（寫入/列表） | $4.50 / 百萬次 |
| Class B（讀取） | $0.36 / 百萬次 |
| **Egress** | **$0（免費）** |
| 免費額度 | 儲存 10 GB-月、Class A 100 萬次、Class B 1,000 萬次 |

- 來源：[Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)（擷取 2026-09-05）

以長邊 500px 的 JPEG 海報約 **100 KB** 估算：

| 規模 | 片庫中需 UGC 海報的作品數 | 儲存量 | **月費** |
|---|---|---|---|
| 1,000 MAU | ~1,000 | ~100 MB | **$0**（免費額度內） |
| 10,000 MAU | ~4,000 | ~400 MB | **$0**（免費額度內） |
| 極端：10 萬部作品 | 100,000 | ~10 GB | **~$0.15** |

> 🎯 **即使做到 10 萬部作品的 UGC 海報，月費也只有 15 美分。** 儲存從來不是這件事的成本。

**(c) 真正的成本在別處**

| 項目 | 1,000 MAU | 10,000 MAU | 說明 |
|---|---|---|---|
| R2 儲存 | $0 | $0 | 免費額度內 |
| **UGC 審核人力** | 自己做 | **需要人** | 20% 未命中率 × 使用者上傳量。這是**唯一會隨規模線性成長**的成本 |
| **避風港四要件建置** | **一次性** | — | 服務條款、三振條款、`copyright@` 窗口、取下流程（§5.5.3） |
| 取下通知處理 | 低頻 | 中頻 | 每件需在「立即」的時限內處理（第90條之7第3款） |
| 律師諮詢（付費牆與第90條之7第2款，§5.5.4） | **一次性，建議做** | — | 這是我無法從條文推斷的問題 |

> **結論：把「UGC 海報」當成法務與營運問題，不要當成基礎設施問題。** 技術成本趨近於零，但避風港四要件若沒在 Phase 1 建好，事後無法補救（§5.5.4 陷阱一）。

### 7.4 修正後的成本總表

| 項目 | 1,000 MAU | 10,000 MAU |
|---|---|---|
| TMDB 商業訂閱 | $149 | $149 |
| 政府開放資料 | $0 | $0 |
| OSM / Wikidata / 地理編碼 | $0 | $0 |
| 圖片儲存（R2） | $0 | $0 |
| **資料與圖片小計** | **$149** | **$149** |
| 主機 / 資料庫 | 另計 | 另計 |
| **UGC 審核人力** | 自己做 | **需編列** |

> 資料成本仍然是「平的」（§7.1 的結論成立），但**營運成本不是**——它隨 UGC 量成長。損益兩平的 40–50 個付費會員估算只涵蓋資料成本，未含審核人力。

---

## 8. F. 未能驗證 / 待確認事項

### 🔴 高優先（會直接影響可行性，動工前必須自行確認）

1. **TMDB $149/月商業方案的官方定價頁** — 我只能從 TMDB 員工 (Travis Bell, STAFF) 於 2026-02、2026-04、2026-07 的三則論壇發言取得此數字；自助訂閱頁 `https://www.themoviedb.org/subscribe` 需登入（實測 **HTTP 401**），且官方 FAQ（更新於 2025-10-07）仍只寫「聯繫 sales@」。**請登入自行核對實際價格、方案內容與是否有台灣可用的付款方式。**

2. ~~**票房開放資料 API 被 Cloudflare 阻擋**~~ → **【2026-09-05 已降級：票房已排除於產品範圍外】** 且經實測，電影院與分級這兩個核心來源位於 `bamid.gov.tw` / `file.moc.gov.tw`，**無任何防護、HTTP 200**（見 §8.5）。原文如下保留備查： — `https://boxofficetw.tfai.org.tw/OpenData/statistic/since2016` 我以 curl（含瀏覽器 UA）與 WebFetch 分別嘗試，**均回傳 HTTP 403「Attention Required! | Cloudflare」**。這是週更新片偵測的核心來源，**若排程機器無法存取，整個「自動化」設計的前提就要重寫**。請從實際部署環境測試，必要時聯繫 `box.admin@tfai.org.tw`。

3. **MovieGlu / International Showtimes 是否覆蓋台灣** — 兩者官方頁面**都沒有公開國家清單**（MovieGlu 稱 125+ 國、International Showtimes 稱 120+ 國並列出 "East Asia" 大區，但**都未點名台灣**）。MovieGlu 文件甚至暗示唯一確認方式是申請 API key。若未來要做場次，這是第一個要問清楚的問題。

### 🟡 中優先

4. **Letterboxd 官方頁面未能逐字核對** — `letterboxd.com` 對自動化請求回傳 **HTTP 403**。引文取自搜尋引擎摘要與代理讀取，內容一致但建議用瀏覽器複核。「Letterboxd 已與 TMDB 簽商業協議」是**我的推論，非已證實事實**。
5. ~~**TMDB 的 zh-TW 長尾覆蓋率**~~ → ✅ **【2026-09-05 已結案，見 §8.6】** 未用 100 部抽樣，直接跑完 113 年**全部 805 筆**：命中率 **89.4%**、有中文標題 **89.4%**、有海報 **99.3%**、端到端可用 **80.0%**。缺口集中在**日本（78.6%）劇場版／演唱會**與**韓國（77.6%）偶像影像**，歐洲反而健康（法/英 94.4%）。
6. **影視局分級資料 114 年（2025）何時釋出** — 查證日最新僅到 113 年（2024），存在 1 年以上落差。
7. **Foursquare OS Places / Overture Maps 的台灣電影院覆蓋筆數** — 授權已確認寬鬆（Apache 2.0 / CDLA-P 2.0），但**未實測台灣資料量**。
8. **Trakt.tv 的商業使用矛盾** — 書面 ToS 寫「personal, non-commercial」，客服論壇說可商用。**未找到獨立的 API 專屬條款文件**。若要用，請取得 email 書面確認。
9. **台灣是否有 sui generis 資料庫權** — 僅有學者個人網站（章忠信「著作權筆記」）佐證台灣未採歐盟制度，**未取得智慧財產局官方文件**。
10. **Lawsnote 判決書原文** — 刑度與賠償金額取自律師事務所與新聞報導，**未逐字核對判決書**。

### ⚪ 低優先

11. 影視局統計 PDF（104 家 932 廳）— PDF 使用 CID 字型，本機解析失敗，數字取自搜尋引擎索引內容。惟**932 廳與我從 CSV 實算的總和完全吻合**，可信度高。
12. OMDb Patreon 各級距金額 — `patreon.com/join/omdb` 遭 Cloudflare 阻擋。（不影響結論：CC BY-NC 已排除此方案）
13. 開眼電影網、國賓、新光、美麗華的服務條款頁 — 多次嘗試皆 404 或找不到，**未能驗證**是否存在自動化擷取限制條款。
14. 各縣市層級的「電影院名冊」資料集（新竹市、台中市等）— 搜尋結果提及存在，**未逐一驗證**。
15. 經濟部商業登記「電影片映演業」的營業項目代碼 — `gcis.nat.gov.tw/cod/` 為 JS 應用，無法程式化查詢。
16. FamiPort — `robots.txt` 回傳 HTTP 500，**未能驗證**。

---

## 8.5 ✅ 本機實測複核（2026-09-05，由 David 的機器執行）

> 票房與場次已排除於產品範圍外，因此只複核**兩個核心資料源**。以下皆為在本專案開發機上實際執行的結果，非二手引用。

### 8.5.1 取得結果

| 檢查項 | 結果 |
|---|---|
| `OpenData.aspx?SN=E6C57FC155564DEB`（電影院） | ✅ **HTTP 200**，1,824 bytes，0.21s，無 Cloudflare |
| `OpenData.aspx?SN=E10C6A5C3B9BD8C8`（分級） | ✅ **HTTP 200**，1,855 bytes，0.17s，無 Cloudflare |
| `file.moc.gov.tw` CSV 實體下載 | ✅ 兩者皆成功，無防護 |
| 電影院最新檔 | **2025 年**，14,150 bytes，**107 筆**，總廳數 **932** |
| 分級最新檔 | **113 年（2024）**，122,977 bytes，**805 筆** |
| `統一編號` 完整性 | ✅ **107/107 有值、零重複** → 可直接當主鍵 |
| `原文片名` 填充率 | ✅ **805/805 = 100.0%** → ID 對照策略成立 |

> **關鍵確認：這兩個核心資料源都不在 Cloudflare 後面。** 第 8 節高優先項目 #2 的 403 問題僅影響票房資料集（`boxofficetw.tfai.org.tw`），**不影響電影院與分級這兩個核心來源**。既然產品範圍已排除票房，該風險項可降級。

### 8.5.2 兩個會卡住人的實作細節（實測踩到）

1. **包裝 JSON 帶 UTF-8 BOM** —— `json.load()` 直接失敗（`Unexpected UTF-8 BOM`）。必須以 `utf-8-sig` 解碼。下載的 CSV 同樣是 UTF-8 with BOM。
2. **`相關檔案` 是一個字串，不是陣列** —— 格式為 `名稱(URL);名稱(URL);...`，需自行切分。可用 `/([^;()]+)\((https?:\/\/[^)]+)\)/g` 取出 10 組年度檔案。
   - 另有 `FileName` 欄位，但它指向 `Download.ashx?u=<base64>` 且**只給最舊的那一年**（電影院為 2016、分級為 104 年），**不要用它**。

### 8.5.3 可複用的取得流程（已驗證）

```js
const SN = { cinema: 'E6C57FC155564DEB', rating: 'E10C6A5C3B9BD8C8' }

async function fetchLatestCsv(kind) {
  const res = await fetch(`https://www.bamid.gov.tw/OpenData.aspx?SN=${SN[kind]}`)
  // ⚠️ 必須手動去 BOM，否則 res.json() 會炸
  const wrapper = JSON.parse((await res.text()).replace(/^\uFEFF/, ''))
  const files = [...wrapper[0]['相關檔案'].matchAll(/([^;()]+)\((https?:\/\/[^)]+)\)/g)]
    .map(m => ({ name: m[1].trim(), url: m[2] }))
  const latest = files.at(-1) // 陣列即為年度升冪
  const csv = (await (await fetch(latest.url)).text()).replace(/^\uFEFF/, '')
  return { name: latest.name, csv }
}
```

### 8.5.4 匯入時必做的正規化（實測發現）

- **`事業名稱` trim**：2025 年有 2 筆帶空白 —— `'台中大遠百威秀影城 '`、`' in89駁二電影院'`。
- **縣市「台/臺」正規化**：地址前綴混用。正規化後實測分布為 台北市 30、新北市 13、台中市 13、高雄市 10、台南市 9、桃園市 9、嘉義市 3、新竹市 2…
- **`廳數` 是字串**，需轉數字（實測全部可轉，總和 932，與影視局統計月報吻合）。
- **`映演時間` 是 `1 時 45 分 30 秒` 格式**，非數字分鐘。
- **`出品公司` 混入國別**：如 `匈牙利 RELAY MOTION KFT.`，不可直接當發行商欄位用。

### 8.5.5 仍待確認

- **分級資料最新僅到 113 年（2024）**，電影院資料已到 2025 —— 兩者釋出節奏不同步。2024 年後上映的新片，在放棄票房資料集的前提下**沒有政府來源可補**，需完全倚賴 TMDB + UGC。這是排除票房後新增的缺口，見第 6 節路線圖需相應調整。

---

## 8.6 ✅ TMDB zh-TW 覆蓋率實測（2026-09-05，母體 805 筆）

> 第 8 節高優先項目 #5（「TMDB 的 zh-TW 長尾覆蓋率未測」）之結案。
> **不是抽樣**——直接跑影視局 113 年分級資料的**全部 805 筆**，即真實匯入工作量。共約 3,200 次 TMDB API 呼叫，免費 key，8 執行緒，每輪約 4 分鐘，**未觸發 429 限流**。

### 8.6.1 方法

以政府資料的 `原文片名` 與 `中文片名` 雙查詢 TMDB `/search/movie?language=zh-TW`，候選以三訊號評分後取最佳，再以 `/movie/{id}?append_to_response=release_dates` 取明細：

| 訊號 | 權重 | 說明 |
|---|---|---|
| 原文片名精確吻合 | +5 | 正規化後（NFKC、去標點、剝版本標註） |
| 中文片名精確吻合 | +5 | 對 TMDB 的 zh-TW `title` 比對 |
| 中文片名前綴吻合 | +3 | |
| 上映年落在 2023–2025 | +1.5 | **只加分不懲罰**（重映片核准年 ≠ 上映年） |
| 片長差 > 5 分且無精確吻合 | 判定誤配 | `映演時間` 解析為分鐘後交叉驗證 |

### 8.6.2 結果

| 指標 | v1（原文片名＋年份懲罰） | **v2（雙查詢＋剝版本標註＋片長驗證）** |
|---|---|---|
| **命中率** | 719/805 = 89.3% | **720/805 = 89.4%** |
| 有中文標題 (zh-TW) | 81.2% | **89.4%** |
| 中文標題與政府相符（正規化後） | 60.1% | **84.4%** |
| 有海報 | 97.9% | **99.3%** |
| 有中文簡介 | 78.7% | **89.2%** |
| 有台灣上映日 (TW region) | 65.0% | **71.4%** |
| **端到端可用（中文標題＋海報）** | — | **644/805 = 80.0%** |

> **關鍵解讀：v2 不是找到更多片，而是找對了片。** 命中率幾乎沒動，但配對品質全面提升——v1 存在假陽性（《一屍到底》配到 "Making Of One Cut of the Dead"、《貓的報恩》配到 *Batman Returns*），被 v2 的片長交叉驗證攔下。**韓國片命中率從 93.4% 降至 77.6% 正是移除假陽性的結果，v2 的數字才是誠實的。**

### 8.6.3 依國別拆解（v2）— **缺口不在歐洲，在日韓**

| 國別 | n | 命中率 | 有中文標題 |
|---|---|---|---|
| 美國 | 193 | **98.4%** | **95.3%** |
| 泰國 | 24 | 95.8% | 87.5% |
| 法國 | 36 | 94.4% | 86.1% |
| 英國 | 36 | 94.4% | 83.3% |
| 香港 | 26 | 88.5% | 69.2% |
| 中華民國 | 112 | 86.6% | 75.0% |
| **日本** | 182 | **78.6%** | **67.0%** |
| **韓國** | 76 | **77.6%** | **57.9%** |

**缺口的三種型態**（實際樣本）：

1. **日本劇場版／總集篇／OVA**：銀魂劇場版 2D、刀劍亂舞 迴、劇場版 OVERLORD、電影版屁屁偵探、麵包超人電影版、黑執事 寄宿學校篇、GIVEN 被贈與的未來、特別總集篇 名偵探柯南 vs. 怪盜基德。
2. **演唱會／偶像影像作品**：JUNG KOOK: I AM STILL、RM: Right People Wrong Place、嵐 5x20、hololive 4th fes、福山雅治 Live Film。
3. **台港中的獨立片與數位修復重映**：戀戀風塵（數位修復版）、恐怖份子（數位修復版）、蘇州河（4K 修復版）、家有囍事 4K、填詞L、三個人的一一、妮波自由式、有種的人。

### 8.6.4 附帶發現：政府資料的品質問題（實測）

| 問題 | 量 | 影響 |
|---|---|---|
| **`分級證明字號` 零重複** | 0 組 | ✅ 可安全當主鍵 |
| **`中文片名` 重複 56 組** | 56 | ⚠️ **805 張證明書 ≠ 805 部電影**。同片因國語版／日語版／2D／3D 分開核准（《SPY x FAMILY CODE: White》×3、《沙丘：第二部》×2）。→ **schema 必須兩層**：`certificate`（字號 PK）→ `film`（TMDB id PK），多對一。否則「本月看了幾部片」會重複計數。 |
| **中文片名內嵌版本標註** | 60 筆 (7.5%) | ⚠️ `(中文版)`／`數位修復版`／`經典重映`／`前篇`／`4K`。比對 TMDB 前必須剝除——這是 v1 誤殺重映片的主因之一。 |
| **原文片名被 Excel 誤判為日期** | 1 筆 | 《福田村事件》的 `原文片名` = `Sep-23`。經典的 Excel 日期自動轉換災難。 |
| **原文片名編碼損毀** | 1 筆 | 《小小次文化戰爭~比利治玩家的逆襲》= `?????????????` |
| **原文片名拼寫錯誤** | ≥2 筆 | `THE INVISILBLE FIGHT`（應為 INVISIBLE）、`AN ITALIAN GOURMET GRIME STORY`（應為 CRIME） |

> → 匯入管線必須是**防禦性**的：日期樣式偵測、全形/半形正規化、版本標註剝除、片長交叉驗證。

### 8.6.5 對產品的結論

- **主流商業片幾乎無縫**：美國片 98.4% 命中、95.3% 有中文標題。一般使用者的日常觀影記錄（好萊塢大片 + 台灣院線熱門片）體驗會很好。
- **80% 端到端可用率**是設計 UGC 的依據，不是失敗指標。**剩下的 20% 正是 UGC 的價值所在**——動漫迷與影展觀眾恰好是最願意補資料的族群。
- **「找不到片」必須是一等公民的 UX**，不是錯誤狀態。應提供「手動新增作品」流程（片名＋年份＋海報上傳），並在後台排入人工／自動回補佇列。
- **`原文片名` 100% 填充率仍然成立且關鍵**，但**單靠它不夠**：必須同時用 `中文片名` 查詢，並用 `映演時間` 換算的片長做交叉驗證，否則會產生假陽性誤配。
- ⚠️ **修正第 6.3 節的樂觀假設**：原報告稱「用原文片名＋年度打 TMDB search 可繞開中文 fuzzy match 難題」——實測顯示這**只解決了一部分**。年份不能當硬篩（重映片核准年 ≠ 上映年），且 TMDB 的 `original_title` 常是母語（`紅の豚` 而非 `Porco Rosso`），與政府提供的英文片名對不上。**正確做法是雙查詢 + 片長驗證。**

### 8.6.6 未觸及

- 僅測 113 年（2024）單一年度。**更早年度（104–112）的覆蓋率未測**，老片與修復片比例更高，命中率預期更低。
- 未測 TMDB 的**演職員（cast/crew）**中文化程度。
- 免費 key 實測未觸發限流，但**商業方案的實際 rate limit 未驗證**。

---

## 9. 參考來源清單

> 全部擷取於 **2026-09-05**。

### TMDB
- [API Terms of Use](https://www.themoviedb.org/api-terms-of-use)（Last updated: October 20, 2023）
- [API for Business](https://www.themoviedb.org/api-for-business)
- [FAQ](https://developer.themoviedb.org/docs/faq)（Last Updated: 2025-10-07）
- [Rate Limiting](https://developer.themoviedb.org/docs/rate-limiting)（dateModified: 2025-10-20）
- [Daily ID Exports](https://developer.themoviedb.org/docs/daily-id-exports)
- [Movie Changes 端點](https://developer.themoviedb.org/reference/changes-movie-list)
- [movie-translations](https://developer.themoviedb.org/reference/movie-translations)｜[movie-release-dates](https://developer.themoviedb.org/reference/movie-release-dates)｜[Region Support](https://developer.themoviedb.org/docs/region-support)
- STAFF 發言：[2026-02-06](https://www.themoviedb.org/talk/697df2a0576e95a402e4e71e)｜[2026-04-01](https://www.themoviedb.org/talk/69cbf4f91b914f0e9542a772)｜[2026-07-07](https://www.themoviedb.org/talk/6a47e0462281f2fc02b86a4b)｜[2022-03](https://www.themoviedb.org/talk/622b91d0d236e60045f62782)
- 實測頁：[movie/1022789/translations](https://www.themoviedb.org/movie/1022789/translations)｜[/releases](https://www.themoviedb.org/movie/1022789/releases)｜[movie/1046090/translations](https://www.themoviedb.org/movie/1046090/translations)｜[/releases](https://www.themoviedb.org/movie/1046090/releases)

### 其他 metadata
- [OMDb API](https://www.omdbapi.com/)｜[apikey.aspx](https://www.omdbapi.com/apikey.aspx)
- [IMDb Non-Commercial Datasets](https://developer.imdb.com/non-commercial-datasets/)｜[data.imdb.com](https://data.imdb.com/non-commercial-datasets/)｜[IMDb Conditions of Use](https://www.imdb.com/conditions/)
- [AWS Marketplace – IMDb Essential Metadata (API)](https://aws.amazon.com/marketplace/pp/prodview-wdqq4hg3bcbws)｜[(Bulk data)](https://aws.amazon.com/marketplace/pp/prodview-yeuyizioqmfsy)
- [Trakt Terms](https://app.trakt.tv/terms)｜[Trakt 論壇商用討論](https://forums.trakt.tv/t/asking-about-api-commercial-uses-on-free-plan/99367)
- [JustWatch API 文件](https://apis.justwatch.com/docs/api/)｜[JustWatch Streaming API](https://www.justwatch.com/us/JustWatch-Streaming-API)
- [Wikidata:Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)｜[Wikipedia:Copyrights](https://en.wikipedia.org/wiki/Wikipedia:Copyrights)｜[WDQS User Manual](https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual)
- [Letterboxd Film data](https://letterboxd.com/about/film-data/)｜[Letterboxd 支援文件](https://support.letterboxd.com/hc/en-us/articles/15269025512847-Where-does-Letterboxd-get-its-film-data-from)｜[Letterboxd FAQ](https://letterboxd.com/about/faq/)

### 台灣政府開放資料
- [data.gov.tw/dataset/59820 電影片分級及相關資訊](https://data.gov.tw/dataset/59820)｜[opendata.culture.tw 鏡像](https://opendata.culture.tw/frontsite/barrierFree/openDataDetail/584)
- [data.gov.tw/dataset/22213 全國電影院資料](https://data.gov.tw/dataset/22213)
- [data.gov.tw/dataset/94224 全國電影票房統計數據](https://data.gov.tw/dataset/94224)｜metadata API：`https://data.gov.tw/api/v2/rest/dataset/94224`
- [data.gov.tw/dataset/6010「電影」（⚠️ 實為藝文活動場次）](https://data.gov.tw/dataset/6010)｜[data.gov.tw/dataset/7731 國家文化資料庫-電影](https://data.gov.tw/dataset/7731)
- BAMID OpenData 入口：分級 `https://www.bamid.gov.tw/OpenData.aspx?SN=E10C6A5C3B9BD8C8`｜影城 `https://www.bamid.gov.tw/OpenData.aspx?SN=E6C57FC155564DEB`
- [政府資料開放授權條款-第 1 版](https://data.gov.tw/license)
- [影視局電影事業統計](https://www.bamid.gov.tw/News.aspx?n=3642&sms=13011)｜[文化部統計-電影片映演業](https://stat.moc.gov.tw/ImportantPointer_LatestDownload.aspx?sqno=30)
- [TFAI 開放博物館](https://openmuseum.tw/museum/tfai)｜[開放博物館授權說明](https://openmuseum.tw/howto)

### 地理與 POI
- [Google Maps Platform ToS](https://cloud.google.com/maps-platform/terms/)｜[Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)｜[Places 政策](https://developers.google.com/maps/documentation/places/web-service/policies)｜[定價](https://developers.google.com/maps/billing-and-pricing/pricing)｜[2025-03 計價變更](https://developers.google.com/maps/billing-and-pricing/march-2025)
- [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)｜[OSMF Collective Database Guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)｜[Horizontal Map Layers](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Horizontal_Map_Layers_-_Guideline)｜[Attribution Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)
- [Foursquare OS Places NOTICE](https://opensource.foursquare.com/places-notice-txt/)｜[Overture Places 文件](https://docs.overturemaps.org/guides/places/)
- [Mapbox Product Terms (Oct 1, 2025)](https://cdn.prod.website-files.com/609ed46055e27a02ffc0749b/68dddd2815cb3d82685f0096_Mapbox%20Product%20Terms%20(October%201,%202025).pdf)

### 場次供應商與台灣站點
- [MovieGlu About](https://movieglu.com/about/)｜[Pricing](https://movieglu.com/pricing/)｜[Developer](https://developer.movieglu.com/)
- [Gracenote movie_showtimes（US/Canada only）](https://developer.tmsapi.com/docs/read/data_v1_1/movies/movie_showtimes)
- [TechCrunch: Google shutters Google Showtimes (2016-11-07)](https://techcrunch.com/2016/11/07/google-quietly-shutters-standalone-google-showtimes-movie-site/)
- robots.txt 實測：`showtimes.com.tw/robots.txt`（允許）｜`vscinemas.com.tw/robots.txt`（403 Akamai）｜`tw.tv.yahoo.com/robots.txt`（封鎖 ClaudeBot/GPTBot/Scrapy）｜`atmovies.com.tw/robots.txt`（無 `User-agent: *`）｜`ticket.ibon.com.tw/robots.txt`

### 法律
- [全國法規資料庫 著作權法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0070017)（第 7 條、第 9 條）
- [全國法規資料庫 公平交易法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0150002)（第 25 條）
- [全國法規資料庫 個人資料保護法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=I0050021)（第 19、20 條）
- [公平交易委員會](https://www.ftc.gov.tw/)：公處字第 111070 號（2022-09-01，愛食記 v. 飢餓黑熊）
- 新北地院 111 年度智訴字第 8 號（2025-06-24，Lawsnote v. 法源）
- hiQ v. LinkedIn（9th Cir. 2019/2022；2022-12-06 stipulated judgment）｜[Van Buren v. United States, 593 U.S. 374 (2021)](https://supreme.justia.com/cases/federal/us/593/19-783/)｜[Ryanair v. PR Aviation, CJEU C-30/14](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A62014CJ0030)

---

## 10. 一句話總結

**電影 metadata 問題已解**（政府開放資料當歷史骨幹 + TMDB $149/月商業授權當主力，實測端到端可用率 **80.0%**，主流商業片 **98.4%**）；**影城問題已解且免費**（政府開放資料 107 家、932 廳，`統一編號` 實測 107/107 無空值、零重複，可直接當主鍵）；**只有場次無解——而觀影日記根本不需要它。**

「人工維護會擺爛」的風險已被化解，但**化解方式不是「全自動」，而是「自動化涵蓋 80%，UGC 補完 20%」**。實測顯示那 20% 的缺口高度集中在動漫劇場版、偶像演唱會電影與台港數位修復重映——**而這三類的觀眾，恰好是最願意主動補資料的族群。** 把「找不到片」設計成一等公民的 UX，而非錯誤狀態，這個產品就成立。
