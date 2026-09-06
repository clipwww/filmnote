import type { CmapResult } from './og-cmap'
import { Buffer } from 'node:buffer'
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
 * ★ `satori` 與 `@resvg/resvg-js` 以**執行期動態匯入**取得，而且 specifier
 *   刻意經過一個變數。原因是這兩個相依還沒進 `package.json`（共用檔，需主
 *   session 核可），而靜態 import 會讓**整個專案**在套件裝好之前建置失敗——
 *   那會擋住另外兩個 session 的工作，代價遠大於晚一輪落地。
 *
 *   ⚠️ 這是暫時的形狀。套件一進 `package.json` 就應該改回一般的靜態 import：
 *   動態 + 非字面 specifier 會讓打包器放棄靜態分析，也拿不到型別。
 *   套件不在時這裡回 503 並說明原因，而不是一個沒有上下文的模組解析錯誤。
 */
export async function renderPng(element: unknown, fonts: OgFonts['fonts']): Promise<Buffer> {
  const satoriId = 'satori'
  const resvgId = '@resvg/resvg-js'

  let satori: (el: unknown, opts: unknown) => Promise<string>
  let Resvg: new (svg: string, opts?: unknown) => { render: () => { asPng: () => Buffer } }
  try {
    satori = (await import(satoriId)).default
    Resvg = (await import(resvgId)).Resvg
  }
  catch {
    throw createError({
      statusCode: 503,
      statusMessage:
        'OG 圖產生器尚未啟用：package.json 缺少 satori 與 @resvg/resvg-js。'
        + '（共用檔需主 session 核可，見 docs/handoff/backend.md）',
    })
  }

  const svg = await satori(element, { width: OG_WIDTH, height: OG_HEIGHT, fonts })
  return new Resvg(svg, { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng()
}

/**
 * OG 圖的快取標頭。
 *
 * 這些圖是**純公開內容**——不含票價、不含備註、不隨檢視者而異（`SCREENS §16.3`），
 * 所以放心讓 CDN 快取。這一點與 `/u/**` 的 `private, no-store` 不衝突：
 * 那條規則的理由是「同一個 URL 對不同人 render 出不同 HTML」，而 OG 圖沒有這個
 * 性質——它對所有人逐位元組相同。
 */
export const OG_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'
