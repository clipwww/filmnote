/**
 * 片名正規化與版本標註處理。
 *
 * 政府分級資料的中文片名常內嵌版本標註（實測 113 年 60/805 筆，7.5%），
 * 例如「紅豬(中文版)」「戀戀風塵（數位修復版）」「啊，荒野 前篇」。
 * 這些標註在 TMDB 上不存在，比對前必須剝除，否則必然誤配。
 */

/**
 * 版本標註的樣式。
 *
 * 修復類標註刻意寫成通用樣式而非窮舉詞彙——實際資料裡至少有
 * 「數位修復版」「4K修復版」「4K數位修復加長版」三種寫法，
 * 而且每年都可能冒出新的組合。窮舉必然漏掉。
 *
 * 順序有意義：較長的樣式必須排在較短的之前，否則
 * 「4K數位修復加長版」會先被較短的樣式吃掉一部分。
 */
const VERSION_TERMS = [
  // (4K)(數位)修復(加長)(版) 的各種組合
  '\\d+K\\s*數位修復加長版',
  '\\d+K\\s*數位修復版',
  '\\d+K\\s*修復加長版',
  '\\d+K\\s*修復版',
  '\\d+K\\s*數位修復',
  '\\d+K\\s*修復',
  '數位修復加長版',
  '數位修復版',
  '數位修復',
  '修復加長版',
  '修復版',
  '經典重映',
  '國語版',
  '中文版',
  '日文版',
  '台語版',
  '粵語版',
  '導演版',
  '特別版',
  '完整版',
  '加長版',
  'IMAX版',
  'IMAX',
  '重映',
  '前篇',
  '後篇',
] as const

/** 版本標註可能被這些成對符號包住，也可能裸露。 */
const OPEN = '[(（【[]?\\s*'
const CLOSE = '\\s*[)）】\\]]?'

const VERSION_RE = new RegExp(`${OPEN}(${VERSION_TERMS.join('|')})${CLOSE}`, 'gi')

/** 比對鍵不保留的符號：全形與半形標點、空白、書名號。 */
const PUNCTUATION_RE = /[\s\-–—_:：,，.。!！?？'"“”‘’()（）[\]【】《》~～、/|]+/g

export interface VersionExtraction {
  /** 剝除版本標註後的片名，保留原始大小寫與標點供顯示用。 */
  title: string
  /** 被剝除的版本標註（人類可讀），沒有則為 null。 */
  note: string | null
}

/**
 * 自片名分離出版本標註。
 *
 * 回傳的 `title` 供顯示與後續比對，`note` 存入 certificate.versionNote。
 * 同一片名出現多個標註時（罕見），以「、」串接。
 */
export function extractVersionNote(raw: string): VersionExtraction {
  const input = (raw ?? '').trim()
  if (!input)
    return { title: '', note: null }

  const notes: string[] = []
  const stripped = input.replace(VERSION_RE, (_match, term: string) => {
    notes.push(term.trim())
    return ''
  })

  // 剝除後可能留下孤立的括號或連續空白，收乾淨再回傳。
  const cleaned = stripped
    .replace(/[(（【[]\s*[)）】\]]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return {
    // 若標註佔滿整個片名（理論上不該發生），寧可保留原字串也不要回傳空值。
    title: cleaned || input,
    note: notes.length ? notes.join('、') : null,
  }
}

/**
 * 產生用於比對的正規化鍵。
 *
 * NFKC 會把全形英數與符號摺疊為半形（「：」→「:」、「Ａ」→「A」），
 * 這是政府資料與 TMDB 之間最常見的差異來源之一。
 */
export function normalizeTitle(raw: string): string {
  if (!raw)
    return ''
  return extractVersionNote(raw.normalize('NFKC'))
    .title
    .toLowerCase()
    .replace(PUNCTUATION_RE, '')
}
