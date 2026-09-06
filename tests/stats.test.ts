import type { YearStats } from '../app/utils/stats'
import { describe, expect, it } from 'vitest'
import {
  calendarSeries,
  dayTitle,
  doubleFeatureDays,
  homeVenue,
  hourGrid,
  hourInsightText,
  inHourRow,
  isoDow,
  MIDNIGHT_LABEL,
  monthlyBaselineSeries,
  monthlySeries,
  monthlySeriesToDate,
  peakStandsOut,
  slotTitle,
  spendText,
  topWithRest,
  venueInsightText,
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

  /**
   * ★ 這一組 2026-09-06 整個換掉了。
   *
   * 舊的那條叫「歷年每月平均＝該月份的全期總場次 ÷ 年份數」，而且把
   * `avg![9]` 釘成 **1.85**（24 ÷ 13）。**那是把錯的答案釘住的假綠燈**：
   * 分母不是年份數，是 `years_observed`（曝光數）——那個月份實際經歷過幾次。
   * DB 早就在 `monthly_baseline` 裡給了正確答案（十月 **2.00**，因為 2026-10
   * 還沒發生 ⇒ 曝光 12 次不是 13 次），前端卻自己算了一套，而這條測試
   * 保護的正是那一套。
   *
   * 現在的形狀：**前端只搬運，不計算**，所以測試也不再重算一次公式
   * （重算就是實作的複本，實作改錯它會跟著改錯）。它守的是搬運的正確性
   * ——月份對得上、格數是 12、缺格不畫。分母對不對由
   * `verify-all.ts` 的 `frontend/monthly-baseline` 拿真實資料跟 DB 對帳。
   */
  const REAL_BASELINE = [
    // user_year_stats('clipwww', null) → monthly_baseline 實測 2026-09-06
    { month: 1, years_observed: 12, records: 11, avg_records: 0.92 },
    { month: 2, years_observed: 12, records: 11, avg_records: 0.92 },
    { month: 3, years_observed: 13, records: 18, avg_records: 1.38 },
    { month: 4, years_observed: 13, records: 12, avg_records: 0.92 },
    { month: 5, years_observed: 13, records: 11, avg_records: 0.85 },
    { month: 6, years_observed: 13, records: 10, avg_records: 0.77 },
    { month: 7, years_observed: 13, records: 13, avg_records: 1.00 },
    { month: 8, years_observed: 13, records: 14, avg_records: 1.08 },
    { month: 9, years_observed: 13, records: 15, avg_records: 1.15 },
    { month: 10, years_observed: 12, records: 24, avg_records: 2.00 },
    { month: 11, years_observed: 12, records: 17, avg_records: 1.42 },
    { month: 12, years_observed: 12, records: 18, avg_records: 1.50 },
  ].map(b => ({ ...b, avg_tickets: 0, avg_spend: 0, spend_is_partial: false }))

  it('平均線的數值原封不動來自 monthly_baseline.avg_records', () => {
    const avg = monthlyBaselineSeries(REAL_BASELINE)
    expect(avg).toEqual([0.92, 0.92, 1.38, 0.92, 0.85, 0.77, 1.00, 1.08, 1.15, 2.00, 1.42, 1.50])
  })

  it('★ 分母是曝光數不是年份數——十月是 2.00 不是 1.85', () => {
    // 這一條是拿來**分辨兩種分母**的，不是重算公式。
    // 十月：24 場、曝光 12 次（2026-10 還沒到）⇒ 2.00；除以年份數 13 會得到 1.85。
    // 一月：11 場、曝光 12 次（2014-01 在第一筆紀錄之前）⇒ 0.92；除以 13 會得到 0.85。
    const avg = monthlyBaselineSeries(REAL_BASELINE)!
    expect(avg[9]).toBe(2.00)
    expect(avg[9]).not.toBe(1.85)
    expect(avg[0]).toBe(0.92)
    expect(avg[0]).not.toBe(0.85)
    // 曝光數確實不是全部相同——否則這組資料分辨不出兩種分母，這條測試會變成空轉
    expect(new Set(REAL_BASELINE.map(b => b.years_observed)).size).toBeGreaterThan(1)
  })

  it('月份順序由 month 欄位決定，不是陣列順序', () => {
    // RPC 有 `order by e.m`，但契約是欄位不是順序。倒著餵應該得到一樣的結果。
    const shuffled = [...REAL_BASELINE].reverse()
    expect(monthlyBaselineSeries(shuffled)).toEqual(monthlyBaselineSeries(REAL_BASELINE))
  })

  it('缺任何一格就整條不畫——不補 0（那會讓那個月看起來像平均從沒去過）', () => {
    expect(monthlyBaselineSeries(undefined)).toBeNull()
    expect(monthlyBaselineSeries([])).toBeNull()
    expect(monthlyBaselineSeries(REAL_BASELINE.filter(b => b.month !== 7))).toBeNull()
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

describe('金額的呈現', () => {
  it('一般金額', () => {
    expect(spendText(3130, 'TWD', false)).toBe('NT$3,130')
  })

  it('★ 涵蓋不完整時「以上」跟著數字走，不是只靠底下一行小字', () => {
    // 使用者只截到一列的圖時，那個但書必須仍然在——
    // 看到一張「每年花費」而不知道那是部分資料，比沒有這張圖更糟。
    expect(spendText(7236, 'TWD', true)).toBe('NT$7,236 以上')
  })

  it('★ NT$0 不等於隱藏——涵蓋完整的 0 是「免費」（SCREENS §12.1）', () => {
    // 實測 David 2015 年 2 場、票價都記了、合計 NT$0（兌換票）。
    // 那是真實的事實，不是「沒有資料」。第一版把它整列過濾掉，
    // 結果年表上有那一年、花費圖上沒有，而畫面看起來完全正常。
    expect(spendText(0, 'TWD', false)).toBe('免費')
  })

  it('★ 但「0 而且涵蓋不完整」不可以寫成免費——那是把「沒公開」講成「沒花錢」', () => {
    // 這是這張圖最不能犯的錯：看得到的部分加起來是 0，實際只會更多。
    expect(spendText(0, 'TWD', true)).toBe('NT$0 以上')
    expect(spendText(0, 'TWD', true)).not.toBe('免費')
  })

  it('非 TWD 不硬套 NT$', () => {
    expect(spendText(1200, 'JPY', false)).toBe('JPY 1,200')
    expect(spendText(1200, 'JPY', true)).toBe('JPY 1,200 以上')
  })
})

describe('圖說：「最」要是真的', () => {
  /** David 的真實時段分布（user_year_stats 實測 2026-09-06）。 */
  function davidHours() {
    const rows: { weekday: number, hour: number, records: number }[] = []
    // 前三高：週六 14:00=9、週六 10:00=9、週五 22:00=8 —— **前兩名並列**
    rows.push({ weekday: 6, hour: 14, records: 9 })
    rows.push({ weekday: 6, hour: 10, records: 9 })
    rows.push({ weekday: 5, hour: 22, records: 8 })
    // 其餘 64 格湊到 174 場，且維持週末 78.7% 的形狀
    for (let i = 0; i < 40; i++)
      rows.push({ weekday: 5 + (i % 3), hour: 9 + (i % 12), records: 2 })
    for (let i = 0; i < 24; i++)
      rows.push({ weekday: 1 + (i % 4), hour: 9 + (i % 12), records: 2 })
    return rows
  }

  it('★ 前兩名並列時不可以講「最」——那是在並列裡任意挑一個', () => {
    // 這正是舊邏輯輸出「你最常在週六 10:00 進場，共 9 場」的那組資料。
    // 9 場不小（z 分數會過關），但「最」宣稱的是**唯一性**。
    expect(peakStandsOut([9, 9, 8, 2, 2, 2])).toBe(false)
  })

  it('明顯領先時可以講', () => {
    expect(peakStandsOut([120, 14, 10, 8, 5])).toBe(true)
  })

  it('★ 領先再多，太少場也不算習慣', () => {
    // 4 場 vs 1 場是 4 倍領先，但 4 場不是一個習慣，是巧合
    expect(peakStandsOut([4, 1, 1])).toBe(false)
    expect(peakStandsOut([5, 1, 1])).toBe(true)
  })

  it('只有一格有資料時不必比領先幅度', () => {
    expect(peakStandsOut([7, 0, 0])).toBe(true)
  })

  it('★ David 的真實分布：講週末佔比（真的），不講並列的尖峰（假的）', () => {
    const text = hourInsightText(davidHours(), '全部年度')!
    expect(text).toContain('週五到週日')
    expect(text).not.toContain('最常')
    expect(text).not.toContain('10:00')
  })

  it('★ 聚合句必須真的在講多數——39% 不可以寫成「你 39% 的場次在…」', () => {
    // 實測 David 的「週末晚上」是 39%，基準線 30%（3/7 × 8/16）⇒ 倍率 1.3。
    // 光看 lift 會放行，畫面上就出現「你 39% 的場次在週五到週日的晚上」——
    // 技術上沒說錯，但使用者讀到的是「這就是我的樣子」，而 61% 不是那樣。
    // ⚠️ 總筆數必須 >= INSIGHT_MIN(20)，否則會走「樣本不足」那條早退路徑而
    //    根本進不到聚合分支——第一版寫成 10 筆，**弄壞實作時測試照樣綠**。
    // 這組：20 場，週末晚上 8/20 = 40%、週末 40%、晚場 40% ⇒ 三個分支都該被擋。
    // 而尖峰 8 vs 6 不到 1.5 倍 ⇒ 也不准講「最」。
    const rows = [
      { weekday: 6, hour: 20, records: 8 }, // 週末晚上
      { weekday: 2, hour: 10, records: 6 }, // 平日白天
      { weekday: 3, hour: 11, records: 6 }, // 平日白天
    ]
    const text = hourInsightText(rows, '全部年度')!
    expect(text).not.toMatch(/你 \d+% 的場次/)
  })

  it('樣本不足時只敘述，不出現「最」「主場」「你的」', () => {
    const few = [{ weekday: 6, hour: 10, records: 2 }, { weekday: 3, hour: 14, records: 1 }]
    const text = hourInsightText(few, '2026 年')!
    expect(text).toContain('2026 年')
    expect(text).not.toContain('最')
  })

  it('★ 什麼都站不出來時，給一句真的敘述而不是硬講一個「最」', () => {
    // 平坦分布：40 格各 5 場，沒有尖峰也沒有週末/晚場的偏斜
    const flat = Array.from({ length: 40 }, (_, i) => ({
      weekday: (i % 7) + 1,
      hour: 9 + (i % 6), // 全部落在 09–14，晚場佔比 0 ⇒ 聚合也站不出來
      records: 5,
    }))
    const text = hourInsightText(flat, '全部年度')!
    expect(text).toContain('沒有特別集中')
    expect(text).not.toContain('最常')
  })

  it('影城：站得出來才叫「主場」，站不出來改講前三家的佔比', () => {
    const dominant = [
      { venue_id: 'a', name: '林口威秀', city: null, kind: null, records: 120 },
      { venue_id: 'b', name: '信義威秀', city: null, kind: null, records: 14 },
      { venue_id: 'c', name: '京站威秀', city: null, kind: null, records: 10 },
    ]
    expect(venueInsightText(dominant, 144, '全部年度')).toContain('主場')

    const flat = [
      { venue_id: 'a', name: 'A', city: null, kind: null, records: 30 },
      { venue_id: 'b', name: 'B', city: null, kind: null, records: 28 },
      { venue_id: 'c', name: 'C', city: null, kind: null, records: 25 },
      { venue_id: 'd', name: 'D', city: null, kind: null, records: 20 },
    ]
    const text = venueInsightText(flat, 103, '全部年度')!
    expect(text).not.toContain('主場')
    expect(text).toContain('最常去的三家')
  })
})
