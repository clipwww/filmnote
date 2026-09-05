# research-rendering

> 全部內容以官方文件實際擷取為準，**擷取日期：2026-09-05**。
> 版本基準（npm registry 查詢，2026-09-05）：`nuxt@4.5.2`（engines: `node ^22.19.0 || ^24.11.0 || >=26.0.0`；內部依賴 `@nuxt/nitro-server@4.5.2` → `nitropack ^2.13.4`，也就是 **Nitro v2**）、`@nuxt/ui@4.11.0`、`@nuxtjs/supabase@2.0.10`、`echarts@6.1.0`、`vue-echarts@8.2.0`、`nuxt-echarts@1.0.1`。

---

## 1. `routeRules` 在 Nuxt 4 的確切語法

### 1.1 官方原文（Nuxt 4 文件 `Hybrid Rendering` 一節，逐字）

來源：<https://nuxt.com/docs/4.x/guide/concepts/rendering>（原始檔 <https://raw.githubusercontent.com/nuxt/nuxt/main/docs/3.guide/1.concepts/1.rendering.md>）

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  routeRules: {
    // Homepage pre-rendered at build time
    '/': { prerender: true },
    // Products page generated on demand, revalidates in background, cached until API response changes
    '/products': { swr: true },
    // Product pages generated on demand, revalidates in background, cached for 1 hour (3600 seconds)
    '/products/**': { swr: 3600 },
    // Blog posts page generated on demand, revalidates in background, cached on CDN for 1 hour (3600 seconds)
    '/blog': { isr: 3600 },
    // Blog post page generated on demand once until next deployment, cached on CDN
    '/blog/**': { isr: true },
    // Admin dashboard renders only on client-side
    '/admin/**': { ssr: false },
    // Add cors headers on API routes
    '/api/**': { cors: true },
    // Redirects legacy urls
    '/old-page': { redirect: '/new-page' },
  },
})
```

完整選項清單（官方原文）：

| 選項 | 型別 | 官方說明 |
|---|---|---|
| `redirect` | `string` | Define server-side redirects. |
| `ssr` | `boolean` | Disables server-side rendering of the HTML for sections of your app and make them render only in the browser with `ssr: false` |
| `cors` | `boolean` | Automatically adds cors headers with `cors: true` - you can customize the output by overriding with `headers` |
| `headers` | `object` | Add specific headers to sections of your site |
| `swr` | `number \| boolean` | 伺服器/反向代理端快取，TTL 到期後先送舊的、背景重生 |
| `isr` | `number \| boolean` | 同 `swr`，但在支援的平台（目前 Netlify、Vercel）會進 CDN 快取；`true` 代表持續到下次部署 |
| `prerender` | `boolean` | Prerenders routes at build time and includes them in your build as static assets |
| `noScripts` | `boolean` | Disables rendering of Nuxt scripts and JS resource hints for sections of your site |
| `appMiddleware` | `string \| string[] \| Record<string, boolean>` | 指定 Vue app 端（非 Nitro route）哪些 middleware 該／不該跑 |

**pattern 語法**（來源 <https://nitro.build/config> routeRules 章節）：pattern 遵循 [rou3](https://github.com/h3js/rou3) 慣例，`**` 比對任意巢狀 segment、`*` 比對單一 segment。Nitro 還額外支援 `proxy`、`cache`、`static`、`security`，以及帶狀態碼的 redirect：

```js
routeRules: {
  '/old-page': { redirect: '/new-page' },
  '/old-page2': { redirect: { to:'/new-page2', statusCode: 301 } },
  '/old-page/**': { redirect: '/new-page/**' },
  '/proxy/example': { proxy: 'https://example.com' },
}
```

### 1.2 給 filmnote 可直接抄的設定

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',

  // 全站預設 Universal Rendering（SSR）；不要動這個。
  // 只用 routeRules 把登入後的區塊「opt out」。
  ssr: true,

  modules: [
    '@nuxt/ui',
    '@nuxtjs/supabase',
    'nuxt-echarts',
  ],

  routeRules: {
    // ── 公開頁：SSR，給 SEO / OG ─────────────────────────────
    // 首頁靜態化（若首頁有即時排行榜就改成 isr: 300）
    '/': { prerender: true },

    // 個人頁 /u/{username}：SSR。**不要**加 isr/swr，見「地雷 #1」
    '/u/**': { ssr: true },

    // 作品頁 /film/{id}：內容幾乎不變 → 走 Vercel CDN ISR，1 小時重生
    '/film/**': { ssr: true, isr: 3600 },

    // 法遵靜態頁（服務條款、DMCA/著作權窗口、開放資料聲明）
    '/legal/**': { prerender: true },

    // ── 登入後儀表板：client-only SPA ────────────────────────
    '/app/**': {
      ssr: false,
      // 私人區域不要被索引；SSR 關掉後 <meta robots> 只存在於 hydration 後，
      // 用 HTTP header 才是對爬蟲有效的那一份
      headers: { 'x-robots-tag': 'noindex, nofollow' },
    },

    // ── API：絕不快取（含票價等隱私欄位）───────────────────
    '/api/**': { headers: { 'cache-control': 'no-store' } },
  },

  // ssr:false 的路由在 JS 載入前會是空殼，放個 loading 畫面
  // 檔案位置：app/spa-loading-template.html
  //（Nuxt 4 預設 srcDir = "app"，alias "~" → "<rootDir>/app"）
})
```

