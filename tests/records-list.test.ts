import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { matchesQuery, pageSlice } from '../app/utils/record-list'

/**
 * `/app/records` 的關鍵字搜尋與頁碼分頁。
 *
 * ── 為什麼需要這一支 ────────────────────────────────────────────────────
 * 這兩件事**只有在瀏覽器裡才會執行**：`typecheck` / `lint` / `test` / `build` 四關
 * 對「第 2 頁切到的是不是第 25 筆」「打的字有沒有比到備註」一律全綠。
 * ⇒ 能靜態量的就靜態量，把 Chrome 留給真的只能點的（`#236`）。
 */

function record(over: Partial<Parameters<typeof matchesQuery>[0]> = {}) {
  return {
    film: { titleZh: '沙丘', titleOriginal: 'Dune: Part Two' },
    venueName: '威秀影城 信義',
    hallLabel: 'IMAX 廳',
    memo: '座位有點前面',
    ...over,
  }
}

describe('matchesQuery', () => {
  it('空字串放行全部（清空搜尋 = 還原）', () => {
    expect(matchesQuery(record(), '')).toBe(true)
    expect(matchesQuery(record(), '   ')).toBe(true)
  })

  it('四個欄位各自都比得到', () => {
    expect(matchesQuery(record(), '沙丘')).toBe(true) // 作品（中文）
    expect(matchesQuery(record(), '威秀')).toBe(true) // 影城
    expect(matchesQuery(record(), 'IMAX')).toBe(true) // 影廳
    expect(matchesQuery(record(), '座位')).toBe(true) // 備註
  })

  it('原文片名不分大小寫（`titleOriginal` 是拉丁字）', () => {
    expect(matchesQuery(record(), 'dune')).toBe(true)
    expect(matchesQuery(record(), 'DUNE')).toBe(true)
  })

  it('沒比到就是沒比到', () => {
    expect(matchesQuery(record(), '奧本海默')).toBe(false)
  })

  it('★ 不跨欄命中：逐欄比對而不是把欄位串起來比一次', () => {
    // 「信義座位」在「影城結尾 + 備註開頭」之間是連著的，串起來比會假命中。
    expect(matchesQuery(record(), '信義座位')).toBe(false)
    expect(matchesQuery(record(), '廳座位')).toBe(false)
  })

  it('欄位是 null / undefined 不會炸，也不會假命中', () => {
    const bare = { film: null, venueName: null, hallLabel: null, memo: null }
    expect(matchesQuery(bare, '沙丘')).toBe(false)
    expect(matchesQuery({}, '沙丘')).toBe(false)
    expect(matchesQuery({ film: { titleZh: null, titleOriginal: null } }, '沙丘')).toBe(false)
  })

  it('★ 不含日期（交接 §8 卡點 2 還沒裁決）', () => {
    // 這一條是**釘住現況**不是釘住正確性：David 說要就改，改了這條要一起改。
    // 與時區無關（比的是欄位字串，不是 `watchedOn`）⇒ 不需要跑第二個 TZ。
    expect(matchesQuery(record({ memo: '看完去吃飯' }), '2024')).toBe(false)
    // 但片名裡的數字照樣比得到——「不含日期」講的是不去翻 `watchedOn`。
    expect(matchesQuery(record({ film: { titleZh: '1917', titleOriginal: '1917' } }), '1917')).toBe(true)
  })
})

describe('pageSlice', () => {
  const all = Array.from({ length: 174 }, (_, i) => `r${i}`) // David 現有 174 筆
  const PER_PAGE = 24

  it('★ 驗的是內容不是長度（#234：JS 陣列會自己長）', () => {
    expect(pageSlice(all, 2, PER_PAGE)[0]).toBe(all[PER_PAGE])
    expect(pageSlice(all, 2, PER_PAGE).at(-1)).toBe(all[PER_PAGE * 2 - 1])
    expect(pageSlice(all, 3, PER_PAGE)[0]).toBe(all[PER_PAGE * 2])
  })

  it('每一頁都接得上，而且合起來剛好是全集（沒有重疊、沒有漏）', () => {
    const pageCount = Math.ceil(all.length / PER_PAGE)
    const rejoined = Array.from({ length: pageCount }, (_, i) => pageSlice(all, i + 1, PER_PAGE)).flat()
    expect(rejoined).toEqual(all)
  })

  it('最後一頁不補滿：174 = 7 × 24 + 6', () => {
    expect(pageSlice(all, 8, PER_PAGE)).toHaveLength(6)
    expect(pageSlice(all, 8, PER_PAGE)[0]).toBe(all[168])
  })

  it('空集合與越界的頁碼回空陣列（不是 undefined、不會炸）', () => {
    expect(pageSlice([], 1, PER_PAGE)).toEqual([])
    expect(pageSlice(all, 99, PER_PAGE)).toEqual([])
  })
})

/**
 * ★ 這一段釘的是「回第 1 頁的訊號來源」。
 *
 * `refresh()`（存檔、刪除之後都會呼叫）會換掉 `filtered` 的 identity。
 * 監看 `filtered` ⇒ **每一次存檔都把使用者踢回第 1 頁**，而那正是 David 抱怨的
 * 「返回上一頁狀態都被清掉」的同一個病。四關對這件事一律全綠，只有真的存一筆才看得到。
 */
describe('/app/records 的頁碼重設訊號', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../app/pages/app/records/index.vue', import.meta.url)),
    'utf8',
  )
  const script = parse(src, { filename: 'index.vue' }).descriptor.scriptSetup?.content ?? ''

  it('腳本真的讀到了（不然下面兩條會是永遠綠的裝飾品）', () => {
    expect(script).toContain('page.value = 1')
  })

  it('沒有任何 watch 監看 `filtered`', () => {
    expect(script).not.toMatch(/watch\(\s*filtered\b/)
    expect(script).not.toMatch(/watch\(\s*\[[^\]]*\bfiltered\b/)
  })

  it('回第 1 頁的 watch 監看的是五個輸入值', () => {
    const m = /watch\(\s*\[([^\]]*)\]\s*,\s*\(\)\s*=>\s*\{\s*page\.value = 1/.exec(script)
    expect(m).not.toBeNull()
    const watched = m![1]!.split(',').map(s => s.trim()).filter(Boolean)
    expect(watched.sort()).toEqual(['cost', 'format', 'q', 'venue', 'year'])
  })
})
