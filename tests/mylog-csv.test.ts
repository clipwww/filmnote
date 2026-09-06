import { describe, expect, it } from 'vitest'
import { parseMyLogCsv, taipeiWallClockToIso } from '../server/utils/mylog-csv'
import { decodeImportKey, toTaipeiWallClock } from '../src/import/mylog'

/**
 * `/app/import` 的 CSV 剖析。
 *
 * ★ 這裡的每一個 case 都對應一個**真的存在於 DB 裡的形狀**（174 筆 import_key
 *   解碼後實測），但內容改成合成資料——那些備註是 David 本人的私人筆記，
 *   不該進版控。形狀保留，內容不保留。
 *
 * ★ 最重要的兩條是 `逗號在備註裡` 與 `逗號在片名裡`：兩者在「欄數變多」這件事
 *   上長得一模一樣，而猜錯的樣子是把票價寫成片名的一部分，且不會報錯（踩雷 #67）。
 */

const HEADER = '日期,片名,國別,版本,影城,票價,手續費,張數,折扣,小計,備註\n'
const BASIC = '2016/05/17 (週二) 19:20,少女與戰車劇場版,日本,4DX,信義威秀,500,20,1,0,520'

describe('parseMyLogCsv', () => {
  it('十欄（無備註）的基本列', () => {
    const { items, issues, headerSkipped } = parseMyLogCsv(`${BASIC}\n`)
    expect(issues).toEqual([])
    expect(headerSkipped).toBe(0)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: '少女與戰車劇場版',
      area: '日本',
      version: '4DX',
      theater: '信義威秀',
      price: 500,
      fee: 20,
      tickets: 1,
      discount: 0,
      cost: 520,
      memo: '',
    })
  })

  it('id 解碼回來就是原始列（＝ import_key 與 JSON 匯入路徑一致）', () => {
    const { items } = parseMyLogCsv(`${BASIC}\n`)
    expect(decodeImportKey(items[0]!.id)).toBe(BASIC)
  })

  it('date 是 UTC 瞬間，但代表台北牆上時間', () => {
    const { items } = parseMyLogCsv(`${BASIC}\n`)
    expect(toTaipeiWallClock(items[0]!.date)).toEqual({
      watchedOn: '2016-05-17',
      watchedTime: '19:20',
    })
  })

  it('午夜場不會退到前一天（台北 00:00 的 UTC 是前一天 16:00）', () => {
    const line = '2017/11/16 (週四) 00:00,正義聯盟,美國,2D,信義威秀,300,0,1,0,300'
    const { items, issues } = parseMyLogCsv(`${line}\n`)
    expect(issues).toEqual([])
    expect(toTaipeiWallClock(items[0]!.date)).toEqual({
      watchedOn: '2017-11-16',
      watchedTime: '00:00',
    })
    expect(items[0]!.date).toBe('2017-11-15T16:00:00.000Z')
  })

  it('略過標題列，而且只略過第一筆', () => {
    const { items, issues, headerSkipped } = parseMyLogCsv(`${HEADER + BASIC}\n`)
    expect(issues).toEqual([])
    expect(headerSkipped).toBe(1)
    expect(items).toHaveLength(1)
  })

  it('吃掉 Excel 的 BOM（否則第一筆會被當成標題列丟掉）', () => {
    const { items, headerSkipped } = parseMyLogCsv(`﻿${BASIC}\n`)
    expect(headerSkipped).toBe(0)
    expect(items).toHaveLength(1)
  })

  it('★ 備註裡有逗號與換行（引號包住）：收攏成 memo，一列不多不少', () => {
    const csv = `${HEADER}2023/11/04 (週六) 19:00,少女與戰車最終章 第4話,日本,2D,`
      + `イオンシネマ,350,0,1,0,350,"第一段 | \n票價為 JPY 1,600 | \n第三段"\n`
    const { items, issues } = parseMyLogCsv(csv)
    expect(issues).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]!.memo).toBe('第一段 | \n票價為 JPY 1,600 | \n第三段')
    expect(items[0]!.cost).toBe(350)
    // import_key 要還原成「逗號 join」的樣子——備註裡的逗號原樣保留、沒有引號，
    // 這正是 DB 裡那 174 筆的形狀。
    expect(decodeImportKey(items[0]!.id)).toContain('JPY 1,600')
    expect(decodeImportKey(items[0]!.id)).not.toContain('"')
  })

  it('★ 備註裡有逗號但**沒有**引號包住：仍然收攏（金額欄全是數字 ⇒ 可以確定）', () => {
    const csv = `2023/11/04 (週六) 19:00,某片,日本,2D,某影城,350,0,1,0,350,花了 JPY 8,000 多\n`
    const { items, issues } = parseMyLogCsv(csv)
    expect(issues).toEqual([])
    expect(items[0]!.memo).toBe('花了 JPY 8,000 多')
  })

  it('★★ 逗號出現在**片名**裡（整列位移）：不猜，列進 issues', () => {
    // 踩雷 #67 的原始案例形狀：片名含未被引號包住的逗號 ⇒ 全部欄位往右移一格，
    // 於是「票價」那一格是「日本」。收攏成 memo 會把 500 寫進片名旁邊，
    // 而且完全不會報錯——所以這裡必須拒絕。
    const csv = `2016/05/17 (週二) 19:20,劇場版IDOLiSH7,LIVE 4bit,日本,4DX,信義威秀,500,20,1,0,520\n`
    const { items, issues } = parseMyLogCsv(csv)
    expect(items).toEqual([])
    expect(issues).toHaveLength(1)
    expect(issues[0]!.reason).toBe('ambiguous-columns')
    expect(issues[0]!.detail).toContain('人工確認')
  })

  it('欄數不足：列進 issues 而不是補空值', () => {
    const { items, issues } = parseMyLogCsv('2016/05/17 (週二) 19:20,某片,日本\n')
    expect(items).toEqual([])
    expect(issues[0]!.reason).toBe('too-few-columns')
  })

  it('金額欄不是數字（欄數正確）：列進 issues', () => {
    const csv = '2016/05/17 (週二) 19:20,某片,日本,2D,某影城,免費,0,1,0,0\n'
    const { items, issues } = parseMyLogCsv(csv)
    expect(items).toEqual([])
    expect(issues[0]!.reason).toBe('bad-number')
  })

  it('第一欄不是時間（且不是第一筆）：列進 issues 而不是被當標題丟掉', () => {
    const csv = `${BASIC}\n不是日期,某片,日本,2D,某影城,300,0,1,0,300\n`
    const { items, issues } = parseMyLogCsv(csv)
    expect(items).toHaveLength(1)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.reason).toBe('bad-timestamp')
  })

  it('空白列不算一筆，也不算 issue', () => {
    const { items, issues } = parseMyLogCsv(`${BASIC}\n\n\n`)
    expect(items).toHaveLength(1)
    expect(issues).toEqual([])
  })

  it('手續費留空視為 0（舊資料常常留空）', () => {
    const csv = '2016/05/17 (週二) 19:20,某片,日本,2D,某影城,300,,1,0,300\n'
    const { items, issues } = parseMyLogCsv(csv)
    expect(issues).toEqual([])
    expect(items[0]!.fee).toBe(0)
  })

  it('★★ 完全相同的兩列：加上 #1 / #2 後綴（否則會撞 unique 而靜默併成一筆）', () => {
    // 實測 DB 裡 175 個 import_key：165 個唯一列沒有後綴，5 組各出現兩次、
    // 兩筆分別是 #1 與 #2（第一筆**也有**後綴）。這條規則推不出來，只能量。
    const dup = '2020/10/08 (週四) 21:30,某片,日本,4DX,某影城,430,0,2,0,860'
    const { items, issues } = parseMyLogCsv(`${dup}\n${dup}\n${BASIC}\n`)
    expect(issues).toEqual([])
    expect(items).toHaveLength(3)
    const base = items.find(i => i.title === '少女與戰車劇場版')!.id
    expect(base).not.toContain('#') // 唯一列沒有後綴
    const dups = items.filter(i => i.title === '某片').map(i => i.id)
    expect(dups[0]).toMatch(/#1$/)
    expect(dups[1]).toMatch(/#2$/)
    expect(new Set(dups).size).toBe(2) // 兩筆真的不同鍵
  })

  it('「下午 22:10」這種寫法：上午／下午是裝飾，不加 12', () => {
    const csv = '2025/7/4 下午 22:10:00,某片,日本,2D,某影城,300,0,1,0,300\n'
    const { items, issues } = parseMyLogCsv(csv)
    expect(issues).toEqual([])
    expect(toTaipeiWallClock(items[0]!.date).watchedTime).toBe('22:10')
  })
})

