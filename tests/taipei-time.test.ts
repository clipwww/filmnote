import { afterAll, describe, expect, it, vi } from 'vitest'
import { agoText, dayText, stampText } from '../app/utils/admin-format'
import { monthlySeriesToDate } from '../app/utils/stats'
import {
  taipeiAgoText,
  taipeiCalendarDaysBetween,
  taipeiDateText,
  taipeiDateTimeText,
  taipeiParts,
  taipeiToday,
  taipeiYearMonth,
} from '../src/time/taipei'

/**
 * `src/time/taipei.ts` 的介面測試（「今天」全站一律台北，2026-09-28 David 裁決）。
 * ★ 整支檔案跑在 `America/Los_Angeles`：踩雷 #239 實測把 `timeZone` 拿掉，台北機器上全綠、
 *   非台灣時區才紅 ⇒ 在台北跑的時區斷言恆真。第一個 describe 先證明切換真的生效。
 */
/*
 * ⚠️ 必須在 import 之前切（`vi.hoisted`），`beforeAll` 太晚：格式器是模組頂層建的，
 * 沒寫 `timeZone` 時它吃的是**建構當下**的時區。實測用 `beforeAll` 切、拿掉 `timeZone`，
 * 在台北機器上 118 條全綠——反向檢查抓不到它守的東西。
 */
const ORIGINAL_TZ = vi.hoisted(() => {
  const tz = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  return tz
})
afterAll(() => {
  process.env.TZ = ORIGINAL_TZ
})

/** 台北 2026-09-28 00:30；洛杉磯與 UTC 都還是 9/27。 */
const CROSS_MIDNIGHT = '2026-09-27T16:30:00Z'

describe('測試環境本身', () => {
  it('真的跑在洛杉磯時區（否則下面每一條都是恆真）', () => {
    const d = new Date(CROSS_MIDNIGHT)
    expect(d.getTimezoneOffset()).toBe(420) // PDT
    // 用瀏覽器本地時區取日期的舊寫法會拿到 27 號——這正是要抓的錯。
    expect(d.getDate()).toBe(27)
    expect(taipeiDateText(d)).toBe('2026-09-28')
  })
})

describe('瞬間 → 台北牆上時間', () => {
  it('跨午夜：UTC 16:30 是台北隔天 00:30', () => {
    expect(taipeiParts(CROSS_MIDNIGHT)).toEqual({ year: '2026', month: '09', day: '28', hour: '00', minute: '30' })
    expect(taipeiDateText(CROSS_MIDNIGHT)).toBe('2026-09-28')
    expect(taipeiDateTimeText(CROSS_MIDNIGHT)).toBe('2026/09/28 00:30')
  })

  it('午夜印成 00 不是 24（hourCycle h23）', () => {
    expect(taipeiDateTimeText('2026-01-05T16:00:00Z')).toBe('2026/01/06 00:00')
  })

  it('字串、毫秒數、Date 三種輸入同一個答案', () => {
    const ms = Date.parse(CROSS_MIDNIGHT)
    expect(taipeiDateText(ms)).toBe('2026-09-28')
    expect(taipeiDateText(new Date(ms))).toBe('2026-09-28')
  })

  it('1979 年以前的日光節約時間照 tzdata 算，不是硬寫 +8', () => {
    // 1975-06-30 台灣實施夏令時間（UTC+9）：UTC 15:30 是台北 7/1 00:30，硬寫 +8 會是 6/30 23:30。
    expect(taipeiDateTimeText('1975-06-30T15:30:00Z')).toBe('1975/07/01 00:30')
  })

  it('空值與解析不了的輸入回空字串（null 給呼叫端決定）', () => {
    for (const bad of [null, undefined, '', '不是時間']) {
      expect(taipeiParts(bad)).toBeNull()
      expect(taipeiDateText(bad)).toBe('')
      expect(taipeiDateTimeText(bad)).toBe('')
    }
  })
})

describe('台北的今天', () => {
  it('洛杉磯 9/27 晚上 9:30 在台北已經是 9/28', () => {
    expect(taipeiToday(Date.parse(CROSS_MIDNIGHT))).toBe('2026-09-28')
    // `toISOString().slice(0, 10)`（settings.vue 舊的匯出檔名）在這一刻是 9/27。
    expect(new Date(CROSS_MIDNIGHT).toISOString().slice(0, 10)).toBe('2026-09-27')
  })

  it('年與月跟著台北跨年', () => {
    expect(taipeiYearMonth(Date.parse('2025-12-31T16:30:00Z'))).toEqual({ year: 2026, month: 1 })
    expect(taipeiYearMonth(Date.parse('2025-12-31T15:59:00Z'))).toEqual({ year: 2025, month: 12 })
  })
})

