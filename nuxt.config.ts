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
