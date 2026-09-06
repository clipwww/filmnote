import { describe, expect, it } from 'vitest'
import { extractCity, unifyTaiwanChar } from '#pipeline/normalize/city'
import { normalizeCountry } from '#pipeline/normalize/country'
import { hasPrivateUseChars, hasReplacementChars, inspectOriginalTitle, inspectTitleZh, isCorruptedEncoding, isExcelDateArtifact } from '#pipeline/normalize/defensive'
import { parseRuntimeMinutes } from '#pipeline/normalize/runtime'
import { extractVersionNote, normalizeTitle } from '#pipeline/normalize/title'

describe('版本標註剝除', () => {
  it.each([
    ['紅豬(中文版)', '紅豬', '中文版'],
    ['崖上的波妞(中文版)', '崖上的波妞', '中文版'],
    ['貓的報恩(日文版)', '貓的報恩', '日文版'],
    ['佩佩的電影派對（國語版）', '佩佩的電影派對', '國語版'],
    ['下女的誘惑 經典重映', '下女的誘惑', '經典重映'],
    ['戀戀風塵（數位修復版）', '戀戀風塵', '數位修復版'],
    ['恐怖份子（數位修復版）', '恐怖份子', '數位修復版'],
    ['蘇州河（4K修復版）', '蘇州河', '4K修復版'],
    ['啊，荒野 前篇', '啊，荒野', '前篇'],
    ['啊，荒野 後篇', '啊，荒野', '後篇'],
    ['魯邦三世 卡里奧斯特羅城 4K數位修復版', '魯邦三世 卡里奧斯特羅城', '4K數位修復版'],
  ])('%s → %s（標註：%s）', (input, expectedTitle, expectedNote) => {
    const result = extractVersionNote(input)
    expect(result.title).toBe(expectedTitle)
    expect(result.note).toBe(expectedNote)
  })

  it('沒有標註時原樣返回', () => {
    expect(extractVersionNote('沙丘：第二部')).toEqual({ title: '沙丘：第二部', note: null })
  })

  it('長標註優先於短標註，不被切碎', () => {
    // 「4K數位修復加長版」不可以先被「數位修復版」吃掉一部分
    expect(extractVersionNote('家有囍事4K數位修復加長版').note).toBe('4K數位修復加長版')
  })
})

describe('比對鍵正規化', () => {
  it('全形與半形冒號視為相同', () => {
    expect(normalizeTitle('機密特務:阿蓋爾')).toBe(normalizeTitle('機密特務：阿蓋爾'))
  })

  it('剝除標註後兩種寫法收斂為同一鍵', () => {
    expect(normalizeTitle('紅豬(中文版)')).toBe(normalizeTitle('紅豬'))
  })

  it('大小寫與空白不影響比對', () => {
    expect(normalizeTitle('ANYONE BUT YOU')).toBe(normalizeTitle('anyone but you'))
  })

  it('書名號與波浪號不影響比對', () => {
    expect(normalizeTitle('《少女與戰車 最終章》 第４話')).toBe(normalizeTitle('少女與戰車最終章 第4話'))
  })

  it('空字串安全', () => {
    expect(normalizeTitle('')).toBe('')
  })
})

describe('映演時間解析', () => {
  it.each([
    ['1 時 43 分 24 秒', 103],
    ['1 時 45 分 30 秒', 106],
    ['2 時 0 分 0 秒', 120],
    ['58 分 12 秒', 58],
    ['3 時', 180],
  ])('%s → %s 分', (input, expected) => {
    expect(parseRuntimeMinutes(input)).toBe(expected)
  })

  it('空值與零值回傳 null，不當成片長 0 分鐘', () => {
    expect(parseRuntimeMinutes('')).toBeNull()
    expect(parseRuntimeMinutes(null)).toBeNull()
    expect(parseRuntimeMinutes('0 時 0 分 0 秒')).toBeNull()
  })
})

describe('來源資料損毀偵測', () => {
  it('抓出 Excel 把片名誤判為日期的情況', () => {
    // 《福田村事件》的原文片名欄位實際值
    expect(isExcelDateArtifact('Sep-23')).toBe(true)
    expect(isExcelDateArtifact('9/23/2023')).toBe(true)
  })

  it('不誤判正常片名', () => {
    expect(isExcelDateArtifact('OUR SEASON')).toBe(false)
    expect(isExcelDateArtifact('Perfect Revolution')).toBe(false)
  })

  it('抓出編碼損毀', () => {
    expect(isCorruptedEncoding('?????????????')).toBe(true)
    expect(isCorruptedEncoding('What?')).toBe(false)
  })

  it('把損毀型態回報為具名的 defect', () => {
    expect(inspectOriginalTitle('Sep-23')).toEqual({ usable: false, defect: 'original-title-excel-date' })
    expect(inspectOriginalTitle('?????')).toEqual({ usable: false, defect: 'original-title-corrupted' })
    expect(inspectOriginalTitle('  ')).toEqual({ usable: false, defect: 'original-title-missing' })
    expect(inspectOriginalTitle('ANYONE BUT YOU')).toEqual({ usable: true, defect: null })
  })
})