describe('taipeiWallClockToIso', () => {
  it('與 toTaipeiWallClock 互為反函式（含午夜場）', () => {
    for (const [on, time] of [
      ['2026-09-06', '14:30'],
      ['2026-01-01', '00:00'],
      ['2014-03-01', '09:05'],
      ['2019-12-31', '23:59'],
    ] as [string, string][]) {
      const iso = taipeiWallClockToIso(on, time)
      expect(iso).not.toBeNull()
      expect(toTaipeiWallClock(iso!)).toEqual({ watchedOn: on, watchedTime: time })
    }
  })

  it('1979 年以前（台灣實施過日光節約時間）也不能硬寫 +8', () => {
    // 1979-07-01 台灣在日光節約時間內（UTC+9）。硬寫 +8 會差一小時，
    // 而且不會有任何錯誤——只是每一筆都晚一小時。
    const iso = taipeiWallClockToIso('1979-07-01', '12:00')
    expect(iso).not.toBeNull()
    expect(toTaipeiWallClock(iso!)).toEqual({ watchedOn: '1979-07-01', watchedTime: '12:00' })
  })

  it('無法解析的輸入回 null 而不是 Invalid Date', () => {
    expect(taipeiWallClockToIso('not-a-date', '12:00')).toBeNull()
  })
})