**規則優先序**：`'/app/**': { ssr: false }` 之下若再宣告 `'/app/report': { ssr: true }`，較精確的規則會贏（官方在 §2 的 server-bundle 說明中就是用這個例子）。

**`/u/{username}` 改名後 301**：`routeRules.redirect` 是**建置期靜態**的，做不到「查 DB 找舊 username」。要動態 301 必須寫 Nitro server middleware（以下是設計建議，非文件原文）：

```ts
// server/middleware/username-redirect.ts
export default defineEventHandler(async (event) => {
  const m = event.path.match(/^\/u\/([^/?]+)(.*)$/)
  if (!m) return
  const newName = await lookupRenamedUsername(m[1]) // 查 username_history 表
  if (newName) {
    return sendRedirect(event, `/u/${newName}${m[2]}`, 301)
  }
})
```

---

## 2. Nuxt 4 是否仍用 `ssr: false`？有無改名？

**沒有改名，`ssr: false` 仍然是唯一且正確的寫法。** Nuxt 4 文件與 Vercel 2026-08-26 更新的文件都仍使用它：

- Nuxt：`'/admin/**': { ssr: false }` — <https://nuxt.com/docs/4.x/guide/concepts/rendering>
- Vercel：「If you deploy with `nuxt build`, you can opt nuxt routes into client-side rendering using `routeRules` by setting `ssr: false`」 — <https://vercel.com/docs/frameworks/full-stack/nuxt>

### Nuxt 4 新增的相關行為：`ssr: false` 會把頁面元件踢出 server bundle

官方新章節 **「Server Bundle Size with `ssr: false`」**（逐字）：

> A route covered by `ssr: false` is only ever rendered in the browser, so Nuxt excludes its page component from the server bundle. This applies whenever the rules covering every path that reaches the page can be resolved at build time, including dynamic routes such as `pages/products/[id].vue` under a `/products/**` rule.

以下情況頁面**仍會**留在 server bundle：

> - a more specific rule re-enables SSR somewhere below the client-only one (`'/admin/**': { ssr: false }` with `'/admin/report': { ssr: true }`)
> - the page has an alias, or a child declared with an absolute path, that falls outside the client-only region
> - the page is a parent shell rendering a child that is still server-rendered
>
> This is a build-time optimization only; it does not change what the server sends to the browser.

其他必須知道的官方限制：

> **Note that Hybrid Rendering is not available when using `nuxt generate`.**（所以 filmnote 一定用 `nuxt build`，不能用 `nuxt generate`）

> Routes using `isr` or `swr` also generate `_payload.json` files alongside HTML.（<https://nuxt.com/docs/4.x/getting-started/prerendering> 亦確認：「Routes using ISR or SWR caching generate their payload file when the route is first rendered, even on a hybrid (non-static) site.」）

### SPA loading 畫面（`ssr: false` 路由必配）

`nuxt.config` 參考文件 `spaLoadingTemplate`（逐字）：

> Boolean or a path to an HTML file with the contents of which will be inserted into **any HTML page rendered with `ssr: false`**.
> - If it is unset, it will use `~/spa-loading-template.html` file in one of your layers, if it exists.

Nuxt 4 `alias` 預設 `"~": "/<rootDir>/app"`、`srcDir` 預設 `"app"`（同頁 `## alias` / `## srcDir`），所以實際檔案路徑是 **`app/spa-loading-template.html`**。

### 不能在頁面元件裡設定算繪模式

`definePageMeta` 的 `PageMeta` 介面（<https://nuxt.com/docs/4.x/api/utils/define-page-meta>）只有 `validate / redirect / name / path / props / alias / groups / pageTransition / layoutTransition / viewTransition / key / keepalive / layout / middleware / scrollToTop`，**沒有 `ssr`**。Vercel 文件也明講：「At the moment, there is no way to configure route deployment options within your page components」。→ 算繪模式只有 `nuxt.config.ts` 的 `routeRules` 一個入口。

---

## 3. SSR 頁面產生 OG meta 的現行 API

### 3.1 `useSeoMeta`（**官方推薦**）

來源：<https://nuxt.com/docs/4.x/api/composables/use-seo-meta>

> ::important
> This is the recommended way to add meta tags to your site as it is XSS safe and has full TypeScript support.

