import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/**
 * `satori` → `harfbuzzjs` 的 `hb.wasm` 絕對路徑。
 *
 * ★ 一定要從 `satori` 的位置去解，不能從專案根目錄解：pnpm 的嚴格 `node_modules`
 *   不把傳遞相依提升到頂層，`require.resolve('harfbuzzjs/hb.js')` 在 root 是
 *   `MODULE_NOT_FOUND`（實測）。
 *
 * 解不到就回 `null` 而不是讓建置炸掉——這條只影響 OG 圖，不該讓整個部署停擺；
 * 而 `verify:all` 有一條產物斷言會在 wasm 沒進 `.output` 時變紅，所以「安靜地
 * 少一個檔」不會發生。
 */
function resolveHarfbuzzWasm(): string | null {
  try {
    const fromRoot = createRequire(fileURLToPath(new URL('./noop.js', import.meta.url)))
    return createRequire(fromRoot.resolve('satori')).resolve('harfbuzzjs/hb.wasm')
  }
  catch {
    return null
  }
}

const harfbuzzWasm = resolveHarfbuzzWasm()

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  future: { compatibilityVersion: 4 },
  ssr: true, // 預設 SSR，只用 routeRules 把登入後區塊 opt out

  modules: ['@nuxt/ui', '@nuxtjs/supabase'],
  css: ['~/assets/css/main.css'],

  /**
   * 預設亮色（David 2026-09-20：「能夠預設大家都使用亮色系嗎？
   * 暗色系越看越不滿意，但打算之後再調整」）。
   *
   * 在這之前沒有這段設定 ⇒ 吃 `@nuxt/ui` 的預設 `'system'`，
   * 也就是**跟隨使用者的作業系統**，而台灣不少人的手機是整天暗色。
   *
   * ⚠️ **暗色沒有被移除，也不要移除。** 它仍然是導覽列「外觀」裡選得到的三個
   *   選項之一（跟隨系統／亮色／暗色），`DESIGN_SYSTEM §7` 也仍然規範它的色票
   *   （亮 `rgb(248,237,220)`／暗 `rgb(29,22,16)`）。改的只是**沒選過的人拿到哪一個**。
   *   ⇒ 不要因為「預設是亮色」就去刪暗色的 token 或跳過暗色的驗收。
   *
   * ⚠️ **這個改動對「已經選過」的人完全沒有作用。** 偏好存在 localStorage
   *   （`@nuxtjs/color-mode` 的 `nuxt-color-mode` 鍵），一旦有值就以它為準——
   *   包含開發者自己的瀏覽器。驗收時**要用無痕視窗或新的 profile**，
   *   否則會看到「改了沒效」而那是假的。同一個陷阱在 `§7 #170` 記過：
   *   已存的偏好會蓋掉 `prefers-color-scheme` 的模擬。
   *
   * `fallback` 一併設成 light：那是「使用者選了跟隨系統、但偵測不到系統偏好」時
   * 的退路，讓**每一條不確定的路徑都落在同一個方向**。
   */
  colorMode: {
    preference: 'light',
    fallback: 'light',
  },

  // ★ `#pipeline` 在 package.json 的 imports 裡是 "#pipeline/*": "./src/*"，
  //   而 Node 的 subpath imports **不補副檔名**——`#pipeline/match/matcher`
  //   會去找不存在的 `./src/match/matcher`（實檔是 .ts）。rollup 與 TS 的
  //   Bundler 模式都照 Node 的語意走，所以 server/** 裡的值匯入在執行期 ENOENT，
  //   而 tsx、vitest、tsc 走的是 tsconfig paths，**全部照樣綠燈**。
  //   這個別名補上 Vite/rollup 端的解析（它會補副檔名），兩條路徑才會一致。
  //   同一類錯誤在本專案已出現三次，都是「測試與正式執行走不同解析路徑」。
  alias: { '#pipeline': fileURLToPath(new URL('./src', import.meta.url)) },

  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant-TW' },
      link: [{ rel: 'icon', href: '/favicon.ico' }],
    },

    /**
     * ★ 換頁淡入（2026-09-14 David 裁決，DS §6 第二個編排過的時刻）。
     *
     * 這裡只宣告「用哪個 transition name、用哪個 mode」，**動畫本身一行 CSS 都不在這**
     * ——Nuxt 不自帶 `page` 這組 class，真正的 `.page-enter-active` 等四條規則寫在
     * `app/assets/css/main.css` 最下方。要調時間或關掉效果請去改那裡，兩邊要一起看。
     *
     * ⚠️ 明確寫成物件而不是 `pageTransition: true`：Nuxt 的預設值是 `false`（不開），
     *    寫 `true` 才會展開成這個物件。把它攤開來寫，下一個人不必去翻 schema 才知道
     *    name 是 `page`、mode 是 `out-in`。
     *
     * ⚠️ `mode: 'out-in'` 的代價寫在 main.css：離場與進場是**相加**的，
     *    所以單邊時間必須 ≤ 100ms 才守得住 DS §6 的「互動回饋 ≤ 200ms」。
     *    不寫 mode（預設同時進出）會讓新舊兩頁在同一瞬間重疊，兩份內容互相穿透。
     *
     * ⚠️ **不要設 `appear: true`**。預設 `appear: false` ＝ SSR 首屏直接出現，
     *    這是刻意的：首次進站沒有「使用者剛按下的那一下」可以回應，淡入只是把 LCP
     *    往後推。DS §6 對「編排過的時刻」的定義就是「回應使用者剛做的動作」。
     *
     * ⚠️ **根節點陷阱**（加新頁面時會踩到）：<Transition> 的 hooks 是掛在頁面元件
     *    render 出來的**根 vnode** 上，所以每一頁的根都必須是**永遠存在的單一元素**。
     *    根寫成 `<div v-if="x">` 時，x 為 falsy 會 render 成註解節點——註解沒有樣式，
     *    淡入淡出對它是 no-op，那一次換頁就變成硬切。
     *    ★★ **「單一元素」連開頭的註解都算**（2026-09-14 David 實跑抓到）：
     *      `<template>` 的直接子註解自己就是一個根節點，寫在根元素上方 ⇒ 兩個根 ⇒
     *      Fragment ⇒ 淡入整個不生效，Nuxt 會噴
     *      `[NUXT_E4004] … does not have a single root node`。
     *      諷刺的是，第一版**解釋這條規則的那段註解**正是踩到它的東西。
     *      ⇒ 頁面的說明註解只能放在根元素**裡面**。
     *    ★ 誰會告訴你：**Vue 自己不會**（`isElementRoot()` 明文放行 `Comment`）。
     *      Nuxt 會，但它查的是 render 出來的東西不是模板形狀——`route-provider.js`
     *      在 `dev && client` 時看 `vnode.el.nodeName` 落不落在 `#comment` / `#text`
     *      ⇒ 多根與 falsy 的 v-if 根兩種都抓得到，**但只在瀏覽器裡真的換一次頁時**。
     *      SSR、typecheck、lint、test、build 一個都看不到 ⇒ `tests/page-root.test.ts`
     *      用靜態解析把這條規則釘在 `pnpm test` 裡。
     *    ★ 以下是 Vue 端的細節：`isElementRoot()` 放行 `Comment`
     *      （`vnode.shapeFlag & (6 | 1) || vnode.type === Comment`，在
     *       `@vue/runtime-core` 的 `renderComponentRoot`），理由是「可能只是 v-if 分支切換」。
     *      真的會噴 `Component inside <Transition> renders non-element root node that
     *      cannot be animated.` 的是 **Fragment 根**（多根 template，或根是 `<slot />`）。
     *      ⇒ 不能指望 console 幫你抓，只能靠「根永遠是單一元素」這條規則擋。
     *    正解是「外層永遠存在的元素、v-if 移到內層的 <template>」，
     *    範例見 `app/components/LegalDocumentView.vue` 與 `app/pages/film/[slug].vue`。
     *    ⚠️⚠️ **這條管的是整條根節點鏈，不是只有頁面檔那一層。** 頁面的根寫成
     *    `<SomeComponent>` 時，要看的是**那支元件自己 render 出來的根**——
     *    一支根是 `<slot />` 的元件不能當頁面根。2026-09-14 真的踩到：
     *    `/admin/*` 四頁的根都是 `-StaffGate.vue`，而它的通過分支是 `<slot v-else />`
     *    ⇒ Fragment 根。**照字面掃頁面根的普查看不出來**（`<StaffGate>` 本身
     *    「確實」是永遠存在的單一節點），要往下走進它 render 的東西。
     */
    pageTransition: { name: 'page', mode: 'out-in' },
  },
  // ★ 實測：此值被「字面」接到 srcDir（= app/）後面，別名不解析。
  //   §2.3 的 'app/spa-loading-template.html' → app/app/…（不存在）
  //   官方文件的 '~/spa-loading-template.html' → app/~/…（同樣不存在）
  //   檔案放在 app/ 底下是對的（踩雷 #4），但這裡只能寫裸檔名。
  spaLoadingTemplate: 'spa-loading-template.html',

  routeRules: {
    '/': { ssr: true, isr: { expiration: 300, allowQuery: [] } },
    // ⚠️ 這裡曾經是 prerender: true，但實測**完全沒有生效**（踩雷 #91，
    //    .output/public/ 一個 HTML 都沒有）。而且就算生效也是錯的：
    //    條款正文來自 legal_document，烤死在建置當下的版本會讓
    //    legal_acceptance 記下的「使用者同意了某一版」變成不可查證
    //    ——畫面顯示的內容與 DB 裡那一版可能已經不同。
    //    改成明確的即時 SSR，並且不快取：條款頁的正確性遠比它的延遲重要，
    //    而它們一年也改不了幾次，快取省不到什麼。
    '/legal/**': { ssr: true, headers: { 'cache-control': 'no-store' } },
    // ★ 絕不加 isr / swr：同一路徑對作者與路人 render 出不同 HTML（踩雷 #1）
    '/u/**': { ssr: true, headers: { 'cache-control': 'private, no-store' } },
    '/film/**': { ssr: true, isr: { expiration: 3600, allowQuery: [] } },
    '/venue/**': { ssr: true, isr: { expiration: 3600, allowQuery: [] } },
    // 搜尋結果依 query 而異，不快取（ISR 的 allowQuery 一開就是快取爆炸，踩雷 #8）
    '/search': { ssr: true, headers: { 'cache-control': 'no-store' } },
    '/app/**': { ssr: false, headers: { 'x-robots-tag': 'noindex, nofollow' } },
    // 與 /app/** 同一組理由：ssr:false 路由的 <meta name="robots"> 在爬蟲眼裡
    // 不存在，只有 HTTP header 有效（踩雷 #3）。管理介面漏了這條的後果比
    // /app/** 更難看——被索引到的是審核佇列與 DMCA 承辦頁。
    '/admin/**': { ssr: false, headers: { 'x-robots-tag': 'noindex, nofollow' } },
    '/api/**': { headers: { 'cache-control': 'no-store' } },
  },

  supabase: {
    redirect: true,
    redirectOptions: {
      login: '/login',
      // ★ 絕不能設 '/'：模組會對 callback 路徑硬加 { ssr: false }（踩雷 #14）
      callback: '/confirm',
      // pattern 是 RegExp 不是 glob：'^' + p.replace(/\*/g, '.*') + '$'（踩雷 #15）
      include: ['/app(/*)?', '/admin(/*)?'],
      exclude: [],
      saveRedirectToCookie: true,
    },
    cookieOptions: {
      maxAge: 60 * 60 * 24 * 365, // 預設 8 小時對低頻產品體驗太差（踩雷 #20）
      sameSite: 'lax',
      // Safari 不接受 http://localhost 的 Secure cookie（踩雷 #19）
      secure: process.env.NODE_ENV === 'production',
    },
    types: '~/types/database.types.ts',
  },

  runtimeConfig: {
    tmdbApiKey: '', // NUXT_TMDB_API_KEY —— 只在 server 用
    cronSecret: '', // NUXT_CRON_SECRET
    public: {
      siteUrl: 'http://localhost:3000', // NUXT_PUBLIC_SITE_URL
      // ⚠️ 這裡曾經有一個 `copyrightContactEmail`（§90-4 第 3 款要公告的受理窗口）。
      // 2026-09-07 David 裁定拿掉：專案沒有任何寄信能力，而那個網域實測是 NXDOMAIN，
      // 公告一個收不到的信箱等於承諾做不到的事。公告的窗口改成只有 `/legal/dmca`
      // 那張表（理由完整寫在 `app/pages/legal/copyright.vue` 檔頭 ①）。
      // 不要把它加回來：`runtimeConfig.public` 的每一個值都會序列化進 SSR payload，
      // 「畫面上沒有」不等於「沒有送出去」。
    },
  },

  nitro: {
    preset: undefined, // Vercel 自動偵測，不要手動釘（踩雷 #11）

    externals: {
      /**
       * ★ `satori` → `harfbuzzjs` 的 `hb.wasm` 必須強制納入相依追蹤。
       *
       * `hb.js` 是用 `__dirname + 'hb.wasm'` 在**執行期**組路徑去讀檔，
       * 而 node-file-trace 只看得懂靜態的 import／require ⇒ 它會複製 `hb.js`、
       * 漏掉 `hb.wasm`，於是 OG 端點在部署後 500：
       *   `ENOENT … open '/var/task/node_modules/harfbuzzjs/hb.wasm'`
       *
       * ⚠️ **這不是 Vercel 的問題**：本機 `pnpm build` 出來的 `.output` 同樣
       *   一個 `.wasm` 都沒有。它沒被發現，是因為驗收從來沒有拿 `.output` 去打
       *   那支端點——`scripts/og-preview.ts` 直接呼叫 render 函式，繞過整個打包產物。
       *
       * ⇒ 驗收方式是**看產物**（`find .output -name '*.wasm'`），不是看這段設定。
       */
      traceInclude: harfbuzzWasm ? [harfbuzzWasm] : [],
    },
  },
  typescript: { typeCheck: false, strict: true },
})
