# 影記 / filmnote 文件

## 規格與計畫

| 文件 | 內容 |
|---|---|
| [SPEC.md](./SPEC.md) | **產品規格（權威）**。58 條 user stories、資料模型、實測覆蓋率、Out of Scope 與其理由。 |
| [BUILD_PLAN.md](./BUILD_PLAN.md) | Nuxt 應用建置計畫。Supabase schema/RLS 完整 SQL、專案設定、路由、逐步驗證方式、法遵落點。 |

## 調研

| 文件 | 內容 |
|---|---|
| [research/DATA_SOURCES.md](./research/DATA_SOURCES.md) | 資料來源可行性調研。TMDB 商業授權、政府開放資料、影城資料、場次為何不做、著作權與 ISP 避風港。含條款原文引用。 |
| [research/STACK.md](./research/STACK.md) | 技術選型調研。oxlint 對 Vue 的支援現況、部署平台的商業使用限制、BaaS 免費額度與陷阱。 |

## 設計素材

`research/design/` 保存產出 BUILD_PLAN 的原始素材，供追溯決策依據。

| 文件 | 內容 |
|---|---|
| `research-rendering.md` | Nuxt 4 算繪模式、ECharts 在 SSR 的處理 |
| `research-supabase-auth.md` | `@nuxtjs/supabase` + Google OAuth |
| `research-nuxt-ui.md` | Nuxt UI v4 元件與 Tailwind 4 |
| `schema-rls-first.md` | Schema 提案 1：安全優先（洩漏 5/10、成本 8.5/10） |
| `schema-query-first.md` | Schema 提案 2：查詢效能優先（洩漏 3.5/10、成本 6/10） |
| `schema-evolution-first.md` | Schema 提案 3：可演進性優先（洩漏 6.5/10、成本 3/10） |
| **`judge-leak.md`** | **對抗式資安評審**。逐案的洩漏路徑分析——動 schema 前必讀。 |
| `judge-practical.md` | 務實評審：實作與維護成本 |

> 三個 schema 提案是各自獨立設計的，沒有一個在安全性上及格（最高 6.5/10）。
> BUILD_PLAN §1.1 列出的六項結構性修正即來自 `judge-leak.md`，其中修正 A
> （`auth.uid() is null` 不可視為 service_role）若未修正，等於對未登入者
> 關閉全部 RLS。
