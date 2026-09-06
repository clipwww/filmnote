/**
 * 把六種 OG 版面算成真的 PNG 放進 scratch 目錄，用眼睛看。
 *
 *   pnpm tsx scripts/og-preview.ts [輸出目錄]
 *
 * OG 圖是「要看到才知道對不對」的東西——版面歪了、字級太小、色階分不開，
 * 這些單元測試一條都抓不到。所以看它一眼的成本應該接近零。
 *
 * ⚠️ 需要 satori 與 @resvg/resvg-js。它們還沒進 package.json（共用檔需主 session
 *   核可），沒裝的話這支會明確告訴你缺什麼，而不是丟一個模組解析錯誤。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { clampHero, FALLBACK_HERO, OG_HEIGHT, OG_WIDTH, profileCard, recordCard } from '../server/utils/og-card'

const outDir = process.argv[2] ?? '.data/og-preview'
mkdirSync(outDir, { recursive: true })

let satori: (el: unknown, o: unknown) => Promise<string>
let Resvg: new (svg: string, o?: unknown) => { render: () => { asPng: () => Buffer } }
// specifier 經過變數：這兩個套件還沒進 package.json，字面 specifier 會讓
// `pnpm typecheck` 直接紅（TS2307），而那會擋住另外兩個 session。
const satoriId = 'satori'
const resvgId = '@resvg/resvg-js'
try {
  satori = (await import(satoriId)).default as never
  Resvg = (await import(resvgId)).Resvg as never
}
catch {
  console.error('缺少 satori 或 @resvg/resvg-js。請先加進 package.json：')
  console.error('  pnpm add satori @resvg/resvg-js')
  process.exit(1)
}

const fonts = [
  { name: 'Noto Sans TC', data: readFileSync('server/assets/fonts/NotoSansTC-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Noto Sans TC', data: readFileSync('server/assets/fonts/NotoSansTC-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
]
const ATTR = '片名資料：文化部影視及流行音樂產業局 · TMDB'

async function shot(name: string, el: unknown) {
  const svg = await satori(el, { width: OG_WIDTH, height: OG_HEIGHT, fonts })
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng()
  const file = join(outDir, `${name}.png`)
  writeFileSync(file, png)
  console.log(`${file}  ${png.length} bytes`)
}

await shot('01-record', recordCard({
  hero: clampHero('劇場版 吉伊卡哇 人魚島的秘密'),
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
  hero: clampHero('劇場版 藍色監獄 -EPISODE 凪- 特別加長紀念版 完全新作 導演剪輯'),
  kicker: '2025 / 12 / 31（三）23:55',
  venue: '國賓長春廣場影城（1廳）',
  meta: 'IMAX　4張',
  attribution: ATTR,
}))
