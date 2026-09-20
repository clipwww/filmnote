import type { MyLogItem } from '#pipeline/import/mylog'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DOUBLE_FEATURES, expandDoubleFeature, expandedCount, resolveDoubleFeature } from '#pipeline/import/double-features'
import {
  decodeImportKey,
  knownFormats,
  mapScreeningFormat,
  normalizeRecords,
  parseRawWallClock,
  toTaipeiWallClock,
} from '#pipeline/import/mylog'
import { ALL_OVERRIDES, resolveTmdbOverride } from '#pipeline/import/tmdb-overrides'
import { AMBIGUOUS_ALIASES, resolveVenueAlias, VENUE_ALIASES } from '#pipeline/import/venue-aliases'

/**
 * 案例全部取自 mechakucha-api `/my-log/movie` 的 169 筆實測資料。
 * `id` 是原始 CSV 列的 base64，所以每個案例都自帶預期答案——
 * 解碼後那一行就是上游寫下的牆上時間，不是我推論出來的。
 */

function item(partial: Partial<MyLogItem>): MyLogItem {
  return {
    id: 'MjAyNi8wNy8yNiAo6YCx5pelKSAxNjowMCzliofloLTniYgg5ZCJ5LyK5Y2h5ZOHIOS6uumtmuWztueahOenmOWvhizml6XmnKwsMkQs5p6X5Y+j5aiB56eALDI2MCwwLDIsMCw1MjA=',
    memo: '',
    date: '2026-07-26T08:00:00.000Z',
    title: '劇場版 吉伊卡哇 人魚島的秘密',
    area: '日本',
    version: '2D',
    theater: '林口威秀',
    price: 260,
    fee: 0,
    tickets: 2,
    discount: 0,
    cost: 520,
    ...partial,
  }
}

describe('台北牆上時間換算', () => {
  it.each([
    // date（UTC）→ 期望的台北日期／時間，答案取自同一筆 id 解碼後的原始列
    ['2026-07-26T08:00:00.000Z', '2026-07-26', '16:00', '最晚一筆（2026）'],
    ['2014-03-01T06:00:00.000Z', '2014-03-01', '14:00', '最早一筆（2014 KANO）'],
    ['2025-07-04T14:10:00.000Z', '2025-07-04', '22:10', '晚場 22:10 不可跑到隔天'],
    ['2019-06-29T09:00:00.000Z', '2019-06-29', '17:00', '傍晚場'],
    ['2023-11-04T11:00:00.000Z', '2023-11-04', '19:00', '晚場 19:00'],
  ])('%s → %s %s（%s）', (iso, expectedOn, expectedTime) => {
    expect(toTaipeiWallClock(iso)).toEqual({ watchedOn: expectedOn, watchedTime: expectedTime })
  })

  /**
   * 直覺會以為「晚場會跑到隔天」，其實方向相反：台北 = UTC+8，
   * 台北 08:00 以後的場次 UTC 日期不變，真正會偏移的是午夜場——
   * 台北 00:00 的 UTC 是前一天 16:00。169 筆裡這樣的有 5 筆。
   */
  it.each([
    ['2017-10-31T16:00:00.000Z', '2017-11-01', '正義聯盟'],
    ['2017-09-30T16:00:00.000Z', '2017-10-01', '雷神索爾3：諸神黃昏'],
    ['2017-10-20T16:00:00.000Z', '2017-10-21', '氣象戰'],
    ['2017-12-29T16:00:00.000Z', '2017-12-30', '少女與戰車 最終章 第1話'],
    ['2016-04-29T16:00:00.000Z', '2016-04-30', '美國隊長3：英雄內戰'],
  ])('午夜場 %s 必須是 %s 而非前一天（%s）', (iso, expectedOn) => {
    const clock = toTaipeiWallClock(iso)
    expect(clock.watchedOn).toBe(expectedOn)
    expect(clock.watchedTime).toBe('00:00')
    // 直接取 UTC 日期部分會退到前一天——這正是這個測試要擋的迴歸
    expect(clock.watchedOn).not.toBe(iso.slice(0, 10))
  })

  it('無法解析的時間字串要炸出來，不要靜默回傳 NaN', () => {
    expect(() => toTaipeiWallClock('not-a-date')).toThrow(/無法解析/)
  })
})

