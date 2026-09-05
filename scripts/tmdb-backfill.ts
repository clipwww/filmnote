/**
 * 反覆呼叫 `/api/cron/tmdb-refresh` 直到佇列清空，並把各輪的統計加總。
 *
 * 為什麼不直接寫一支獨立的匯入腳本：那會出現第二套「TMDB → 快照」的映射邏輯，
 * 而兩套一定會漂移。這支只是驅動器——真正做事的是正式的 cron 端點，所以這次
 * 回填同時也是那支端點的壓力測試（2,400 次請求）。
 *
 *   pnpm dev                                                    # 另一個終端
 *   pnpm tsx --env-file=.env scripts/tmdb-backfill.ts
 *   pnpm tsx --env-file=.env scripts/tmdb-backfill.ts --limit 200 --concurrency 8
 *
 * （沒有 `pnpm tmdb:backfill` 別名：`package.json` 是共用檔，加 script 需主
 *  session 核可。核可後把 `"tmdb:backfill": "tsx --env-file=.env
 *  scripts/tmdb-backfill.ts"` 加進去，並回來改這段說明。）
 *
 * 環境變數：`NUXT_CRON_SECRET`（必要）、`BACKFILL_BASE_URL`（預設 localhost:3000）。
 */

import process from 'node:process'

interface RefreshReport {
  due: number
  claimed: number
  fresh: number
  gone: number
  failed: number
  untouched: number
  applied: number
  tmdb: { requests: number, retries: number, throttled: number }
  elapsedMs: number
  abortedBy: string | null
  errors: string[]
}

function arg(name: string, fallback: number): number {
  const args = process.argv.slice(2).filter(a => a !== '--')
  const i = args.indexOf(`--${name}`)
  if (i < 0)
    return fallback
  const n = Number(args[i + 1])
  return Number.isFinite(n) ? n : fallback
}

const secret = process.env.NUXT_CRON_SECRET
if (!secret) {
  console.error('缺少 NUXT_CRON_SECRET（.env）。')
  process.exit(1)
}

const baseUrl = process.env.BACKFILL_BASE_URL ?? 'http://localhost:3000'
const limit = arg('limit', 200)
const concurrency = arg('concurrency', 8)
// 每一輪的時間預算。回填時放寬（不受 Vercel 函式上限拘束），但仍有上限，
// 這樣「卡住」會表現成一輪跑很久後回報，而不是無限等待。
const budget = arg('budget', 120_000)
const maxRounds = arg('rounds', 60)

const total = {
  rounds: 0,
  fresh: 0,
  gone: 0,
  failed: 0,
  applied: 0,
  requests: 0,
  retries: 0,
  throttled: 0,
  elapsedMs: 0,
}
const errorSamples: string[] = []

for (let round = 1; round <= maxRounds; round++) {
  const url = `${baseUrl}/api/cron/tmdb-refresh?limit=${limit}&concurrency=${concurrency}&budget=${budget}`

  // ★ 一定要有逾時。實測（2026-09-06）：回填途中改到 server/** 會讓 Nuxt dev
  //   的 Nitro 熱重載，**已在飛的請求就此沒有回應也不會斷線**。沒有逾時的話
  //   這支會安靜地永遠等下去，而資料庫那邊看起來就只是「進度停住了」。
  //   給伺服器端預算 + 30 秒的寬限。
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(budget + 30_000),
    })
  }
  catch (cause) {
    console.error(`第 ${round} 輪沒有回應（逾時或連線中斷）：${cause instanceof Error ? cause.message : cause}`)
    console.error('伺服器可能重載過。確認 pnpm dev 還活著，然後重跑這支——已刷新的列不會再被取出。')
    process.exit(1)
  }

  if (!response.ok) {
    console.error(`第 ${round} 輪 HTTP ${response.status}：${await response.text()}`)
    process.exit(1)
  }

  const report = await response.json() as RefreshReport
  total.rounds = round
  total.fresh += report.fresh
  total.gone += report.gone
  total.failed += report.failed
  total.applied += report.applied
  total.requests += report.tmdb.requests
  total.retries += report.tmdb.retries
  total.throttled += report.tmdb.throttled
  total.elapsedMs += report.elapsedMs
  for (const e of report.errors) {
    if (errorSamples.length < 20)
      errorSamples.push(e)
  }

  console.log(
    `#${round} due=${report.due} fresh=${report.fresh} gone=${report.gone} failed=${report.failed} `
    + `applied=${report.applied} req=${report.tmdb.requests} retry=${report.tmdb.retries} `
    + `429=${report.tmdb.throttled} ${report.elapsedMs}ms${report.abortedBy ? ` abort=${report.abortedBy}` : ''}`,
  )

  if (report.abortedBy === 'fatal') {
    console.error('端點回報設定層錯誤，停止。', report.errors)
    process.exit(1)
  }

  // ★ 收斂條件是「這一輪什麼都沒動到」而不是 due === 0：失敗的列會被退避到
  //   未來，於是 due 會下降到一個非 0 的殘量並停在那裡。以「沒有進展」收尾
  //   才不會空轉 60 輪。
  if (report.fresh + report.gone + report.failed === 0) {
    console.log(`第 ${round} 輪沒有任何進展（due=${report.due}），收工。`)
    break
  }
}

console.log('\n── 合計 ──')
console.table([total])
if (errorSamples.length) {
  console.log('錯誤取樣：')
  for (const e of errorSamples)
    console.log(`  - ${e}`)
}
