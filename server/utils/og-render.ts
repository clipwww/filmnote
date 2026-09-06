import type { CmapResult } from './og-cmap'
import { Buffer } from 'node:buffer'
import { Resvg } from '@resvg/resvg-js'
import satori from 'satori'
import { OG_HEIGHT, OG_WIDTH } from './og-card'
import { parseCmap } from './og-cmap'

/**
 * OG 圖的算圖層：載入字型、算 cmap、把版面轉成 PNG。
 *
 * ── ⚠️ 兩個部署期才會炸的約束（`DS §2.7`）────────────────────────────────
 *
 * ① **這條路由必須跑 Node runtime，不能是 Edge。**
 *    字型是 6.76 MB × 2 個字重。Vercel Node serverless 是 250 MB 未壓縮，放得下；
 *    **Edge 是 1 MB（Hobby）／4 MB（Pro），放不下。**
 *    本專案沒有設 `vercel-edge` preset（踩雷 #11 也明說不要設），所以預設就是
 *    Node——但這件事**在本機完全測不出來**，錯了的症狀是部署失敗或函式起不來，
 *    不是渲染出醜圖。改 `nuxt.config.ts` 的 preset 之前請先回來讀這一段。
 *
 * ② **satori 不吃 woff2。** 實測（2026-09-06）：
 *      `Unsupported OpenType signature wOF2`
 *    design 用「Google Fonts 對非瀏覽器 UA 直接回 .ttf」繞開這題，並誠實標記
 *    「那是繞開不是解決」。現在有答案了：**那不是繞開，那是唯一的路。**
 *    字型必須是 .ttf/.otf。
 *
 * ③ **`@resvg/resvg-js` 必須在 `dependencies`。** 它是原生模組，打包器一定
 *    外部化它。放進 devDependencies 的症狀是本機全綠、部署後端點 500。
 *
 * ── 字型為什麼進版控 ──────────────────────────────────────────────────────
 * Google Fonts 的 URL 帶版本雜湊（`…/v39/-nFuOG82…ttf`），改版就換 URL。
 * 建置時下載等於讓每一次建置都依賴一個會腐爛的網址，而失敗的樣子是「OG 圖
 * 突然全部變成豆腐格」。14 MB 的版控成本換一個確定性的建置，值得。
 */

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
 * 載入字型並算一次 cmap，之後常駐記憶體。
 *
 * 算 cmap 要走完 20,745 個碼位，不該每次請求都做；而 serverless 實例是溫的，
 * 第二次之後就免費。**刻意不預先在模組頂層執行**——那會讓每一支冷啟動的函式
 * 都付這個代價，即使它根本不畫 OG 圖。
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
 * 版面樹 → PNG。
 *
 * ★ `@resvg/resvg-js` 是**原生模組**（napi）。打包器不會把 .node 內聯，它一定是
 *   外部化的 ⇒ **必須放在 `dependencies` 而不是 `devDependencies`**，否則
 *   本機一切正常、**部署後 OG 端點 500**，而那要到部署才會發現。
 *   實測見交接筆記第 7 節（`.output/server/package.json` 的 dependencies 清單）。
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
