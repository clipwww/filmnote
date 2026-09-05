/**
 * 自地址取出縣市，並統一「台」與「臺」。
 *
 * 政府電影院資料的地址前綴混用兩種寫法（實測 2025 年：
 * 台北市 25 筆 vs 臺北市 5 筆、台南市 7 筆 vs 臺南市 2 筆），
 * 不正規化會讓同一個縣市在統計中裂成兩筆。
 */

/** 全國 22 個縣市。以「台」為正規形式。 */
const CITIES = [
  '基隆市',
  '台北市',
  '新北市',
  '桃園市',
  '新竹市',
  '新竹縣',
  '苗栗縣',
  '台中市',
  '彰化縣',
  '南投縣',
  '雲林縣',
  '嘉義市',
  '嘉義縣',
  '台南市',
  '高雄市',
  '屏東縣',
  '宜蘭縣',
  '花蓮縣',
  '台東縣',
  '澎湖縣',
  '金門縣',
  '連江縣',
] as const

export type City = typeof CITIES[number]

/** 把「臺」統一寫成「台」。兩者在政府資料中可互換出現。 */
export function unifyTaiwanChar(text: string): string {
  return text.replace(/臺/g, '台')
}

/**
 * 自地址取出縣市。
 *
 * 認不出來時回傳 null 而非猜測——寧可讓這筆進人工佇列，
 * 也不要在統計中產生一個錯誤的縣市。
 */
export function extractCity(address: string | undefined | null): City | null {
  if (!address)
    return null

  const unified = unifyTaiwanChar(address.trim())
  return CITIES.find(city => unified.startsWith(city)) ?? null
}
