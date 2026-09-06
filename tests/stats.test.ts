import type { YearStats } from '../app/utils/stats'
import { describe, expect, it } from 'vitest'
import {
  calendarSeries,
  dayTitle,
  doubleFeatureDays,
  homeVenue,
  hourGrid,
  inHourRow,
  isoDow,
  MIDNIGHT_LABEL,
  monthlyAverageSeries,
  monthlySeries,
  monthlySeriesToDate,
  slotTitle,
  topWithRest,
  weekendEveningShare,
  weekIndexInYear,
  yearStripRows,
} from '../app/utils/stats'

describe('出席圖', () => {
  const daily: YearStats['daily'] = [
    { date: '2026-01-02', records: 1, tickets: 2 },
    { date: '2026-03-14', records: 2, tickets: 2 },
    { date: '2026-07-26', records: 1, tickets: 2 },
  ]

  it('轉成 [date, value]', () => {
    expect(calendarSeries(daily)).toEqual([
      ['2026-01-02', 1],
      ['2026-03-14', 2],
      ['2026-07-26', 1],
    ])
  })

  it('只有「兩場以上」的日子進 scatter', () => {
    // 這 4 天（實測）是雙片連映，是那張圖唯一想讓人看見的東西
    expect(doubleFeatureDays(daily)).toEqual([['2026-03-14', 2]])
  })
})

describe('時段熱點圖', () => {
  it('7 × N 全格都有值，包含 0（§5.3-6：cartesian2d 不畫空格）', () => {
    const g = hourGrid([{ weekday: 5, hour: 22, records: 8 }])
    expect(g.data.length).toBe(7 * g.rows.length)
    expect(g.data.filter(d => d[2] === 0).length).toBe(7 * g.rows.length - 1)
  })

  it('預設從 09:00 開始，午夜場在最後一列', () => {
    const g = hourGrid([{ weekday: 1, hour: 10, records: 1 }])
    expect(g.rows[0]).toBe('09:00')
    expect(g.rows.at(-1)).toBe(MIDNIGHT_LABEL)
    expect(g.rows.length).toBe(16) // 09..23 共 15 列 + 午夜場
  })

  it('00–02 時折進午夜場，不放行首', () => {
    const g = hourGrid([{ weekday: 5, hour: 0, records: 3 }])
    const last = g.rows.length - 1
    expect(g.data.find(d => d[0] === 4 && d[1] === last)?.[2]).toBe(3)
  })

  it('weekday 是 isodow：1=週一落在第 0 欄、7=週日落在第 6 欄', () => {
    // 當成 0-indexed 會讓整張圖平移一天，而且不會報錯
    const g = hourGrid([
      { weekday: 1, hour: 12, records: 1 },
      { weekday: 7, hour: 12, records: 5 },
    ])
    const y = g.rows.indexOf('12:00')
    expect(g.data.find(d => d[0] === 0 && d[1] === y)?.[2]).toBe(1)
    expect(g.data.find(d => d[0] === 6 && d[1] === y)?.[2]).toBe(5)
  })

  it('真的有清晨場時軸往前延伸，不吃掉那筆紀錄', () => {
    const g = hourGrid([{ weekday: 3, hour: 6, records: 1 }])
    expect(g.rows[0]).toBe('06:00')
    const y = g.rows.indexOf('06:00')
    expect(g.data.find(d => d[0] === 2 && d[1] === y)?.[2]).toBe(1)
  })

  it('同一格的多個小時桶會相加而不是覆蓋', () => {
    const g = hourGrid([
      { weekday: 6, hour: 0, records: 2 },
      { weekday: 6, hour: 1, records: 3 },
    ])
    const last = g.rows.length - 1
    expect(g.data.find(d => d[0] === 5 && d[1] === last)?.[2]).toBe(5)
    expect(g.max).toBe(5)
  })

  it('沒有資料時仍然回完整格盤，max 為 0', () => {
    const g = hourGrid([])
    expect(g.data.length).toBe(7 * 16)
    expect(g.max).toBe(0)
  })

  it('週五到週日晚上的佔比', () => {
    const share = weekendEveningShare([
      { weekday: 5, hour: 19, records: 5 },
      { weekday: 7, hour: 21, records: 2 },
      { weekday: 2, hour: 14, records: 3 },
    ])
    expect(share).toBe(70)
  })
})

