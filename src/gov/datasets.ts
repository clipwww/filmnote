/**
 * 影視局開放資料的取得。
 *
 * 這兩個資料集的下載機制不是標準的「一個 URL 一份檔案」：
 * `OpenData.aspx?SN=...` 回傳的是一層「包裝 JSON」，真正的逐年 CSV
 * 連結藏在其中的「相關檔案」欄位，且該欄位是分號分隔的字串而非陣列。
 *
 * 三個實測踩到的坑，全部在此處理：
 *   1. 包裝 JSON 與 CSV 皆為 UTF-8 with BOM，直接 JSON.parse 會拋錯
 *   2. 「相關檔案」是 `名稱(URL);名稱(URL);...` 格式的單一字串
 *   3. 同一份 JSON 的 `FileName` 欄位是陷阱——它只指向最舊的年度
 */

/** 資料集在影視局系統中的識別碼。 */
export const DATASET_SN = {
  /** 電影片分級及相關資訊（年更，104–113 年）。 */
  rating: 'E10C6A5C3B9BD8C8',
  /** 全國電影院資料（年更，2016–2025 年）。 */
  cinema: 'E6C57FC155564DEB',
} as const

export type DatasetKey = keyof typeof DATASET_SN

const BASE_URL = 'https://www.bamid.gov.tw/OpenData.aspx'

/** 「相關檔案」欄位的格式：`名稱(URL);名稱(URL);...` */
const RELATED_FILE_RE = /([^;()]+)\((https?:\/\/[^)]+)\)/g

export interface DatasetFile {
  /** 檔案名稱，如「113年電影片分級及相關資訊」。 */
  name: string
  url: string
}

/** 取文字並去除 UTF-8 BOM。影視局的回應一律帶 BOM。 */
export function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, '')
}

/**
 * 解析包裝 JSON 的「相關檔案」欄位。
 *
 * 抽成獨立函式是為了能離線測試——這段字串切分是整條管線最容易
 * 因上游格式微調而默默壞掉的地方。
 */
export function parseRelatedFiles(related: string): DatasetFile[] {
  return [...related.matchAll(RELATED_FILE_RE)].map(match => ({
    name: match[1]!.trim(),
    url: match[2]!,
  }))
}

/** 讓呼叫端注入 fetch，測試時可換成假的。 */
export type Fetcher = (url: string) => Promise<string>

const defaultFetcher: Fetcher = async (url) => {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'filmnote-ingest/0.1 (+https://github.com/clipwww/filmnote)' },
  })
  if (!response.ok)
    throw new Error(`取得 ${url} 失敗：HTTP ${response.status}`)
  return response.text()
}

/**
 * 列出某資料集的所有逐年檔案，依年度升冪排列。
 *
 * 回傳的最後一筆即為最新年度。
 */
export async function listDatasetFiles(
  dataset: DatasetKey,
  fetcher: Fetcher = defaultFetcher,
): Promise<DatasetFile[]> {
  const raw = await fetcher(`${BASE_URL}?SN=${DATASET_SN[dataset]}`)
  const wrapper = JSON.parse(stripBom(raw)) as { 相關檔案?: string }[]

  const related = wrapper[0]?.相關檔案
  if (!related)
    throw new Error(`資料集 ${dataset} 的包裝 JSON 沒有「相關檔案」欄位，上游格式可能已變更`)

  const files = parseRelatedFiles(related)
  if (!files.length)
    throw new Error(`資料集 ${dataset} 的「相關檔案」解析不出任何檔案，上游格式可能已變更`)

  return files
}

/** 下載單一檔案的內容（已去 BOM）。 */
export async function fetchDatasetFile(
  file: DatasetFile,
  fetcher: Fetcher = defaultFetcher,
): Promise<string> {
  return stripBom(await fetcher(file.url))
}
