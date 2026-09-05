/**
 * 核准紀錄 → 作品的收斂。
 *
 * 這是 SPEC 中「兩層模型」的實作。同一部片會因跨年度重映、國語版與
 * 日語版分開送審而擁有多張證明書；若不收斂，「今年看了幾部片」這類
 * 統計會失真。實測 110–113 年的 3,116 筆收斂為約 2,664 部，
 * 亦即有 14.5% 是重複的。
 */

import type { Certificate, Film, MatchOutcome } from '~/types'
import { normalizeTitle } from '~/normalize/title'

export interface ConsolidateInput {
  certificate: Certificate
  outcome: MatchOutcome
  /** 比對命中時自 TMDB 取得的補充資料。 */
  tmdb?: {
    titleZh: string
    titleOriginal: string
    runtimeMinutes: number | null
  }
}

/**
 * 未命中作品的收斂鍵。
 *
 * 同時使用中文與原文片名，而非只用中文——只用中文會把不同年份的
 * 同名片誤併為一部。兩者皆空的極端情況退回使用核准紀錄自身的 id，
 * 寧可產生一部孤兒作品，也不要把無關的資料混在一起。
 */
export function unmatchedFilmKey(certificate: Certificate): string {
  const zh = normalizeTitle(certificate.titleZh)
  const original = normalizeTitle(certificate.titleOriginal)

  if (!zh && !original)
    return `gov:orphan:${certificate.id}`

  return `gov:${zh}:${original}`
}

export function consolidate(inputs: ConsolidateInput[]): Film[] {
  const films = new Map<string, Film>()

  for (const { certificate, outcome, tmdb } of inputs) {
    const id = outcome.matched
      ? `tmdb:${outcome.tmdbId}`
      : unmatchedFilmKey(certificate)

    const existing = films.get(id)
    if (existing) {
      existing.certificateIds.push(certificate.id)
      // 同一部片的多張證明書，取最早的年度作為首次出現。
      existing.firstSeenRocYear = Math.min(existing.firstSeenRocYear, certificate.rocYear)
      // 先前缺的欄位，由後續的證明書補上。
      existing.runtimeMinutes ??= certificate.runtimeMinutes
      existing.country ||= certificate.country
      continue
    }

    films.set(id, {
      id,
      tmdbId: outcome.matched ? outcome.tmdbId : null,
      // 中文片名以政府核准名為準——實測 TMDB 的中文標題只有 83.2%
      // 與官方一致，政府資料正是為了校正這一點而匯入的。
      titleZh: certificate.titleZh || tmdb?.titleZh || '',
      // 原文片名反過來以 TMDB 為準：政府欄位有 Excel 日期誤判、
      // 編碼損毀與拼寫錯誤，而 TMDB 的 original_title 是母語正名。
      titleOriginal: tmdb?.titleOriginal || certificate.titleOriginal || '',
      country: certificate.country,
      runtimeMinutes: certificate.runtimeMinutes ?? tmdb?.runtimeMinutes ?? null,
      firstSeenRocYear: certificate.rocYear,
      certificateIds: [certificate.id],
      source: outcome.matched ? 'tmdb' : 'gov',
    })
  }

  return [...films.values()]
}

export interface ConsolidationSummary {
  certificates: number
  films: number
  matched: number
  unmatched: number
  /** 因收斂而消去的重複筆數。 */
  collapsed: number
}

export function summarize(inputs: ConsolidateInput[], films: Film[]): ConsolidationSummary {
  return {
    certificates: inputs.length,
    films: films.length,
    matched: films.filter(f => f.tmdbId !== null).length,
    unmatched: films.filter(f => f.tmdbId === null).length,
    collapsed: inputs.length - films.length,
  }
}