```vue [app/app.vue]
<script setup lang="ts">
useSeoMeta({
  title: 'My Amazing Site',
  ogTitle: 'My Amazing Site',
  description: 'This is my amazing site, let me tell you all about it.',
  ogDescription: 'This is my amazing site, let me tell you all about it.',
  ogImage: 'https://example.com/image.png',
  twitterCard: 'summary_large_image',
})
</script>
```

**反應式一定要用 getter 語法 `() => value`**（原文：「When inserting tags that are reactive, you should use the computed getter syntax」）：

```vue
<script setup lang="ts">
const title = ref('My title')

useSeoMeta({
  title,
  description: () => `This is a description for the ${title.value} page`,
})
</script>
```

參數超過 100 個，完整清單在 <https://github.com/harlan-zw/zhead/blob/main/packages/zhead/src/metaFlat.ts#L1035>。

### 3.2 ⚠️ `useServerSeoMeta` 已 **deprecated**

<https://nuxt.com/docs/4.x/api/composables/use-server-seo-meta>（逐字）：

> ::warning
> `useServerSeoMeta` is deprecated. Wrap `useSeoMeta` in an `if (import.meta.server)` block instead. The auto-import is removed under `future.compatibilityVersion: 5`.

現行寫法（官方 Performance 章節原文）：

```vue [app/app.vue]
<script setup lang="ts">
if (import.meta.server) {
  // These meta tags will only be added during server-side rendering
  useSeoMeta({
    robots: 'index, follow',
    description: 'Static description that does not need reactivity',
    ogImage: 'https://example.com/image.png',
    // other static meta tags...
  })
}

const dynamicTitle = ref('My title')
// Only use reactive meta tags outside the condition when necessary
useSeoMeta({
  title: () => dynamicTitle.value,
  ogTitle: () => dynamicTitle.value,
})
</script>
```

### 3.3 `useHead` / `app.head`

<https://nuxt.com/docs/4.x/getting-started/seo-meta>

```vue
<script setup lang="ts">
useHead({
  title: 'My App',
  meta: [
    { name: 'description', content: 'My amazing site.' },
  ],
  bodyAttrs: { class: 'test' },
  script: [{ innerHTML: 'console.log(\'Hello world\')' }],
})
</script>
```

`MetaObject` 介面：`title / titleTemplate / templateParams / base / link / meta / style / script / noscript / htmlAttrs / bodyAttrs`。

靜態全站設定放 `app.head`（官方註明「This method does not allow you to provide reactive data.」）：

```ts
export default defineNuxtConfig({
  app: {
    head: {
      title: 'Nuxt',
      htmlAttrs: { lang: 'en' },
      link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    },
  },
})
```

### 3.4 filmnote 的作品頁範本

```vue
<!-- app/pages/film/[id].vue -->
<script setup lang="ts">
const route = useRoute()
const { data: film } = await useFetch(`/api/film/${route.params.id}`)

// 海報一律熱連結 image.tmdb.org（SPEC 法遵要件）
const poster = computed(() =>
  film.value?.tmdbPosterPath
    ? `https://image.tmdb.org/t/p/w780${film.value.tmdbPosterPath}`
    : `${useRequestURL().origin}/og-fallback.png`,
)

useSeoMeta({
  title: () => `${film.value?.titleZh} — 影記`,
  description: () => `${film.value?.titleZh}（${film.value?.titleOriginal}）的觀影紀錄與統計`,
  ogType: 'video.movie',
  ogTitle: () => film.value?.titleZh,
  ogDescription: () => `${film.value?.titleZh} 在影記的觀影紀錄`,
  ogImage: () => poster.value,
  ogUrl: () => useRequestURL().href,
  twitterCard: 'summary_large_image',
})

