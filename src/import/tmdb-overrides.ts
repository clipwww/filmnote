/**
 * 舊 log 片名 → TMDB id 的**人工**指定。為什麼不是「把比對門檻調鬆一點」：舊 log 沒有
 * 片長欄位 ⇒ 片長交叉驗證那一關在這條路徑上形同關閉，護欄失效時放寬門檻等於在最沒有
 * 把握的時候最敢猜——實測咬過一次（《Fate stay night Heaven's feel》配到系列第二部）。
 * ⇒ 呼叫端收緊，缺口用這張逐筆人工指定的表補，一部都不放給演算法猜。
 */
// `reason` 不是裝飾：想知道「放寬哪一種樣式能多命中幾部、又會誤配幾部」，答案在這一欄
// 的分佈裡。Step 7 的審核 UI 可直接把本表當「建議配對」的種子資料。

/** 比對器沒配到的原因分類。皆為 169 筆舊 log 實測所見，不是預想出來的分類。 */
export type TmdbMissReason
  /** 中文片名用詞不同：「電影版」vs「劇場版」、「總篇集」vs「總集篇」。 */
  = | 'zh-wording'
  /** 中文片名錯字，連 TMDB 搜尋都查不到（「侏儸紀」應為「侏羅紀」）。 */
    | 'zh-typo'
  /** TMDB 的中文片名帶英文主標，舊 log 只寫中文副標。 */
    | 'zh-has-latin-main-title'
  /** 系列作序號寫法不同：阿拉伯數字 vs 羅馬數字＋副標。**最危險的一類**， */
  /** 因為前綴比對會讓第一部配到第二部。 */
    | 'series-numbering'
  /** 片名太短，低於比對器的 MIN_PREFIX_LENGTH_ZH（3 字）而不觸發前綴訊號。 */
    | 'zh-too-short'
  /** 標點或符號差異：全形「．」vs 中點「·」、破折號。 */
    | 'punctuation'

export interface TmdbOverride {
  /** 舊 log `title` 欄的原字串。逐字比對，不做正規化。 */
  logTitle: string
  tmdbId: number
  /** TMDB 上的中文片名，供人工複核與 Step 7 的 UI 顯示。 */
  tmdbTitle: string
  releaseYear: number
  reason: TmdbMissReason
  /** 給審核者看的一句話：比對器為什麼沒配到。 */
  note: string
}