describe('月度趨勢', () => {
  it('12 個月補滿，缺的月份是 0 不是缺點', () => {
    const s = monthlySeries([{ month: 3, records: 4, tickets: 5, spend: 0, spend_is_partial: false }])
    expect(s.length).toBe(12)
    expect(s[2]).toBe(4)
    expect(s[0]).toBe(0)
  })

  it('歷年每月平均＝該月份的全期總場次 ÷ 年份數', () => {
    // David 的真實分佈（user_year_stats('clipwww', null) 實測）：
    // 1:11 2:11 3:18 4:12 5:11 6:10 7:13 8:14 9:15 10:24 11:17 12:18，共 174 場、13 個年份
    const totals = [11, 11, 18, 12, 11, 10, 13, 14, 15, 24, 17, 18]
    const monthly = totals.map((records, i) => ({
      month: i + 1,
      records,
      tickets: records,
      spend: 0,
      spend_is_partial: false,
    }))
    const avg = monthlyAverageSeries(monthly, 13)
    expect(avg).not.toBeNull()
    expect(avg!).toHaveLength(12)
    // 十月是旺季：24 / 13 = 1.85
    expect(avg![9]).toBe(1.85)
    expect(avg![0]).toBe(0.85)
    // 總和 ÷ 年份數要等於「平均一年看幾場」
    const perYear = avg!.reduce((a, b) => a + b, 0)
    expect(perYear).toBeCloseTo(174 / 13, 1)
  })

  it('年份數不明時不畫平均線——寧可少一條，也不要除以錯的數字', () => {
    const monthly = [{ month: 1, records: 5, tickets: 5, spend: 0, spend_is_partial: false }]
    expect(monthlyAverageSeries(monthly, undefined)).toBeNull()
    expect(monthlyAverageSeries(monthly, 0)).toBeNull()
    expect(monthlyAverageSeries([], 13)).toBeNull()
  })

  it('看今年時，還沒到的月份是斷點不是 0', () => {
    const monthly = [{ month: 1, records: 3, tickets: 3, spend: 0, spend_is_partial: false }]
    const today = new Date('2026-03-15T00:00:00Z')
    const s = monthlySeriesToDate(monthly, 2026, today)
    expect(s[0]).toBe(3)
    expect(s[1]).toBe(0) // 二月過了但沒去 ⇒ 真的是 0
    expect(s[2]).toBe(0) // 三月進行中
    expect(s[3]).toBeNull() // 四月還沒到 ⇒ 斷點，不是 0
    expect(s[11]).toBeNull()
    // 看往年時整年都過完了，12 個月都是數字
    expect(monthlySeriesToDate(monthly, 2025, today).every(v => v !== null)).toBe(true)
    // 全期視角沒有「未來的月份」
    expect(monthlySeriesToDate(monthly, null, today).every(v => v !== null)).toBe(true)
  })
})

describe('分布', () => {
  const venues = [
    { venue_id: 'a', name: '林口威秀', city: null, kind: null, records: 115 },
    { venue_id: 'b', name: '信義威秀', city: null, kind: null, records: 14 },
    { venue_id: 'c', name: '京站威秀', city: null, kind: null, records: 10 },
    { venue_id: 'd', name: 'X', city: null, kind: null, records: 5 },
    { venue_id: 'e', name: 'Y', city: null, kind: null, records: 3 },
  ]

  it('長尾收成「其他 N 家」並保留筆數總和', () => {
    const out = topWithRest(venues.map(v => ({ name: v.name!, records: v.records })), 3, n => `其他 ${n} 家`)
    expect(out.length).toBe(4)
    expect(out[3]).toEqual({ name: '其他 2 家', records: 8 })
  })

  it('不足 limit 時原樣回傳，不加一條空的「其他 0 家」', () => {
    const items = [{ name: 'A', records: 1 }]
    expect(topWithRest(items, 3, n => `其他 ${n} 家`)).toEqual(items)
  })

  it('主場與佔比', () => {
    expect(homeVenue(venues)).toEqual({ name: '林口威秀', share: 78 })
  })

  it('沒有場所資料時回 null，不要印出「你的主場是 null」', () => {
    expect(homeVenue([])).toBeNull()
  })
})