// 不需反應式的部分，只在 server 端輸出，可從 client bundle 省掉
if (import.meta.server) {
  useSeoMeta({ robots: 'index, follow' })
}
</script>
```

> 動態 OG 圖：Vercel 官方文件（<https://vercel.com/docs/frameworks/full-stack/nuxt> §Open Graph Images）建議用 `nuxt-og-image`（`defineOgImageComponent('Template', { title })`），它跑在同一個 Nuxt/Nitro SSR function 上。**注意**：SPEC 規定海報熱連結 TMDB、不自行轉存，把 TMDB 海報 pipe 進自己的 OG 生成器等同轉存，要謹慎；純文字卡片的 OG image 才安全。

---

## 4. ECharts 在 SSR 環境的處理

### 4.1 先講結論（對應 filmnote 的三種頁面）

| 頁面 | 算繪 | 圖表做法 |
|---|---|---|
| `/app/**` 儀表板 | `ssr: false` | **什麼都不用包**。整條路由本來就只在瀏覽器跑，`<ClientOnly>` 是多餘的。直接 `<VChart>`。 |
| `/u/**` 個人頁 | SSR | `<ClientOnly>` + `#fallback` 骨架（防 CLS）。或用 `nuxt-echarts` 的 `<VChartServer>` 拿到首屏 SVG。 |
| `/film/**` 作品頁 | SSR + ISR | 同上；ISR 快取的頁面首屏有 SVG 圖最划算。 |

### 4.2 `<ClientOnly>` vs `.client.vue`：Nuxt 4 的差異

`<ClientOnly>`（<https://nuxt.com/docs/4.x/api/components/client-only>）：

> ::note
> The content of the default slot will be tree-shaken out of the server build. (This does mean that any CSS used by components within it may not be inlined when rendering the initial HTML.)

Props：`placeholderTag` | `fallbackTag`（server 端要 render 的標籤）、`placeholder` | `fallback`（server 端要 render 的內容）。Slot：`#fallback`。

```vue [app/pages/example.vue]
<template>
  <div>
    <Sidebar />
    <!-- This renders the "span" element on the server side -->
    <ClientOnly fallback-tag="span">
      <!-- this component will only be rendered on client side -->
      <Comments />
      <template #fallback>
        <!-- this will be rendered on server side -->
        <p>Loading comments...</p>
      </template>
    </ClientOnly>
  </div>
</template>
```

`.client.vue`（<https://nuxt.com/docs/4.x/directory-structure/app/components> §Client Components）：

> If a component is meant to be rendered only client-side, you can add the `.client` suffix to your component.
>
> ::note
> This feature only works with Nuxt auto-imports and `#components` imports. **Explicitly importing these components from their real paths does not convert them into client-only components.**
>
> ::important
> `.client` components are rendered only after being mounted. To access the rendered template using `onMounted()`, add `await nextTick()` in the callback of the `onMounted()` hook.

**對照表：**

| | `<ClientOnly>` | `.client.vue` |
|---|---|---|
| 作用單位 | 每個使用點 | 元件本身（全域生效） |
| server 端佔位 | ✅ `fallback` / `#fallback` slot | ❌ 沒有 fallback 機制 |
| server bundle | default slot 內容被 tree-shake（**內部 CSS 可能無法 inline**） | — |
| 失效風險 | 無 | 用真實路徑 explicit import 就**靜默失效**（會被 SSR，然後 canvas 爆） |
| 掛載時機 | mount 後才 render | mount 後才 render，`onMounted` 內需 `await nextTick()` |

**建議：SSR 頁面用 `<ClientOnly>` + `#fallback`**（可以放固定高度的骨架，避免圖表載入時版面跳動，這對 CLS/Core Web Vitals 有實質差別）。`.client.vue` 只在「這個元件無論放哪都不該 SSR、而且團隊保證只用 auto-import」時才用。

### 4.3 重要事實：`vue-echarts` 本身其實 SSR-safe

`vue-echarts` v8 README §Server-side rendering（逐字，<https://github.com/ecomfe/vue-echarts>）：

> `VChart` can be rendered and hydrated by Vue SSR frameworks. The server renders only the chart container; ECharts initializes after the component mounts in the browser. **The low-level ECharts `ssr` field in `init-options` does not enable server-side chart rendering in `VChart`.**

也就是說：`<VChart>` 在 SSR 時**不會壞**（server 只吐容器 div），但 server HTML 裡**不會有圖**。所以 `<ClientOnly>` 對它而言不是「防爆」，而是「給 fallback 骨架 + 把 echarts 從 server bundle tree-shake 掉」。

### 4.4 ECharts 官方 SSR 模式（SVG 字串）值不值得用於公開頁？

官方 handbook（<https://echarts.apache.org/handbook/en/how-to/cross-platform/server/>，原始檔 `apache/echarts-handbook/contents/en/how-to/cross-platform/server.md`）：

```ts
// Server-side code
const echarts = require('echarts');

// In SSR mode the first container parameter is not required
let chart = echarts.init(null, null, {
  renderer: 'svg', // must use SVG rendering mode
  ssr: true,       // enable SSR
  width: 400,      // need to specify height and width
  height: 300
});

chart.setOption({ /* ... */ });

// Output a string
const svgStr = chart.renderToSVGString();

// If chart is no longer useful, consider disposing it to release memory.
chart.dispose();
chart = null;
```

官方明列的**能力與限制**：

- ✅ 零依賴（不需要 node-canvas）、SVG 向量不糊、體積比 canvas 圖小
- ✅ 首屏動畫可用（原理：SVG 內嵌 CSS animation，不需要額外 JS）
- ✅ hover highlight 樣式
- ❌ **必須指定固定 `width` / `height`** —— 原文：「if your chart size needs to be responsive to the container, you may need to think about whether server-side rendering is appropriate for your scenario」
- ❌ 不支援動態改資料、legend 點擊切換、tooltip 等即時互動
- ❌ 不支援 bar racing / label 動畫 / `lines` 特效

兩種 hydration 路線：
1. **Lazy-Loading Full ECharts**：server 出 SVG 秒開，client 再載入完整 echarts.js 重繪同一張圖。client 端要開 `tooltip: { show: true }`、並用 `animation: 0` 關掉初始動畫（初始動畫已由 server SVG 的 CSS 播完）。
2. **Lightweight Client Runtime（v5.5.0+）**：`https://cdn.jsdelivr.net/npm/echarts/ssr/client/dist/index.min.js`，`window['echarts-ssr-client'].hydrate(container, { on: { click } })`，**< 4KB**，支援初始動畫、hover highlight、legend 切換（原理：向 server 請求二次 render）。