describe('縣市正規化', () => {
  it('台與臺視為同一個縣市', () => {
    expect(extractCity('台北市信義區松壽路18號')).toBe('台北市')
    expect(extractCity('臺北市南港區經貿二路131號')).toBe('台北市')
    expect(extractCity('臺南市東區中華東路一段366號')).toBe('台南市')
  })

  it('認得出所有六都與縣市', () => {
    expect(extractCity('新北市板橋區縣民大道二段66號')).toBe('新北市')
    expect(extractCity('花蓮縣吉安鄉南濱路一段503號')).toBe('花蓮縣')
    expect(extractCity('金門縣金城鎮民權路100號')).toBe('金門縣')
  })

  it('認不出來時回傳 null 而非猜測', () => {
    expect(extractCity('無效地址')).toBeNull()
    expect(extractCity('')).toBeNull()
    expect(extractCity(null)).toBeNull()
  })

  it('unifyTaiwanChar 只換字不做其他處理', () => {
    expect(unifyTaiwanChar('臺中市臺灣大道')).toBe('台中市台灣大道')
  })
})

describe('國別正規化', () => {
  it.each([
    ['中華民國', '台灣'],
    ['臺灣', '台灣'],
    ['台灣', '台灣'],
    ['  中華民國  ', '台灣'],
    ['日本', '日本'],
    ['香港', '香港'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCountry(input)).toBe(expected)
  })

  // 冪等：套兩次跟套一次一樣。這條在「上游正規化 + 既有資料 UPDATE」兩層並存時
  // 特別重要——同一列可能兩邊都經過一次。
  it('冪等', () => {
    for (const input of ['中華民國', '臺灣', '台灣', '日本']) {
      const once = normalizeCountry(input)
      expect(normalizeCountry(once)).toBe(once)
    }
  })

  // 空值回 null 不是 ''：0008 已經在 DB 層把「沒有國別」定成 NULL
  // （連 default '' 都拿掉、加了 film_country_not_blank check），
  // 上游回空字串等於繞過那條規則。
  it('空值一律回 null', () => {
    expect(normalizeCountry('')).toBeNull()
    expect(normalizeCountry('   ')).toBeNull()
    expect(normalizeCountry(null)).toBeNull()
    expect(normalizeCountry(undefined)).toBeNull()
  })

  // 不要順手統一別的國名：政府資料的國名有自己的體系，動了會製造新的不一致。
  it('只碰台灣的寫法，其餘原樣', () => {
    expect(normalizeCountry('中國')).toBe('中國')
    expect(normalizeCountry('中華人民共和國')).toBe('中華人民共和國')
    expect(normalizeCountry('Taiwan')).toBe('Taiwan')
  })
})

describe('編碼損毀：私用區字元', () => {
  // U+F8F8 是實測那兩筆（LEOPOLDSTADT / BLDG. N）落到的碼位。
  // ★ 測試裡也一律用逃脫寫法。把私用區字元字面貼進原始碼，它會在編輯器／
  //   終端機／剪貼簿之間被吃掉，而且肉眼看不出來已經壞了——寫這組測試時
  //   就被吃掉過一次，正則變成一個什麼都比對不到的字元類別而 tsc 不會抱怨。
  const PUA = '\uF8F8'

  it('抓得到 BMP 私用區', () => {
    expect(hasPrivateUseChars(`利${PUA}${PUA}德城`)).toBe(true)
  })

  it('抓得到增補平面的私用區（需要 u 旗標，否則代理對會漏判）', () => {
    expect(hasPrivateUseChars(`a\u{F0001}b`)).toBe(true)
    expect(hasPrivateUseChars(`a\u{100001}b`)).toBe(true)
  })

  it('乾淨的中文片名不誤判', () => {
    expect(hasPrivateUseChars('利奧波德城（英國國家劇院現場）')).toBe(false)
    expect(hasPrivateUseChars('Ｎ號棟鬧鬼')).toBe(false)
    expect(hasPrivateUseChars('劇場版「鬼滅之刃」無限城篇')).toBe(false)
    expect(hasPrivateUseChars('')).toBe(false)
    expect(hasPrivateUseChars(null)).toBe(false)
  })

  it('★ 私用區與替換字元是不同的失敗模式，不可合成一條規則', () => {
    // 解碼「成功」但落到私用區 —— 字串在編碼上完全合法
    expect(hasPrivateUseChars(`利${PUA}德城`)).toBe(true)
    expect(hasReplacementChars(`利${PUA}德城`)).toBe(false)
    // 解碼明確失敗 —— 資訊在那一刻就沒了
    expect(hasReplacementChars('利�德城')).toBe(true)
    expect(hasPrivateUseChars('利�德城')).toBe(false)
  })

  it('inspectTitleZh 依確定度回報最確定的那一種', () => {
    expect(inspectTitleZh(`利${PUA}德城`)).toBe('private-use')
    expect(inspectTitleZh('利�德城')).toBe('replacement')
    expect(inspectTitleZh('?????')).toBe('question-marks')
    expect(inspectTitleZh('孩子，你好嗎?')).toBe('suspect-question-mark')
    expect(inspectTitleZh('利奧波德城')).toBeNull()
    // 同時有私用區與問號時，回報比較確定的那一個
    expect(inspectTitleZh(`利${PUA}德城?`)).toBe('private-use')
  })
})
