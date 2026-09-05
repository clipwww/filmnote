/** 政府分級資料的一列原始欄位（110 年起的 9 欄 schema）。 */
export interface RawRatingRow {
  年度: string
  分級證明字號: string
  級別: string
  中文片名: string
  原文片名: string
  國別: string
  語言: string
  出品公司: string
  映演時間: string
}

/** 政府電影院資料的一列原始欄位（2025 年的 6 欄 schema）。 */
export interface RawCinemaRow {
  事業名稱: string
  公司名稱: string
  統一編號: string
  廳數: string
  地址: string
  電話: string
}

/** 核准紀錄。一部作品可能有多筆（國語版／日語版／2D／3D 分開核准）。 */
export interface Certificate {
  /**
   * 確定性的代理主鍵：`年度:字號:正規化片名`。
   *
   * 不用 `permitNo` 當主鍵，因為它只在 113 年唯一——113 年的字號帶有
   * 系列前綴（局影外／本／港／陸），110–112 年的 CSV 沒有前綴，
   * 四個系列各自從 001 編號因而全部撞號（110 年 103 組、111 年 105 組、
   * 112 年 120 組重複）。前綴無法從國別可靠地推回。
   *
   * 此複合鍵在 110–113 年全部 3,116 筆上實測唯一，且為確定性——
   * 重跑匯入不會產生重複列。
   */
  id: string
  /** 分級證明字號。**跨年度不唯一**，僅作為屬性保留。 */
  permitNo: string
  /** 民國年度。 */
  rocYear: number
  /** 對應的西元年，用於 TMDB 年份比對。 */
  gregorianYear: number
  rating: string
  titleZh: string
  titleOriginal: string
  country: string
  language: string
  producer: string
  /** 由「映演時間」解析出的分鐘數；無法解析時為 null。 */
  runtimeMinutes: number | null
  /** 自中文片名剝除的版本標註，如「中文版」「數位修復版」。 */
  versionNote: string | null
  /** 來源資料的已知問題，供人工佇列判讀。 */
  defects: RowDefect[]
}

/** 來源資料的損毀型態。皆為 110–113 年實測所見。 */
export type RowDefect
  /** 原文片名被 Excel 誤判為日期，如《福田村事件》的 `Sep-23`。 */
  = | 'original-title-excel-date'
  /** 原文片名編碼損毀，呈現為連續問號。 */
    | 'original-title-corrupted'
  /** 原文片名為空。 */
    | 'original-title-missing'
  /** 中文片名為空。 */
    | 'title-zh-missing'
  /**
   * 映演時間欄位放的不是片長。
   * 實測見過發行商名稱（《大發明家》= `木棉花國際股份有限公司`）
   * 與上映日期區間（《戀戀風塵（數位修復版）》= `113.08.17-113.08.17`）。
   */
    | 'runtime-unparseable'
  /**
   * 中文片名疑似編碼損毀。
   *
   * 來源資料把無法轉換的 CJK 字元寫成 ASCII `?`，例如「坂本龍一：終章」
   * 變成「?本龍一：終章」、「-EPISODE 凪-」變成「-EPISODE ?-」。
   *
   * 不做自動修復，因為無法可靠地與真正的問號區分——《孩子，你好嗎？》
   * 這類片名本身就含問號。標記後由 consolidate 決定：有 TMDB 中文標題
   * 時採用它，否則進 UGC 佇列由人補。
   */
    | 'title-zh-suspect-encoding'
  /**
   * CSV 引號損壞導致欄位右移，已回推修正。
   * 實測 113 年 2 筆《劇場版IDOLiSH7》——原文片名內含逗號卻未被引號包住，
   * 使「原文片名」之後的欄位全部錯位一格，若不修正會污染國別統計。
   */
    | 'column-shift-recovered'
  /** 欄數異常且無法安全回推，該列的欄位對應不可信。 */
    | 'column-count-unexpected'

export interface Cinema {
  /** 統一編號。實測 2025 年 107/107 有值、零重複。 */
  taxId: string
  /** 事業名稱（對外營業名稱），UI 顯示用。 */
  name: string
  /** 公司名稱（登記法人全銜）。 */
  companyName: string
  hallCount: number
  address: string
  phone: string
  /** 由地址前綴正規化而得（台／臺統一）。 */
  city: string
}

/** TMDB 搜尋結果中我們用得到的欄位。 */
export interface TmdbSearchResult {
  id: number
  title: string
  original_title: string
  release_date: string
  poster_path: string | null
  popularity: number
}

/** TMDB 影片明細中我們用得到的欄位。 */
export interface TmdbMovieDetail extends TmdbSearchResult {
  imdb_id: string | null
  overview: string
  runtime: number | null
  release_dates?: {
    results: { iso_3166_1: string, release_dates: { release_date: string }[] }[]
  }
}

/** 比對時採計的訊號，保留於結果中供除錯與回歸測試斷言。 */
export type MatchSignal
  = | 'original-exact'
    | 'original-prefix'
    | 'zh-exact'
    | 'zh-prefix'
    | 'year-near'

export type MatchRejection
  = | 'no-candidates'
    | 'score-too-low'
    | 'runtime-mismatch'

export type MatchOutcome
  = | { matched: true, tmdbId: number, score: number, signals: MatchSignal[] }
    | { matched: false, reason: MatchRejection, score: number }

/**
 * 作品。多筆 Certificate 收斂為一部 Film。
 *
 * 實測 110–113 年的 3,116 筆核准紀錄收斂為 2,669 部作品，
 * 亦即有 14.3%（447 筆）是同片的重複核准（跨年度重映、國語版／日語版分開送審）。
 */
export interface Film {
  /**
   * 確定性主鍵。
   * 命中 TMDB 者為 `tmdb:<id>`，未命中者為 `gov:<正規化中文片名>:<正規化原文片名>`。
   * 兩種前綴都可重跑而不產生重複。
   */
  id: string
  /** 未命中 TMDB 時為 null。這正是 SPEC 要求可為 NULL 的欄位。 */
  tmdbId: number | null
  titleZh: string
  titleOriginal: string
  country: string
  runtimeMinutes: number | null
  /** 最早出現此作品的民國年度。 */
  firstSeenRocYear: number
  /** 收斂進此作品的核准紀錄 id。 */
  certificateIds: string[]
  source: 'tmdb' | 'gov'
}

/** 單筆核准紀錄的比對結果，供 checkpoint 保存與續跑。 */
export interface MatchRecord {
  certificateId: string
  outcome: MatchOutcome
  /** 比對當下的時間，供資料新鮮度判斷。 */
  matchedAt: string
}
