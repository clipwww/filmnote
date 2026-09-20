import type { Certificate, TmdbSearchResult } from '#pipeline/types'
import { describe, expect, it } from 'vitest'
import { matchCertificate, scoreCandidate } from '#pipeline/match/matcher'

/**
 * 本檔案的每個案例都來自 110–113 年 3,116 筆的實測結果。
 * 修改比對器前請先確認這些仍然通過——它們是三個已知失敗模式的護欄。
 */

function cert(partial: Partial<Certificate>): Certificate {
  return {
    id: '113:局影外第113001號:test',
    permitNo: '局影外第113001號',
    rocYear: 113,
    gregorianYear: 2024,
    rating: '普',
    titleZh: '',
    titleOriginal: '',
    country: '美國',
    language: '英語',
    producer: '',
    runtimeMinutes: null,
    versionNote: null,
    defects: [],
    ...partial,
  }
}

function candidate(partial: Partial<TmdbSearchResult>): TmdbSearchResult {
  return {
    id: 1,
    title: '',
    original_title: '',
    release_date: '2024-01-01',
    poster_path: '/x.jpg',
    popularity: 1,
    ...partial,
  }
}

const noRuntime = () => null

describe('失敗模式一：年份不可作硬篩（重映片）', () => {
  it('《紅豬》核准 113 年、TMDB 1992，仍應命中', () => {
    // 政府給義大利文片名，TMDB 的 original_title 是日文，
    // 唯一對得上的是 TMDB 的 zh-TW title。
    const result = matchCertificate(
      cert({ rocYear: 113, gregorianYear: 2024, titleZh: '紅豬(中文版)', titleOriginal: 'Porco Rosso' }),
      [candidate({ id: 11621, title: '紅豬', original_title: '紅の豚', release_date: '1992-07-18' })],
      noRuntime,
    )
    expect(result.matched).toBe(true)
  })

  it('《千禧曼波》核准 113 年、TMDB 2001，仍應命中', () => {
    const result = matchCertificate(
      cert({ titleZh: '千禧曼波', titleOriginal: 'Millennium Mambo' }),
      [candidate({ id: 25423, title: '千禧曼波', original_title: '千禧曼波', release_date: '2001-05-01' })],
      noRuntime,
    )
    expect(result.matched).toBe(true)
  })

  it('《戀戀風塵》數位修復版核准 113 年、TMDB 1986，仍應命中', () => {
    const result = matchCertificate(
      cert({ titleZh: '戀戀風塵（數位修復版）', titleOriginal: 'Dust in the Wind (Restored)' }),
      [candidate({ id: 42465, title: '戀戀風塵', original_title: '戀戀風塵', release_date: '1986-12-01' })],
      noRuntime,
    )
    expect(result.matched).toBe(true)
  })

  it('年份接近仍然加分，只是不再是必要條件', () => {
    const near = scoreCandidate(
      cert({ gregorianYear: 2024, titleZh: '沙丘：第二部' }),
      candidate({ title: '沙丘：第二部', release_date: '2024-02-27' }),
    )
    const far = scoreCandidate(
      cert({ gregorianYear: 2024, titleZh: '沙丘：第二部' }),
      candidate({ title: '沙丘：第二部', release_date: '1984-12-14' }),
    )
    expect(near.signals).toContain('year-near')
    expect(far.signals).not.toContain('year-near')
    expect(near.score).toBeGreaterThan(far.score)
    // 但年份差距不會把分數壓到門檻以下
    expect(far.score).toBeGreaterThanOrEqual(5)
  })
})

describe('失敗模式二：TMDB 的 original_title 常是母語而非英文', () => {
  it('政府給 Ponyo on the Cliff、TMDB 存 崖の上のポニョ，透過中文片名命中', () => {
    const result = matchCertificate(
      cert({ titleZh: '崖上的波妞(中文版)', titleOriginal: 'Ponyo on the Cliff by the Sea' }),
      [candidate({ id: 12429, title: '崖上的波妞', original_title: '崖の上のポニョ', release_date: '2008-07-19' })],
      noRuntime,
    )
    expect(result.matched).toBe(true)
  })

  it('原文片名對上 TMDB 的 title 而非 original_title 時也算精確吻合', () => {
    const scored = scoreCandidate(
      cert({ titleOriginal: 'ANYONE BUT YOU' }),
      candidate({ title: 'Anyone But You', original_title: 'Anyone But You' }),
    )
    expect(scored.signals).toContain('original-exact')
  })
})

