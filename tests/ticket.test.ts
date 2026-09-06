import { describe, expect, it } from 'vitest'
import { displayTitle } from '../app/utils/film-title'
import { costText, dateBand, detailSegment, ticketMetaLine, venueSegment } from '../app/utils/ticket'

describe('dateBand', () => {
  it('拆出年月日與星期，月與星期都是英文縮寫', () => {
    expect(dateBand('2026-07-26')).toEqual({ year: '2026', month: 'Jul', day: '26', weekday: 'Sun' })
  })

  it('月是三字母縮寫、日補零到兩位', () => {
    expect(dateBand('2026-01-06')).toMatchObject({ month: 'Jan', day: '06' })
  })

  // 縮寫寫死不用 Intl：`Sept` 與 `Sep` 在不同 ICU 版本上都出現過，
  // 而這三個字母要在每一張卡上等寬對齊。
  it('九月是 Sep 不是 Sept', () => {
    expect(dateBand('2026-09-06')?.month).toBe('Sep')
  })

  it('星期在 UTC 以西的時區不位移', () => {
    // 用 new Date('2026-07-26').getDay() 在 UTC-5 會得到「六」。
    // watched_on 是台北牆上時間的日期，全程留在 UTC 算才不會退一天。
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(dateBand('2026-07-26')?.weekday).toBe('Sun')
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

describe('meta 的兩段（§4.3）', () => {
  const full = {
    venueName: '林口MITSUI OUTLET PARK威秀影城',
    hallLabel: '7廳',
    formatLabel: '數位',
    watchedTime: '16:00:00',
    ticketCount: 2,
    cost: 520,
  }

  it('影城與廳別自成一段，永遠不被切開', () => {
    expect(venueSegment(full)).toBe('林口MITSUI OUTLET PARK威秀影城 (7廳)')
  })

  it('第二段不含影城——否則 375px 下斷點會落在名稱中間', () => {
    const d = detailSegment(full)
    expect(d).toBe('數位 2張 NT$520')
    expect(d).not.toContain('威秀')
  })

  // 2026-09-06 起場次時間搬到日期帶。兩邊都印就是同一個值出現兩次，
  // 而讀的人會以為那是兩個不同的時間。
  it('第二段不含場次時間——它在日期帶上', () => {
    expect(detailSegment(full)).not.toContain('16:00')
  })

  it('沒有影城時第一段整段不存在，不留一個孤零零的括號', () => {
    expect(venueSegment({ venueName: null, hallLabel: null })).toBeNull()
    expect(venueSegment({ venueName: null, hallLabel: '7廳' })).toBe('(7廳)')
  })

  it('第二段全空時回 null，不回空字串', () => {
    expect(detailSegment({ formatLabel: null, watchedTime: null, ticketCount: null, cost: null })).toBeNull()
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
    })).toBe('林口威秀 (7廳) 2D 2張 NT$520')
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