describe('年表 YearStrip', () => {
  it('2026-01-01（週四）落在第 0 週，1/5（週一）進第 1 週', () => {
    // 週一起始（WEEK_START=1）
    expect(weekIndexInYear('2026-01-01')).toEqual({ year: 2026, week: 0 })
    expect(weekIndexInYear('2026-01-04')).toEqual({ year: 2026, week: 0 })
    expect(weekIndexInYear('2026-01-05')).toEqual({ year: 2026, week: 1 })
  })

  it('永遠落在 0..52，不會溢位到第 54 格', () => {
    for (const y of [2020, 2021, 2024, 2028, 2032]) {
      for (const d of ['01-01', '12-31']) {
        const w = weekIndexInYear(`${y}-${d}`)!
        expect(w.week).toBeGreaterThanOrEqual(0)
        expect(w.week).toBeLessThan(53)
      }
    }
  })

  it('年初的日子留在自己的年份，不會被算進前一年（不是 ISO 週號）', () => {
    // 2027-01-01 是週五，ISO 會把它算成 2026 年第 53 週
    expect(weekIndexInYear('2027-01-01')?.year).toBe(2027)
  })

  it('列依年份新到舊，每列 53 格', () => {
    const rows = yearStripRows(
      [
        { date: '2026-07-26', records: 1, tickets: 2 },
        { date: '2026-07-28', records: 2, tickets: 2 },
        { date: '2025-03-01', records: 1, tickets: 1 },
      ],
      [2026, 2025, 2024],
    )
    expect(rows.map(r => r.year)).toEqual([2026, 2025, 2024])
    expect(rows[0]!.weeks.length).toBe(53)
    expect(rows[0]!.records).toBe(3)
    expect(rows[2]!.records).toBe(0) // 有列出來但整年空的年份
  })

  it('同一週的多天會相加（週的填滿率才會比日高）', () => {
    const rows = yearStripRows(
      [
        { date: '2026-07-27', records: 1, tickets: 1 }, // 週一
        { date: '2026-07-30', records: 1, tickets: 1 }, // 同一週的週四
      ],
      [2026],
    )
    expect(Math.max(...rows[0]!.weeks)).toBe(2)
    expect(rows[0]!.weeks.filter(n => n > 0).length).toBe(1)
  })
})

describe('點格子 → 底部片單', () => {
  it('isoDow：1=週一、7=週日，且不受時區影響', () => {
    expect(isoDow('2026-07-26')).toBe(7) // 週日
    expect(isoDow('2026-07-27')).toBe(1) // 週一
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(isoDow('2026-07-26')).toBe(7)
    }
    finally {
      process.env.TZ = tz
    }
  })

  it('inHourRow：午夜場那一列吃 00/01/02 時', () => {
    expect(inHourRow('00:30', MIDNIGHT_LABEL)).toBe(true)
    expect(inHourRow('02:00', MIDNIGHT_LABEL)).toBe(true)
    expect(inHourRow('03:00', MIDNIGHT_LABEL)).toBe(false)
    expect(inHourRow('21:30:00', '21:00')).toBe(true)
    expect(inHourRow('21:30:00', '22:00')).toBe(false)
    expect(inHourRow(null, '21:00')).toBe(false)
  })

  it('標題格式沿用舊專案', () => {
    expect(dayTitle('2026-07-26')).toBe('2026/07/26（週日）')
    expect(slotTitle(5, '21:00')).toBe('週五　21:00')
  })
})