**對 filmnote 的判斷：**

- `/film/**`（走 ISR，HTML 進 CDN）→ **值得**。首屏就有 SVG 圖，且因為 ISR 快取，SSR 算圖的成本被攤平。
- `/u/**`（每次 request 都 SSR）→ **邊際效益低、風險高**。每個 request 都在 Vercel Function 裡跑一次 ECharts render（Hobby 有執行時間/用量限制），而且 SPEC 的隱私模型讓 `/u/**` 不能快取（見地雷 #1）。**建議先用 `<ClientOnly>` + 骨架**，等有實測數據再考慮升級。
- `/app/**` → 完全用不到，該路由是 SPA。

### 4.5 `nuxt-echarts` 模組（可用來拿 SSR SVG）

<https://echarts.nuxt.dev>（原始碼 <https://github.com/kingyue737/nuxt-echarts>）。`nuxt-echarts@1.0.1`：deps `@nuxt/kit ^4.1.3`，peer `echarts ^6.0.0` + `vue-echarts ^8.0.0`，module meta `compatibility.nuxt: '>=3.2.0'`。

安裝：`npx nuxi module add echarts`

Tree-shake 設定（正好符合 SPEC 的「tree-shaken 模組化 import」決策）：

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['nuxt-echarts'],
  echarts: {
    renderer: ['canvas', 'svg'],  // 預設只有 'canvas'；要 SSR 就得加 'svg'
    charts: ['BarChart', 'LineChart', 'PieChart'],
    components: ['DatasetComponent', 'GridComponent', 'TooltipComponent', 'LegendComponent', 'TitleComponent'],
    features: ['LabelLayout', 'UniversalTransition'],
  },
})
```

四個元件的官方對照（文件 §Summary 原文摘要）：

| 元件 | 方案 | 載入量 | 失去的功能 |
|---|---|---|---|
| `VChart` | 純 client | 大 | 無（但無首屏 SSR） |
| `VChartFull` | server SVG + client 端 lazy-load 完整 ECharts | 大 | lazy load 完成前不能互動 |
| `VChartIsland` | server SVG | 小 | 不支援 legend 切換、tooltip 等即時互動 |
| `VChartServer` | server SVG，且可 `inject` 祖先 `provide` 的 option | 小 | 同上 |
| `VChartLight` | server SVG + 輕量 runtime | 小 | 不支援高即時性互動 |

**⚠️ 官方自己標的風險**（逐字）：

> Server-Side Rendering is based on [experimental `<NuxtIsland>`](https://nuxt.com/docs/api/components/nuxt-island). If you found any issue, design flaw, or have ideas to improve it, please open an issue or a Discussion.

而且 `<VChartServer>` 的 props 註記：「We have to specify the `height` and `width` property in `init-options` for SSR.」（呼應 ECharts 官方的固定尺寸限制）。

模組 setup 會自動把 `experimental.componentIslands` 從 `'auto'` 改成 `true`，並把 `echarts` 加進 `vite.optimizeDeps.exclude`（避免 echarts 被複製多份）。

---

## 5. Vercel 部署 Nuxt 4 的 preset

### 結論：**不需要**明指 nitro preset。

- Nuxt 官方 <https://nuxt.com/deploy/vercel>：「Integration with Vercel is possible with **zero configuration**」、「Vercel will detect that you are using Nitro and will enable the correct settings for your deployment.」
- Vercel 官方 <https://vercel.com/docs/frameworks/full-stack/nuxt>（last_updated 2026-08-26）：「You can deploy Nuxt static and server-side rendered sites on Vercel with **no configuration required**.」、「On Vercel, Nuxt apps are server-rendered by default」、預設 build command 就是 `nuxt build`。
- Nitro v2 <https://v2.nitro.build/deploy/providers/vercel>：「Integration with this provider is possible with zero configuration.」preset 名稱為 `vercel`；`vercel_edge` 已標 deprecated（建議改用 default runtime + Fluid compute）。

只有在**要強制 edge runtime** 時才需要 `NITRO_PRESET`（Nuxt 文件 §Edge-Side Rendering：「Vercel Cloud using the `nuxt build` command and `NITRO_PRESET=vercel-edge` environment variable」）——但 `vercel_edge` 已 deprecated，filmnote **不要用**。

### 需要／可以額外設定的東西

```ts
// nuxt.config.ts —— Vercel 專屬微調（都是選配）
export default defineNuxtConfig({
  nitro: {
    // preset 不用寫！Vercel 會自動偵測。
    vercel: {
      config: {
        // 合併進自動產生的 Build Output API v3 設定
      },
      functionRules: {
        // 需要跑比較久的路由才調（例如 seed / 匯入 API）
        '/api/admin/import': { maxDuration: 60, memory: 1024 },
      },
    },
  },
})
```

`isr` route rule 的細部選項（Nitro v2 Vercel provider 文件原文範例）：

```ts
routeRules: {
  "/products/**": {
    isr: {
      allowQuery: ["q"],
      passQuery: true,
      exposeErrBody: true
    },
  },
}
```

- `expiration`：秒數，`false` = 不過期
- `group`：一起 revalidate 的資產群組
- `allowQuery`：可獨立快取的 query 參數（空陣列＝忽略 query；`undefined`＝每個不同值都各自快取 → 容易快取爆炸）
- `passQuery`：`true` 時 query string 會傳進 function
- `exposeErrBody`：錯誤狀態碼也吐 body

Vercel 也明說 **Nuxt 要用 `isr` 不要用 `swr`**：「You should use the `isr` option rather than `swr` to enable ISR in a route. The `isr` option enables Nuxt to use Vercel's Cache.」

### Vercel 專案設定 checklist

| 項目 | 值 | 依據 |
|---|---|---|
| Framework Preset | Nuxt.js（自動偵測） | Vercel 文件 |
| Build Command | `nuxt build`（預設，別改成 `nuxt generate`） | Vercel 文件比較表：`nuxt generate` **不支援 SSR、不支援 ISR** |
| `NITRO_PRESET` | **不要設** | 兩邊文件都說 zero-config |
| Node.js Version | 22.x 或 24.x | `nuxt@4.5.2` engines: `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` |
| `@nuxt/image` | 零設定即接上 Vercel Image Optimization | Vercel 文件 §Image Optimization |

---

## 6. 一頁式 nuxt.config.ts（把上面全部合起來）

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  ssr: true,

  modules: [
    '@nuxt/ui',
    '@nuxtjs/supabase',
    'nuxt-echarts',
  ],

  future: { compatibilityVersion: 4 },

  routeRules: {
    '/':          { prerender: true },
    '/legal/**':  { prerender: true },
    '/u/**':      { ssr: true },                     // 不快取，見地雷 #1
    '/film/**':   { ssr: true, isr: 3600 },
    '/app/**':    { ssr: false, headers: { 'x-robots-tag': 'noindex, nofollow' } },
    '/api/**':    { headers: { 'cache-control': 'no-store' } },
  },

  supabase: {
    redirectOptions: {
      login: '/login',
      callback: '/confirm',
      // 只在 /app/** 強制登入；公開頁一律放行
      include: ['/app(/*)?'],
      exclude: [],
      saveRedirectToCookie: true,
    },
  },

  echarts: {
    renderer: ['canvas', 'svg'],
    charts: ['BarChart', 'LineChart', 'PieChart'],
    components: ['DatasetComponent', 'GridComponent', 'TooltipComponent', 'LegendComponent', 'TitleComponent'],
    features: ['LabelLayout', 'UniversalTransition'],
  },

  nitro: {
    // preset 不設 → Vercel 自動偵測
  },

  app: {
    head: {
      htmlAttrs: { lang: 'zh-Hant-TW' },
      link: [{ rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' }],
    },
  },
})
```

