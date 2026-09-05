import process from 'node:process'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  future: { compatibilityVersion: 4 },
  ssr: true, // 預設 SSR，只用 routeRules 把登入後區塊 opt out

  modules: ['@nuxt/ui', '@nuxtjs/supabase'],
  css: ['~/assets/css/main.css'],

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
    '/legal/**': { prerender: true },
    // ★ 絕不加 isr / swr：同一路徑對作者與路人 render 出不同 HTML（踩雷 #1）
    '/u/**': { ssr: true, headers: { 'cache-control': 'private, no-store' } },
    '/film/**': { ssr: true, isr: { expiration: 3600, allowQuery: [] } },
    '/venue/**': { ssr: true, isr: { expiration: 3600, allowQuery: [] } },
    // 搜尋結果依 query 而異，不快取（ISR 的 allowQuery 一開就是快取爆炸，踩雷 #8）
    '/search': { ssr: true, headers: { 'cache-control': 'no-store' } },
    '/app/**': { ssr: false, headers: { 'x-robots-tag': 'noindex, nofollow' } },
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
    public: { siteUrl: 'http://localhost:3000' }, // NUXT_PUBLIC_SITE_URL
  },

  nitro: { preset: undefined }, // Vercel 自動偵測，不要手動釘（踩雷 #11）
  typescript: { typeCheck: false, strict: true },
})
