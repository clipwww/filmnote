import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseLegalMarkdown } from '../app/utils/legal-markdown'

/**
 * 守的坑：**受理窗口的電子郵件不可以被加回來**（2026-09-07 David 裁定）。
 *
 * 為什麼需要一條測試，而不是交接筆記裡的一行 grep：
 * 這一項與**兩份已定案的規格**正面衝突（`SCREENS §15.2`、`BUILD_PLAN §6.1 ③`
 * 原本都明文要求公告一個 `copyright@` 信箱）。規格已請協調者改寫，但下一棒照著
 * 舊印象施工把信箱加回來，是這個 repo 反覆發生過的事——而 shell 一行 grep
 * 「只有讀過那份交接筆記的人知道要跑，session 一換就等於沒有」
 *（`scripts/verify-all.ts` 檔頭）。
 *
 * 裁決的理由（完整版在 `app/pages/legal/copyright.vue` 檔頭 ①）：專案沒有任何
 * 寄信能力，而站上原本公告的網域實測是 NXDOMAIN ⇒ 公告一個沒人收得到的信箱，
 * 等於把做不到的承諾寫在法遵頁的入口上。
 *
 * ⚠️ 這裡刻意**不用「檔案裡沒有 @ 字元」**這種寫法：`.vue` 裡的 `@click`、
 * `@submit` 會讓它永遠紅，而 `/legal/dmca` 的信箱欄位 placeholder
 *（`legal@example.com`）是表單提示、不是受理窗口，必須留著。所以斷言的形狀是
 * 「頁面上出現的電子郵件位址，只允許那一個 placeholder」——它同時就是這條
 * 正則的**正向對照**：`legal@example.com` 抓得到，才證明抓不到別的不是因為
 * 正則壞了（`verify-all.ts` 規矩③：凡是「應該看不到」的斷言都要有「應該看得到」的對照）。
 */

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const read = (p: string) => readFileSync(root(p), 'utf8')

/** 電子郵件位址的形狀。至少一個點的網域，避免把 `@click` 之類的指令當成位址。 */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const emailsIn = (src: string) => [...new Set(src.match(EMAIL_RE) ?? [])].sort()

const LEGAL_MD = ['copyright-policy.md', 'privacy.md', 'terms.md'] as const

describe('受理窗口只有 /legal/dmca 那張表', () => {
  it('正向對照：這條正則抓得到 /legal/dmca 表單裡的 placeholder', () => {
    // 這一條紅了代表 EMAIL_RE 或檔案路徑壞了 ⇒ 下面每一條「找不到位址」都不算數。
    // 也代表有人把信箱欄位的 placeholder 刪了——那個要留著（它是表單提示，不是窗口）。
    expect(emailsIn(read('app/pages/legal/dmca.vue'))).toEqual(['legal@example.com'])
  })

  it('/legal/copyright 上沒有任何電子郵件位址', () => {
    expect(emailsIn(read('app/pages/legal/copyright.vue'))).toEqual([])
  })

  it('兩頁都沒有 mailto: 連結', () => {
    for (const p of ['app/pages/legal/copyright.vue', 'app/pages/legal/dmca.vue'])
      expect(read(p), p).not.toContain('mailto:')
  })

  it('速率限制的錯誤訊息不把人導去別的管道，也不寫死次數', () => {
    // 舊文案是「請稍後再試，或直接寄到 <信箱>」。信箱撤掉之後這張表是唯一的窗口，
    // 429 時再叫人改用信箱等於把法定窗口關掉；而寫死「一小時最多 N 件」也是錯的
    // （rate-limit 是行程內記憶體，Vercel 上每個實例各一份）。
    const dmca = read('app/pages/legal/dmca.vue')
    const line = dmca.split('\n').find(l => l.includes('submitError.value = \'短時間內送出太多次了'))
    expect(line, '找不到 429 的文案，這條斷言已經失去目標').toBeTruthy()
    expect(line).not.toMatch(/寄到|信箱|一小時|每小時|\d+\s*件/)
  })

  it('三份條款正文一個電子郵件位址都沒有寫死', () => {
    // 條款一旦被同意過就依 0007 的 legal_doc_immutable 改不動了，
    // 把會變的東西寫進去等於鎖死。窗口寫在頁面上，不寫在條款裡。
    for (const f of LEGAL_MD)
      expect(emailsIn(read(`docs/legal/${f}`)), f).toEqual([])
  })

  it('條款正文不再指向一個已經不存在的信箱公告', () => {
    const dead = ['公告之著作權聯繫信箱', '公告的著作權聯繫窗口', '著作權政策」公告的窗口']
    for (const f of LEGAL_MD) {
      const src = read(`docs/legal/${f}`)
      for (const phrase of dead)
        expect(src, `${f} / ${phrase}`).not.toContain(phrase)
    }
  })

  it('著作權政策 §3.1 仍然公告得出一個窗口，而且那個窗口是表單', () => {
    // 這一條守的是相反方向的失敗：不要為了「拿掉信箱」把整節刪成空的。
    // §90-4 第 3 款要的是「公告接收通知文件之聯繫窗口資訊」——窗口不見了比信箱還糟。
    const doc = parseLegalMarkdown(read('docs/legal/copyright-policy.md'))
    const start = doc.blocks.findIndex(b => b.type === 'heading' && b.id === 's3-1')
    expect(start, '§3.1 聯繫窗口這一節不見了').toBeGreaterThanOrEqual(0)
    const end = doc.blocks.findIndex((b, i) => i > start && b.type === 'heading')
    const section = doc.blocks.slice(start + 1, end < 0 ? undefined : end)

    const inlines = section.flatMap(b => b.type === 'paragraph' ? b.inlines : b.type === 'list' ? b.items.flat() : [])
    const text = inlines.map(n => n.value).join('')
    expect(inlines.filter(n => n.type === 'code').map(n => n.value)).toContain('/legal/dmca')
    expect(text).not.toContain('信箱')
    // 「只以表單受理」要**明寫**：一來 §90-4 第 3 款要的是公告「窗口資訊」，
    // 二來這句話與「多列一個電子郵件管道」互斥 ⇒ 有人把信箱加回來時這一條會紅。
    expect(text).toContain('不提供電子郵件受理管道')
  })
})

describe('信箱的設定值也一起死透（畫面上沒有 ≠ 沒有送出去）', () => {
  it('nuxt.config.ts 不再有 copyrightContactEmail', () => {
    const src = read('nuxt.config.ts')
    // 正向對照：runtimeConfig.public 這一區還在，才證明這條讀對了檔案。
    expect(src).toContain('siteUrl:')
    expect(src).not.toMatch(/copyrightContactEmail\s*:/)
    expect(src).not.toMatch(/process\.env\.COPYRIGHT_CONTACT_EMAIL/)
  })

  it('.env.example 沒有作用中的 COPYRIGHT_CONTACT_EMAIL 那一行', () => {
    const src = read('.env.example')
    expect(src).toMatch(/^NUXT_PUBLIC_SITE_URL=/m) // 正向對照
    expect(src).not.toMatch(/^COPYRIGHT_CONTACT_EMAIL=/m)
  })
})
