/**
 * 政府核准紀錄 → TMDB 作品的比對。
 *
 * 演算法經 110–113 年全部 3,116 筆實測驗證：命中率 90.3%、
 * 端到端可用率 81.1%。以下三個設計選擇都是實測失敗換來的，
 * 修改前請先看 tests/matcher.test.ts 的回歸案例。
 *
 * ⚠ 給呼叫端：`runtimeOf` 回傳 null 時，最強的那道驗證訊號會消失。
 *
 * 片長交叉驗證是本比對器唯一能擋住「片名相近但根本是另一部片」的機制
 * （花絮、幕後特輯、同系列的另一部）。但它只在 certificate.runtimeMinutes
 * 與 runtimeOf 皆非 null 時才生效——兩者任一為 null，該檢查會**靜默跳過**，
 * 而不是拒絕比對。政府資料有片長所以感覺不到，換一個沒有片長的來源就會踩到。
 *
 * 實測（舊 log 匯入，US-56）：來源沒有片長欄位，runtimeOf 只能回 null，
 * 於是《Fate stay night Heaven's feel》靠 zh-prefix 配到了系列**第二部**
 * 《Ⅱ.迷途之蝶》——分數 4.5 高於門檻，片長那關形同不存在。
 *
 * 沒有片長可用時，呼叫端必須自行補一道護欄。已驗證有效的做法是**收緊**
 * 而非放寬：要求 signals 含 `zh-exact` 或 `original-exact`，否則一律視為
 * 未命中送進 UGC 佇列，缺口用人工對照表補
 * （見 scripts/import-mylog.ts 與 src/import/tmdb-overrides.ts）。
 * 反過來調鬆門檻來提高命中率，等於在最沒有把握的時候最敢猜。
 */

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
 * 平手時偏好「有內容的條目」。
 *
 * ── 為什麼需要這條（2026-09-20 實測）────────────────────────────────────
 * TMDB 上存在**空殼條目**：有標題，但沒有上映日、片長 0、沒有簡介、常常沒有海報。
 * 它們在片名上可以是一字不差的精確吻合，於是拿到跟真片一樣的分數。
 *
 * 實例一（David 看了 5 次的片）：核准資料是 `你的名字。` ／ 原文 `YOUR NAME.`
 *   · 553301「Your Name」空殼 → `original-exact` 5 分
 *   · 372058「你的名字」真片   → `zh-exact` 5 分
 *   兩者皆 5 分。`ingest-rating.ts` 是先搜原文片名再搜中文片名、以 Map 合併，
 *   所以空殼**先進候選集**；舊的 `reduce` 用嚴格大於，平手保留先出現的 ⇒ 空殼贏。
 *   ⚠️ 真片拿不到 `year-near`：它是 2016 年的片，而那筆核准是 113 年的**重映**。
 *
 * 實例二：`潛艦危機倒數` ／ `U235`，1391860 空殼 5 分 vs 554022（Torpedo, 2019）
 *   `zh-exact` 5 分，同樣平手、同樣空殼贏。
 *
 * ── ★ 為什麼是平手比較，不是加分 ──────────────────────────────────────
 * 「有上映日就加 0.5 分」會把**每一個**有上映日的候選整體抬升，於是原本低於
 * `SCORE_THRESHOLD` 的配對可能被推過門檻 ⇒ 產生全新的、沒有人審視過的配對。
 * 做成平手比較則分數完全不變 ⇒ 門檻判定完全不變 ⇒ **能改變的結果只有平手那些**。
 * 實測全片庫 2,764 部裡，勝出者沒有上映日的只有 3 部（見 `tests/matcher.test.ts`），
 * 所以這個改動的影響範圍是封閉且已知的。
 *
 * 判準只用 `release_date`，不用 `poster_path`：海報會因地區與時間變動，
 * 而「有沒有上映日」是條目建檔完整度的穩定代理。實測第三部（`亞洲`／`Asia`）
 * 的空殼**有海報卻沒有上映日**——用海報當判準那一部會判錯。
 */
function preferPopulated(a: ScoredCandidate, b: ScoredCandidate): ScoredCandidate {
  const aHas = !!a.candidate.release_date
  const bHas = !!b.candidate.release_date
  if (aHas === bHas)
    return a // 兩者都有或都沒有 ⇒ 維持原行為（保留先出現的）
  return aHas ? a : b
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
    .reduce((a, b) => {
      if (b.score > a.score)
        return b
      if (b.score < a.score)
        return a
      return preferPopulated(a, b)
    })

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
