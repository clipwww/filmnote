/**
 * 政府核准紀錄 → TMDB 作品的比對。演算法經 110–113 年全部 3,116 筆實測：命中率 90.3%、
 * 端到端可用率 81.1%。下面的設計選擇都是實測失敗換來的，修改前先看
 * `tests/matcher.test.ts` 的回歸案例。
 */
// ⚠️ 給呼叫端：`runtimeOf` 回 null 時，**最強的那道驗證訊號會靜默消失**（片長交叉驗證
//    是唯一能擋住「片名相近但根本是另一部片」的機制，兩邊任一為 null 就跳過而不是拒絕）。
//    實測（舊 log 匯入，US-56）：《Fate stay night Heaven's feel》靠 zh-prefix 配到系列
//    第二部《Ⅱ.迷途之蝶》，分數 4.5 高於門檻而片長那關形同不存在。
//    ⇒ 沒有片長可用時呼叫端必須自行補護欄，而且要**收緊**不是放寬：要求 signals 含
//    `zh-exact` 或 `original-exact`，否則一律視為未命中送進 UGC 佇列，缺口用人工對照表補。
//    調鬆門檻來提高命中率等於在最沒有把握的時候最敢猜。

import type {
  Certificate,
  MatchOutcome,
  MatchSignal,
  TmdbSearchResult,
} from '#pipeline/types'
import { normalizeTitle } from '#pipeline/normalize/title'

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
 * 為單一候選評分。年份「只加分、不懲罰」是關鍵設計：經典重映片的核准年與 TMDB 上映年
 * 可差數十年（《紅豬》核准 113 年／TMDB 1992），早期版本以年份硬篩，誤殺了全部重映片。
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
 * 平手時偏好「有內容的條目」。TMDB 上存在**空殼條目**（有標題，但沒有上映日、片長 0、
 * 沒有簡介），它們在片名上可以一字不差，於是拿到跟真片一樣的分數。
 */
// 實測 2026-09-20 兩例：`你的名字。` 的 553301「Your Name」空殼 original-exact 5 分 vs
//   372058 真片 zh-exact 5 分；`潛艦危機倒數` 的 1391860 空殼 vs 554022（Torpedo, 2019）。
//   兩例都平手，而空殼**先進候選集**（先搜原文再搜中文），舊的 reduce 用嚴格大於 ⇒ 空殼贏。
//   ⚠️ 真片拿不到 `year-near`：那是 2016 年的片而核准是 113 年的**重映**。
// ★ 為什麼是平手比較不是加分：「有上映日就加 0.5 分」會把每一個有上映日的候選整體抬升，
//   原本低於門檻的配對可能被推過去 ⇒ 產生沒有人審視過的新配對。平手比較則分數不變、
//   門檻判定不變，**能改變的只有平手那些**（實測 2,764 部裡勝出者沒有上映日的只有 3 部）。
// 判準只用 `release_date` 不用 `poster_path`：海報會因地區與時間變動，而實測第三部
//   （`亞洲`／`Asia`）的空殼**有海報卻沒有上映日**，用海報當判準那一部會判錯。
function preferPopulated(a: ScoredCandidate, b: ScoredCandidate): ScoredCandidate {
  const aHas = !!a.candidate.release_date
  const bHas = !!b.candidate.release_date
  if (aHas === bHas)
    return a // 兩者都有或都沒有 ⇒ 維持原行為（保留先出現的）
  return aHas ? a : b
}

/**
 * 自候選集中挑出最佳配對。`runtimeOf` 讓呼叫端決定片長從哪裡來（搜尋結果不含 runtime，
 * 必須另外查明細）——做成參數，比對邏輯才能離線測試。
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
    .reduce((a, b) => {
      if (b.score > a.score)
        return b
      if (b.score < a.score)
        return a
      return preferPopulated(a, b)
    })

  if (best.score < SCORE_THRESHOLD)
    return { matched: false, reason: 'score-too-low', score: best.score }

  // 片長是最強的驗證訊號：片名相近但片長差很多幾乎都是花絮、幕後特輯或同名的另一部片
  // （"Making Of" 系列的陷阱）。
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
