/**
 * 國別正規化。目前只做一件事：**把台灣的各種寫法收斂成「台灣」**。
 *
 * David 2026-09-06：「國別：中華民國 = 台灣。有些資料會是中華民國的都統一改用台灣」。
 *
 * ── 為什麼這是資料問題不是外觀問題 ──────────────────────────────────
 * `/app` 與 `/u/` 的國別分布圖直接 `group by f.country`
 * （`0003_user_year_stats.sql:199`），所以同一個國家的兩種寫法會**裂成兩條長條**。
 * 實測 2026-09-06 David 自己的儀表板上就有「台灣 2」與「中華民國 1」各一條。
 *
 * 這正是 `city.ts` 當初被寫出來要防的同一件事（台北市 25 筆 vs 臺北市 5 筆）——
 * 同一個問題換一個欄位又發生一次，所以這裡沿用它的形狀，也沿用它的
 * `unifyTaiwanChar()`，不另外寫一份「臺→台」。
 *
 * ── 刻意**不做**的事 ──────────────────────────────────────────────
 * 除了台灣的寫法之外**一律原樣返回**。政府資料的國名有它自己的體系
 * （香港、韓國、俄羅斯…），順手「統一」別的國名不是需求，而且會製造新的不一致：
 * 分布圖上突然多出一個跟歷史資料對不起來的分類，比原本的問題更難查。
 */

import { unifyTaiwanChar } from '#pipeline/normalize/city'

/** 會被收斂成「台灣」的寫法。比對前先過 `unifyTaiwanChar()`，所以「臺灣」不必列。 */
const TAIWAN_ALIASES = new Set(['中華民國', '台灣'])

/**
 * `中華民國` → `台灣`；`臺灣` → `台灣`；其餘原樣。
 *
 * ⚠️ 空字串回 `null` 而不是 `''`：`0008_ugc_delete_and_country_null.sql` 已經把
 * 「沒有國別」在資料庫層定成 NULL（連 `default ''` 都拿掉、還加了
 * `film_country_not_blank` check）。這裡回 `''` 等於在上游繞過那條規則。
 * ⚠️ 呼叫端若需要 `string`（例如 `Certificate.country` 的型別），自己 `?? ''`——
 * 那是型別的需要，不是這支函式該替它決定的事。
 *
 * 冪等：`f(f(x)) === f(x)`，有測試釘住。
 */
export function normalizeCountry(text: string | null | undefined): string | null {
  if (!text)
    return null

  const unified = unifyTaiwanChar(text.trim())
  if (!unified)
    return null

  return TAIWAN_ALIASES.has(unified) ? '台灣' : unified
}