describe('台北日曆天', () => {
  it('台北 23:50 到隔天 00:10 是 1 天，不是 0', () => {
    // 台北 9/27 23:50 = UTC 15:50；台北 9/28 00:10 = UTC 16:10。
    expect(taipeiCalendarDaysBetween('2026-09-27T15:50:00Z', '2026-09-27T16:10:00Z')).toBe(1)
  })

  it('同一個台北日期裡差 23 小時也是 0', () => {
    // 台北 9/28 00:05 到 23:55
    expect(taipeiCalendarDaysBetween('2026-09-27T16:05:00Z', '2026-09-28T15:55:00Z')).toBe(0)
  })

  it('倒過來是負數；解析不了回 null', () => {
    expect(taipeiCalendarDaysBetween('2026-09-28T04:00:00Z', '2026-09-25T04:00:00Z')).toBe(-3)
    expect(taipeiCalendarDaysBetween('不是時間', CROSS_MIDNIGHT)).toBeNull()
  })
})

describe('agoText —— 佇列列表的「幾天前」', () => {
  // 現在 = 台北 9/28 00:10
  const now = Date.parse('2026-09-27T16:10:00Z')

  it('昨晚 23:50 建的列，過了台北午夜就是「昨天」', () => {
    // 舊版 floor(20 分鐘 / 24h) = 0 ⇒「今天」。
    expect(agoText('2026-09-27T15:50:00Z', now)).toBe('昨天')
    expect(taipeiAgoText('2026-09-27T15:50:00Z', now)).toBe('昨天')
  })

  it('今天、N 天前、未來與空值', () => {
    expect(agoText('2026-09-27T16:05:00Z', now)).toBe('今天')
    expect(agoText('2026-09-25T02:00:00Z', now)).toBe('3 天前')
    expect(agoText('2026-09-30T02:00:00Z', now)).toBe('今天') // 時鐘偏差造成的未來值不寫「-2 天前」
    expect(agoText(null, now)).toBe('')
    expect(agoText('不是時間', now)).toBe('')
  })
})

describe('管理後台與法遵頁的格式', () => {
  it('dayText 與 stampText 在非台灣時區仍是台北日期', () => {
    expect(dayText(CROSS_MIDNIGHT)).toBe('2026-09-28')
    expect(stampText('2026-09-05T18:29:18.9+00:00')).toBe('2026/09/06 02:29')
  })

  it('taipeiDateText 等於舊的 zh-Hant-TW 生效日寫法（StrikeStatus／effectiveDateText）', () => {
    // 舊寫法原樣保留在這裡當對照：兩個頁面換成共用函式時不得改變輸出。
    const legacy = (iso: string) => new Intl.DateTimeFormat('zh-Hant-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso)).replace(/\//g, '-')
    for (const iso of [CROSS_MIDNIGHT, '2026-09-06T02:36:36.795Z', '2026-01-05T16:00:00Z'])
      expect(taipeiDateText(iso)).toBe(legacy(iso))
  })
})

describe('monthlySeriesToDate —— 「這個月」是台北的', () => {
  const monthly = [{ month: 3, records: 2, tickets: 2, spend: 0, spend_is_partial: false }]

  it('洛杉磯 3/31 晚上（台北 4/1）四月已經不是斷點', () => {
    const s = monthlySeriesToDate(monthly, 2026, new Date('2026-03-31T16:30:00Z'))
    expect(s[2]).toBe(2)
    expect(s[3]).toBe(0) // 台北四月進行中
    expect(s[4]).toBeNull()
  })

  it('台北跨年那一刻，今年從一月開始、去年整年都是數字', () => {
    const t = Date.parse('2025-12-31T16:30:00Z') // 台北 2026-01-01 00:30
    const thisYear = monthlySeriesToDate(monthly, 2026, t)
    expect(thisYear[0]).toBe(0)
    expect(thisYear[1]).toBeNull()
    expect(monthlySeriesToDate(monthly, 2025, t).every(v => v !== null)).toBe(true)
  })
})
