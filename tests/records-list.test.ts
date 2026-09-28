import type { ListableRecord } from '../app/utils/record-list'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { RECORD_LIST_ALL as ALL, RECORD_LIST_PER_PAGE as PER_PAGE, useRecordListState } from '../app/utils/record-list'

/**
 * `/app/records` 的篩選、關鍵字搜尋與頁碼分頁，打的是 `useRecordListState` 的介面：
 * 改輸入 → 看 `filtered`／`visible`／`page`／選項。
 *
 * ── 為什麼需要這一支 ────────────────────────────────────────────────────
 * 這些**只有在瀏覽器裡才會執行**：四關對「第 2 頁切到的是不是第 25 筆」「存檔後有沒有被踢回
 * 第 1 頁」一律全綠 ⇒ 能靜態量的就靜態量，把 Chrome 留給真的只能點的（`#236`、`#332`）。
 * ⚠️ watch 是 flush 'pre'（非同步）：每次改輸入都要 `await nextTick()`，否則「不回第 1 頁」會假綠。
 */

function rec(over: Partial<ListableRecord> = {}): ListableRecord {
  return {
    year: '2026',
    film: { titleZh: '沙丘', titleOriginal: 'Dune: Part Two' },
    venueName: '威秀影城 信義',
    hallLabel: 'IMAX 廳',
    formatLabel: 'IMAX',
    memo: '座位有點前面',
    cost: 390,
    ...over,
  }
}

function setup(rows: ListableRecord[]) {
  const records = ref(rows)
  const s = effectScope().run(() => useRecordListState(records))!
  return { records, s }
}

/** 只看搜尋：一筆紀錄比不比得到 `query`。 */
async function hits(r: ListableRecord, query: string) {
  const { s } = setup([r])
  s.q.value = query
  await nextTick()
  return s.filtered.value.length === 1
}

/** 預設 174 筆（David 現有筆數），`memo` 當編號好驗「切到的是哪一段」。 */
function many(n = 174) {
  return Array.from({ length: n }, (_, i) => rec({ memo: `r${i}` }))
}

describe('關鍵字搜尋', () => {
  it('空字串放行全部（清空搜尋 = 還原）', async () => {
    expect(await hits(rec(), '')).toBe(true)
    expect(await hits(rec(), '   ')).toBe(true)
  })

  it('四個欄位各自都比得到', async () => {
    expect(await hits(rec(), '沙丘')).toBe(true) // 作品（中文）
    expect(await hits(rec(), '威秀')).toBe(true) // 影城
    expect(await hits(rec({ formatLabel: null }), 'IMAX')).toBe(true) // 影廳（版本欄不參與搜尋）
    expect(await hits(rec(), '座位')).toBe(true) // 備註
  })

  it('原文片名不分大小寫（`titleOriginal` 是拉丁字）', async () => {
    expect(await hits(rec(), 'dune')).toBe(true)
    expect(await hits(rec(), 'DUNE')).toBe(true)
  })

  it('沒比到就是沒比到', async () => {
    expect(await hits(rec(), '奧本海默')).toBe(false)
  })

  it('★ 不跨欄命中：逐欄比對而不是把欄位串起來比一次', async () => {
    // 「信義座位」在「影城結尾 + 備註開頭」之間是連著的，串起來比會假命中。
    expect(await hits(rec(), '信義座位')).toBe(false)
    expect(await hits(rec(), '廳座位')).toBe(false)
  })

  it('欄位是 null / undefined 不會炸，也不會假命中', async () => {
    expect(await hits({ year: '2026', film: null, venueName: null, hallLabel: null, memo: null }, '沙丘')).toBe(false)
    expect(await hits({ year: '2026' }, '沙丘')).toBe(false)
    expect(await hits({ year: '2026', film: { titleZh: null, titleOriginal: null } }, '沙丘')).toBe(false)
  })

  it('★ 不含日期（David 2026-09-25 裁決：不用比對日期）', async () => {
    // 與時區無關（比的是欄位字串，不是 `watchedOn`）⇒ 不需要跑第二個 TZ。
    expect(await hits(rec({ year: '2024', memo: '看完去吃飯' }), '2024')).toBe(false)
    // 但片名裡的數字照樣比得到——「不含日期」講的是不去翻 `watchedOn`。
    expect(await hits(rec({ film: { titleZh: '1917', titleOriginal: '1917' } }), '1917')).toBe(true)
  })

  it('搜尋與篩選器是疊加不是取代', async () => {
    const { s } = setup([rec({ memo: '甲' }), rec({ memo: '甲', cost: null }), rec({ memo: '乙', cost: null })])
    s.q.value = '甲'
    s.cost.value = 'none'
    await nextTick()
    expect(s.filtered.value).toHaveLength(1)
    expect(s.filtered.value[0]!.cost).toBeNull()
  })
})