describe('失敗模式三：片名相近的花絮與同名片不得配上', () => {
  it('《一屍到底》不可配到 Making Of 花絮', () => {
    // 這個案例在評分階段就被擋下（片名前綴對不上、年份也差 5 年），
    // 根本走不到片長驗證。被更早的關卡攔截是更好的結果。
    const result = matchCertificate(
      cert({ titleZh: '一屍到底', titleOriginal: 'ONE CUT OF THE DEAD', runtimeMinutes: 96 }),
      [candidate({
        id: 999001,
        title: 'Making Of "One Cut Of The Dead"',
        original_title: 'Making Of "One Cut Of The Dead"',
        release_date: '2019-01-01',
      })],
      () => 30,
    )
    expect(result.matched).toBe(false)
    expect(result).toMatchObject({ reason: 'score-too-low' })
  })

  it('《貓的報恩》不可配到 Batman Returns', () => {
    const result = matchCertificate(
      cert({ titleZh: '貓的報恩(日文版)', titleOriginal: 'The Cat Returns', runtimeMinutes: 75 }),
      [candidate({
        id: 999002,
        title: 'Batman Returns: The Bat, the Cat and the Penguin',
        original_title: 'Batman Returns: The Bat, the Cat and the Penguin',
        release_date: '1992-01-01',
      })],
      () => 126,
    )
    expect(result.matched).toBe(false)
  })

  it('片名只是前綴吻合、且片長對不上時，由片長閘門攔下', () => {
    // 《嗜殺路人甲》原文為 THE STRANGERS TRILOGY: PART 1，
    // 前綴會吻合到 The Strangers（2008 年的另一部片），
    // 加上年份接近共 3.5 分越過門檻——只有片長能區分兩者。
    const result = matchCertificate(
      cert({
        titleZh: '嗜殺路人甲',
        titleOriginal: 'THE STRANGERS TRILOGY: PART 1',
        runtimeMinutes: 91,
        gregorianYear: 2024,
      }),
      [candidate({
        id: 999003,
        title: 'The Strangers',
        original_title: 'The Strangers',
        release_date: '2024-05-17',
      })],
      () => 178,
    )
    expect(result.matched).toBe(false)
    expect(result).toMatchObject({ reason: 'runtime-mismatch' })
  })

  it('同樣的前綴吻合，片長相符時應該通過', () => {
    const result = matchCertificate(
      cert({
        titleZh: '嗜殺路人甲',
        titleOriginal: 'THE STRANGERS TRILOGY: PART 1',
        runtimeMinutes: 91,
        gregorianYear: 2024,
      }),
      [candidate({
        id: 999004,
        title: 'The Strangers',
        original_title: 'The Strangers',
        release_date: '2024-05-17',
      })],
      () => 91,
    )
    expect(result.matched).toBe(true)
  })

  it('片名精確吻合時，片長差異不否決配對（導演版、加長版的情形）', () => {
    const result = matchCertificate(
      cert({ titleZh: '沙丘：第二部', titleOriginal: 'DUNE: PART TWO', runtimeMinutes: 166 }),
      [candidate({ id: 693134, title: '沙丘：第二部', original_title: 'Dune: Part Two', release_date: '2024-02-27' })],
      () => 200,
    )
    expect(result.matched).toBe(true)
  })

  it('政府或 TMDB 任一方沒有片長時，不因此否決', () => {
    const result = matchCertificate(
      cert({ titleZh: '某部片', titleOriginal: 'SOME FILM', runtimeMinutes: null }),
      [candidate({ id: 5, title: '某部片', original_title: 'Some Film' })],
      () => 120,
    )
    expect(result.matched).toBe(true)
  })
})

describe('未命中的判定', () => {
  it('候選集為空時回報 no-candidates', () => {
    const result = matchCertificate(cert({ titleZh: '查無此片' }), [], noRuntime)
    expect(result).toEqual({ matched: false, reason: 'no-candidates', score: 0 })
  })

  it('只有年份接近而片名毫無關聯時，不硬猜', () => {
    const result = matchCertificate(
      cert({ titleZh: '福田村事件', titleOriginal: 'Sep-23' }),
      [candidate({ id: 7, title: '完全無關的片', original_title: 'Totally Unrelated', release_date: '2024-05-01' })],
      noRuntime,
    )
    expect(result.matched).toBe(false)
    expect(result).toMatchObject({ reason: 'score-too-low' })
  })

  it('短片名不因前綴而偽吻合', () => {
    // 「商魂」不該因為前綴而配到「商魂之類的其他片」
    const scored = scoreCandidate(
      cert({ titleZh: '商魂', titleOriginal: 'Trade War' }),
      candidate({ title: 'Trump\'s Trade War', original_title: 'Trump\'s Trade War' }),
    )
    expect(scored.signals).not.toContain('zh-exact')
    expect(scored.signals).not.toContain('original-exact')
  })
})

describe('版本標註在比對前被剝除', () => {
  it.each([
    ['紅豬(中文版)', '紅豬'],
    ['貓的報恩(日文版)', '貓的報恩'],
    ['下女的誘惑 經典重映', '下女的誘惑'],
    ['蘇州河（4K修復版）', '蘇州河'],
  ])('%s 能配到 TMDB 的《%s》', (govTitle, tmdbTitle) => {
    const scored = scoreCandidate(
      cert({ titleZh: govTitle }),
      candidate({ title: tmdbTitle, original_title: tmdbTitle }),
    )
    expect(scored.signals).toContain('zh-exact')
  })
})