export const TMDB_OVERRIDES: TmdbOverride[] = [
  {
    logTitle: 'Fate stay night Heaven\'s feel',
    tmdbId: 283984,
    tmdbTitle: 'Fate/stay night [Heaven\'s Feel] I.預示之花',
    releaseYear: 2017,
    reason: 'series-numbering',
    note:
      '舊 log 的第一部不寫序號，TMDB 寫「Ⅰ.預示之花」。'
      + '前綴比對會讓它配到第二部「Ⅱ.迷途之蝶」——實測確實配錯了，'
      + '這正是呼叫端要求精確訊號的原因。',
  },
  {
    logTitle: 'Fate stay night Heaven\'s feel 2',
    tmdbId: 390634,
    tmdbTitle: 'Fate/stay night [Heaven\'s Feel] II.迷途之蝶',
    releaseYear: 2019,
    reason: 'series-numbering',
    note: '舊 log 用阿拉伯數字「2」，TMDB 用「Ⅱ.迷途之蝶」。',
  },
  {
    logTitle: 'Fate stay night Heaven\'s feel 3',
    tmdbId: 390635,
    tmdbTitle: 'Fate/stay night [Heaven\'s Feel] III.春櫻之歌',
    releaseYear: 2020,
    reason: 'series-numbering',
    note: '舊 log 用阿拉伯數字「3」，TMDB 用「Ⅲ.春櫻之歌」。',
  },
  {
    logTitle: '星際大戰八部曲：最後的絕地武士',
    tmdbId: 181808,
    tmdbTitle: 'STAR WARS：最後的絕地武士',
    releaseYear: 2017,
    reason: 'zh-has-latin-main-title',
    note: 'TMDB 的中文片名主標是英文「STAR WARS」，舊 log 寫「星際大戰八部曲」。',
  },
  {
    logTitle: '星際大戰九部曲：天行者的崛起',
    tmdbId: 181812,
    tmdbTitle: 'STAR WARS：天行者的崛起',
    releaseYear: 2019,
    reason: 'zh-has-latin-main-title',
    note: '同上，主標為英文。副標「天行者的崛起」完全吻合但不足以觸發精確訊號。',
  },
  {
    logTitle: '遊戲人生 ZERO',
    tmdbId: 445030,
    tmdbTitle: 'NO GAME NO LIFE 劇場版：遊戲人生 ZERO',
    releaseYear: 2017,
    reason: 'zh-has-latin-main-title',
    note: 'TMDB 片名前面多了英文主標「NO GAME NO LIFE 劇場版：」，前綴比對因此不成立。',
  },
  {
    logTitle: '劇場版艦隊收藏',
    tmdbId: 412383,
    tmdbTitle: '艦隊Collection 劇場版',
    releaseYear: 2016,
    reason: 'zh-wording',
    note: '「艦隊收藏」vs「艦隊Collection」，且「劇場版」在舊 log 是前綴、TMDB 是後綴。',
  },
  {
    logTitle: '紫羅蘭永恆花園電影版',
    tmdbId: 533514,
    tmdbTitle: '紫羅蘭永恆花園 劇場版',
    releaseYear: 2020,
    reason: 'zh-wording',
    note: '舊 log 寫「電影版」，TMDB 寫「劇場版」。日本動畫劇場版最常見的用詞落差。',
  },
  {
    logTitle: '電影版小林家的龍女僕：害怕寂寞的龍',
    tmdbId: 1359607,
    tmdbTitle: '小林家的龍女僕 害怕寂寞的龍',
    releaseYear: 2025,
    reason: 'zh-wording',
    note: '舊 log 多了「電影版」前綴，TMDB 沒有。',
  },
  {
    logTitle: '來自深淵 深沉靈魂的黎明',
    tmdbId: 573730,
    tmdbTitle: '來自深淵  劇場版 深沉靈魂的黎明',
    releaseYear: 2020,
    reason: 'zh-wording',
    note: 'TMDB 片名中間插了「劇場版」，舊 log 沒有，前綴因此在中途分岔。',
  },
  {
    logTitle: '刀劍神域 Progressive 無星夜的詠嘆調',
    tmdbId: 761898,
    tmdbTitle: '刀劍神域劇場版－Progressive－無星夜的詠嘆調',
    releaseYear: 2021,
    reason: 'zh-wording',
    note: 'TMDB 多了「劇場版」且以全形破折號包住 Progressive。',
  },
  {
    logTitle: '少女與戰車總篇集',
    tmdbId: 701527,
    tmdbTitle: '少女與戰車 總集篇 - 第63屆戰車道全國高中生大會',
    releaseYear: 2018,
    reason: 'zh-wording',
    note: '「總篇集」與「總集篇」二字倒置，且 TMDB 帶了長副標。',
  },
  {
    logTitle: '我的英雄學院劇場版：英雄新世紀',
    tmdbId: 592350,
    tmdbTitle: '我的英雄學院 英雄新世紀',
    releaseYear: 2019,
    reason: 'zh-wording',
    note:
      '舊 log 多了「劇場版：」。這筆連 TMDB 搜尋都回 0 筆——'
      + '未命中不必然代表片庫沒有，也可能是查詢字串本身帶了雜訊。',
  },
  {
    logTitle: '侏儸紀世界：殞落國度',
    tmdbId: 351286,
    tmdbTitle: '侏羅紀世界：殞落國度',
    releaseYear: 2018,
    reason: 'zh-typo',
    note:
      '舊 log 寫「侏儸紀」，正確是「侏羅紀」。錯字讓 TMDB 搜尋回 0 筆，'
      + '比對器連候選都拿不到——這一類只能靠人工，任何門檻都救不了。',
  },
  {
    logTitle: '白箱',
    tmdbId: 532323,
    tmdbTitle: '劇場版 白箱 SHIROBAKO',
    releaseYear: 2020,
    reason: 'zh-too-short',
    note:
      '片名只有兩個字，低於比對器的 MIN_PREFIX_LENGTH_ZH（3），'
      + '前綴訊號不觸發。這個下限是刻意的——兩字片名做前綴比對會產生大量偽吻合。',
  },
  {
    logTitle: '新．超人力霸王',
    tmdbId: 634429,
    tmdbTitle: '新·超人力霸王',
    releaseYear: 2022,
    reason: 'punctuation',
    note:
      '舊 log 用全形句點「．」(U+FF0E)，TMDB 用中點「·」(U+00B7)。'
      + 'normalizeTitle 的標點清單沒有涵蓋這兩個字元，正規化後仍然不同。',
  },
]

const GIRLS_UND_PANZER_NOTE
  = '舊 log 把第1話與第2話（或第3話與第4話）的連映記成一筆「1+2」／「3+4」，'
    + 'TMDB 上四話各自獨立、沒有連映版條目。拆分規則見 src/import/double-features.ts，'
    + '此處只負責指定拆出來的每一話對應哪一部作品。'

export const TMDB_OVERRIDES_DOUBLE_FEATURE_PARTS: TmdbOverride[] = [
  {
    logTitle: '少女與戰車最終章 第1話',
    tmdbId: 474659,
    tmdbTitle: '少女與戰車最終章 第1話',
    releaseYear: 2017,
    reason: 'zh-wording',
    note: GIRLS_UND_PANZER_NOTE,
  },
  {
    logTitle: '少女與戰車最終章 第2話',
    tmdbId: 496891,
    tmdbTitle: '少女與戰車最終章 第2話',
    releaseYear: 2019,
    reason: 'zh-wording',
    note: GIRLS_UND_PANZER_NOTE,
  },
  {
    logTitle: '少女與戰車最終章 第3話',
    tmdbId: 746880,
    tmdbTitle: '少女與戰車最終章 第3話',
    releaseYear: 2021,
    reason: 'zh-wording',
    note: GIRLS_UND_PANZER_NOTE,
  },
  {
    logTitle: '少女與戰車最終章 第4話',
    tmdbId: 1051192,
    tmdbTitle: '少女與戰車最終章 第4話',
    releaseYear: 2023,
    reason: 'zh-wording',
    note: GIRLS_UND_PANZER_NOTE,
  },
]

/** 全部人工指定（含連映拆出來的分話）。 */
export const ALL_OVERRIDES: TmdbOverride[] = [
  ...TMDB_OVERRIDES,
  ...TMDB_OVERRIDES_DOUBLE_FEATURE_PARTS,
]

const BY_LOG_TITLE = new Map(ALL_OVERRIDES.map(o => [o.logTitle, o]))

/** 逐字查表。查無時回傳 null，不做任何模糊比對。 */
export function resolveTmdbOverride(logTitle: string): TmdbOverride | null {
  return BY_LOG_TITLE.get(logTitle.trim()) ?? null
}