describe('import_key 與原始列', () => {
  it('base64 解回原始 CSV 列', () => {
    expect(decodeImportKey(item({}).id))
      .toBe('2026/07/26 (週日) 16:00,劇場版 吉伊卡哇 人魚島的秘密,日本,2D,林口威秀,260,0,2,0,520')
  })

  it.each([
    ['2026/07/26 (週日) 16:00,劇場版,日本,2D', '2026-07-26', '16:00'],
    ['2025/7/4 下午 22:10:00,侏羅紀世界：重生,美國,2D', '2025-07-04', '22:10'],
    ['2025/6/13 下午 20:00:00,片名,日本,2D', '2025-06-13', '20:00'],
    ['2017/11/01 (週三) 00:00,正義聯盟,美國,2D', '2017-11-01', '00:00'],
  ])('原始列 %s → %s %s', (raw, expectedOn, expectedTime) => {
    expect(parseRawWallClock(raw)).toEqual({ watchedOn: expectedOn, watchedTime: expectedTime })
  })

  it('「下午」是裝飾，時針已是 24 小時制，不可再加 12', () => {
    // 上游三筆這種寫法的時針分別是 21、22、20，加 12 都會溢位
    expect(parseRawWallClock('2025/8/8 下午 21:40:00,片名')?.watchedTime).toBe('21:40')
  })

  it('解析不出來時回傳 null，不要猜', () => {
    expect(parseRawWallClock('沒有日期的一行')).toBeNull()
  })
})

describe('放映版本對照', () => {
  it.each([
    ['2D', 'digital', null, null],
    ['2D (ATMOS)', 'digital', 'ATMOS', null],
    ['IMAX', 'imax', null, null],
    ['IMAX 3D', 'imax', '3D', null],
    ['4DX', '4dx', null, null],
    ['4DX 3D', '4dx', '3D', null],
    ['4DX 極爆', '4dx', '極爆', null],
    ['Dolby Cinema', 'dolby', null, null],
    // TITAN / MAPPA 各自是獨立的放映版本（David 2026-09-20 推翻了前一輪
    // 「它們是廳型品牌 ⇒ 進 hall_label、format_code 記 other」的決定；
    // 完整理由與舊結論留在 src/import/mylog.ts 的 FORMAT_TABLE 註解裡）。
    // hall 一併留空：版本已經指明是哪個廳，不留空會印成「…威秀影城 (MAPPA) MAPPA」。
    ['TITAN', 'titan', null, null],
    ['MAPPA', 'mappa', null, null],
  ])('%s → format_code=%s note=%s hall=%s', (version, code, note, hall) => {
    expect(mapScreeningFormat(version)).toEqual({ code, note, hall })
  })

  it('未知版本回傳 null，由呼叫端列進報告而非靜默歸為「其他」', () => {
    expect(mapScreeningFormat('ScreenX 4DX 未來廳')).toBeNull()
  })

  it('對照表涵蓋上游全部 10 種寫法', () => {
    expect(knownFormats()).toHaveLength(10)
  })

  it('format_code 全部落在 screening_format 的值域內', () => {
    // 0001_init.sql 種入的 screening_format.code
    // ＋ 0016_screening_format_mappa_titan.sql 追加的 mappa / titan。
    // ⚠️ 這一條守的是外鍵 viewing_record_format_code_fkey：這裡漏掉一個 code，
    //    匯入時才會在 DB 層爆 23503。加新版本時務必兩邊一起加。
    const valid = new Set(['digital', 'imax', 'imax_laser', '3d', '4dx', 'screenx', 'dolby', 'film_35', 'mappa', 'titan', 'other'])
    for (const version of knownFormats())
      expect(valid).toContain(mapScreeningFormat(version)!.code)
  })
})

