import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertTaxIdUsableAsKey, parseCinemaCsv } from '#pipeline/gov/cinema'
import { parseRelatedFiles, stripBom } from '#pipeline/gov/datasets'
import { alignRow, parseRatingCsv, rocToGregorian } from '#pipeline/gov/rating'

/**
 * fixture 皆自 110–113 年與 2025 年的真實 CSV 節錄，未經修改。
 * 挑選標準是涵蓋全部已知的損毀型態，而非「好看的資料」。
 */
function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
    .replace(/^\uFEFF/, '')
}

describe('包裝 JSON 的「相關檔案」解析', () => {
  it('自分號分隔的字串取出逐年檔案', () => {
    const related
      = '110年電影片分級及相關資訊(https://file.moc.gov.tw/a.csv);'
        + '111年電影片分級及相關資訊(https://file.moc.gov.tw/b.csv);'
        + '112年電影片分級及相關資訊(https://file.moc.gov.tw/c.csv)'

    expect(parseRelatedFiles(related)).toEqual([
      { name: '110年電影片分級及相關資訊', url: 'https://file.moc.gov.tw/a.csv' },
      { name: '111年電影片分級及相關資訊', url: 'https://file.moc.gov.tw/b.csv' },
      { name: '112年電影片分級及相關資訊', url: 'https://file.moc.gov.tw/c.csv' },
    ])
  })

  it('陣列末筆即為最新年度', () => {
    const files = parseRelatedFiles('2024年(https://x/a.csv);2025年(https://x/b.csv)')
    expect(files.at(-1)?.name).toBe('2025年')
  })

  it('格式不符時回傳空陣列，讓呼叫端拋出明確錯誤', () => {
    expect(parseRelatedFiles('沒有任何連結的字串')).toEqual([])
  })

  it('去除 UTF-8 BOM', () => {
    expect(JSON.parse(stripBom('﻿{"a":1}'))).toEqual({ a: 1 })
  })
})

describe('民國年換算', () => {
  it.each([[110, 2021], [111, 2022], [112, 2023], [113, 2024]])(
    '%i 年 → 西元 %i',
    (roc, gregorian) => expect(rocToGregorian(roc)).toBe(gregorian),
  )
})

describe('欄位錯位的偵測與回推', () => {
  const normal = ['113', '局影外第113001號', '普', '鬼媽媽的假期', 'OUR SEASON', '韓國', '韓語', 'X 公司', '1 時 45 分 30 秒']

  it('欄數正確時原樣通過', () => {
    expect(alignRow(normal)).toEqual({ cells: normal, defects: [] })
  })

  it('原文片名含逗號導致多切一欄時，合併回原欄位', () => {
    // 實測 113 年《劇場版IDOLiSH7》的真實形狀
    const broken = [
      '113',
      '局影外第113227號',
      '普',
      '劇場版IDOLiSH7-偶像星願-',
      'IDOLiSH7 the Movie',
      ' LIVE 4bit BEYOND THE PERiOD＜DAY 1＞With After Talk version.',
      '日本',
      '日語',
      'Bandai Namco Filmworks Inc.',
      '1 時 37 分 50 秒',
    ]
    const aligned = alignRow(broken)

    expect(aligned.defects).toEqual(['column-shift-recovered'])
    expect(aligned.cells).toHaveLength(9)
    expect(aligned.cells[4]).toBe('IDOLiSH7 the Movie, LIVE 4bit BEYOND THE PERiOD＜DAY 1＞With After Talk version.')
    // 關鍵：國別必須是「日本」而不是被右移進來的片名片段
    expect(aligned.cells[5]).toBe('日本')
    expect(aligned.cells[6]).toBe('日語')
    expect(aligned.cells[8]).toBe('1 時 37 分 50 秒')
  })

  it('最後一欄不是片長時不硬修，改為標記', () => {
    const unrecoverable = [...normal, '多出來的東西']
    const aligned = alignRow(unrecoverable)
    expect(aligned.defects).toEqual(['column-count-unexpected'])
    expect(aligned.cells).toHaveLength(9)
  })

  it('欄數不足時補齊並標記', () => {
    const aligned = alignRow(['113', '局影外第113001號', '普'])
    expect(aligned.defects).toEqual(['column-count-unexpected'])
    expect(aligned.cells).toHaveLength(9)
  })
})

