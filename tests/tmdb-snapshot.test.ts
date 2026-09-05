/**
 * TMDB 明細 → 快照列的映射。
 *
 * 這裡釘住的全是「TMDB 的空值長什麼樣子」——那是刷新流程唯一會讓整批 update
 * 因為一列而失敗的地方（date 收到 `""` 是 22007、runtime 收到 0 或 9999 違反
 * check constraint），而且在正常資料上永遠測不到。
 */

import type { TmdbDetailForSnapshot } from '../server/utils/tmdb-snapshot'
import { describe, expect, it } from 'vitest'
import {
  backoffMinutes,
  CACHE_TTL_DAYS,
  failurePatch,
  gonePatch,
  outcomeForError,
  REFRESH_INTERVAL_DAYS,
  snapshotDate,
  snapshotFromDetail,
  snapshotRuntime,
} from '../server/utils/tmdb-snapshot'

const NOW = new Date('2026-09-06T00:00:00.000Z')

function detail(overrides: Partial<TmdbDetailForSnapshot> = {}): TmdbDetailForSnapshot {
  return {
    id: 550,
    title: '鬥陣俱樂部',
    original_title: 'Fight Club',
    release_date: '1999-10-15',
    poster_path: '/poster.jpg',
    backdrop_path: '/backdrop.jpg',
    popularity: 1,
    imdb_id: 'tt0137523',
    overview: '簡介',
    runtime: 139,
    genres: [{ id: 18, name: '劇情' }],
    release_dates: {
      results: [
        { iso_3166_1: 'US', release_dates: [{ release_date: '1999-10-15T00:00:00.000Z' }] },
        { iso_3166_1: 'TW', release_dates: [{ release_date: '1999-11-13T00:00:00.000Z' }] },
      ],
    },
    ...overrides,
  }
}

describe('snapshotRuntime', () => {
  it('把 TMDB 的 0 當成「不知道」，不是 0 分鐘', () => {
    expect(snapshotRuntime(0)).toBeNull()
  })

  it('超出 check constraint（1–1200）的值收斂成 null，而不是讓整列寫入失敗', () => {
    expect(snapshotRuntime(1201)).toBeNull()
    expect(snapshotRuntime(-5)).toBeNull()
    expect(snapshotRuntime(1200)).toBe(1200)
  })

  it('null / undefined / NaN 一律 null', () => {
    expect(snapshotRuntime(null)).toBeNull()
    expect(snapshotRuntime(undefined)).toBeNull()
    expect(snapshotRuntime(Number.NaN)).toBeNull()
  })
})

describe('snapshotDate', () => {
  it('擋掉 TMDB 資料不全時回的空字串，不能直接餵給 date 欄位', () => {
    expect(snapshotDate('')).toBeNull()
    expect(snapshotDate('   ')).toBeNull()
  })

  it('只接受 YYYY-MM-DD', () => {
    expect(snapshotDate('1999-10-15')).toBe('1999-10-15')
    expect(snapshotDate('1999-10')).toBeNull()
    expect(snapshotDate('1999')).toBeNull()
  })
})

describe('snapshotFromDetail', () => {
  it('六個月條款：expires_at 為 180 天後，next_refresh_at 為 150 天後', () => {
    const patch = snapshotFromDetail(detail(), NOW)
    const days = (iso: string) => Math.round((Date.parse(iso) - NOW.getTime()) / 86_400_000)

    expect(days(patch.expires_at)).toBe(CACHE_TTL_DAYS)
    expect(days(patch.next_refresh_at)).toBe(REFRESH_INTERVAL_DAYS)
    // 排程一定要早於到期，否則永遠不會被刷新就先過期。
    expect(Date.parse(patch.next_refresh_at)).toBeLessThan(Date.parse(patch.expires_at))
  })

  it('成功刷新會歸零 attempts 與 last_error', () => {
    const patch = snapshotFromDetail(detail(), NOW)
    expect(patch.state).toBe('fresh')
    expect(patch.attempts).toBe(0)
    expect(patch.last_error).toBeNull()
  })

  it('台灣上映日取 TW 區塊，且只留日期', () => {
    expect(snapshotFromDetail(detail(), NOW).tw_release_date).toBe('1999-11-13')
  })

  it('沒有 TW 區塊時 tw_release_date 為 null', () => {
    const patch = snapshotFromDetail(detail({ release_dates: { results: [] } }), NOW)
    expect(patch.tw_release_date).toBeNull()
  })

  it('genres 取 id 陣列（明細端點沒有 genre_ids）', () => {
    expect(snapshotFromDetail(detail(), NOW).genre_ids).toEqual([18])
    expect(snapshotFromDetail(detail({ genres: undefined }), NOW).genre_ids).toBeNull()
  })

  it('空字串一律 null，不寫進資料庫當「有值的空字串」', () => {
    const patch = snapshotFromDetail(
      detail({ overview: '', poster_path: null, backdrop_path: null, release_date: '' }),
      NOW,
    )
    expect(patch.overview).toBeNull()
    expect(patch.poster_path).toBeNull()
    expect(patch.backdrop_path).toBeNull()
    expect(patch.release_date).toBeNull()
  })

  it('海報只存路徑，不存完整網址（一律熱連結 image.tmdb.org）', () => {
    expect(snapshotFromDetail(detail(), NOW).poster_path).toBe('/poster.jpg')
  })
})

