/**
 * 「全國電影院資料」CSV → Cinema[]
 *
 * 只取最新年度單一檔案。跨年度 schema 不穩定（2016 年有縣市與備註共 8 欄、
 * 2020 年反而拿掉地址與電話改成設立年份共 7 欄、2025 年為 6 欄），
 * 合併多個年度只會製造麻煩。
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
   * 「事業名稱」欄是空的、`name` 已退回公司名稱的那幾筆。
   *
   * 實測 2025 年 3 筆（21235165／25116865／54186685）。這是**每年都會重來**
   * 的上游現象，所以要帶出去讓 `ingest-cinema` 印出來——不印的話，明年多了
   * 第 4 筆不會有任何人知道，而它會直接長進「在哪看」的下拉選單裡。
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
    // 事業名稱在來源資料中可能帶前後空白（實測 2025 年 2 筆：
    // 「台中大遠百威秀影城 」與「 in89駁二電影院」）。
    const govName = (row.事業名稱 ?? '').trim()
    const companyName = (row.公司名稱 ?? '').trim()
    const taxId = (row.統一編號 ?? '').trim()
    const address = (row.地址 ?? '').trim()
    const city = extractCity(address)

    /**
     * ★ 事業名稱**可能整欄是空的**（實測 2025 年 3 筆：21235165 龍子電影事業、
     *   25116865 國元影業、54186685 映捌玖數位影城，三筆都只填了公司名稱）。
     *
     * 空字串不是解析錯誤，是政府 CSV 的常態——但把它原樣往下傳會出事：
     * `venue.name` 一路空到「在哪看」的下拉選單，被 `{{ name }} · {{ city }}`
     * 這種樣板算繪成只剩「· 台北市」，看起來像選單裡混進了行政區名
     * （2026-09-07 David 回報的就是這個）。**症狀在算繪層、病灶在這一行。**
     *
     * `SCREENS §6` 早就裁決 `displayName = name || companyName`，在這裡收斂：
     * 下游七個直接讀 `venue.name` 的地方（記錄選單、匯入選單、票根卡的
     * `venueSegment()`、兩支圖表的 `?? '（場所不明）'`…）各有各的爛法，
     * 沒有任何一個共用層擋得住，只有源頭擋得住。
     *
     * ⚠️ 這只是**保底**，給的是法人全銜（「國元影業股份有限公司」）。真正的
     *    店名由 `supabase/migrations/0015_venue_blank_name.sql` 以 `curated_fields`
     *    寫死，那一支才是 UI 上會看到的名字。
     * ⚠️ 不要改成「從公司名稱的全形括號裡挖店名」：全庫 110 筆 cinema 只有
     *    1 筆是那個形狀（n=1），那是猜測不是規則。
     * ⚠️ 這個 fallback 會連 `venue.raw` 一起變（`scripts/seed-supabase.ts` 存的
     *    `raw` 是**這個物件本身**，不是政府 CSV 原樣），所以「政府那一欄本來
     *    是空的」這個證據只剩下 `blankName` 的 console 輸出。見交接的 not_done。
     */
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

/**
 * 檢查每一家都有名字可用。
 *
 * `parseCinemaCsv` 已經把空的事業名稱退回公司名稱，所以走到這裡還是空的，
 * 代表**兩欄同時空**——那是上游格式真的壞掉，不是常態。
 *
 * ★ 為什麼要在這裡炸而不是讓它流下去：`0015` 之後 `venue.name` 有
 *   `venue_name_not_blank` 這道 CHECK，空名會在 `pnpm seed` 的 SQL 層以
 *   `23514` 炸掉——那個訊息看不出是哪一筆、也看不出是政府資料變了。
 *   在 parse 階段就攔下來，訊息裡帶得出統編與地址。
 *
 * ⚠️ `assertTaxIdUsableAsKey` **不看 name**（它只驗統編），所以上游把整欄
 *   名稱清空也照樣「通過」。這一支補的就是那個洞。
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
