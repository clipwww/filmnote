/**
 * 把六種 OG 版面算成真的 PNG 放進 scratch 目錄，用眼睛看。
 *
 *   pnpm tsx scripts/og-preview.ts [輸出目錄]
 *
 * OG 圖是「要看到才知道對不對」的東西——版面歪了、字級太小、色階分不開，
 * 這些單元測試一條都抓不到。所以看它一眼的成本應該接近零。
 *
 * satori 與 @resvg/resvg-js 已在 dependencies（a2a18f0）。
 */
import { Resvg } from '@resvg/resvg-js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import satori from 'satori'
import { FALLBACK_HERO, OG_HEIGHT, OG_WIDTH, profileCard, recordCard, safeHero } from '../server/utils/og-card'
import { parseCmap } from '../server/utils/og-cmap'

const outDir = process.argv[2] ?? '.data/og-preview'
mkdirSync(outDir, { recursive: true })

const fonts = [
  { name: 'Noto Sans TC', data: readFileSync('server/assets/fonts/NotoSansTC-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Noto Sans TC', data: readFileSync('server/assets/fonts/NotoSansTC-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
]
const ATTR = '片名資料：文化部影視及流行音樂產業局 · TMDB'
// ★ 預覽必須走**跟正式路由一樣**的缺字判斷，否則預覽圖會比線上好看。
//   第一版沒有這一段，於是預覽圖上出現了一個豆腐格而正式路由不會。
const { codepoints } = parseCmap(new Uint8Array(fonts[0]!.data))

async function shot(name: string, el: unknown) {
  const svg = await satori(el, { width: OG_WIDTH, height: OG_HEIGHT, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng()
  const file = join(outDir, `${name}.png`)
  writeFileSync(file, png)
  console.log(`${file}  ${png.length} bytes`)
}

await shot('01-record', recordCard({
  hero: safeHero('劇場版 吉伊卡哇 人魚島的秘密', codepoints),
  kicker: '2026 / 07 / 26（六）16:00',
  venue: '林口MITSUI OUTLET PARK威秀影城（7廳）',
  meta: '數位　2張',
  attribution: ATTR,
}))

await shot('02-profile', profileCard({
  username: 'clipwww',
  count: 169,
  years: [2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]
    .map((year, i) => ({ year, n: [3, 8, 12, 5, 20, 17, 21, 11, 9, 14, 21, 18, 10][i]! })),
  attribution: ATTR,
}))

// 缺字降級態。★ 換掉的是整行，不是只拿掉缺的那個字
await shot('06-fallback', recordCard({
  hero: FALLBACK_HERO,
  kicker: '2024 / 03 / 01（五）19:30',
  venue: '國賓影城@台北長春廣場（3廳）',
  meta: '數位　1張',
  attribution: ATTR,
}))

// 極長片名，確認硬截斷有效
await shot('07-longtitle', recordCard({
  // 這一部含「凪」（字型沒有）⇒ 應該整行降級，不是畫出方框
  hero: safeHero('劇場版 藍色監獄 -EPISODE 凪- 特別加長紀念版 完全新作 導演剪輯', codepoints),
  kicker: '2025 / 12 / 31（三）23:55',
  venue: '國賓長春廣場影城（1廳）',
  meta: 'IMAX　4張',
  attribution: ATTR,
}))
