import process from 'node:process'

// 視覺驗收：CDP 附著到使用者自己開的 Chrome（已登入），逐頁量三件事。
//
//   node scripts/screenshot-pages.mjs '名稱|/路徑|寬度' ...
//   node scripts/screenshot-pages.mjs 'app|/app|1280' 'app-375|/app|375'
//
// 量的是這個專案實測最會抓到問題的三個查詢（來自 frontend 第二棒的交接筆記）：
// 橫向溢出、暗色漏純白、以及頁面高度——這個 repo 有過 17,481px 與 22,635px
// 兩次紀錄，都是同一個錯誤換一頁再犯。
//
// ⚠️ 絕對不要呼叫 browser.close()——那會把 David 的瀏覽器關掉。斷開用 process.exit(0)。
// Google 會擋 Playwright 啟動的 Chrome（navigator.webdriver=true），但不擋 CDP 附著。

// playwright-core 刻意不是專案相依——它只給人工驗收用，不該進 CI 也不該
// 讓每個 clone 的人下載一份瀏覽器。用 PLAYWRIGHT_CORE 指到你自己那份。
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core')

const OUT = process.env.SHOT_DIR ?? '/tmp/filmnote-shots'
const targets = process.argv.slice(2)

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = await ctx.newPage()

for (const spec of targets) {
  const [name, path, width] = spec.split('|')
  await page.setViewportSize({ width: Number(width || 1280), height: 900 })
  await page.goto(`http://localhost:3000${path}`, { waitUntil: 'networkidle', timeout: 45000 })
  await page.waitForTimeout(1200)

  const box = await page.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    // 掃有沒有純白殘留。
    //
    // ⚠️ **範圍限縮在 `#__nuxt`，不要掃整份文件**（踩雷 #243）。
    //    2026-09-08 實測 `/app` 暗色：掃全文件得到 3 個純白元素，祖鏈全部是
    //    `body > div#vue-tracer-overlay > …`——那是 Nuxt DevTools 在 dev 注入的，
    //    而且全部不可見（`opacity:0`、0×0）。`#__nuxt` 之內是 **0 個**。
    //    掃全文件的話每一次量測都會帶著三個永遠修不掉的紅字，而一份永遠有紅字的
    //    報告等於沒有報告：真的漏純白時，沒有人會注意到數字從 3 變成 4。
    white: [...(document.querySelector('#__nuxt')?.querySelectorAll('*') ?? [])].filter((el) => {
      const bg = getComputedStyle(el).backgroundColor
      return bg === 'rgb(255, 255, 255)'
    }).length,
    posters: document.querySelectorAll('img[src*="image.tmdb.org"]').length,
    // ★ 主題的證據，不是「我以為我切到暗色了」。
    //   2026-09-06 實測（records）：David 的瀏覽器裡留著 nuxt-color-mode 偏好，
    //   而那個偏好會**蓋掉** Emulation 的 prefers-color-scheme 模擬——量到
    //   prefersDark=true 而 documentElement.className 其實是 light，
    //   然後所有檢查照樣全綠。⇒ 任何一份提到亮／暗的量測都要附這兩個值。
    htmlClass: document.documentElement.className,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }))

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  console.log(`${name.padEnd(22)} 高=${String(box.scrollH).padStart(6)}px  橫向溢出=${box.scrollW > box.clientW ? '有 ⚠️' : '無'}  純白元素=${box.white}  海報=${box.posters}  html.class="${box.htmlClass}"  body=${box.bodyBg}`)
}

await page.close()
process.exit(0)
