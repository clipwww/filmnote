/**
 * 分級資料匯入：政府 CSV → TMDB 比對 → 收斂為作品 → 輸出 JSON。
 *
 * 用法：
 *   tsx src/pipeline/ingest-rating.ts            # 預設匯入 110–113 年
 *   tsx src/pipeline/ingest-rating.ts 112 113    # 指定年度
 *
 * 中斷後重跑會自動跳過已比對的核准紀錄（見 checkpoint.ts）。
 */

import type { ConsolidateInput } from './consolidate'
import type { Certificate, MatchOutcome, TmdbMovieDetail } from '~/types'
import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fetchDatasetFile, listDatasetFiles } from '~/gov/datasets'
import { parseRatingCsv } from '~/gov/rating'
import { matchCertificate } from '~/match/matcher'
import { TmdbClient } from '~/tmdb/client'
import { runResumable } from './checkpoint'
import { consolidate, summarize } from './consolidate'

/** SPEC 定義的匯入範圍：110 年起 schema 統一為 9 欄。 */
const DEFAULT_YEARS = [110, 111, 112, 113]
const OUT_DIR = '.data'

interface MatchArtifact {
  outcome: MatchOutcome
  tmdb?: { titleZh: string, titleOriginal: string, runtimeMinutes: number | null }
}

/** 自檔名取出民國年度，如「113年電影片分級及相關資訊」→ 113。 */
function rocYearOf(fileName: string): number | null {
  const match = /^(\d{3})年/.exec(fileName)
  return match ? Number(match[1]) : null
}

async function loadCertificates(years: number[]): Promise<Certificate[]> {
  const files = await listDatasetFiles('rating')
  const wanted = files.filter((file) => {
    const year = rocYearOf(file.name)
    return year !== null && years.includes(year)
  })

  const missing = years.filter(y => !wanted.some(f => rocYearOf(f.name) === y))
  if (missing.length)
    throw new Error(`找不到這些年度的檔案：${missing.join('、')}。上游可能尚未釋出或命名已變更。`)

  const all: Certificate[] = []
  for (const file of wanted) {
    const certificates = parseRatingCsv(await fetchDatasetFile(file))
    console.log(`  ${file.name}：${certificates.length} 筆`)
    all.push(...certificates)
  }
  return all
}

/**
 * 對單筆核准紀錄執行比對。
 *
 * 雙查詢是實測驗證的關鍵設計：只用原文片名會漏掉大量日本片，因為
 * TMDB 的 original_title 常是母語（政府給 `Porco Rosso`，TMDB 存 `紅の豚`）。
 */
async function matchOne(certificate: Certificate, tmdb: TmdbClient): Promise<MatchArtifact> {
  const queries = [certificate.titleOriginal, certificate.titleZh].filter(Boolean)

  // 兩個查詢彼此獨立，並行送出。TmdbClient 的閘門負責控制實際併發量。
  const batches = await Promise.all(queries.map(query => tmdb.search(query)))

  const candidates = new Map<number, Awaited<ReturnType<TmdbClient['search']>>[number]>()
  for (const batch of batches) {
    for (const result of batch)
      candidates.set(result.id, result)
  }

  // 片長驗證需要明細，但明細很貴。先用不含片長的評分挑出最佳候選，
  // 只對它取一次明細——這讓每筆的請求數維持在 2–3 次而非 N+1 次。
  const pool = [...candidates.values()]
  const provisional = matchCertificate(certificate, pool, () => null)
  if (!provisional.matched)
    return { outcome: provisional }

  let detail: TmdbMovieDetail
  try {
    detail = await tmdb.detail(provisional.tmdbId)
  }
  catch {
    // 取不到明細就退回未命中，讓它進 UGC 佇列。硬留一個未經
    // 片長驗證的配對，比缺一筆更糟。
    return { outcome: { matched: false, reason: 'score-too-low', score: provisional.score } }
  }

  const outcome = matchCertificate(
    certificate,
    pool.filter(c => c.id === provisional.tmdbId),
    () => detail.runtime,
  )

  if (!outcome.matched)
    return { outcome }

  return {
    outcome,
    tmdb: {
      titleZh: detail.title,
      titleOriginal: detail.original_title,
      runtimeMinutes: detail.runtime,
    },
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) {
    console.error('缺少 TMDB_API_KEY。請複製 .env.example 為 .env 並填入。')
    process.exit(1)
  }

  const years = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n))
  const targetYears = years.length ? years : DEFAULT_YEARS

  console.log(`匯入 ${targetYears.join('、')} 年的分級資料\n`)
  const certificates = await loadCertificates(targetYears)
  console.log(`\n合計 ${certificates.length} 筆核准紀錄，開始比對 TMDB…`)

  const tmdb = new TmdbClient({ apiKey })
  const started = Date.now()

  const results = await runResumable<Certificate, MatchArtifact>({
    path: `${OUT_DIR}/checkpoint-rating.json`,
    items: certificates,
    keyOf: certificate => certificate.id,
    process: certificate => matchOne(certificate, tmdb),
    onProgress: ({ done, total, skipped }) => {
      const elapsed = Math.round((Date.now() - started) / 1000)
      const suffix = skipped ? `（續跑，跳過 ${skipped} 筆）` : ''
      console.log(`  ${done}/${total}  已耗時 ${elapsed}s${suffix}`)
    },
  })

  const inputs: ConsolidateInput[] = certificates.map(certificate => ({
    certificate,
    outcome: results[certificate.id]!.outcome,
    tmdb: results[certificate.id]!.tmdb,
  }))

  const films = consolidate(inputs)
  const stats = summarize(inputs, films)

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(`${OUT_DIR}/films.json`, JSON.stringify(films, null, 2), 'utf8')
  await writeFile(`${OUT_DIR}/certificates.json`, JSON.stringify(certificates, null, 2), 'utf8')

  const defects = certificates.filter(c => c.defects.length).length

  console.log(`
匯入完成（${Math.round((Date.now() - started) / 1000)}s）

  核准紀錄    ${stats.certificates}
  收斂為作品  ${stats.films}   （消去重複 ${stats.collapsed} 筆，${(stats.collapsed / stats.certificates * 100).toFixed(1)}%）
  命中 TMDB   ${stats.matched}   （${(stats.matched / stats.films * 100).toFixed(1)}%）
  未命中      ${stats.unmatched}   → 待 UGC 補完
  來源有缺陷  ${defects}

  TMDB 請求 ${tmdb.stats.requests}｜重試 ${tmdb.stats.retries}｜遭節流 ${tmdb.stats.throttled}

輸出：${OUT_DIR}/films.json、${OUT_DIR}/certificates.json`)
}

await main()
