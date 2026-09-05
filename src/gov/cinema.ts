/**
 * 「全國電影院資料」CSV → Cinema[]
 *
 * 只取最新年度單一檔案。跨年度 schema 不穩定（2016 年有縣市與備註共 8 欄、
 * 2020 年反而拿掉地址與電話改成設立年份共 7 欄、2025 年為 6 欄），
 * 合併多個年度只會製造麻煩。
 */

import type { Cinema, RawCinemaRow } from '~/types'
import { parse } from 'csv-parse/sync'
import { extractCity } from '~/normalize/city'

/** 2025 年的欄位。 */
const EXPECTED_COLUMNS = ['事業名稱', '公司名稱', '統一編號', '廳數', '地址', '電話'] as const

export interface CinemaParseResult {
  cinemas: Cinema[]
  /** 認不出縣市的地址，需人工處理。實測 2025 年為 0 筆。 */
  unknownCity: { taxId: string, name: string, address: string }[]
}

export function parseCinemaCsv(csv: string): CinemaParseResult {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as RawCinemaRow[]

  if (!rows.length)
    return { cinemas: [], unknownCity: [] }

  const missing = EXPECTED_COLUMNS.filter(col => !(col in rows[0]!))
  if (missing.length)
    throw new Error(`電影院資料的欄位與預期不符，缺少：${missing.join('、')}`)

  const cinemas: Cinema[] = []
  const unknownCity: CinemaParseResult['unknownCity'] = []

  for (const row of rows) {
    // 事業名稱在來源資料中可能帶前後空白（實測 2025 年 2 筆：
    // 「台中大遠百威秀影城 」與「 in89駁二電影院」）。
    const name = (row.事業名稱 ?? '').trim()
    const taxId = (row.統一編號 ?? '').trim()
    const address = (row.地址 ?? '').trim()
    const city = extractCity(address)

    if (!city)
      unknownCity.push({ taxId, name, address })

    cinemas.push({
      taxId,
      name,
      companyName: (row.公司名稱 ?? '').trim(),
      hallCount: Number((row.廳數 ?? '').trim()) || 0,
      address,
      phone: (row.電話 ?? '').trim(),
      city: city ?? '',
    })
  }

  return { cinemas, unknownCity }
}

/**
 * 檢查統一編號是否堪用為主鍵。
 *
 * 實測 2025 年 107/107 皆有值且零重複，但這是每年重新匯入時
 * 必須複驗的前提——上游一旦出現空值或重複，主鍵策略就要改。
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
