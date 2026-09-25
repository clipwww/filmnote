import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { keepIfOffered, matchesQuery, pageSlice } from '../app/utils/record-list'

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

  it('★ 不含日期（David 2026-09-25 裁決：不用比對日期）', () => {
    // 與時區無關（比的是欄位字串，不是 `watchedOn`）⇒ 不需要跑第二個 TZ。
    expect(matchesQuery(record({ memo: '看完去吃飯' }), '2024')).toBe(false)
    // 但片名裡的數字照樣比得到——「不含日期」講的是不去翻 `watchedOn`。
    expect(matchesQuery(record({ film: { titleZh: '1917', titleOriginal: '1917' } }), '1917')).toBe(true)
  })
})

describe('keepIfOffered', () => {
  const ALL = '__all__'
  const offered = [{ value: ALL }, { value: '威秀影城 信義' }, { value: '國賓影城 長春' }]

  it('新年份還有這家影城 ⇒ 留著', () => {
    expect(keepIfOffered('威秀影城 信義', offered, ALL)).toBe('威秀影城 信義')
  })

  it('新年份沒有這家影城 ⇒ 歸回全部（不然表是空的而且看不出原因）', () => {
    expect(keepIfOffered('秀泰影城 台北車站', offered, ALL)).toBe(ALL)
  })

  it('本來就是全部 ⇒ 還是全部', () => {
    expect(keepIfOffered(ALL, offered, ALL)).toBe(ALL)
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
describe('/app/records 換年份', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../app/pages/app/records/index.vue', import.meta.url)),
    'utf8',
  )
  const script = parse(src, { filename: 'index.vue' }).descriptor.scriptSetup?.content ?? ''
  const body = /watch\(\s*year\s*,\s*\(\)\s*=>\s*\{([^}]*)\}/.exec(script)?.[1] ?? ''

  it('腳本裡真的有 watch(year)（不然下面兩條是永遠綠的裝飾品）', () => {
    expect(body).toContain('keepIfOffered')
  })

  it('★ 不再無條件清掉影城／版本，也不碰票價', () => {
    expect(body).not.toMatch(/(venue|format|cost)\.value = ALL/)
    expect(body).not.toMatch(/cost\.value/)
  })
})

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

/**
 * ★ 編輯抽屜（David 第 1 條）。這一整組釘的都是**行為**，而行為四關一律全綠。
 *
 * 第 1 條的驗收是「列表元件不卸載、篩選／頁碼／捲動位置全部沒變」。那件事最終只有真的
 * 點一次才看得到，但它有三個**可以靜態釘住的前提**：換頁的入口是 query 不是路徑、
 * 關抽屜是 replace、骨架不擋 `refresh()`。前提被改掉時這裡會紅。
 */
describe('/app/records 編輯抽屜', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../app/pages/app/records/index.vue', import.meta.url)),
    'utf8',
  )
  const redirect = readFileSync(
    fileURLToPath(new URL('../app/pages/app/records/[id]/edit.vue', import.meta.url)),
    'utf8',
  )

  it('沒有任何**活著的**連結指向舊的 `/edit` 路徑', () => {
    // 交接 §2.1：入口有兩處（操作欄、備註對話框），漏掉第二處就是一個活著的舊連結
    // ——而漏掉的那一個**換頁之後列表狀態就沒了**，正是 David 抱怨的那件事。
    // ⚠️ 比對的是 `:to` 屬性值不是整份原始碼：原始碼裡還留著一則說明改動的註解，
    //    照字面 grep `/edit` 會被那則註解咬到 ⇒ 那種斷言守的不是它宣稱要守的東西（§7.6）。
    const links = src.match(/:to="[^"]*"/g) ?? []
    // 自證：真的抓到連結了，不是因為一個都沒抓到才「通過」。
    expect(links.length).toBeGreaterThan(0)
    expect(links.filter(l => l.includes('/edit'))).toEqual([])
  })

  it('兩個入口都用 `editLink()`（真連結，push 一筆 history）', () => {
    // 必須是真連結不是 @click 切 ref：只有推了 history，「上一頁」才關得掉抽屜。
    expect(src.match(/:to="editLink\(/g)?.length).toBe(2)
  })

  it('★ 關抽屜是 replace 不是 push', () => {
    // 不 replace 的話 history 是 [列表, 列表?edit=X, 列表]，關掉後按上一頁抽屜會重開。
    expect(src).toMatch(/navigateTo\(\s*\{\s*query:[^}]*edit:\s*undefined\s*\}\s*\}\s*,\s*\{\s*replace:\s*true\s*\}\s*\)/)
  })

  it('★ 骨架只擋首次載入，不擋 refresh()', () => {
    // `refresh()` 會把 status 打回 'pending'（asyncData.js 無條件）⇒ 只看 status 的話
    // 每次存檔都把整張表換成骨架、文件高度塌掉、捲動位置跑掉 = 違反第 1 條。
    expect(src).toMatch(/v-if="status === 'pending' && !records\.length"/)
  })

  it('`?edit` 只認字串（重複參數會變陣列）', () => {
    expect(src).toMatch(/typeof route\.query\.edit === 'string'/)
  })

  it('★ 抽屜寬度覆寫的是 max-w，不是 w-full（375 滿版的硬條件）', () => {
    // 主題 side=right/inset=false 組出來的是 `w-full inset-y-0 right-0` ＋ `max-w-md`
    // ⇒ 375 下是 `w-full` 在決定寬度。動到 w-full 才會破壞「375 維持滿版」；只換上限不會。
    expect(src).toMatch(/:ui="\{ content: 'max-w-2xl' \}"/)
    // 抽屜的 :ui 裡不可以出現 w-\d 或 w-full 之類的寬度指定
    const ui = /<USlideover[\s\S]*?>/.exec(src)?.[0] ?? ''
    expect(ui).not.toMatch(/w-full|w-\[/)
  })

  it('舊的 `/edit` 路徑還活著，而且是 replace 轉址', () => {
    // 深連結不要死；replace 是為了不讓「上一頁」在轉址頁與抽屜之間彈來彈去。
    expect(redirect).toMatch(/path:\s*'\/app\/records'/)
    expect(redirect).toMatch(/query:\s*\{\s*edit:/)
    expect(redirect).toMatch(/replace:\s*true/)
  })
})

/**
 * ★ 改作品（David 第 2 條）：**單一 UPDATE，不是刪掉再新增**。
 * ⚠️ 只驗「總數不變」分辨不出來——刪掉再新增也是 -1+1、總數一樣（交接 §1 第 2 條）。
 * 資料層的證據在 `scripts/`（見交接 §10.2 的 SQL 驗證）；這裡釘的是**寫入路徑的形狀**。
 */
describe('/app/records 改作品的寫入路徑', () => {
  const form = readFileSync(
    fileURLToPath(new URL('../app/components/RecordEditForm.vue', import.meta.url)),
    'utf8',
  )

  it('走 update().eq(id)，而且 film_id 跟著一起送', () => {
    expect(form).toMatch(/\.update\(\{\s*\.\.\.toRecordRow\(form\),\s*film_id:\s*form\.film\.id\s*\}\)/)
    expect(form).toMatch(/\.eq\('id',\s*props\.record\.id\)/)
  })

  it('★ viewing_record 完全沒有 delete 或 insert', () => {
    // 這一條就是「不可以刪掉再新增」的靜態版本。
    expect(form).not.toMatch(/from\('viewing_record'\)[\s\S]{0,80}\.delete\(/)
    expect(form).not.toMatch(/from\('viewing_record'\)[\s\S]{0,80}\.insert\(/)
  })

  it('票價的三態沒有被壓成兩態（null ≠ 0）', () => {
    expect(form).toMatch(/form\.cost === null/)
    expect(form).toMatch(/onConflict:\s*'record_id'/)
  })
})
