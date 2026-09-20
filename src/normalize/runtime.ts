/**
 * 「映演時間」欄位的解析（政府資料記的是「1 時 45 分 30 秒」而非分鐘數）。
 * 此值是 TMDB 比對的關鍵驗證訊號：實測缺少片長交叉驗證會把《一屍到底》配到
 * "Making Of One Cut of the Dead"、《貓的報恩》配到 "Batman Returns"。
 */

const RUNTIME_RE = /(?:(\d+)\s*時)?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?/

/**
 * 解析為分鐘數（四捨五入）。無法解析、或結果為 0 時回 null——後者代表來源欄位是空的，
 * 不應該被當成「片長 0 分鐘」。
 */
export function parseRuntimeMinutes(raw: string | undefined | null): number | null {
  if (!raw)
    return null

  const match = RUNTIME_RE.exec(raw.normalize('NFKC'))
  if (!match)
    return null

  const [, h, m, s] = match
  const total = Number(h ?? 0) * 60 + Number(m ?? 0) + Number(s ?? 0) / 60

  return total > 0 ? Math.round(total) : null
}
