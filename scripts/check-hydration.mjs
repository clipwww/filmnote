import process from 'node:process'

// SSR 頁的**瀏覽器端健康檢查**：hydration mismatch ＋ 任何 console error／pageerror。
// **亮暗兩種偏好都要各重新載入一次。**
//
//   PLAYWRIGHT_CORE=… node scripts/check-hydration.mjs /u/clipwww /film/xxx
//
// ── 為什麼需要這一支 ──────────────────────────────────────────────────────
// 踩雷 #88：在 JS 裡用 `useColorMode()` 挑顏色再寫成 inline style，SSR 算出來的
// 是一種模式、hydrate 時是另一種 ⇒ `Hydration completed but contains mismatches`，
// 而**畫面看起來完全正常**。`/app` 是 `ssr: false` 所以永遠看不到，同一個元件
// 搬到 `/u/` 就會炸——2026-09-06 把 DistributionBars 搬過去時實測就是這樣。
//
// ⚠️ **一定要兩種偏好都跑。** 實測那次的病灶只有 `preference=dark` 會出現
//    35 條警告，`preference=light` 是 0 條——只驗亮色會得到一個乾淨的假象。
//
// ── ★★ 為什麼連「一般的 console error」也要當成失敗 ──────────────────────
// 2026-09-06 實測：把一個匯出的函式從 `app/composables/` 搬到 `app/utils/`
// 之後，dev server 的模組圖沒有跟著更新，瀏覽器收到
// `SyntaxError: The requested module '…/useUserSpend.ts' does not provide an
// export named 'spendText'` ⇒ **`/u/` 整頁一條 band 都畫不出來**。
// 而同一時間 `pnpm typecheck` / `lint` / `test` / `verify:all` **四個全綠**：
//   · typecheck 讀的是 Nuxt 產生的 imports.d.ts，那份已經是對的
//   · verify:all 的 `u/html-has-content` 檢查的是 **SSR 的 HTML**，
//     而 SSR 本來就正常——爆掉的是 client 端的 hydration
// ⇒ 「這一頁在真的瀏覽器裡跑不跑得起來」沒有任何自動檢查在守。這一支就是。
//
// ⚠️ playwright-core 刻意不是專案相依（只給人工驗收用），用 PLAYWRIGHT_CORE 指路。
// ⚠️ 絕對不要 browser.close()——那會關掉使用者的瀏覽器。斷開用 process.exit(0)。

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')
const SITE = process.env.SITE ?? 'http://localhost:3000'
const paths = process.argv.slice(2)
if (!paths.length) {
  console.error('用法：node scripts/check-hydration.mjs /u/someone [/film/slug …]')
  process.exit(2)
}

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = await browser.contexts()[0].newPage()
const logs = []
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning')
    logs.push({ level: m.type(), text: m.text() })
})
page.on('pageerror', e => logs.push({ level: 'pageerror', text: String(e) }))

let bad = 0
try {
  for (const path of paths) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle', timeout: 45000 })
    await page.waitForTimeout(1200)

    for (const pref of ['dark', 'light']) {
      // 走真正的切換路徑，不要自己 classList.add('dark')——color-mode 會改回去
      await page.evaluate((v) => {
        window.useNuxtApp().$colorMode.preference = v
      }, pref)
      await page.waitForTimeout(500)
      logs.length = 0
      // ★ 一定要**整頁重新載入**：mismatch 只在 SSR → hydrate 那一刻發生
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(1800)

      const hydration = logs.filter(l => /Hydration|mismatch/i.test(l.text))
      // ★ 任何 error／pageerror 都算失敗，不只 hydration —— 見檔頭。
      const errors = logs.filter(l => l.level === 'error' || l.level === 'pageerror')
      const hits = [...new Set([...hydration, ...errors])]
      const mark = hits.length ? '❌' : '✅'
      console.log(`${mark} ${path}  preference=${pref}  hydration ${hydration.length} 條／console error ${errors.length} 條`)
      for (const h of hits.slice(0, 4))
        console.log(`     ↳ [${h.level}] ${h.text.replace(/\s+/g, ' ').slice(0, 170)}`)
      if (hits.length)
        bad++
    }
  }
  await page.evaluate(() => {
    window.useNuxtApp().$colorMode.preference = 'system'
  })
}
finally {
  await page.close()
}
console.log(bad ? `\n❌ ${bad} 組有 hydration mismatch 或 console 錯誤` : '\n✅ 全部乾淨')
process.exit(bad ? 1 : 0)
