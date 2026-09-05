import { describe, expect, it } from 'vitest'
import { extractCity, unifyTaiwanChar } from '#pipeline/normalize/city'
import { inspectOriginalTitle, isCorruptedEncoding, isExcelDateArtifact } from '#pipeline/normalize/defensive'
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