搭配 `app/spa-loading-template.html`（`ssr: false` 路由的骨架畫面）。

---

## 來源清單（全部 2026-09-05 擷取）

- <https://nuxt.com/docs/4.x/guide/concepts/rendering> ／ 原始檔 <https://raw.githubusercontent.com/nuxt/nuxt/main/docs/3.guide/1.concepts/1.rendering.md>
- <https://nuxt.com/docs/4.x/api/nuxt-config> ／ 原始檔 <https://raw.githubusercontent.com/nuxt/nuxt/main/docs/4.api/6.nuxt-config.md>
- <https://nuxt.com/docs/4.x/api/composables/use-seo-meta>
- <https://nuxt.com/docs/4.x/api/composables/use-server-seo-meta>
- <https://nuxt.com/docs/4.x/getting-started/seo-meta>
- <https://nuxt.com/docs/4.x/getting-started/prerendering>
- <https://nuxt.com/docs/4.x/api/components/client-only>
- <https://nuxt.com/docs/4.x/directory-structure/app/components>
- <https://nuxt.com/docs/4.x/api/utils/define-page-meta>
- <https://nuxt.com/deploy/vercel>
- <https://nitro.build/config>（routeRules pattern / preset）
- <https://v2.nitro.build/deploy/providers/vercel>（Nuxt 4.5.2 用的是 Nitro v2）
- <https://v2.nitro.build/guide/cache>
- <https://vercel.com/docs/frameworks/full-stack/nuxt>（頁面標示 last_updated 2026-08-26）
- <https://vercel.com/docs/incremental-static-regeneration>（頁面標示 last_updated 2026-08-28）
- <https://echarts.apache.org/handbook/en/how-to/cross-platform/server/> ／ 原始檔 <https://raw.githubusercontent.com/apache/echarts-handbook/master/contents/en/how-to/cross-platform/server.md>
- <https://github.com/ecomfe/vue-echarts>（README，v8）
- <https://echarts.nuxt.dev> ／ <https://github.com/kingyue737/nuxt-echarts>
- <https://github.com/nuxt-modules/supabase>（docs/content/1.getting-started/*）
- npm registry：`nuxt`、`echarts`、`vue-echarts`、`nuxt-echarts`、`@nuxtjs/supabase`、`@nuxt/ui`、`@nuxt/nitro-server`

