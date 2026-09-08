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
import { assertNameUsable, assertTaxIdUsableAsKey, parseCinemaCsv } from '#pipeline/gov/cinema'
import { fetchDatasetFile, listDatasetFiles } from '#pipeline/gov/datasets'

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

  const { cinemas, unknownCity, blankName } = parseCinemaCsv(await fetchDatasetFile(latest))

  // 統一編號是主鍵，每年重新匯入時都必須複驗這個前提。
  assertTaxIdUsableAsKey(cinemas)
  // 名字空到底（事業名稱與公司名稱都沒有）就直接停，不要讓它到 seed 的
  // SQL 層才以 23514 炸掉——那時候看不出是哪一筆、也看不出是上游變了。
  assertNameUsable(cinemas)

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

  /**
   * ★ 空的事業名稱要**每年**看一次。
   *
   * 這不是錯誤（parser 已退回公司名稱，資料是可用的），但退回來的是法人全銜，
   * 選單裡會出現「國元影業股份有限公司」這種東西。真正的店名寫在
   * `supabase/migrations/0015_venue_blank_name.sql` 的 `curated_fields` 裡，
   * 而那份清單只涵蓋 2025 年的 3 筆——多出來的第 4 筆只有這裡看得到。
   * 不印出來的話，明年沒有任何人會知道要去補。
   */
  if (blankName.length) {
    console.log(`\n⚠ ${blankName.length} 筆沒有事業名稱，已退回公司名稱（正名見 0015 的 curated_fields）：`)
    for (const row of blankName)
      console.log(`    ${row.taxId}：${row.companyName}（${row.address}）`)
  }

  console.log(`\n輸出：${OUT_DIR}/venues.json`)
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
