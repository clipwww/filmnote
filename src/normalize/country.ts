/**
 * 國別正規化：只做一件事——把台灣的各種寫法收斂成「台灣」（2026-09-20 前的決定）。
 * 這是資料問題不是外觀問題：分布圖直接 `group by f.country`，兩種寫法會**裂成兩條長條**
 * （實測 2026-09-06 David 的儀表板上就有「台灣 2」與「中華民國 1」各一條）。
 */
// 沿用 `city.ts` 的形狀與它的 `unifyTaiwanChar()`（同一個問題換一個欄位又發生一次），
// 不另外寫一份「臺→台」。
// ⚠️ 除了台灣的寫法之外**一律原樣返回**：政府資料的國名有自己的體系，順手統一別的國名
//    會製造出跟歷史資料對不起來的新分類，比原本的問題更難查。

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
