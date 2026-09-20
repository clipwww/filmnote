/**
 * 核准紀錄 → 作品的收斂（SPEC「兩層模型」的實作）。同一部片會因跨年度重映、國語版與
 * 日語版分開送審而有多張證明書，不收斂會讓「今年看了幾部片」失真。實測 110–113 年的
 * 3,116 筆收斂為 2,669 部，亦即 14.3%（447 筆）是重複的。
 */

import type { Certificate, Film, MatchOutcome } from '#pipeline/types'
import { normalizeTitle } from '#pipeline/normalize/title'

const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/

/** TMDB 以 0 表示「無片長資料」，轉成 null 以免被當成片長 0 分鐘。 */
function nonZero(value: number | null | undefined): number | null {
  return value || null
}

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
 * 未命中作品的收斂鍵。同時用中文與原文片名（只用中文會把不同年份的同名片誤併為一部）；
 * 兩者皆空時退回核准紀錄自身的 id——寧可產生一部孤兒作品也不要把無關的資料混在一起。
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
      if (existing.runtimeMinutes === 0)
        existing.runtimeMinutes = null
      existing.country ||= certificate.country
      continue
    }

    // 中文片名一般以政府核准名為準（實測 TMDB 的中文標題只有 83.2% 與官方一致）。但來源
    // 若有編碼損毀，政府那份反而是壞的——實測 15 筆含 ASCII 問號的片名中，4 筆有 TMDB
    // 配對者全是真損毀（「?本龍一：終章」的坂、「-EPISODE ?-」的凪）⇒ 此時採用 TMDB。
    const zhSuspect = certificate.defects.includes('title-zh-suspect-encoding')
    const tmdbZh = tmdb?.titleZh?.trim()
    const preferTmdbZh = zhSuspect && !!tmdbZh && CJK.test(tmdbZh)

    films.set(id, {
      id,
      tmdbId: outcome.matched ? outcome.tmdbId : null,
      titleZh: (preferTmdbZh ? tmdbZh : certificate.titleZh) || tmdbZh || '',
      // 原文片名反過來以 TMDB 為準：政府欄位有 Excel 日期誤判、編碼損毀與拼寫錯誤，
      // 而 TMDB 的 original_title 是母語正名。
      titleOriginal: tmdb?.titleOriginal || certificate.titleOriginal || '',
      country: certificate.country,
      // TMDB 對「無片長資料」回傳 0 而非 null，原樣帶下來會變成「片長 0 分鐘」。
      runtimeMinutes: certificate.runtimeMinutes ?? nonZero(tmdb?.runtimeMinutes) ?? null,
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