describe('篩選選項', () => {
  const rows = [
    rec({ year: '2026', venueName: '國賓影城 長春', formatLabel: '數位' }),
    rec({ year: '2025', venueName: '威秀影城 信義', formatLabel: 'IMAX' }),
    rec({ year: '2025', venueName: '秀泰影城 台北車站', formatLabel: '數位' }),
    rec({ year: '2024', venueName: '威秀影城 信義', formatLabel: '4DX' }),
  ] // 已按 watched_on 新到舊，同 useMyRecords

  it('★ 年份預設「所有年份」，選項新到舊（不走升冪的 sort）', () => {
    const { s } = setup(rows)
    expect(s.year.value).toBe(ALL)
    expect(s.yearOptions.value.map(o => o.value)).toEqual([ALL, '2026', '2025', '2024'])
    expect(s.yearOptions.value[0]!.label).toBe('所有年份（4）')
  })

  it('影城／版本升冪、含「所有…」，預設從全期長出來（David 2026-09-25：不限制選項）', () => {
    const { s } = setup(rows)
    expect(s.venueOptions.value.map(o => o.value)).toEqual([ALL, '國賓影城 長春', '威秀影城 信義', '秀泰影城 台北車站'])
    expect(s.formatOptions.value.map(o => o.value)).toEqual([ALL, '4DX', 'IMAX', '數位'])
  })

  it('選了某一年，影城／版本收斂回那一年', async () => {
    const { s } = setup(rows)
    s.year.value = '2025'
    await nextTick()
    expect(s.venueOptions.value.map(o => o.value)).toEqual([ALL, '威秀影城 信義', '秀泰影城 台北車站'])
    expect(s.formatOptions.value.map(o => o.value)).toEqual([ALL, 'IMAX', '數位'])
  })

  it('★ 換年份：還提供的影城／版本留著，不提供的才歸回全部，票價不動', async () => {
    const { s } = setup(rows)
    s.venue.value = '威秀影城 信義'
    s.format.value = '數位'
    s.cost.value = 'has'
    await nextTick()
    s.year.value = '2024' // 2024 有威秀，但沒有「數位」
    await nextTick()
    expect(s.venue.value).toBe('威秀影城 信義')
    expect(s.format.value).toBe(ALL)
    expect(s.cost.value).toBe('has')
  })

  it('clearFilters 五個一起歸位', async () => {
    const { s } = setup(rows)
    s.year.value = '2025'
    s.q.value = 'x'
    s.cost.value = 'none'
    await nextTick()
    expect(s.hasNarrowed.value).toBe(true)
    s.clearFilters()
    await nextTick()
    expect([s.year.value, s.venue.value, s.format.value, s.cost.value, s.q.value]).toEqual([ALL, ALL, ALL, ALL, ''])
    expect(s.hasNarrowed.value).toBe(false)
  })
})

