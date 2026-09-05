import { describe, expect, it } from 'vitest'
import { displayTitle } from '../app/utils/film-title'
import { costText, dateBand, ticketMetaLine } from '../app/utils/ticket'

describe('dateBand', () => {
  it('拆出年月日與星期', () => {
    expect(dateBand('2026-07-26')).toEqual({ year: '2026', month: '7', day: '26', weekday: '日' })
  })

  it('月不補零、日補零', () => {
    expect(dateBand('2026-01-06')).toMatchObject({ month: '1', day: '06' })
  })

  it('星期在 UTC 以西的時區不位移', () => {
    // 用 new Date('2026-07-26').getDay() 在 UTC-5 會得到「六」。
    // watched_on 是台北牆上時間的日期，全程留在 UTC 算才不會退一天。
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(dateBand('2026-07-26')?.weekday).toBe('日')
    }
    finally {
      process.env.TZ = tz
    }
  })

  it('壞值回 null 而不是丟例外', () => {
    expect(dateBand(null)).toBeNull()
    expect(dateBand('')).toBeNull()
    expect(dateBand('2026-7-6')).toBeNull()
  })
})

describe('costText', () => {
  it('沒資料就是不存在，不給佔位字串', () => {
    expect(costText(null)).toBeNull()
    expect(costText(undefined)).toBeNull()
  })

  it('0 是招待票，顯示「免費」不是 NT$0', () => {
    expect(costText(0)).toBe('免費')
  })

  it('一般金額加千分位', () => {
    expect(costText(520)).toBe('NT$520')
    expect(costText(9860)).toBe('NT$9,860')
  })
})

describe('ticketMetaLine', () => {
  it('照 §4.3 的欄位順序組成開眼式括號量詞串', () => {
    expect(ticketMetaLine({
      venueName: '林口威秀',
      hallLabel: '7廳',
      formatLabel: '2D',
      watchedTime: '16:00:00',
      ticketCount: 2,
      cost: 520,
    })).toBe('林口威秀 (7廳) 2D 16:00 2張 NT$520')
  })

  it('缺的欄位整段消失，不留殘骸', () => {
    expect(ticketMetaLine({ venueName: '林口威秀', watchedTime: null, cost: null }))
      .toBe('林口威秀')
  })

  it('票價被隱藏時行變短，不出現佔位', () => {
    const line = ticketMetaLine({ venueName: '信義威秀', ticketCount: 1, cost: null })
    expect(line).toBe('信義威秀 1張')
    expect(line).not.toContain('NT$')
  })

  it('票價永遠排最後', () => {
    const line = ticketMetaLine({ venueName: 'A', formatLabel: 'IMAX', ticketCount: 3, cost: 0 })
    expect(line.endsWith('免費')).toBe(true)
  })
})

describe('displayTitle', () => {
  it('拿掉書名號', () => {
    expect(displayTitle('《聽見天堂》')).toBe('聽見天堂')
  })

  it('雙片連映不能只剝頭尾', () => {
    // 實測片庫真有這一筆
    expect(displayTitle('《屁屁偵探：咖哩香料事件》 《屁屁偵探：瓢蟲遺跡之謎》'))
      .toBe('屁屁偵探：咖哩香料事件 屁屁偵探：瓢蟲遺跡之謎')
  })

  it('「」不動——那是片名的一部分', () => {
    expect(displayTitle('劇場版「鬼滅之刃」無限城篇')).toBe('劇場版「鬼滅之刃」無限城篇')
  })

  it('空值回空字串', () => {
    expect(displayTitle(null)).toBe('')
  })
})
