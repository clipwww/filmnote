/**
 * 政府核准紀錄 → TMDB 作品的比對。
 *
 * 演算法經 110–113 年全部 3,116 筆實測驗證：命中率 90.3%、
 * 端到端可用率 81.1%。以下三個設計選擇都是實測失敗換來的，
 * 修改前請先看 tests/matcher.test.ts 的回歸案例。
 */

import type {
  Certificate,
  MatchOutcome,
  MatchSignal,
  TmdbSearchResult,
} from '~/types'
import { normalizeTitle } from '~/normalize/title'

/** 低於此分數視為未命中，寧可進 UGC 佇列也不硬猜。 */
const SCORE_THRESHOLD = 3

/** 片長差超過此分鐘數且無片名精確吻合時，判定為誤配。 */
const RUNTIME_TOLERANCE_MINUTES = 5

/** 前綴比對的最短長度，避免短字串產生大量偽吻合。 */
const MIN_PREFIX_LENGTH_ORIGINAL = 5
const MIN_PREFIX_LENGTH_ZH = 3

const WEIGHTS: Record<MatchSignal, number> = {
  'original-exact': 5,
  'zh-exact': 5,
  'zh-prefix': 3,
  'original-prefix': 2,
  'year-near': 1.5,
}

interface ScoredCandidate {
  candidate: TmdbSearchResult
  score: number
  signals: MatchSignal[]
}

function prefixMatch(a: string, b: string, minLength: number): boolean {
  if (!a || !b || a.length < minLength)
    return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * 為單一候選評分。
 *
 * 年份「只加分、不懲罰」是關鍵設計：經典重映片的核准年與 TMDB 上映年
 * 相差可達數十年（《紅豬》核准 113 年、TMDB 1992；《千禧曼波》核准
 * 113 年、TMDB 2001）。早期版本以年份為硬篩，誤殺了全部重映與數位修復片。
 */
export function scoreCandidate(
  certificate: Certificate,
  candidate: TmdbSearchResult,
): ScoredCandidate {
  const signals: MatchSignal[] = []

  const wantOriginal = normalizeTitle(certificate.titleOriginal)
  const wantZh = normalizeTitle(certificate.titleZh)
  const gotOriginal = normalizeTitle(candidate.original_title)
  const gotTitle = normalizeTitle(candidate.title)

  // 原文片名比對時同時看 TMDB 的 original_title 與 title：TMDB 的
  // original_title 常是母語而非英文（政府給 `Porco Rosso`，TMDB 存
  // `紅の豚`），只比對其中一邊會漏掉大量日本片。
  if (wantOriginal && (gotOriginal === wantOriginal || gotTitle === wantOriginal))
    signals.push('original-exact')
  else if (prefixMatch(wantOriginal, gotOriginal, MIN_PREFIX_LENGTH_ORIGINAL))
    signals.push('original-prefix')

  if (wantZh && (gotTitle === wantZh || gotOriginal === wantZh))
    signals.push('zh-exact')
  else if (prefixMatch(wantZh, gotTitle, MIN_PREFIX_LENGTH_ZH))
    signals.push('zh-prefix')

  const releaseYear = Number(candidate.release_date?.slice(0, 4))
  if (Number.isFinite(releaseYear)
    && Math.abs(releaseYear - certificate.gregorianYear) <= 1) {
    signals.push('year-near')
  }

  const score = signals.reduce((sum, signal) => sum + WEIGHTS[signal], 0)
  return { candidate, score, signals }
}

function hasExactSignal(signals: MatchSignal[]): boolean {
  return signals.includes('original-exact') || signals.includes('zh-exact')
}

/**
 * 自候選集中挑出最佳配對。
 *
 * `runtimeOf` 讓呼叫端決定片長從哪裡來——搜尋結果本身不含 runtime，
 * 必須另外查明細。把它做成參數，比對邏輯就能離線測試。
 */
export function matchCertificate(
  certificate: Certificate,
  candidates: TmdbSearchResult[],
  runtimeOf: (candidate: TmdbSearchResult) => number | null,
): MatchOutcome {
  if (!candidates.length)
    return { matched: false, reason: 'no-candidates', score: 0 }

  const best = candidates
    .map(candidate => scoreCandidate(certificate, candidate))
    .reduce((a, b) => (b.score > a.score ? b : a))

  if (best.score < SCORE_THRESHOLD)
    return { matched: false, reason: 'score-too-low', score: best.score }

  // 片長是最強的驗證訊號。片名相近但片長差很多，幾乎都是花絮、
  // 幕後特輯或同名的另一部片——這正是 "Making Of" 系列的陷阱。
  const runtime = runtimeOf(best.candidate)
  const expected = certificate.runtimeMinutes
  if (
    expected !== null
    && runtime !== null
    && Math.abs(runtime - expected) > RUNTIME_TOLERANCE_MINUTES
    && !hasExactSignal(best.signals)
  ) {
    return { matched: false, reason: 'runtime-mismatch', score: best.score }
  }

  return {
    matched: true,
    tmdbId: best.candidate.id,
    score: best.score,
    signals: best.signals,
  }
}