describe('逐筆正規化', () => {
  it('金額直接採用上游的 cost，不自行重算', () => {
    // fee 是「每張」手續費：240×3 + 20×3 = 780，不是 240×3+20 = 740
    const { records } = normalizeRecords([item({ price: 240, fee: 20, tickets: 3, cost: 780 })])
    expect(records[0]!.amount).toBe(780)
  })

  it('兌換票的 0 元是合法金額', () => {
    const { records, issues } = normalizeRecords([
      item({ price: 0, fee: 0, tickets: 1, discount: 200, cost: 0, memo: '兌點票' }),
    ])
    expect(issues).toHaveLength(0)
    expect(records[0]!.amount).toBe(0)
  })

  it('空備註收斂為 null，不寫入空字串', () => {
    expect(normalizeRecords([item({ memo: '   ' })]).records[0]!.memo).toBeNull()
  })

  it('多行備註原樣保留', () => {
    const memo = '解鎖人生成就「在日本看電影」| \n票價為 JPY 1,600'
    expect(normalizeRecords([item({ memo })]).records[0]!.memo).toBe(memo)
  })

  it('未知版本進 issues 而非records', () => {
    const { records, issues } = normalizeRecords([item({ version: 'ScreenX' })])
    expect(records).toHaveLength(0)
    expect(issues[0]!.reason).toBe('unknown-format')
  })

  it('票數超出 schema 的 1–99 進 issues', () => {
    const { records, issues } = normalizeRecords([item({ tickets: 0 })])
    expect(records).toHaveLength(0)
    expect(issues[0]!.reason).toBe('bad-ticket-count')
  })

  it('date 欄與原始列不一致時進 issues——上游改了產生方式要立刻炸出來', () => {
    // id 解碼是 16:00，把 date 改成對應 15:00 的瞬間
    const { records, issues } = normalizeRecords([item({ date: '2026-07-26T07:00:00.000Z' })])
    expect(records).toHaveLength(0)
    expect(issues[0]!.reason).toBe('wall-clock-mismatch')
  })
})

describe('影廳對照表', () => {
  const officialIds = new Set<string>(
    (JSON.parse(readFileSync('.data/venues.json', 'utf8')) as { taxId: string }[])
      .map(v => v.taxId),
  )

  it('每一筆對應的 venue_id 都真的存在於官方名冊或虛擬場所', () => {
    for (const entry of VENUE_ALIASES) {
      if (entry.venueId === null)
        continue
      const known = officialIds.has(entry.venueId) || entry.venueId.startsWith('virtual:')
      expect(known, `${entry.alias} → ${entry.venueId}`).toBe(true)
    }
  })

  it('對應到的官方名稱與名冊一致——防止統編與名稱抄錯行', () => {
    const nameById = new Map(
      (JSON.parse(readFileSync('.data/venues.json', 'utf8')) as { taxId: string, name: string }[])
        .map(v => [v.taxId, v.name]),
    )
    for (const entry of VENUE_ALIASES) {
      if (entry.venueId === null || entry.venueId.startsWith('virtual:'))
        continue
      expect(nameById.get(entry.venueId), entry.alias).toBe(entry.officialName)
    }
  })

  it('涵蓋上游全部 15 個相異影廳簡稱', () => {
    expect(VENUE_ALIASES).toHaveLength(15)
    expect(new Set(VENUE_ALIASES.map(e => e.alias)).size).toBe(15)
  })

  it('每一筆都寫了判定依據', () => {
    for (const entry of VENUE_ALIASES)
      expect(entry.reason.length, entry.alias).toBeGreaterThan(0)
  })

  it('待裁決的簡稱一律 venueId = null，不得先猜一個填著', () => {
    for (const entry of VENUE_ALIASES) {
      if (entry.question)
        expect(entry.venueId, entry.alias).toBeNull()
    }
    expect(AMBIGUOUS_ALIASES.map(e => e.alias).sort())
      .toEqual(VENUE_ALIASES.filter(e => e.question).map(e => e.alias).sort())
  })

  it('已確定的簡稱逐字查得到', () => {
    expect(resolveVenueAlias('林口威秀')?.venueId).toBe('24808911')
    expect(resolveVenueAlias('信義威秀')?.venueId).toBe('16431011')
  })

  it('未知簡稱回傳 null——只做逐字比對，絕不做子字串猜測', () => {
    // 「林口威秀」若以子字串比對，會配到「台北京站威秀影城」
    expect(resolveVenueAlias('高雄威秀')).toBeNull()
    expect(resolveVenueAlias('威秀')).toBeNull()
  })
})