## 踩雷點

- 【最嚴重】不要對 /u/** 加 isr 或 swr。Nitro v2 快取文件明講「all incoming request headers are dropped when handling cached responses」、cache key 只由 group:name:getKey 組成，request headers 與 cookies 不在 key 裡（只有列在 varies 的 header 才算）；Vercel ISR 文件也說「Vercel knows a path is cacheable before the first request arrives」——快取以「路徑」為單位。SPEC 的隱私模型（cost 預設隱藏、可切 show_cost、個別紀錄可設 private）代表同一個 /u/{username} 對「作者本人」與「路人」會 render 出不同 HTML。一旦作者本人先造訪把含票價的 HTML 寫進 CDN，全世界都會拿到那份快取 → 直接洩漏票價與私密紀錄。若真要快取，唯一安全做法是：SSR 時一律以「匿名視角」render，作者專屬欄位放 <ClientOnly> 在 client 端補上。
- nuxt generate 不能用。官方原文：「Note that Hybrid Rendering is not available when using nuxt generate.」Vercel 的比較表也標明 nuxt generate 不支援 SSR、不支援 ISR。build command 必須維持 nuxt build。
- ssr: false 的路由，<meta name="robots"> 只有在 hydration 之後才存在，爬蟲第一次抓到的是空殼。要對 /app/** 生效必須用 HTTP header：headers: { 'x-robots-tag': 'noindex, nofollow' }。
- ssr: false 路由若沒有 app/spa-loading-template.html，使用者會看到純白畫面直到 JS 下載完。注意檔名在文件裡寫成 ~/spa-loading-template.html，而 Nuxt 4 的 ~ = <rootDir>/app（srcDir 預設 "app"），實際路徑是 app/spa-loading-template.html，不是專案根目錄。
- .client.vue 只在 auto-import 或從 #components import 時才生效。官方原文：「Explicitly importing these components from their real paths does not convert them into client-only components.」——有人手滑寫成 import Chart from '~/components/Chart.client.vue' 就會靜默變成 SSR 元件，然後 canvas 在 Node 裡爆掉。這是很難 debug 的失效模式。
- <ClientOnly> 的 default slot 內容會從 server build 被 tree-shake，官方註明「any CSS used by components within it may not be inlined when rendering the initial HTML」——圖表容器的樣式可能晚一拍才套上，造成閃爍。務必用 #fallback 給固定高度骨架。
- vue-echarts 的 <VChart> 不會在 SSR 時炸掉（server 只 render 容器），所以「沒包 ClientOnly 也跑得動」會讓人誤以為設定正確；但 server HTML 裡完全沒有圖，SEO/OG 一點好處都沒拿到，還把 echarts 打進了 server bundle。
- ECharts 官方 SSR 模式強制要求固定 width / height。官方原文：「if your chart size needs to be responsive to the container, you may need to think about whether server-side rendering is appropriate」——filmnote 的響應式圖表（手機/桌機不同寬度）跟 SSR SVG 天生衝突。
- nuxt-echarts 的 SSR 元件（VChartIsland / VChartServer / VChartLight）建立在 experimental 的 <NuxtIsland> 之上，模組自己在文件裡標了 experimental 警語，並會自動把 experimental.componentIslands 設成 true。上 production 前要評估風險。另外它的 module meta 只宣告 compatibility.nuxt: '>=3.2.0'，沒有針對 Nuxt 4 的明確相容性聲明（雖然 deps 已用 @nuxt/kit ^4.1.3）。
- nuxt-echarts 的 renderer 預設只有 'canvas'。要用任何 server-side SVG 元件，必須在 nuxt.config 的 echarts.renderer 明確加入 'svg'，否則 SSR 元件拿不到 SVG renderer。
- 算繪模式無法寫在頁面元件裡。definePageMeta 的 PageMeta 介面沒有 ssr 欄位；Vercel 文件也明講「there is no way to configure route deployment options within your page components」。所有 SSR/SPA 切換只能集中在 nuxt.config.ts 的 routeRules——重構搬檔案時很容易忘了同步更新路徑 pattern。
- useServerSeoMeta 已 deprecated，且在 future.compatibilityVersion: 5 之下 auto-import 會被移除。新程式碼一律寫 if (import.meta.server) { useSeoMeta({...}) }。
- useSeoMeta 的反應式值必須用 getter 語法 () => value。直接傳 `film.value.titleZh` 只會抓到 render 當下的快照，之後資料變了 meta 不會更新。
- isr 的 allowQuery 若留 undefined，每個不同的 query string 值都會產生一份獨立快取 → 被人用 ?a=1、?a=2… 打就會快取爆炸並吃光 Vercel Hobby 的 ISR write 額度。/film/** 建議明確設 isr: { expiration: 3600, allowQuery: [] }。
- Vercel 明確要求 Nuxt 用 isr 而非 swr：「You should use the isr option rather than swr to enable ISR in a route. The isr option enables Nuxt to use Vercel's Cache.」寫成 swr 會退化成只有 Cache-Control header，拿不到 CDN 快取、request collapsing、300ms 全球 purge 等能力。
- 使用 isr / swr 的路由會額外產生 _payload.json（官方：「Routes using ISR or SWR caching generate their payload file when the route is first rendered」）。這個 payload 裡是 useAsyncData/useFetch 的序列化結果——如果 SSR 時把票價或私密紀錄塞進 payload，就算 HTML 上沒顯示，_payload.json 也會被快取並公開可讀。RLS 要在資料層就把欄位擋掉，不能只在 template 用 v-if 隱藏。
- vercel_edge preset 在 Nitro v2 文件已標 deprecated（建議改用 default runtime + Fluid compute）。不要為了效能去設 NITRO_PRESET=vercel-edge。
- Node 版本要對齊。nuxt@4.5.2 的 engines 是 ^22.19.0 || ^24.11.0 || >=26.0.0；Vercel 專案若還停在 20.x 會裝不起來。
- @nuxtjs/supabase 的 redirect 預設是 true，會對「所有」頁面強制導向 /login。filmnote 的公開頁（/u/**、/film/**）必須放行——用 redirectOptions.include: ['/app(/*)?'] 只對儀表板生效，比用 exclude 一個一個排除安全得多（漏掉一頁就等於把公開頁擋掉，SEO 直接歸零）。

## 未能驗證

- appMiddleware route rule 的完整語義與實際範例：它只出現在 rendering.md 的 route rules 清單裡（型別 string | string[] | Record<string, boolean>），Nuxt 4 的 middleware 專章（docs/2.directory-structure/1.app/1.middleware.md）完全沒提到它，也找不到官方使用範例。若要用它控制 /app/** 的 auth middleware，建議先在本機驗證行為。
- Vercel ISR 是否會把 cookie 或 Authorization header 納入快取 key：Vercel 的 ISR 文件（last_updated 2026-08-28）與 Nuxt on Vercel 文件都沒有任何一句直接談 cookie / Set-Cookie / 私密內容的快取行為。地雷 #1 的結論是綜合「Nitro v2 cache 文件明言 request headers 預設全被 drop、只有 varies 列出的才算」與「Vercel ISR 在 build time 就決定路徑可快取性」推導出來的，屬於工程判斷，不是 Vercel 官方明文。上線前務必實測：登入後造訪 /u/{自己}，再用無痕視窗打同一網址，確認拿不到含票價的 HTML。
- experimental.spaLoadingTemplateLocation 在 Nuxt 4 是否還存在：在 docs/4.api/6.nuxt-config.md 全文中 grep 不到這個 key（只有 spaLoadingTemplate）。Nuxt 3.x 時代它控制 loading 模板插在 app root 內或外，Nuxt 4 是否已固定行為或改名，未能從官方文件確認。
- nuxt-echarts 對 Nuxt 4 的官方相容性聲明：模組 meta 寫的是 compatibility.nuxt: '>=3.2.0'，README 與文件站都沒有「supports Nuxt 4」的明文。雖然 1.0.1 的 dependencies 已是 @nuxt/kit ^4.1.3（強烈暗示支援），但沒有官方保證。
- nuxt-echarts 的 SSR 元件在 routeRules 的 isr / prerender 路由下的實際行為（NuxtIsland 是 runtime fetch，可能與 CDN 快取或 prerender 互相打架）——文件沒有涵蓋這個組合，需自行實測。
- Nuxt UI v4（@nuxt/ui@4.11.0）與 ssr: false routeRules 的互動（例如 Tailwind CSS 4 的 CSS 是否會因為頁面被踢出 server bundle 而漏掉某些 utility），完全未查證。
- @nuxtjs/supabase 的 redirect middleware 在 ssr: false 路由上的執行時機（它是 Vue 端 route middleware，理論上只會在 client 跑，但未在官方文件中找到針對 hybrid rendering 的說明）。
- routeRules 在 nuxt.config 參考文件中仍被標為「Experimental: This is an experimental feature and API may change in the future.」——雖然它已是官方推薦的 hybrid rendering 唯一入口，且 Vercel 官方文件也全篇使用它，但 Nuxt 官方尚未把這個 experimental 標記拿掉。
