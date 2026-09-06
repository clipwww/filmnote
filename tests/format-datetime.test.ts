import { describe, expect, it } from 'vitest'
import { dateTimeText, shortTime, watchedAtText } from '../app/utils/format-datetime'

describe('watchedAtText', () => {
  it('日期用斜線、時間截到分', () => {
    expect(watchedAtText('2026-07-26', '16:00:00')).toBe('2026/07/26 16:00')
  })

  it('已經是 HH:mm 的時間不會被再截一次', () => {
    expect(watchedAtText('2026-07-26', '16:00')).toBe('2026/07/26 16:00')
  })

  // ⚠️ 這一條是刻意的：沒有場次時間就只印日期，不補 `--:--` 之類的佔位。
  // 缺席靠「別的列後面都有一截、這一列沒有」自己顯現；佔位符會變成一整欄的
  // 雜訊，而且讀起來像「有一個時間但不給你看」（SCREENS §12 第 4 條同理）。
  it('沒有時間就只有日期，不補佔位', () => {
    expect(watchedAtText('2026-07-26', null)).toBe('2026/07/26')
    expect(watchedAtText('2026-07-26')).toBe('2026/07/26')
    expect(watchedAtText('2026-07-26', '')).toBe('2026/07/26')
  })

  it('月與日補零到兩位（tabular-nums 要對得齊）', () => {
    expect(watchedAtText('2026-01-06', '09:05:00')).toBe('2026/01/06 09:05')
  })

  it('日期不合格式時回空字串，不做盡量拼湊', () => {
    expect(watchedAtText(null)).toBe('')
    expect(watchedAtText('')).toBe('')
    expect(watchedAtText('2026-7-6')).toBe('')
    expect(watchedAtText('2026-07-26T16:00:00Z')).toBe('')
  })

  it('不會因為沒有時區而位移一天', () => {
    // watched_on 是台北牆上時間的日期，這支函式全程只做字串切割、
    // 不經過 Date，所以在任何 TZ 下都是同一天（對照 dateBand 的同名測試）。
    const tz = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      expect(watchedAtText('2026-07-26', '00:30:00')).toBe('2026/07/26 00:30')
    }
    finally {
      process.env.TZ = tz
    }
  })
})

// ── 以下兩支是既有函式的迴歸樁 ─────────────────────────────────────────
// `format-datetime.ts` 是前任 frontend 留下的共用層，現在沒有主人。
// 加 `watchedAtText` 時「只新增、不改既有行為」是主 session 的條件，
// 這兩組就是那個條件的機器可讀版本：有人改了它們，測試會紅。
describe('shortTime（既有行為，不得更動）', () => {
  it('截到分', () => {
    expect(shortTime('21:30:00')).toBe('21:30')
  })

  it('空值回 null', () => {
    expect(shortTime(null)).toBeNull()
    expect(shortTime('')).toBeNull()
  })
})

describe('dateTimeText（既有行為，不得更動）', () => {
  it('仍然是連字號 + 空白，不是斜線', () => {
    expect(dateTimeText('2026-07-26', '16:00:00')).toBe('2026-07-26 16:00')
  })

  it('只有日期時就只回日期', () => {
    expect(dateTimeText('2026-07-26')).toBe('2026-07-26')
    expect(dateTimeText(null)).toBe('')
  })
})
