/**
 * 「全國電影院資料」CSV → Cinema[]。只取最新年度單一檔案：跨年度 schema 不穩定
 * （2016 年 8 欄、2020 年反而拿掉地址與電話改成 7 欄、2025 年 6 欄），合併只會製造麻煩。
 */

import type { Cinema, RawCinemaRow } from '#pipeline/types'
import { parse } from 'csv-parse/sync'
import { extractCity } from '#pipeline/normalize/city'

/** 2025 年的欄位。 */
const EXPECTED_COLUMNS = ['事業名稱', '公司名稱', '統一編號', '廳數', '地址', '電話'] as const

export interface CinemaParseResult {
  cinemas: Cinema[]
  /** 認不出縣市的地址，需人工處理。實測 2025 年為 0 筆。 */
  unknownCity: { taxId: string, name: string, address: string }[]
  /**
   * 「事業名稱」欄是空的、`name` 已退回公司名稱的那幾筆（實測 2025 年 3 筆）。
   * 這是**每年都會重來**的上游現象 ⇒ 要帶出去讓 `ingest-cinema` 印出來，不印的話明年
   * 多了第 4 筆不會有人知道，而它會直接長進「在哪看」的下拉選單。
   */
  blankName: { taxId: string, companyName: string, address: string }[]
}

export function parseCinemaCsv(csv: string): CinemaParseResult {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawCinemaRow[]

  if (!rows.length)
    return { cinemas: [], unknownCity: [], blankName: [] }

  const missing = EXPECTED_COLUMNS.filter(col => !(col in rows[0]!))
  if (missing.length)
    throw new Error(`電影院資料的欄位與預期不符，缺少：${missing.join('、')}`)

  const cinemas: Cinema[] = []
  const unknownCity: CinemaParseResult['unknownCity'] = []
  const blankName: CinemaParseResult['blankName'] = []

  for (const row of rows) {
    // 事業名稱可能帶前後空白（實測 2025 年 2 筆）。
    const govName = (row.事業名稱 ?? '').trim()
    const companyName = (row.公司名稱 ?? '').trim()
    const taxId = (row.統一編號 ?? '').trim()
    const address = (row.地址 ?? '').trim()
    const city = extractCity(address)

    /**
     * ★ 事業名稱**可能整欄是空的**（實測 2025 年 3 筆，只填了公司名稱）。空字串不是解析
     * 錯誤而是政府 CSV 的常態，但原樣往下傳會出事：`venue.name` 一路空到下拉選單，被
     * `{{ name }} · {{ city }}` 算繪成只剩「· 台北市」（2026-09-07 David 回報的就是這個）。
     * **症狀在算繪層、病灶在這一行** ⇒ 照 `SCREENS §6` 的 `name || companyName` 在源頭收斂
     * （下游七個直接讀 `venue.name` 的地方各有各的爛法，只有源頭擋得住）。
     */
    // ⚠️ 這只是保底，給的是法人全銜；真正的店名由 `0015_venue_blank_name.sql` 的
    //    `curated_fields` 寫死，那一支才是 UI 上會看到的名字。
    // ⚠️ 不要改成「從公司名稱的全形括號裡挖店名」：全庫 110 筆只有 1 筆是那個形狀（n=1），
    //    那是猜測不是規則。
    // ⚠️ 這個 fallback 會連 `venue.raw` 一起變（seed 存的 raw 是**這個物件本身**），所以
    //    「政府那一欄本來是空的」這個證據只剩下 `blankName` 的 console 輸出。
    const name = govName || companyName

    if (!city)
      unknownCity.push({ taxId, name, address })

    if (!govName)
      blankName.push({ taxId, companyName, address })

    cinemas.push({
      taxId,
      name,
      companyName,
      hallCount: Number((row.廳數 ?? '').trim()) || 0,
      address,
      phone: (row.電話 ?? '').trim(),
      city: city ?? '',
    })
  }

  return { cinemas, unknownCity, blankName }
}

/**
 * 檢查統一編號是否堪用為主鍵。實測 2025 年 107/107 皆有值且零重複，但這是每年重新匯入
 * 時必須複驗的前提——上游一旦出現空值或重複，主鍵策略就要改。
 */
export function assertTaxIdUsableAsKey(cinemas: Cinema[]): void {
  const empty = cinemas.filter(c => !c.taxId)
  if (empty.length)
    throw new Error(`有 ${empty.length} 家影城沒有統一編號，無法作為主鍵：${empty.map(c => c.name).join('、')}`)

  const seen = new Map<string, string>()
  const duplicates: string[] = []
  for (const cinema of cinemas) {
    const previous = seen.get(cinema.taxId)
    if (previous)
      duplicates.push(`${cinema.taxId}（${previous} / ${cinema.name}）`)
    else
      seen.set(cinema.taxId, cinema.name)
  }

  if (duplicates.length)
    throw new Error(`統一編號重複，無法作為主鍵：${duplicates.join('、')}`)
}

/**
 * 檢查每一家都有名字可用。走到這裡還是空的代表**兩欄同時空**，那是上游格式真的壞了。
 * ★ 在 parse 階段炸而不是讓它流下去：`0015` 的 `venue_name_not_blank` CHECK 會在
 *   `pnpm seed` 的 SQL 層以 23514 炸掉，而那個訊息看不出是哪一筆、也看不出是政府資料變了。
 * ⚠️ `assertTaxIdUsableAsKey` 只驗統編**不看 name**，上游把整欄名稱清空也照樣通過——
 *    這一支補的就是那個洞。
 */
export function assertNameUsable(cinemas: Cinema[]): void {
  const blank = cinemas.filter(c => !c.name.trim())
  if (blank.length) {
    throw new Error(
      `有 ${blank.length} 家影城連事業名稱與公司名稱都是空的，無法顯示：`
      + `${blank.map(c => `${c.taxId}（${c.address || '無地址'}）`).join('、')}`,
    )
  }
}
