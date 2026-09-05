# research-nuxt-ui

> 擷取日期：**2026-09-05**。所有版本號皆於當日以 `npm view` 直接查詢 registry，元件清單與內部實作皆從實際 tarball（`npm pack`）解開驗證，非憑記憶。

---

## 0. 版本與相容性總表（2026-09-05 實測）

| 套件 | 版本 | 來源 |
|---|---|---|
| `nuxt` | **4.5.2** | `npm view nuxt version` |
| `@nuxt/ui` | **4.11.0**（2026-08-21 發布） | `npm view @nuxt/ui version`；[GitHub release v4.11.0](https://github.com/nuxt/ui/releases/tag/v4.11.0) |
| `@nuxt/ui` license | **MIT** | `npm view @nuxt/ui@4.11.0 license` → `MIT` |
| `@nuxt/ui-pro` | **3.3.7**（停在 v3，無 v4） | `npm view @nuxt/ui-pro version` |
| `tailwindcss` | **4.3.3** | `npm view tailwindcss version` |
| `reka-ui` | 2.10.4（Nuxt UI 內部 pin `2.10.3`） | package.json dependencies |
| `echarts` / `zrender` | **6.1.0** | `npm view echarts version` |
| `vue-echarts` | 8.2.0（peer `echarts: ^6.0.0`） | `npm view vue-echarts peerDependencies` |
| `@nuxtjs/supabase` | 2.0.10 | `npm view @nuxtjs/supabase version` |

**Nuxt UI 4.11.0 的硬性條件**（從 `dist/module.json` 與 `package.json` 實際讀出）：

```json
"compatibility": { "nuxt": ">=4.1.0" }
"engines": { "node": "^20.19.0 || >=22.12.0" }
```

**TypeScript peer 範圍**：`"typescript": "^5.6.3 || ^6.0.0 || ^7.0.0"` —— 也就是說 Nuxt UI **本身**不阻止你用 TS 7。專案決策把 TS 釘在 5.9.x 是因為 typescript-eslint / ts-api-utils，不是因為 Nuxt UI。這個 pin 與 Nuxt UI 沒有衝突。

---

## 1. 安裝與 Nuxt 4 整合

來源：<https://ui.nuxt.com/docs/getting-started/installation/nuxt>（2026-09-05 擷取）

### 1.1 安裝

官方文件明確要求**同時安裝 `tailwindcss`**（雖然 `@nuxt/ui` 內部也 bundle 了 `tailwindcss@^4.3.3`，但它同時列在 `peerDependencies` 裡，必須是你的直接相依）：

```bash
npm install @nuxt/ui tailwindcss
```

### 1.2 nuxt.config.ts

```ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css']
})
```

> Nuxt 4 的 `~` 指向 `app/`，所以檔案實際路徑是 `app/assets/css/main.css`。

### 1.3 Tailwind CSS 4 整合點（重要）

只有兩行 `@import`，**不需要 `tailwind.config.js`、不需要 PostCSS 設定、不需要手動加 `@tailwindcss/vite`**：

```css
/* app/assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";
```

我在 tarball 裡 grep `dist/module.mjs`，確認它自己引用 `@tailwindcss/vite` 與 `@tailwindcss/postcss`（兩者都是 `@nuxt/ui` 的 bundled dependency），由 module 負責注入 build plugin。官方安裝頁也完全沒提到要自己加 Vite plugin。

`@import "@nuxt/ui"` 展開後的實際內容（我從 `dist/runtime/index.css` 讀出，這是 v4 的骨架）：

```css
@import "#build/ui.css";
@import "./keyframes.css";
@source "./components";
@variant light (&:where(.light, .light *));
@variant dark  (&:where(.dark, .dark *));
@layer base  { a:focus-visible { outline-offset: 0 } }
@layer theme { :host,:root { --ui-header-height:4rem; --ui-radius:0.25rem; --ui-container:80rem } … }
```

三件事值得記住：
- dark 變體是 **`.dark` class 策略**，且用 `:where()` 包起來（**specificity 為 0**）。
- Nuxt UI 自己的樣式都塞進 `@layer base` / `@layer theme`。
- `@source "./components"` 讓 Tailwind 掃描 Nuxt UI 元件裡的 class。

### 1.4 app.vue

```vue
<template>
  <UApp>
    <NuxtPage />
  </UApp>
</template>
```

文件原文：「The `App` component sets up global config and is required for **Toast**, **Tooltip** and **programmatic overlays**.」——`useOverlay()`（程式化開 Modal/Slideover）沒有 `UApp` 就不能用。

### 1.5 Module options（從 `dist/module.d.mts` 型別定義實際讀出）

```ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ui: {
    prefix: 'U',            // 預設 'U'
    fonts: true,            // 預設 true → 自動註冊 @nuxt/fonts
    colorMode: true,        // 預設 true → 自動註冊 @nuxtjs/color-mode
    theme: {
      colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error'],
      transitions: true,
      unstyled: false,
      defaultVariants: { color: 'primary', size: 'md' },
      prefix: undefined     // Tailwind utility 前綴，例 'tw'
    },
    prose: false,
    content: false,
    experimental: {
      // 只為實際用到的元件產生 theme 檔 → 大幅減少 build 產物
      componentDetection: false  // 預設 false
    }
  }
})
```

**`@nuxt/fonts`、`@nuxt/icon`、`@nuxtjs/color-mode` 都是 `@nuxt/ui` 的 bundled dependency，會自動註冊**，你不用（也不該）另外裝。

**給 filmnote 的建議**：`experimental.componentDetection: true`。v4 共有 124 個元件（見下），預設會替全部產生 theme 檔；你大概只用得到 20 個。Vercel Hobby 有 build 時間與產物大小限制，這個開關值得開。它從 v4.1.0 加入（`module: add experimental.componentDetection option (#5222)`）。

### 1.6 逐路由混合算繪（SSR 公開頁 + SPA 登入後）

這是 **Nuxt 的 `routeRules`**，不是 Nuxt UI 的功能，Nuxt UI 不會干擾：

```ts
routeRules: {
  '/':            { prerender: true },
  '/u/**':        { ssr: true },   // 公開個人頁：SEO / OG
  '/film/**':     { ssr: true },
  '/app/**':      { ssr: false },  // 登入後 SPA
  '/settings/**': { ssr: false }
}
```

⚠️ 唯一要注意的 Nuxt UI 交集：**color mode 在 SSR 頁會有 hydration flash**。官方 color-mode 範例把切換元件包在 `<ClientOnly>` 裡並給 fallback div。

---

## 2. 本專案需要的元件現況

### 2.1 資料表格 — `UTable`（3,000+ 筆片庫 + 虛擬捲動）✅ 完全可行

來源：<https://ui.nuxt.com/docs/components/table>

- 底層是 **TanStack Table v8**（`@tanstack/vue-table@^8.21.3`，實際 dependency）
- **虛擬捲動底層是 `@tanstack/vue-virtual@^3.13.35`**（實際 dependency）
- `virtualize` prop 在 **v4.1.0**（2025-10-23）加入，release note 標題就是「⚡️ Component Virtualization」

```vue
<template>
  <UTable
    sticky
    virtualize
    :data="films"
    :columns="columns"
    class="flex-1 h-80"
  />
</template>
```

`virtualize` 可傳 boolean 或物件：

```vue
<UTable
  :virtualize="{
    estimateSize: 65,        // 預估列高 px
    overscan: 12,            // 視窗外多算幾列
    getScrollElement: () => scrollEl,  // 用外部捲動容器（v4.10.0 加入）
    scrollMargin: 0
  }"
  :data="films"
  :columns="columns"
/>
```

**官方警告（原文）**：「A height constraint is required on the table for virtualization to work properly」——必須給高度（`class="h-[600px]"` 或 flex 容器 + `flex-1`）。

**限制（官方明列）**：**啟用 virtualization 時不支援 row pinning。**

其他已驗證的能力：`v-model:pagination`、`v-model:sorting`、`v-model:row-selection`、`v-model:global-filter`（Table.vue 內部確實引用 `getFilteredRowModel` 與 `globalFilter`）、`loading` / `loading-color` / `loading-animation`、`#expanded` slot、`get-sub-rows`（樹狀）、`getGroupedRowModel`。`sticky` header 在 v4.7.0 起支援 virtualized 模式（`Table: support sticky header/footer in virtualized mode (#6217)`）。

其他虛擬化元件：`UScrollArea`（v4.3.0 新增）、`UListbox`（v4.7.0 新增）、`UCommandPalette`、`UInputMenu`、`USelectMenu`、`UTree` 全部支援 `virtualize`。

### 2.2 日期時間選擇器 — `UInputDate` + `UInputTime`（**這是 v4 才有的，別再用 Popover + Calendar 手工拼**）

`UInputDate` 與 `UInputTime` 是 **v4.2.0（2025-11-18）新增**的元件，release note 原文：

> ### 📅 New InputDate & InputTime components
> Two new components are now available to handle date and time inputs: **InputDate** (#5387) and **InputTime** (#5302)

底層全部是 `@internationalized/date`（`^3.12.3`，實際 dependency）+ reka-ui。

```vue
<script setup lang="ts">
import { CalendarDateTime, now, getLocalTimeZone } from '@internationalized/date'

// watched_at：日期 + 時間
const watchedAt = shallowRef(now(getLocalTimeZone()))
</script>

<template>
  <UFormField label="觀影時間" name="watched_at" required>
    <UInputDate v-model="watchedAt" granularity="minute" locale="zh-TW" />
  </UFormField>
</template>
```

- `UInputDate` 的 v-model 型別：`CalendarDate | CalendarDateTime | ZonedDateTime`，或 range 時 `{ start, end }`
- `granularity`: `'day' | 'hour' | 'minute' | 'second'` —— **`granularity="minute"` 就能一個元件搞定日期＋時間**
- `hour-cycle`: `12 | 24`
- `min-value` / `max-value` / `is-date-unavailable(date)`
- `locale` prop 在 **v4.8.2** 被「restore」（`InputNumber/InputDate/InputTime/Calendar: restore locale prop (#6546)`）—— 中間版本一度被拿掉（v4.2.0 的 `components: remove locale / dir props proxy (#5432)`），4.8.2 才修回來。**若你 pin 到 4.2.0–4.8.1 之間，`locale` prop 不存在。**

`UInputTime` 獨立使用：

```vue
<script setup lang="ts">
import { Time } from '@internationalized/date'
const value = shallowRef(new Time(12, 30, 0))
</script>
<template>
  <UInputTime v-model="value" />
</template>
```

若要傳統的「按鈕 → 彈出月曆」：

```vue
<UPopover>
  <UButton color="neutral" variant="subtle" icon="i-lucide-calendar">
    {{ modelValue ? df.format(modelValue.toDate(getLocalTimeZone())) : '選擇日期' }}
  </UButton>
  <template #content>
    <UCalendar v-model="modelValue" class="p-2" />
  </template>
</UPopover>
```

⚠️ **`UCalendar` 本身沒有時間選擇 UI**（雖然它的 v-model 接受 `CalendarDateTime`）。要日期＋時間就用 `UInputDate granularity="minute"`，或 `UInputDate` + `UInputTime` 併排。

### 2.3 下拉選擇（107 家影城 + 4 個非影城）— `USelectMenu`

來源：<https://ui.nuxt.com/docs/components/select-menu>

三個元件的差別（官方原文）：
- `USelect`：原生 select，無搜尋
- `USelectMenu`：「an advanced searchable select element」，底層 Reka UI **Combobox**，搜尋框在選單內
- `UInputMenu`：「similar to the InputMenu but it's using a Select instead of an Input with the search inside the menu」—— 搜尋框就是 trigger 本身

111 個選項用 `USelectMenu` + 分組最合適：

```vue
<script setup lang="ts">
const venues = [
  // 分組：傳入陣列的陣列
  [
    { label: '威秀影城 信義', value: 'tax:12345678', city: '臺北市', icon: 'i-lucide-clapperboard' },
    // … 107 家
  ],
  [
    { label: '串流平台', value: 'virtual:streaming', icon: 'i-lucide-monitor-play' },
    { label: '影展',     value: 'virtual:festival',  icon: 'i-lucide-ticket' },
    { label: '家中',     value: 'virtual:home',      icon: 'i-lucide-house' },
    { label: '其他',     value: 'virtual:other',     icon: 'i-lucide-circle-ellipsis' }
  ]
]
const venue = ref()
</script>

<template>
  <USelectMenu
    v-model="venue"
    value-key="value"
    :items="venues"
    :filter-fields="['label', 'city']"
    placeholder="選擇觀影場所"
  />
</template>
```

已驗證的關鍵 props：
- `value-key`：只綁物件的某個欄位（**不加就會把整個物件綁進 v-model**，這是最常踩的雷）
- `label-key`：預設 `'label'`
- `filter-fields`：預設 `[labelKey]` —— **你想同時搜「影城名」和「城市」就一定要設**
- `ignore-filter`：關掉內建搜尋，改用自己的 async 查詢（片名搜尋 TMDB 用得上）
- `v-model:search-term`：外部控制搜尋字串
- `multiple`、`create-item`（使用者自建作品的入口）、`virtualize`（v4.1.0+）
- `useInfiniteScroll`（VueUse）相容（v4.4.0+）

**⚠️ 搜尋演算法的重要更正**：官方文件與很多二手資料會讓人以為用 fuse.js。我實際 grep 了 tarball：

```
package/dist/runtime/composables/useFilter.js
  import { useFilter as useRekaFilter } from "reka-ui";
  const { contains, startsWith } = useRekaFilter({ sensitivity: "base" });
```

`SelectMenu` / `InputMenu` / `Listbox` 用的是 **Reka UI 的 `useFilter`（底層 `Intl.Collator`，`sensitivity: 'base'`）—— 是子字串比對，不是模糊比對**。fuse.js 在整包裡只被 `utils/search`（`CommandPalette` / `ContentSearch`）使用。

對 filmnote 的意涵：
- 影城清單（111 項、繁體中文）用子字串比對完全夠，且行為可預測。
- **片名搜尋（3,000+ 筆、要同時比對中文與原文、要容錯）不要靠 `USelectMenu` 的內建 filter。** 設 `ignore-filter` + `v-model:search-term`，改打你自己的 Supabase 全文檢索或 RPC。

### 2.4 Modal / Slideover

來源：<https://ui.nuxt.com/docs/components/modal>、<https://ui.nuxt.com/docs/components/slideover>

宣告式：

```vue
<UModal v-model:open="open" title="新增紀錄" description="…">
  <template #body>…</template>
  <template #footer>…</template>
</UModal>
```

`UModal` props：`v-model:open`、`default-open`、`title`、`description`、`fullscreen`、`dismissible`（預設 `true`）、`overlay`（預設 `true`）、`scrollable`（v4.2.0 加入）、`unmount-on-hide`（**預設 `true`**）。
Slots：`#content`（用了就沒有預設 close 鈕）、`#header`、`#body`、`#footer`、`#title`、`#description`、`#close`。

`USlideover`：`side`（`right` 預設 / `left` / `top` / `bottom`）、`inset`（v4.3.0 加入），slots 同上。

程式化（需要 `UApp`）：

```ts
import { LazyRecordModal } from '#components'

const overlay = useOverlay()
const modal = overlay.create(LazyRecordModal)

const instance = modal.open({ filmId })
const result = await instance.result   // 子元件 emit('close', payload) 的 payload
modal.patch({ filmId: newId })         // 開著的時候改 props
```

### 2.5 表單驗證 — `UForm` + `UFormField`

來源：<https://ui.nuxt.com/docs/components/form>

支援：**Zod、Valibot、Yup、Joi、Superstruct、Regle**，以及任何 **Standard Schema** 實作（`@standard-schema/spec@^1.1.0` 是實際 dependency）。

**官方警告（原文）**：「No validation library is included by default, ensure you install the one you need.」`zod` 的 peer 範圍是 `^3.24.0 || ^4.0.0`。

```vue
<script setup lang="ts">
import * as z from 'zod'
import type { FormSubmitEvent } from '@nuxt/ui'

const schema = z.object({
  film_id:    z.string().min(1, '請選擇作品'),
  watched_at: z.string().datetime(),
  venue_id:   z.string().min(1, '請選擇觀影場所'),
  cost:       z.number().int().nonnegative().optional(),
  tickets:    z.number().int().positive().optional(),
  hall:       z.string().optional(),
  version:    z.enum(['IMAX', '3D', '數位', '4DX']).optional(),
  memo:       z.string().max(500).optional()
})
type Schema = z.output<typeof schema>

const state = reactive<Partial<Schema>>({ watched_at: new Date().toISOString() })

async function onSubmit(event: FormSubmitEvent<Schema>) {
  await $fetch('/api/records', { method: 'POST', body: event.data })
}
</script>

<template>
  <UForm :schema="schema" :state="state" @submit="onSubmit">
    <UFormField label="作品" name="film_id" required>
      <USelectMenu v-model="state.film_id" ignore-filter … />
    </UFormField>
    <UFormField label="票價" name="cost" hint="選填">
      <UInputNumber v-model="state.cost" />
    </UFormField>
    <UButton type="submit">儲存</UButton>
  </UForm>
</template>
```

其他已驗證：
- `validate-on` 預設 `['blur', 'change', 'input']`；submit 一定會驗
- 巢狀欄位用 dot notation（`user.email`）；陣列用 `tags.0`，或 `UFormField` 的 `error-pattern` 傳 regex
- 程式化：`form.submit()`（會先跑 HTML5 驗證）、`form.validate()`、`form.clear(path)`、`form.setErrors(errors)`
- 暴露：`errors`、`dirty`、`dirtyFields`、`touchedFields`、`blurredFields`
- **v3→v4 breaking**：`nullify` modifier 改名 `nullable`，新增 `optional` modifier；巢狀 form 現在必須顯式加 `nested` 與 `name` prop；schema transform 只作用在 `@submit` 的 data，不改 form state

### 2.6 額外：`useIMEGuard` 與注音輸入

v4 內建 `useIMEGuard` composable（處理 `event.isComposing` / `keyCode === 229`）。但我 grep 過整包 runtime：**只有 `ChatPrompt.vue` 用它**。`SelectMenu` / `InputMenu` 的搜尋框依賴 Reka UI Combobox 自己的 composition 處理。中文 IME 輸入行為需要實機驗證（見未驗證清單）。

---

## 3. Pro 是否真的全部併入免費 MIT？—— 是，已完整驗證

### 3.1 證據鏈

1. `npm view @nuxt/ui@4.11.0 license` → **`MIT`**
2. `@nuxt/ui-pro` 的 npm latest 停在 **3.3.7**，**沒有 v4**
3. [GitHub release v4.0.0](https://github.com/nuxt/ui/releases/tag/v4.0.0)（2025-09-23）原文：
   > We are excited to announce Nuxt UI v4, a major milestone that unifies Nuxt UI and Nuxt UI Pro into a single, fully open-source library. Following [NuxtLabs joining Vercel](https://vercel.com/blog/nuxtlabs-joins-vercel) in July, we're now able to offer 100+ production-ready components and a complete Figma Kit available for free to everyone.
   >
   > * **100+ components**: Complete access to all components, including those previously exclusive to Pro
   > * **Figma Kit**: Professional design resources now available to everyone
   > * **Single package**: Everything unified under `@nuxt/ui`
4. 12 個原本 Pro 限定的 template 也全部免費（Starter / Landing / Docs / SaaS / Dashboard / Chat / Portfolio / Changelog…）

### 3.2 哪些元件先前屬 Pro（權威清單）

我把 `@nuxt/ui-pro@3.3.7` 的 tarball 解開，列出 `dist/runtime/components/*.vue`，這是**確定性的 48 個**（不是猜的）：

```
AuthForm  Banner  BlogPost  BlogPosts
ChangelogVersion  ChangelogVersions
ChatMessage  ChatMessages  ChatPalette  ChatPrompt  ChatPromptSubmit
DashboardGroup  DashboardNavbar  DashboardPanel  DashboardResizeHandle
DashboardSearch  DashboardSearchButton  DashboardSidebar
DashboardSidebarCollapse  DashboardSidebarToggle  DashboardToolbar
Error  Footer  FooterColumns  Header  Main
Page  PageAccordion  PageAnchors  PageAside  PageBody  PageCard
PageColumns  PageCTA  PageFeature  PageGrid  PageHeader  PageHero
PageLinks  PageList  PageLogos  PageMarquee  PageSection
PricingPlan  PricingPlans  PricingTable  User
```

`@nuxt/ui@4.11.0` 現在有 **124 個元件**（同樣是解 tarball 數出來的）。上述 48 個全數在內（`PageAccordion` 除外——見下方 migration）。

**對 filmnote 有直接價值的前 Pro 元件**：
- `UPage` / `UPageHeader` / `UPageBody` / `UPageGrid` / `UPageCard` / `UPageHero` → 公開個人頁 `/u/{username}` 與電影頁的版面
- `UHeader` / `UFooter` / `UFooterColumns` → 頁尾放**政府開放資料顯名聲明 + TMDB attribution**（法遵要件）
- `UBanner` → 頂部橫幅，可放 DMCA / 服務條款公告
- `UUser` → 使用者卡片
- `UError` → 404 / 錯誤頁
- `UAuthForm` → 雖然你用 Google OAuth 為主，仍可作為登入頁骨架
- `UDashboard*` → 管理者的作品審核 / 合併重複作品後台

### 3.3 v3 → v4 migration 要點

來源：<https://ui.nuxt.com/docs/getting-started/migration>

| 項目 | 變更 |
|---|---|
| 相依 | 移除 `@nuxt/ui-pro`，改 `@nuxt/ui` + `tailwindcss` |
| module | `'@nuxt/ui-pro'` → `'@nuxt/ui'` |
| CSS | `@import "@nuxt/ui-pro"` → `@import "@nuxt/ui"` |
| app.config | key `uiPro` → `ui` |
| 型別 import | `'@nuxt/ui-pro'` → `'@nuxt/ui'` |
| Vite plugin | `uiPro` → `ui` |
| 元件改名 | `ButtonGroup` → **`FieldGroup`** |
| 元件改名 | `PageMarquee` → **`Marquee`** |
| 元件移除 | `PageAccordion` → 改用 `Accordion`（要加 `unmount-on-hide="false"` 與自訂 `ui` prop） |
| Form | `nullify` → `nullable`；新增 `optional` |
| Nuxt Content | `findPageBreadcrumb` / `findPageHeadline` → 改從 `@nuxt/content/utils` import |

filmnote 是新專案，這段只當作「不要照抄舊部落格文章」的提醒。

### 3.4 v4.x 期間新增（v4.0.0 之後、不在 Pro 裡的全新元件）

`Empty`(4.1)、`ScrollArea`(4.3)、`Editor*` 六件套(4.3)、`InputDate` / `InputTime`(4.2)、`Sidebar`(4.6)、`Listbox`(4.7)、`ColorPicker`、`InputRating`、`Theme`、`Tour`（`useTour` composable）。

---

## 4. 深色模式與主題自訂

來源：<https://ui.nuxt.com/docs/getting-started/theme>、<https://ui.nuxt.com/docs/getting-started/color-mode/nuxt>

### 4.1 深色模式

`@nuxtjs/color-mode` 是 `@nuxt/ui` 的 bundled dependency（`^4.0.1`），**自動註冊，零設定**。

關閉：
```ts
ui: { colorMode: false }
```

策略是 **`.dark` class**，且 Nuxt UI 用 `:where()` 讓它 **specificity = 0**（我從 `dist/runtime/index.css` 讀出）：
```css
@variant light (&:where(.light, .light *));
@variant dark  (&:where(.dark, .dark *));
```

切換：
```ts
const colorMode = useColorMode()
const isDark = computed({
  get() { return colorMode.value === 'dark' },
  set(_isDark) { colorMode.preference = _isDark ? 'dark' : 'light' }
})
```

現成元件：`UColorModeButton`、`UColorModeSwitch`、`UColorModeSelect`、`UColorModeAvatar`、`UColorModeImage`。

⚠️ SSR：官方範例把切換器包在 `<ClientOnly>` + fallback div 裡，避免 hydration mismatch。你的公開頁是 SSR，**必須照做**。

### 4.2 主題（Tailwind 4 CSS-first）

七個語意色：`primary`(green)、`secondary`(blue)、`success`(green)、`info`(blue)、`warning`(yellow)、`error`(red)、`neutral`(slate)。

執行期改色（`app/app.config.ts`）：
```ts
export default defineAppConfig({
  ui: {
    colors: { primary: 'blue', secondary: 'purple', neutral: 'zinc' }
  }
})
```

自訂色票（`app/assets/css/main.css`）：
```css
@import "tailwindcss";
@import "@nuxt/ui";

@theme static {
  --color-brand-50:  #fef2f2;
  --color-brand-100: #fee2e2;
  /* … 一路到 950，50–950 全部要有 */
}
```

新增語意色別名（`nuxt.config.ts` 註冊 → `app.config.ts` 指派）：
```ts
ui: { theme: { colors: ['primary', 'secondary', 'tertiary', 'info', 'success', 'warning', 'error'] } }
```

設計 token（實測從 `dist/runtime/index.css` 讀出，light 與 `.dark` 兩套）：
`--ui-text-dimmed / -muted / -toned / --ui-text / -highlighted / -inverted`、
`--ui-bg / -muted / -elevated / -accented / -inverted`、
`--ui-border / -muted / -accented / -inverted`、
`--ui-radius`(0.25rem)、`--ui-container`(80rem)、`--ui-header-height`(4rem)。

覆寫單一元件 theme：在 `app.config.ts` 的 `ui.<component>` 下，或 inline 用 `:ui="{ … }"` prop。

### 4.3 i18n / 繁體中文 ✅

我在 tarball 裡確認 `dist/runtime/locale/` 有 63 個 locale，**`zh_tw.js` 存在**，內容：

```js
export default defineLocale({
  name: '繁體中文',
  code: 'zh-TW',
  messages: {
    calendar: { nextMonth: '下個月', nextYear: '明年', prevMonth: '上個月', prevYear: '去年' },
    …
  }
})
```

`dist/runtime/locale/index.js` 有 `export { default as zh_tw } from "./zh_tw.js"`，且 `package.json` 的 `exports` 含 `"./locale"`。

```vue
<script setup lang="ts">
import { zh_tw } from '@nuxt/ui/locale'
</script>

<template>
  <UApp :locale="zh_tw">
    <NuxtPage />
  </UApp>
</template>
```

> 注意：檔名/具名匯出是**底線** `zh_tw`，不是 `zh-tw`。官方 i18n 文件頁只說「50+ locales」沒列清單，我是從實際套件驗證的。

---

## 5. 與 ECharts 共存 —— 真正的地雷不是 layer，是 **oklch**

### 5.1 結論先講

**Tailwind 4 的 CSS cascade layer 不會影響 ECharts 的容器尺寸計算。** 但 Tailwind 4 有另一個更致命、且直接命中你「圖表用 Nuxt UI 主題色」需求的問題：**Tailwind 4 / Nuxt UI 的所有色票都是 `oklch()`，而 ECharts 的色彩解析器完全看不懂 `oklch`。**

### 5.2 為什麼 layer 不影響尺寸（已逐項驗證）

Tailwind 4 的 layer 宣告（官方 preflight 文件原文）：
```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css"     layer(theme);
@import "tailwindcss/preflight.css" layer(base);
@import "tailwindcss/utilities.css" layer(utilities);
```

Preflight 對 media 元素的規則（官方原文）：
```css
img, svg, video, canvas, audio, iframe, embed, object {
  display: block;
  vertical-align: middle;
}
img, video {
  max-width: 100%;
  height: auto;
}
```

三個關鍵觀察：
1. **`canvas { display: block }` 對 ECharts 是好事** —— 消除 inline 元素的 baseline descender 造成的容器高度多出 ~4px。
2. **`max-width: 100%; height: auto` 只作用在 `img, video`，不含 `canvas` 與 `svg`** —— ECharts 的 canvas 不會被壓扁。這點常被誤傳。
3. ECharts `init()` 之後會在容器上寫 **inline style**（`position`、`width`、`height`），**inline style 的優先權高於任何 cascade layer**，所以 Tailwind 的 layer 完全碰不到 ECharts 的內部尺寸。

### 5.3 layer 真正的副作用（要知道，但方向跟你擔心的相反）

CSS cascade layer 規範：**未分層（unlayered）的宣告優先權高於所有分層宣告，無視 specificity。** Vue SFC 的 `<style scoped>` 經 Vite 處理後**是未分層的**。

所以在 Tailwind 4：
```vue
<div class="h-[400px] chart" ref="el" />

<style scoped>
.chart { height: 100%; }   /* ← 未分層，贏過 @layer utilities 的 h-[400px] */
</style>
```

在 Tailwind 3 這會是「specificity 相同、後者勝」；在 Tailwind 4 是「**未分層必勝，跟順序與 specificity 都無關**」。若父層沒有確定高度，`height: 100%` 會解析成 `auto` → 容器高度 0 → **ECharts 初始化成 0×0，圖表空白**。這是 v4 才出現的行為反轉。

Tailwind 官方在 [compatibility 頁](https://tailwindcss.com/docs/compatibility)的建議（原文）：
> "If you're using Tailwind with these tools, **we recommend avoiding `<style>` blocks in your components** and just styling things with utility classes directly in your markup, the way Tailwind is meant to be used."

若非用不可，要嘛加 `@reference "../app.css";` 才能用 `@apply`，要嘛直接用 CSS 變數：
```vue
<style scoped>
button { background-color: var(--color-blue-500); }
</style>
```

**給 filmnote 的規則：圖表容器高度一律用 Tailwind utility，不要在 SFC 開 `<style scoped>`。**

### 5.4 真正的地雷：oklch（**這一段最重要**）

我實際解開 `tailwindcss@4.3.3` 的 `theme.css`：
```
--color-red-500:   oklch(63.7% 0.237 25.331)
--color-green-500: oklch(72.3% 0.219 149.579)
--color-blue-500:  oklch(62.3% 0.214 259.815)
```

Nuxt UI 生成的 `ui.static.css` 同樣是 oklch：
```
--color-old-neutral-50:  oklch(98.5% 0 none);
--color-old-neutral-500: oklch(55.6% 0 none);
```

然後我解開 `zrender@6.1.0`（ECharts 6.1.0 的算繪層）的 `lib/tool/color.js`，`parse()` 的 switch 只有四個 case：

```js
var str = colorStr.replace(/ /g, '').toLowerCase();   // ← 先把空白全部拿掉
…
var params = str.substr(op + 1, ep - (op + 1)).split(',');   // ← 只用逗號切
switch (fname) {
    case 'rgba': …
    case 'rgb':  …
    case 'hsla': …
    case 'hsl':  …
    default:
        return;          // ← undefined
}
```

`oklch(72.3% 0.219 149.579)` 走到 `default` → **回傳 `undefined`**。

已知的上游 issue（皆為 **open**，我用 GitHub API 查證）：
- [apache/echarts#20757 「OKLCH Color Support」](https://github.com/apache/echarts/issues/20757)（2025-02-13 開，至 2026-09-05 仍 open）。原文：
  > "Now that tailwind css is using oklch colors, it would be great to be able to pass them as the colors for ECHARTS. … **Currently if you do this the series goes blank when you hover over it.**"
- [apache/echarts#19604 「color parse() does not understand new spec rgb and hsl colors」](https://github.com/apache/echarts/issues/19604)（2024-02-09 開，仍 open）。連 `hsl(229deg 73% 50%)` 這種空白分隔的現代語法都解析失敗（因為上面那行 `.split(',')`）。

**症狀為什麼隱蔽**：靜態填色時，ECharts 有些路徑會把字串原樣丟給 canvas 的 `fillStyle`，而瀏覽器原生支援 oklch，所以**初次算繪看起來是正常的**。爆掉的是需要「插值 / 加亮 / 變暗 / 漸層 / 動畫」的路徑 —— 也就是 **hover emphasis、`LinearGradient`、`visualMap`、色彩過場動畫**。你會在 demo 時一切正常，使用者滑過長條圖時整條變空白。

### 5.5 建議做法（給 filmnote 的圖表色票）

**首選：另開一組 hex 色票，圖表只吃這組，不要去讀 Nuxt UI 的 `--ui-color-*`。**

```css
/* app/assets/css/main.css */
@import "tailwindcss";
@import "@nuxt/ui";

@theme static {
  /* ECharts 專用：一律 hex，zrender 才解析得了 */
  --color-chart-1: #10b981;
  --color-chart-2: #3b82f6;
  --color-chart-3: #f59e0b;
  --color-chart-4: #ef4444;
  --color-chart-5: #8b5cf6;
  --color-chart-grid: #e5e7eb;
  --color-chart-text: #6b7280;
}

:root:where(.dark) {
  --color-chart-grid: #374151;
  --color-chart-text: #9ca3af;
}
```

```ts
// composables/useChartTheme.ts
export function useChartTheme() {
  const colorMode = useColorMode()

  function readVar(name: string) {
    // @theme static 寫的是字面值，getComputedStyle 會原樣回傳 '#10b981'
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  }

  const palette = computed(() => {
    void colorMode.value  // 讓 dark/light 切換觸發重算
    return {
      series: [1, 2, 3, 4, 5].map(i => readVar(`--color-chart-${i}`)),
      grid:   readVar('--color-chart-grid'),
      text:   readVar('--color-chart-text')
    }
  })

  return { palette }
}
```

**次選（若你堅持要同步 Nuxt UI 主題色）**：用 canvas 讓瀏覽器把 oklch 正規化：

```ts
function oklchToLegacy(cssColor: string): string {
  const ctx = document.createElement('canvas').getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillStyle = cssColor          // 瀏覽器原生解析 oklch()
  return ctx.fillStyle as string    // 通常回 '#rrggbb'
}
```
⚠️ 這招我**沒有實機驗證**：Canvas 2D `fillStyle` 對超出 sRGB 色域的 oklch 的序列化行為依瀏覽器而異（可能回 `color(display-p3 …)`，那 zrender 一樣解析不了）。當作 fallback，不要當主方案。

### 5.6 ECharts 在 Nuxt SSR / Nuxt UI 容器裡的其他注意事項

1. **必須 client-only**。ECharts 會碰 `document`。用 `<ClientOnly>` 包，或 `.client.vue` 檔名，或 `import.meta.client` 守衛。
2. **容器必須有確定高度**，且是在 `init()` 之前就有。用 Tailwind utility（`h-80`、`h-[400px]`、或 `flex-1` + 父層固定高），不要用 `h-auto`、也不要靠 SFC scoped style（見 5.3）。
3. **`UModal` / `USlideover` 的 `unmount-on-hide` 預設 `true`** —— 圖表每次開關都重新掛載，是安全的；但如果你為了保留狀態設成 `false`，隱藏時容器是 0×0，再顯示時**必須手動 `chart.resize()`**。
4. **`UTabs` / `UCollapsible` / `UAccordion` 的非作用中面板同理**，Reka UI 的 Presence 會讓內容存在但尺寸為 0。切到該 tab 時要 resize。
5. **用 `vue-echarts@8.2.0` 的 `autoresize` prop**（底層 ResizeObserver），比自己聽 `window.resize` 可靠 —— 因為 `USidebar` / `UDashboardPanel` 收合時視窗大小沒變，`window.resize` 不會觸發。
6. **深色模式切換要重設 option**。監聽 `useColorMode()`，重新 `setOption()`（軸線、文字、grid 顏色）。因為圖表色是 JS 端算的，CSS 的 `.dark` 切換管不到 canvas 裡面。
7. **tree-shaken import 要記得註冊 canvas renderer**：

```ts
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart, HeatmapChart, PieChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent,
  VisualMapComponent, CalendarComponent, TitleComponent
} from 'echarts/components'

use([
  CanvasRenderer,
  BarChart, LineChart, HeatmapChart, PieChart,
  GridComponent, TooltipComponent, LegendComponent,
  VisualMapComponent, CalendarComponent, TitleComponent
])
```
> 你的貢獻圖需要 **`CalendarComponent` + `HeatmapChart` + `VisualMapComponent`**；星期×時段熱力圖需要 `HeatmapChart` + `GridComponent` + `VisualMapComponent`。`VisualMapComponent` 的漸層色**一定要 hex**（它就是走色彩插值路徑，oklch 必死）。

8. **手機可讀性**（User Story #43）：ECharts 的 `media` responsive option 或依 `useBreakpoints` 切 option 都可以，跟 Nuxt UI 無衝突。

---

## 6. 給 filmnote 的建議設定（可直接抄）

```jsonc
// package.json（新增部分）
{
  "engines": { "node": ">=22.12.0" },   // ← 從 >=22 收緊，見 gotcha
  "dependencies": {
    "nuxt": "4.5.2",
    "@nuxt/ui": "^4.11.0",
    "tailwindcss": "^4.3.3",
    "@nuxtjs/supabase": "^2.0.10",
    "echarts": "^6.1.0",
    "vue-echarts": "^8.2.0",
    "@internationalized/date": "^3.12.3",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "5.9.3"               // ← 精確 pin，不用 ^
  }
}
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@nuxtjs/supabase'],
  css: ['~/assets/css/main.css'],
  ui: {
    experimental: { componentDetection: true }
  },
  routeRules: {
    '/u/**':    { ssr: true },
    '/film/**': { ssr: true },
    '/app/**':  { ssr: false },
  }
})
```

```vue
<!-- app/app.vue -->
<script setup lang="ts">
import { zh_tw } from '@nuxt/ui/locale'
</script>

<template>
  <UApp :locale="zh_tw">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
```

---

## 來源清單

| 來源 | URL | 擷取方式 |
|---|---|---|
| Nuxt 安裝 | <https://ui.nuxt.com/docs/getting-started/installation/nuxt> | WebFetch 2026-09-05 |
| 主題 | <https://ui.nuxt.com/docs/getting-started/theme> | WebFetch 2026-09-05 |
| Color mode | <https://ui.nuxt.com/docs/getting-started/color-mode/nuxt> | WebFetch 2026-09-05 |
| i18n | <https://ui.nuxt.com/docs/getting-started/i18n/nuxt> | WebFetch 2026-09-05 |
| Migration v3→v4 | <https://ui.nuxt.com/docs/getting-started/migration> | WebFetch 2026-09-05 |
| Table | <https://ui.nuxt.com/docs/components/table> | WebFetch 2026-09-05 |
| Table 虛擬化 | <https://ui.nuxt.com/docs/components/table#with-virtualization> | WebFetch 2026-09-05 |
| SelectMenu | <https://ui.nuxt.com/docs/components/select-menu> | WebFetch 2026-09-05 |
| Listbox | <https://ui.nuxt.com/docs/components/listbox> | WebFetch 2026-09-05 |
| Calendar | <https://ui.nuxt.com/docs/components/calendar> | WebFetch 2026-09-05 |
| InputDate | <https://ui.nuxt.com/docs/components/input-date> | WebFetch 2026-09-05 |
| InputTime | <https://ui.nuxt.com/docs/components/input-time> | WebFetch 2026-09-05 |
| Modal | <https://ui.nuxt.com/docs/components/modal> | WebFetch 2026-09-05 |
| Slideover | <https://ui.nuxt.com/docs/components/slideover> | WebFetch 2026-09-05 |
| Form | <https://ui.nuxt.com/docs/components/form> | WebFetch 2026-09-05 |
| v4 公告 | <https://nuxt.com/blog/nuxt-ui-v4> ／ <https://github.com/nuxt/ui/releases/tag/v4.0.0> | WebFetch + GitHub API |
| Release notes v4.1–v4.11 | <https://github.com/nuxt/ui/releases> | GitHub API 2026-09-05 |
| Tailwind Preflight | <https://tailwindcss.com/docs/preflight> | WebFetch 2026-09-05 |
| Tailwind Compatibility | <https://tailwindcss.com/docs/compatibility> | WebFetch 2026-09-05 |
| ECharts oklch issue | <https://github.com/apache/echarts/issues/20757> | GitHub API（open） |
| ECharts hsl parse issue | <https://github.com/apache/echarts/issues/19604> | GitHub API（open） |
| 套件內部實作 | `npm pack @nuxt/ui@4.11.0` / `@nuxt/ui-pro@3.3.7` / `zrender@6.1.0` / `tailwindcss@4.3.3` | 解 tarball 直接讀原始碼 |


## 踩雷點

- ECharts 完全看不懂 oklch —— 這是最大的雷。Tailwind 4.3.3 的預設色票與 Nuxt UI 的 --ui-color-* / --color-* token 全是 oklch()，而 zrender 6.1.0 的 lib/tool/color.js 的 parse() switch 只有 rgba/rgb/hsla/hsl 四個 case，其餘一律 `default: return;`（undefined）。症狀極隱蔽：靜態填色因為瀏覽器原生支援 oklch 而看起來正常，一旦走到 hover emphasis、LinearGradient、visualMap、色彩動畫等需要插值的路徑就整條變空白。上游 apache/echarts#20757 自 2025-02-13 開至今仍 open。對策：另開一組 hex 色票（@theme static + --color-chart-*），圖表只吃這組，絕不去讀 Nuxt UI 的色票。你的貢獻圖與熱力圖必用 VisualMapComponent，它就是走插值路徑，oklch 必死。
- zrender 的 parse() 在切參數前先做 `colorStr.replace(/ /g, '')` 再 `.split(',')` —— 所以連現代 CSS 空白分隔語法 `rgb(0 0 0)` / `hsl(229deg 73% 50%)` 都解析失敗（apache/echarts#19604，仍 open）。傳給 ECharts 的顏色一律用 hex 或舊式逗號語法 rgba(r, g, b, a)。
- Tailwind 4 的 cascade layer 造成優先權行為反轉：未分層（unlayered）CSS 必勝所有 @layer utilities，無視 specificity 與順序。Vue SFC 的 <style scoped> 經 Vite 處理後是未分層的。所以 `<style scoped>.chart{height:100%}</style>` 會靜靜蓋掉 class 上的 `h-[400px]`；父層若無確定高度就解析成 auto → 容器 0 高 → ECharts 初始化成 0×0 空白圖。在 Tailwind 3 這只是「後者勝」，v4 變成「必勝」。規則：圖表容器高度一律用 utility class，不要在 SFC 開 <style scoped>。
- USelectMenu / UInputMenu / UListbox 的搜尋不是 fuse.js。實測 dist/runtime/composables/useFilter.js 用的是 reka-ui 的 useFilter（底層 Intl.Collator, sensitivity:'base'），是子字串比對而非模糊比對。fuse.js 在整包 runtime 裡只被 utils/search（CommandPalette / ContentSearch）使用。影城選單（111 項）用子字串夠了，但 3,000+ 筆片庫且要同時比中文／原文的搜尋務必設 ignore-filter + v-model:search-term 走自己的 Supabase 查詢。
- USelectMenu 預設把整個 item 物件綁進 v-model，不是綁 value。要綁單一欄位必須顯式加 value-key="..."。另外 filter-fields 預設只有 [labelKey]，想同時搜「影城名 + 城市」一定要設 :filter-fields="['label','city']"。
- UInputDate / UInputTime / UCalendar / UInputNumber 的 locale prop 在 v4.2.0 被 #5432（components: remove locale / dir props proxy）拿掉，直到 v4.8.2 才用 #6546 修回來。若不小心 pin 在 4.2.0–4.8.1 之間，locale prop 不存在，繁中日期格式會壞掉。用 >=4.8.2（建議 ^4.11.0）。
- UCalendar 本身沒有時間選擇 UI（雖然 v-model 接受 CalendarDateTime / ZonedDateTime）。watched_at 需要日期＋時間，正解是 UInputDate granularity="minute"（v4.2.0 才有的新元件），不是舊教學裡的 UPopover + UCalendar。
- UTable 啟用 virtualize 時必須給容器確定高度（官方原文：A height constraint is required on the table for virtualization to work properly），否則虛擬化不生效；且啟用 virtualization 後不支援 row pinning。
- @nuxt/ui@4.11.0 的 engines 是 `^20.19.0 || >=22.12.0`。filmnote 現在的 package.json 寫 `>=22` —— Node 22.0～22.11 會落在 Nuxt UI 的支援範圍外。應收緊成 >=22.12.0。
- @nuxt/ui 的 tailwindcss 同時列在 dependencies（^4.3.3）與 peerDependencies（^4.0.0）。官方安裝指令明確要求 `npm install @nuxt/ui tailwindcss` —— 必須裝成你的直接相依，不能只靠 bundled 的那份。
- Nuxt UI v4 預設會替全部 124 個元件產生 theme 檔。開 `ui: { experimental: { componentDetection: true } }` 只為實際用到的元件產生，對 Vercel Hobby 的 build 時間／產物大小有實質差別。
- @nuxt/fonts、@nuxt/icon、@nuxtjs/color-mode 都是 @nuxt/ui 的 bundled dependency 並自動註冊，不要另外 install 或加進 modules，會衝突。@nuxt/fonts 預設開啟且會在 build 時抓 Google Fonts；若 Vercel build 網路受限或想省時間，用 `ui: { fonts: false }` 關掉。
- SSR 頁面上的 color mode 切換器會 hydration mismatch。官方範例把它包在 <ClientOnly> + fallback div 裡。filmnote 的 /u/** 與 /film/** 是 SSR，必須照做。
- 程式化開 Modal / Slideover（useOverlay()）需要 app.vue 有 <UApp> 包住，Toast 與 Tooltip 也是。漏掉不會有明顯錯誤訊息，只是不動。
- UModal / USlideover 的 unmount-on-hide 預設 true（每次開關重新掛載，對圖表是安全的）；若為保留狀態改成 false，隱藏時容器 0×0，再顯示必須手動 chart.resize()。UTabs / UAccordion / UCollapsible 的非作用中面板同理。
- USidebar / UDashboardPanel 收合時 window 尺寸沒變，window.resize 不會觸發，ECharts 不會自動重算。用 vue-echarts 的 autoresize prop（底層 ResizeObserver），別自己聽 window.resize。
- Nuxt UI 的 locale 具名匯出是底線寫法 `zh_tw`（import { zh_tw } from '@nuxt/ui/locale'），不是 'zh-tw'。官方 i18n 文件頁沒列完整 locale 清單，只寫「50+ locales」。
- v3→v4 已改名：ButtonGroup → FieldGroup、PageMarquee → Marquee、PageAccordion 移除（改用 Accordion + unmount-on-hide="false"）。UForm 的 nullify modifier 改名 nullable，巢狀 form 現在必須顯式加 nested 與 name prop。抄 2025 年的部落格範例會踩到。
- UForm 不內建任何驗證函式庫（官方明確警告）。zod 的 peer 範圍是 ^3.24.0 || ^4.0.0，要自己裝。
- useIMEGuard composable 雖然存在於 v4，但實測整包 runtime 只有 ChatPrompt.vue 用它。SelectMenu 的搜尋框靠 Reka UI Combobox 自己處理 composition —— 注音／拼音輸入時按 Enter 是否會誤選第一個項目，需要實機驗證。

## 未能驗證

- Nuxt UI 官方文件（nuxt.com/blog/nuxt-ui-v4 與 ui.nuxt.com/docs/getting-started/migration）本身並未在頁面上寫出「MIT」字樣，只說 fully open-source / completely free。MIT 這個結論是我從 `npm view @nuxt/ui@4.11.0 license` → `MIT` 以及 GitHub repo 的 license 欄位取得的，並非官方文件的逐字表述。
- Nuxt UI 官方沒有發布過「哪些元件曾屬 Pro」的正式清單。我列的 48 個是解開 @nuxt/ui-pro@3.3.7 tarball 的 dist/runtime/components/*.vue 數出來的，這反映的是 Pro 生命週期最後一版（v3.3.7）的狀態；更早的 Pro v1/v2 可能有已被移除或改名的元件不在其中。
- UTable 在 3,000+ 筆 × 你實際的欄位數（含 cell renderer、UBadge 等）下的真實 FPS 與記憶體用量沒有實測。官方虛擬化範例用的是 1,000 筆的合成資料且欄位簡單。建議先做一次 3,000 筆真實資料的 profiling 再定案。
- 中文 IME（注音／拼音）在 USelectMenu / UInputMenu 搜尋框裡的 composition 行為沒有實機驗證。歷史 issue nuxt/ui#2713（UInput 缺少 compositionstart/compositionend 處理）已 closed，v4 也有 useIMEGuard，但該 composable 實測只被 ChatPrompt 使用。這是繁中產品的高風險點，務必實機測。
- 5.5 節「次選方案」用 Canvas 2D fillStyle 把 oklch 正規化成 hex 的做法，我沒有實機驗證。Canvas 2D 對超出 sRGB 色域的 oklch 的序列化行為依瀏覽器實作而異（可能回傳 color(display-p3 …)，那 zrender 一樣解析不了）。只當 fallback，主方案請用 @theme static 的 hex 色票。
- 「Vue SFC <style scoped> 的輸出是未分層（unlayered）」這點，Tailwind 官方 compatibility 頁只寫了 <style> 區塊被 build tool 分開處理、建議避免使用，並沒有逐字寫出 layer 優先權的後果。未分層必勝分層是 CSS Cascade Layers 規範的行為，我是由「Tailwind 把 preflight/utilities 放進 @layer」（官方文件明列）＋規範推導出來的，未在單一頁面上逐字查到。建議在專案裡實測一次確認。
- @nuxt/ui 的 UTable 是否自動註冊 TanStack 的 getFilteredRowModel（還是需要使用者自行傳入）沒有完全確認。我只 grep 到 Table.vue 內部引用了 getFilteredRowModel 與 globalFilter 這兩個識別字，沒有追進呼叫脈絡。
- Vercel Hobby 對 Nuxt 4 + Nuxt UI v4（124 個元件的 theme 產生）的實際 build 時間與 Serverless Function 大小上限是否會踩到，沒有實測。componentDetection 的實際節省幅度也未量測。
- vue-echarts@8.2.0 與 Nuxt 4 SSR 的整合細節（是否需要 transpile、有沒有 ESM interop 問題）沒有實測，只驗證了它的 peerDependencies 是 vue ^3.3.0 / echarts ^6.0.0，與你的版本相容。
- @nuxtjs/supabase@2.0.10 與 @nuxt/ui@4.11.0 是否有相依衝突（例如 @nuxt/kit 版本）沒有實際跑過安裝驗證。