describe('backoffMinutes', () => {
  it('1 小時起跳、逐次加倍', () => {
    expect(backoffMinutes(1)).toBe(60)
    expect(backoffMinutes(2)).toBe(120)
    expect(backoffMinutes(3)).toBe(240)
  })

  it('上限 3 天，不會退避到實質放棄', () => {
    expect(backoffMinutes(50)).toBe(60 * 24 * 3)
  })
})

describe('failurePatch', () => {
  it('★ 不動 expires_at：合規靠讀取端把關，不靠刷新成功', () => {
    const patch = failurePatch(2, '429', NOW)
    expect(patch).not.toHaveProperty('expires_at')
    expect(patch.state).toBe('failed')
    expect(patch.attempts).toBe(3)
    expect(Date.parse(patch.next_refresh_at)).toBe(NOW.getTime() + 240 * 60_000)
  })

  it('錯誤訊息截斷，不讓上游的長訊息膨脹欄位', () => {
    expect(failurePatch(0, 'x'.repeat(2000), NOW).last_error).toHaveLength(500)
  })
})

describe('gonePatch', () => {
  it('在 TMDB 說不存在時立刻到期，讓讀取端把欄位變 NULL', () => {
    const patch = gonePatch('404', NOW)
    expect(patch.state).toBe('gone')
    expect(Date.parse(patch.expires_at)).toBe(NOW.getTime())
    expect(Date.parse(patch.next_refresh_at)).toBeGreaterThan(NOW.getTime())
  })
})

describe('outcomeForError', () => {
  // ★ 這一組是 429 驗收條件的替身。Step 9 的 2,483 次實測請求裡節流 0 次，
  //   沒辦法叫 TMDB 真的回 429，所以規則本身在這裡被釘住。
  it('429 只推遲 next_refresh_at，不動 expires_at，整批不中止', () => {
    const outcome = outcomeForError(429, 0, 'TMDB 回應 HTTP 429', NOW)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed')
      throw new Error('unreachable')
    expect(outcome.patch).not.toHaveProperty('expires_at')
    expect(outcome.patch.attempts).toBe(1)
    expect(Date.parse(outcome.patch.next_refresh_at)).toBe(NOW.getTime() + 60 * 60_000)
  })

  it('5xx 與網路中斷（status 0 / undefined）都走同一條退避路徑', () => {
    for (const status of [500, 502, 503, 504, 0, undefined])
      expect(outcomeForError(status, 1, 'x', NOW).kind).toBe('failed')
  })

  it('404 代表上游已刪除，標記 gone 並立刻到期', () => {
    const outcome = outcomeForError(404, 0, '404', NOW)
    expect(outcome.kind).toBe('gone')
    if (outcome.kind !== 'gone')
      throw new Error('unreachable')
    expect(Date.parse(outcome.patch.expires_at)).toBe(NOW.getTime())
  })

  it('401 / 403 是設定錯誤：整批中止且不寫任何狀態', () => {
    expect(outcomeForError(401, 0, 'x', NOW)).toEqual({ kind: 'fatal' })
    expect(outcomeForError(403, 0, 'x', NOW)).toEqual({ kind: 'fatal' })
  })
})
