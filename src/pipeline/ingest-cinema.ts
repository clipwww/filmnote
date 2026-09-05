/**
 * 影城資料匯入：政府 CSV → 正規化 → 輸出 JSON。
 *
 * 用法：tsx src/pipeline/ingest-cinema.ts
 *
 * 這支比分級簡單得多——不需要 TMDB、不需要 checkpoint，因為全台只有
 * 一百多家影城，一次跑完不到一秒。這正是 SPEC 主張「影城問題已解」的原因：
 * 資料量小、變動慢、且有官方來源。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { assertTaxIdUsableAsKey, parseCinemaCsv } from '~/gov/cinema'
import { fetchDatasetFile, listDatasetFiles } from '~/gov/datasets'

const OUT_DIR = '.data'

/**
 * 非影城的觀影場合。
 *
 * 影城為必填欄位，若沒有這些選項，串流、影展、飛機上看的片就完全
 * 無法記錄。以負數 taxId 與真實影城區隔，避免與統一編號衝突。
 */
const NON_CINEMA_VENUES = [
  { taxId: 'virtual:streaming', name: '串流平台', kind: 'streaming' },
  { taxId: 'virtual:festival', name: '影展', kind: 'festival' },
  { taxId: 'virtual:home', name: '家中', kind: 'home' },
  { taxId: 'virtual:other', name: '其他', kind: 'other' },
] as const

async function main(): Promise<void> {
  const files = await listDatasetFiles('cinema')
  const latest = files.at(-1)
  if (!latest)
    throw new Error('影城資料集沒有任何檔案，上游格式可能已變更')

  console.log(`來源：${latest.name}`)

  const { cinemas, unknownCity } = parseCinemaCsv(await fetchDatasetFile(latest))

  // 統一編號是主鍵，每年重新匯入時都必須複驗這個前提。
  assertTaxIdUsableAsKey(cinemas)

  const halls = cinemas.reduce((sum, c) => sum + c.hallCount, 0)
  const cityTally = new Map<string, number>()
  for (const cinema of cinemas)
    cityTally.set(cinema.city, (cityTally.get(cinema.city) ?? 0) + 1)

  const venues = [
    ...cinemas.map(c => ({ ...c, kind: 'cinema' as const })),
    ...NON_CINEMA_VENUES.map(v => ({
      ...v,
      companyName: '',
      hallCount: 0,
      address: '',
      phone: '',
      city: '',
    })),
  ]

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(`${OUT_DIR}/venues.json`, JSON.stringify(venues, null, 2), 'utf8')

  console.log(`
匯入完成

  影城        ${cinemas.length} 家 / ${halls} 廳
  非影城場合  ${NON_CINEMA_VENUES.length} 項（串流、影展、家中、其他）
  統一編號    可作主鍵 ✓
  縣市分布    ${[...cityTally].toSorted((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c}=${n}`).join('  ')}`)

  if (unknownCity.length) {
    console.log(`\n⚠ ${unknownCity.length} 筆無法自地址辨識縣市，需人工處理：`)
    for (const row of unknownCity)
      console.log(`    ${row.name}（${row.taxId}）：${row.address}`)
  }

  console.log(`\n輸出：${OUT_DIR}/venues.json`)
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