describe('tMDB 人工對照表', () => {
  it('tmdbId 不重複——同一部片被指定兩次代表對照表自相矛盾', () => {
    const ids = ALL_OVERRIDES.map(o => o.tmdbId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('logTitle 不重複', () => {
    const titles = ALL_OVERRIDES.map(o => o.logTitle)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('每筆都寫了「比對器為什麼沒配到」——那是 Step 7 調門檻的依據', () => {
    for (const o of ALL_OVERRIDES) {
      expect(o.note.length, o.logTitle).toBeGreaterThan(0)
      expect(o.tmdbTitle.length, o.logTitle).toBeGreaterThan(0)
      expect(o.releaseYear, o.logTitle).toBeGreaterThan(1880)
    }
  })

  it('逐字查表，不做模糊比對', () => {
    expect(resolveTmdbOverride('白箱')?.tmdbId).toBe(532323)
    expect(resolveTmdbOverride('侏儸紀世界：殞落國度')?.tmdbId).toBe(351286)
    // 錯字修正後的正確寫法不在表內——表只負責舊 log 的原字串
    expect(resolveTmdbOverride('侏羅紀世界：殞落國度')).toBeNull()
    expect(resolveTmdbOverride('白')).toBeNull()
  })

  it('系列作三部各自指到不同的 tmdb id——這是最容易配錯的一類', () => {
    // 實測比對器曾讓第一部靠前綴配到第二部
    expect(resolveTmdbOverride('Fate stay night Heaven\'s feel')?.tmdbId).toBe(283984)
    expect(resolveTmdbOverride('Fate stay night Heaven\'s feel 2')?.tmdbId).toBe(390634)
    expect(resolveTmdbOverride('Fate stay night Heaven\'s feel 3')?.tmdbId).toBe(390635)
  })

  it('連映拆出來的每一話都查得到對應作品，否則拆完會無處可去', () => {
    for (const feature of DOUBLE_FEATURES) {
      for (const part of feature.parts)
        expect(resolveTmdbOverride(part.title)?.tmdbId, part.title).toBeGreaterThan(0)
    }
  })
})

describe('名冊外影廳的 seed 資料', () => {
  it('每個待裁決的簡稱都備妥 seed，--unmapped-venue=ugc 才建得出 venue', () => {
    for (const entry of AMBIGUOUS_ALIASES)
      expect(entry.seed, entry.alias).toBeDefined()
  })

  it('歇業與海外影城一律不可出現在新增紀錄的選單', () => {
    for (const entry of AMBIGUOUS_ALIASES)
      expect(entry.seed!.selectable, entry.alias).toBe(false)
  })

  it('status=closed 必附歇業日；仍營業者不得有歇業日', () => {
    for (const entry of AMBIGUOUS_ALIASES) {
      const seed = entry.seed!
      if (seed.status === 'closed')
        expect(seed.closedAt, entry.alias).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      else
        expect(seed.closedAt, entry.alias).toBeNull()
    }
  })

  it('心斎橋仍在營業——不可為了擋選單而謊報歇業', () => {
    const aeon = AMBIGUOUS_ALIASES.find(e => e.alias.startsWith('イオン'))!
    expect(aeon.seed!.status).toBe('active')
    expect(aeon.seed!.selectable).toBe(false)
  })
})

describe('雙片連映拆分', () => {
  const base = normalizeRecords([item({
    title: '少女與戰車最終章 1+2',
    version: '4DX',
    date: '2024-03-09T05:00:00.000Z',
    tickets: 1,
    cost: 600,
    memo: '4DX連映馬拉松場(上)',
    id: 'QkFTRTY0S0VZ',
  })]).records[0]!

  const feature = resolveDoubleFeature('少女與戰車最終章 1+2')!
  const parts = expandDoubleFeature(base, feature)

  it('一筆展開成兩筆', () => {
    expect(parts).toHaveLength(2)
  })

  it('import_key 必須互斥，否則第二筆會覆蓋第一筆、冪等直接壞掉', () => {
    expect(parts[0]!.importKey).toBe('QkFTRTY0S0VZ#1')
    expect(parts[1]!.importKey).toBe('QkFTRTY0S0VZ#2')
    expect(parts[0]!.importKey).not.toBe(parts[1]!.importKey)
    // 也不可與原鍵相同，否則會跟舊資料撞上
    expect(parts.map(p => p.importKey)).not.toContain(base.importKey)
  })

  it('票價全額記在第一筆，第二筆為 null——不對半拆也不重複計算', () => {
    expect(parts[0]!.amount).toBe(600)
    expect(parts[1]!.amount).toBeNull()
    // 拆分不得改變總花費
    const total = parts.reduce((sum, p) => sum + (p.amount ?? 0), 0)
    expect(total).toBe(base.amount)
  })

  it('第二筆的 null 不是 0——0 會被年度總花費當成一筆 0 元消費列出來', () => {
    expect(parts[1]!.amount).not.toBe(0)
  })

  it('各自指向正確的作品', () => {
    expect(parts[0]!.title).toBe('少女與戰車最終章 第1話')
    expect(parts[1]!.title).toBe('少女與戰車最終章 第2話')
  })

  it('時間與場所不變——本來就是同一次進場', () => {
    for (const p of parts) {
      expect(p.watchedOn).toBe(base.watchedOn)
      expect(p.watchedTime).toBe(base.watchedTime)
      expect(p.venueAlias).toBe(base.venueAlias)
      expect(p.ticketCount).toBe(base.ticketCount)
    }
  })

  it('備註註明是連映，且保留原備註', () => {
    expect(parts[0]!.memo).toContain('4DX連映馬拉松場(上)')
    expect(parts[0]!.memo).toContain('連映拆分 1/2')
    expect(parts[1]!.memo).toContain('連映拆分 2/2')
    expect(parts[1]!.memo).toContain('票價記於第 1 筆')
  })

  it('原本沒有備註時也要有連映註記', () => {
    const noMemo = normalizeRecords([item({ title: '少女與戰車最終章 3+4', memo: '' })]).records[0]!
    const out = expandDoubleFeature(noMemo, resolveDoubleFeature('少女與戰車最終章 3+4')!)
    expect(out[0]!.memo).toContain('連映拆分 1/2')
  })

  it('非連映片名不受影響', () => {
    expect(resolveDoubleFeature('玩具總動員5')).toBeNull()
    expect(expandedCount(['玩具總動員5', '天能'])).toBe(2)
  })

  it('實測 5 筆連映 → 10 筆，169 筆總計變 174 筆', () => {
    const titles = ['少女與戰車最終章 1+2', '少女與戰車最終章 1+2', '少女與戰車最終章 1+2', '少女與戰車最終章 3+4', '少女與戰車最終章 3+4']
    expect(expandedCount(titles)).toBe(10)
    expect(169 - titles.length + expandedCount(titles)).toBe(174)
  })
})
