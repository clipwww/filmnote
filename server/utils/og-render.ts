import type { CmapResult } from './og-cmap'
import { Buffer } from 'node:buffer'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import { OG_HEIGHT, OG_WIDTH } from './og-card'
import { parseCmap } from './og-cmap'

/**
 * OG 圖的算圖層：載入字型、算 cmap、把版面轉成 PNG。三個部署期才會炸的約束（`DS §2.7`）：
 * ① **必須跑 Node runtime**：字型 6.76 MB × 2 個字重，Node serverless 250 MB 放得下，
 *    Edge 只有 1 MB（Hobby）／4 MB（Pro）。本機完全測不出來，錯了是函式起不來。
 * ② **satori 不吃 woff2**（2026-09-06 實測 `Unsupported OpenType signature wOF2`）⇒ 只能 .ttf/.otf。
 * ③ **`@resvg/resvg-js` 必須在 `dependencies`**（原生模組，見 `renderPng`）。
 */
// 字型進版控而不是建置時下載：Google Fonts 的 URL 帶版本雜湊，改版就換網址，
// 壞掉的樣子是「OG 圖突然全部變成豆腐格」。14 MB 換一個確定性的建置。

/** 版面用得到的字重。mockup 有 400/600/700，600 對到 700。 */
const FONT_FILES = [
  { file: 'NotoSansTC-Regular.ttf', weight: 400 as const },
  { file: 'NotoSansTC-Bold.ttf', weight: 700 as const },
]

export interface OgFonts {
  fonts: { name: string, data: Buffer, weight: 400 | 700, style: 'normal' }[]
  cmap: CmapResult
}

let cached: OgFonts | null = null

/**
 * 載入字型並算一次 cmap，之後常駐記憶體（算一次要走完 20,745 個碼位）。
 * ★ 刻意不在模組頂層先做：那會讓每一支冷啟動的函式都付這個代價，即使它不畫 OG 圖。
 */
export async function loadOgFonts(): Promise<OgFonts> {
  if (cached)
    return cached

  const storage = useStorage('assets:server')
  const fonts: OgFonts['fonts'] = []
  for (const f of FONT_FILES) {
    const raw = await storage.getItemRaw<Uint8Array>(`fonts/${f.file}`)
    if (!raw)
      throw createError({ statusCode: 500, statusMessage: `找不到字型 ${f.file}` })
    fonts.push({ name: 'Noto Sans TC', data: Buffer.from(raw), weight: f.weight, style: 'normal' })
  }

  // cmap 只需要算一次，兩個字重的字符集相同（同一套 Noto）。
  cached = { fonts, cmap: parseCmap(new Uint8Array(fonts[0]!.data)) }
  return cached
}

/**
 * 版面樹 → PNG。★ `@resvg/resvg-js` 是原生模組（napi），打包器一定外部化它 ⇒
 * **必須在 `dependencies`**，否則本機全綠而部署後 OG 端點 500。
 * 驗法是看產物：`.output/server/package.json` 的 dependencies 清單。
 */
export async function renderPng(element: unknown, fonts: OgFonts['fonts']): Promise<Buffer> {
  const svg = await satori(element as Parameters<typeof satori>[0], {
    width: OG_WIDTH,
    height: OG_HEIGHT,
    fonts,
  })
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng())
}

export const OG_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