describe('分級 CSV 解析（真實資料節錄）', () => {
  const certs = parseRatingCsv(fixture('rating-113-sample.csv'))
  const byPermit = (no: string) => certs.find(c => c.permitNo === no)!

  it('解析出全部資料列', () => {
    expect(certs).toHaveLength(15)
  })

  it('一般案例的欄位對應正確', () => {
    const c = byPermit('局影外第113002號')
    expect(c).toMatchObject({
      rocYear: 113,
      gregorianYear: 2024,
      rating: '輔12',
      titleZh: '愛愛愛上你',
      titleOriginal: 'ANYONE BUT YOU',
      country: '美國',
      runtimeMinutes: 103,
      versionNote: null,
      defects: [],
    })
  })

  it('版本標註被分離到 versionNote', () => {
    expect(byPermit('局影外第113013號')).toMatchObject({
      titleZh: '紅豬',
      titleOriginal: 'Porco Rosso',
      versionNote: '中文版',
    })
  })

  it('excel 日期誤判的原文片名被清空並標記', () => {
    const c = byPermit('局影外第113589號')
    expect(c.titleZh).toBe('福田村事件')
    expect(c.titleOriginal).toBe('')
    expect(c.defects).toContain('original-title-excel-date')
  })

  it('編碼損毀的原文片名被清空並標記', () => {
    const c = byPermit('局影外第113655號')
    expect(c.titleOriginal).toBe('')
    expect(c.defects).toContain('original-title-corrupted')
  })

  it('映演時間放的是日期區間時，片長為 null 並標記', () => {
    const c = byPermit('局影本第113066號')
    expect(c.titleZh).toBe('戀戀風塵')
    expect(c.versionNote).toBe('數位修復版')
    expect(c.runtimeMinutes).toBeNull()
    expect(c.defects).toContain('runtime-unparseable')
  })

  it('映演時間放的是發行商名稱時，片長為 null 並標記', () => {
    const c = byPermit('局影外第113161號')
    expect(c.titleZh).toBe('大發明家')
    expect(c.runtimeMinutes).toBeNull()
    expect(c.defects).toContain('runtime-unparseable')
  })

  it('cSV 引號損壞的列被回推，國別不受污染', () => {
    const c = byPermit('局影外第113227號')
    expect(c.defects).toContain('column-shift-recovered')
    expect(c.country).toBe('日本')
    expect(c.language).toBe('日語')
    expect(c.runtimeMinutes).toBe(98)
  })

  it('同一部片的多張證明書各自保留，由後續流程收斂', () => {
    const spy = certs.filter(c => c.titleZh === 'SPY x FAMILY CODE: White')
    expect(spy.length).toBeGreaterThan(1)
    expect(new Set(spy.map(c => c.permitNo)).size).toBe(spy.length)
  })

  it('中文片名含 ASCII 問號時標記為疑似編碼損毀', () => {
    const { parseRatingCsv: parse } = { parseRatingCsv }
    const csv = [
      '年度,分級證明字號,級別,中文片名,原文片名,國別,語言,出品公司,映演時間',
      '112,第112199號,普,?本龍一：終章,Ryuichi Sakamoto: CODA,日本,日語,X,1 時 42 分 0 秒',
      '112,第112039號,普,"孩子， 你好嗎 ? 鴕鳥騎士",Dear Child,中華民國,國語,Y,1 時 30 分 0 秒',
      '113,局影外第113001號,普,鬼媽媽的假期,OUR SEASON,韓國,韓語,Z,1 時 45 分 30 秒',
    ].join('\n')
    const parsed = parse(csv)

    // 兩種都標記——字串層面無法可靠區分真問號與損毀，交由 consolidate 判斷
    expect(parsed[0]!.defects).toContain('title-zh-suspect-encoding')
    expect(parsed[1]!.defects).toContain('title-zh-suspect-encoding')
    // 正常片名不誤標
    expect(parsed[2]!.defects).toEqual([])
  })

  it('代理主鍵唯一，而分級證明字號不保證唯一', () => {
    const ids = certs.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('代理主鍵是確定性的：同樣的輸入產生同樣的 id', () => {
    const again = parseRatingCsv(fixture('rating-113-sample.csv'))
    expect(again.map(c => c.id)).toEqual(certs.map(c => c.id))
  })

  it('id 由年度、字號與正規化片名組成', () => {
    expect(byPermit('局影外第113002號').id).toBe('113:局影外第113002號:愛愛愛上你')
  })

  it('版本標註不影響 id 的穩定性（標註已在正規化時剝除）', () => {
    // 「紅豬(中文版)」的 id 用的是剝除標註後的片名
    expect(byPermit('局影外第113013號').id).toBe('113:局影外第113013號:紅豬')
  })
})

describe('影城 CSV 解析（真實資料節錄）', () => {
  const { cinemas, unknownCity } = parseCinemaCsv(fixture('cinema-2025-sample.csv'))

  it('事業名稱的前後空白被清除', () => {
    // 來源資料實際帶有空白的兩筆
    expect(cinemas.map(c => c.name)).toContain('台中大遠百威秀影城')
    expect(cinemas.map(c => c.name)).toContain('in89駁二電影院')
  })

  it('臺與台被統一', () => {
    const nangang = cinemas.find(c => c.name === '南港LaLaport威秀影城')!
    // 來源地址寫的是「臺北市」
    expect(nangang.city).toBe('台北市')
  })

  it('廳數轉為數字', () => {
    expect(cinemas.find(c => c.name === '國賓大戲院')?.hallCount).toBe(3)
    expect(cinemas.every(c => Number.isInteger(c.hallCount))).toBe(true)
  })

  it('連鎖店的統一編號各自獨立', () => {
    const xinyi = cinemas.find(c => c.name === '台北信義威秀影城')!
    const nangang = cinemas.find(c => c.name === '南港LaLaport威秀影城')!
    expect(xinyi.taxId).toBe('16431011')
    expect(nangang.taxId).toBe('60745583')
    expect(xinyi.taxId).not.toBe(nangang.taxId)
  })

  it('全部地址都認得出縣市', () => {
    expect(unknownCity).toEqual([])
  })

  it('統一編號可作為主鍵', () => {
    expect(() => assertTaxIdUsableAsKey(cinemas)).not.toThrow()
  })

  it('統一編號有空值時明確拒絕', () => {
    expect(() => assertTaxIdUsableAsKey([
      { taxId: '', name: '某影城', companyName: '', hallCount: 1, address: '', phone: '', city: '' },
    ])).toThrow(/沒有統一編號/)
  })

  it('統一編號重複時明確拒絕', () => {
    const dup = { taxId: '123', companyName: '', hallCount: 1, address: '', phone: '', city: '' }
    expect(() => assertTaxIdUsableAsKey([
      { ...dup, name: 'A' },
      { ...dup, name: 'B' },
    ])).toThrow(/重複/)
  })
})
