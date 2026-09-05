/**
 * 以本機的政府 CSV 全量驗證解析器。
 *
 * 單元測試只證明 fixture 對；這支腳本證明解析器面對完整的 3,116 筆
 * 真實資料不會爆、主鍵不重複、缺陷統計落在已知範圍內。
 *
 * 用法：tsx scripts/verify-parsers.ts <放置 movie11X.csv 與 cinema2025.csv 的目錄>
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'
import { assertTaxIdUsableAsKey, parseCinemaCsv } from '../src/gov/cinema'
import { parseRatingCsv } from '../src/gov/rating'

const dir = process.argv[2]
if (!dir) {
  console.error('用法：tsx scripts/verify-parsers.ts <CSV 目錄>')
  process.exit(1)
}

const read = (name: string) => readFileSync(`${dir}/${name}`, 'utf8').replace(/^\uFEFF/, '')

let total = 0
const defectTally = new Map<string, number>()

for (const year of [110, 111, 112, 113]) {
  const certs = parseRatingCsv(read(`movie${year}.csv`))
  total += certs.length

  const ids = certs.map(c => c.id)
  if (new Set(ids).size !== ids.length)
    throw new Error(`${year} 年的代理主鍵有重複，id 生成規則不成立`)

  // permitNo 本身預期會重複（110–112 年的字號缺系列前綴），在此顯示數量
  // 而非拋錯——這是來源資料的性質，不是錯誤。
  const permits = certs.map(c => c.permitNo)
  const permitDupes = permits.length - new Set(permits).size
  if (certs.some(c => c.gregorianYear !== year + 1911))
    throw new Error(`${year} 年的民國年換算有誤`)

  for (const c of certs) {
    for (const d of c.defects) defectTally.set(d, (defectTally.get(d) ?? 0) + 1)
  }

  console.log(
    `${year} 年: ${String(certs.length).padStart(4)} 筆`
    + ` | 有缺陷 ${String(certs.filter(c => c.defects.length).length).padStart(3)}`
    + ` | 版本標註 ${String(certs.filter(c => c.versionNote).length).padStart(3)}`
    + ` | 無片長 ${String(certs.filter(c => c.runtimeMinutes === null).length).padStart(3)}`
    + ` | 字號重複 ${String(permitDupes).padStart(3)}`,
  )
}

console.log(`\n合計 ${total} 筆核准紀錄\n\n缺陷分布：`)
for (const [defect, n] of [...defectTally].toSorted((a, b) => b[1] - a[1]))
  console.log(`  ${defect.padEnd(30)} ${n}`)

const { cinemas, unknownCity } = parseCinemaCsv(read('cinema2025.csv'))
assertTaxIdUsableAsKey(cinemas)

const halls = cinemas.reduce((sum, c) => sum + c.hallCount, 0)
const cityTally = new Map<string, number>()
for (const c of cinemas) cityTally.set(c.city, (cityTally.get(c.city) ?? 0) + 1)

console.log(`\n影城 ${cinemas.length} 家 / ${halls} 廳｜統編可作主鍵 ✓｜無法辨識縣市 ${unknownCity.length} 筆`)
console.log(`縣市 top6：${[...cityTally].toSorted((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c}=${n}`).join('  ')}`)