describe('頁碼分頁', () => {
  it('★ 驗的是內容不是長度（#234：JS 陣列會自己長）', async () => {
    const all = many()
    const { s } = setup(all)
    s.page.value = 2
    await nextTick()
    // 比 memo 不比物件：ref() 包過之後拿到的是 reactive proxy，toBe 會因 identity 不同而紅。
    expect(s.visible.value[0]!.memo).toBe(all[PER_PAGE]!.memo)
    expect(s.visible.value.at(-1)!.memo).toBe(all[PER_PAGE * 2 - 1]!.memo)
    s.page.value = 3
    await nextTick()
    expect(s.visible.value[0]!.memo).toBe(all[PER_PAGE * 2]!.memo)
  })

  it('每一頁都接得上，而且合起來剛好是全集（沒有重疊、沒有漏）', async () => {
    const all = many()
    const { s } = setup(all)
    const rejoined: ListableRecord[] = []
    for (let p = 1; p <= s.pageCount.value; p++) {
      s.page.value = p
      await nextTick()
      rejoined.push(...s.visible.value)
    }
    expect(rejoined.map(r => r.memo)).toEqual(all.map(r => r.memo))
  })

  it('最後一頁不補滿：174 = 7 × 24 + 6', async () => {
    const { s } = setup(many())
    expect(s.pageCount.value).toBe(8)
    s.page.value = 8
    await nextTick()
    expect(s.visible.value.map(r => r.memo)).toEqual(['r168', 'r169', 'r170', 'r171', 'r172', 'r173'])
  })

  it('空集合只有 1 頁、回空陣列（不是 undefined、不會炸）', () => {
    const { s } = setup([])
    expect(s.pageCount.value).toBe(1)
    expect(s.visible.value).toEqual([])
  })
})

/**
 * ★ 這一段釘的是「回第 1 頁的訊號來源」。
 *
 * `refresh()`（存檔、刪除之後都會呼叫）會換掉 `records`／`filtered` 的 identity。
 * 若監看 `filtered` ⇒ **每一次存檔都把使用者踢回第 1 頁**，而那正是 David 抱怨的
 * 「返回上一頁狀態都被清掉」的同一個病。四關對這件事一律全綠，只有真的存一筆才看得到。
 */
describe('頁碼的重設與夾回', () => {
  // 值要選得讓集合仍有好幾頁，才分得出「回第 1 頁」與「被夾回最後一頁」
  const inputs = { year: '2026', venue: '威秀影城 信義', format: 'IMAX', cost: 'has', q: 'r1' } as const

  it.each(Object.keys(inputs) as (keyof typeof inputs)[])('換 %s ⇒ 回第 1 頁', async (key) => {
    const { s } = setup(many())
    s.page.value = 3
    await nextTick()
    s[key].value = inputs[key]
    await nextTick()
    expect(s.pageCount.value).toBeGreaterThan(1)
    expect(s.page.value).toBe(1)
  })

  it('★ refresh()（records 換成內容相同的新陣列）不回第 1 頁', async () => {
    const { records, s } = setup(many())
    s.page.value = 3
    await nextTick()
    records.value = records.value.map(r => ({ ...r }))
    await nextTick()
    expect(s.page.value).toBe(3)
    expect(s.visible.value[0]!.memo).toBe(`r${PER_PAGE * 2}`)
  })

  it('★ 刪掉最後一頁唯一那筆 ⇒ 夾回新的最後一頁，不是跳回第 1 頁', async () => {
    const { records, s } = setup(many(PER_PAGE * 7 + 1)) // 8 頁，第 8 頁只有 1 筆
    s.page.value = 8
    await nextTick()
    records.value = records.value.slice(0, -1)
    await nextTick()
    expect(s.pageCount.value).toBe(7)
    expect(s.page.value).toBe(7)
    expect(s.visible.value.at(-1)!.memo).toBe(`r${PER_PAGE * 7 - 1}`)
  })
})

/**
 * 頁面接線：規則全在 composable 裡，頁面若自己再加一條 watch 就會繞過上面所有測試。
 */
describe('/app/records 的狀態接線', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../app/pages/app/records/index.vue', import.meta.url)),
    'utf8',
  )
  // 先剝掉註解：頁面裡那則「不要寫 page.value = 1」的警告本身就會咬到下面的斷言（§7.6）。
  const script = (parse(src, { filename: 'index.vue' }).descriptor.scriptSetup?.content ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

  it('篩選／頁碼狀態來自 useRecordListState(records)', () => {
    expect(script).toMatch(/\}\s*=\s*useRecordListState\(records\)/)
  })

  it('★ 頁面自己不重設頁碼、不監看 filtered', () => {
    expect(script).not.toMatch(/page\.value\s*=/)
    expect(script).not.toMatch(/watch\(\s*filtered\b/)
    expect(script).not.toMatch(/watch\(\s*\[[^\]]*\bfiltered\b/)
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

// 改作品（David 第 2 條）的寫入路徑：介面測試在 `tests/record-write.test.ts`。