describe('全形半形差異不影響比對', () => {
  it('《機密特務:阿蓋爾》能配到《機密特務：阿蓋爾》', () => {
    const scored = scoreCandidate(
      cert({ titleZh: '機密特務:阿蓋爾' }),
      candidate({ title: '機密特務：阿蓋爾' }),
    )
    expect(scored.signals).toContain('zh-exact')
  })
})

/**
 * 空殼條目（2026-09-20 實測，David：「你的名字在 TMDB 有海報呀 為什麼我這沒有呀？」）
 *
 * TMDB 上有一類條目只有標題，沒有上映日、片長 0、沒有簡介、常常沒有海報。
 * 它們在片名上可以是一字不差的精確吻合，於是拿到跟真片一樣的分數。
 * `ingest-rating.ts` 先搜原文片名再搜中文片名、以 Map 合併，空殼因此先進候選集，
 * 而舊的 `reduce` 用嚴格大於、平手保留先出現的 ⇒ 空殼贏。
 *
 * ⚠️ 這兩個案例的候選順序**刻意是「空殼在前」**——那正是實際發生的順序。
 *    把順序反過來測會碰巧通過，而那是一個會一路綠的測試。
 */
describe('平手時不可以選到沒有上映日的空殼條目', () => {
  const runtimeUnknown = () => null

  it('《你的名字。》要配到真片而不是同名空殼', () => {
    // 政府核准資料的原文片名是英文「YOUR NAME.」而不是「君の名は。」，
    // 所以空殼的 original-exact 與真片的 zh-exact 都是 5 分。
    const certificate = cert({ titleZh: '你的名字。', titleOriginal: 'YOUR NAME.' })
    const stub = candidate({ id: 553301, title: 'Your Name', original_title: 'Your Name', release_date: '', poster_path: null })
    const real = candidate({ id: 372058, title: '你的名字', original_title: '君の名は。', release_date: '2016-07-01' })

    expect(scoreCandidate(certificate, stub).score).toBe(scoreCandidate(certificate, real).score)

    const outcome = matchCertificate(certificate, [stub, real], runtimeUnknown)
    expect(outcome.matched).toBe(true)
    expect(outcome.matched && outcome.tmdbId).toBe(372058)
  })

  it('《潛艦危機倒數》要配到 Torpedo 而不是同名空殼 U235', () => {
    const certificate = cert({ titleZh: '潛艦危機倒數', titleOriginal: 'U235', rocYear: 110, gregorianYear: 2021 })
    const stub = candidate({ id: 1391860, title: 'U235', original_title: 'U235', release_date: '', poster_path: null })
    const real = candidate({ id: 554022, title: '潛艦危機倒數', original_title: 'Torpedo', release_date: '2019-10-23' })

    expect(scoreCandidate(certificate, stub).score).toBe(scoreCandidate(certificate, real).score)

    const outcome = matchCertificate(certificate, [stub, real], runtimeUnknown)
    expect(outcome.matched && outcome.tmdbId).toBe(554022)
  })

  it('★ 兩者都有上映日時維持原行為（保留先出現的）——證明這條規則只在該出手時出手', () => {
    const certificate = cert({ titleZh: '同名', titleOriginal: 'SAME' })
    const first = candidate({ id: 11, title: 'SAME', original_title: 'SAME', release_date: '2020-01-01' })
    const second = candidate({ id: 22, title: '同名', original_title: '同名', release_date: '2021-01-01' })

    expect(scoreCandidate(certificate, first).score).toBe(scoreCandidate(certificate, second).score)
    // ⚠️ 要先存成變數再取 tmdbId：`MatchOutcome` 是 discriminated union，
    //    `a.matched && b.tmdbId` 這種寫法的型別縮小**不會跨兩次獨立呼叫傳遞**。
    const outcome = matchCertificate(certificate, [first, second], runtimeUnknown)
    expect(outcome.matched).toBe(true)
    expect(outcome.matched && outcome.tmdbId).toBe(11)
  })

  it('★ 分數沒有被動到——這條規則不是加分，所以門檻判定不受影響', () => {
    // 有上映日與沒有上映日的同一個候選，分數必須完全相同。
    //
    // ⚠️ 上映日刻意用 1990 而不是核准年附近：`year-near` 會給 +1.5，
    //    第一版寫 '2024-01-01'（＝ cert 的 gregorianYear）於是量到 6.5 vs 5，
    //    **看起來像我的改動在加分，其實是既有訊號**。
    //    這個斷言要隔離的是「平手比較有沒有動到分數」，不是「有上映日會不會加分」。
    const certificate = cert({ titleZh: '測試片', titleOriginal: 'TEST' })
    const withDate = candidate({ title: 'TEST', original_title: 'TEST', release_date: '1990-01-01' })
    const without = candidate({ title: 'TEST', original_title: 'TEST', release_date: '' })
    expect(scoreCandidate(certificate, withDate).score).toBe(scoreCandidate(certificate, without).score)
  })
})
