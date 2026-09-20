<script setup lang="ts">
import type { Database } from '~/types/database.types'

/**
 * `/` 首頁（`SCREENS §1`，`isr: 300`）。海報牆是**背景**不是主要物件：
 * 「海報牆當背景 ≠ 海報當主角」，分界線是「前景讀起來是暖色收藏冊，還是串流平台」。
 */
/*
 * 三條落實：① 海報降飽和＋壓暗＋蓋實色遮罩，只留輪廓（它不該讓人想去點某一張——
 * 能點的海報就變成主角了）；② 不用漸層、不用發光、不做捲動動畫（會自己滑動的海報牆是
 * Netflix 的簽名）；③ 前景仍是暖紙底＋墨色文字，不是近黑底＋螢光重點色。
 */
/*
 * ⚠️ 海報一律熱連結 `image.tmdb.org`，**不建 proxy、不轉存、不快取到我們的網域**——
 * TMDB 的訂閱買到的是存取 API 的權利不是使用海報的權利。這裡刻意不用 `FilmPoster`：
 * 那支是**語意上的**作品海報，而這裡每一張都是純裝飾，必須 `alt=""` + `aria-hidden`
 * + 不可聚焦，否則螢幕閱讀器會念出 60 個片名。
 */
/*
 * ⚠️ ISR 安全：`isr: 300` 以路徑為快取單位 ⇒ SSR 期間碰到任何來訪者身分，第一個造訪者的
 * 狀態就會被發給所有人（#1 的同一家族）。兩道防線都要在：① 全域 middleware 會把 session
 * cookie 從可快取路由上拔掉；② **不要只依賴它**（它哪天判定改了這一頁不會有症狀）⇒ CTA 包在
 * `<ClientOnly>` 裡、`#fallback` 給的是**未登入**那顆按鈕，第①道失效也只會烤進「未登入」。
 */
const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()

useSeoMeta({
  // ★ 刻意不設 title：app.vue 的 titleTemplate 會把有值的 title 接上站名，
  //   首頁再給一個含站名的 title 就會變成「影記 filmnote — 影記」。
  description: '台灣在地的觀影紀錄工具：記得住台灣的片名、你在哪看的、以及你花了多少。',
})

/**
 * 背景牆的海報走 `/api/posters`。端點給的是 TMDB 的**路徑**不是完整網址，尺寸由版面決定
 * ——所以下面自己組 `image.tmdb.org/t/p/w185{path}`，仍然是熱連結，沒有經過我們的伺服器。
 */
const { data: posterData } = await useAsyncData('home-posters', async () => {
  const res = await $fetch<{ items: { path: string }[] }>('/api/posters', { query: { limit: 60 } })
  return res.items.map(i => i.path)
})

const posters = computed(() => posterData.value ?? [])

/**
 * 牆一定要鋪滿整個區塊，否則底部會露出一條空白（實測 1280px 下 60 張只鋪到約 4.3 列）。
 * 磚數不能靠猜視窗大小——直接循環補到綽綽有餘，再由 `overflow-hidden` 裁掉。
 * 背景牆上重複的海報看不出來，但空掉的一角一眼就看得到。
 */
const WALL_TILES = 160
const wallTiles = computed(() => {
  const src = posters.value
  if (!src.length)
    return []
  return Array.from({ length: WALL_TILES }, (_, i) => src[i % src.length] as string)
})

/**
 * 頁尾那一行的規模數字。硬寫在版面裡的數字會過期而且沒有人會發現，所以查回來
 * （ISR 300 秒，這三個 count 每五分鐘最多跑一次）。
 * 分隔用**量詞 + 全形空白**不是中點——中點串是 Letterboxd 的簽名（§0）。
 */
const { data: scale } = await useAsyncData('home-scale', async () => {
  const [films, venues] = await Promise.all([
    supabase.from('film_public').select('id', { count: 'exact', head: true }),
    supabase.from('venue_option').select('id', { count: 'exact', head: true }),
  ])
  return { films: films.count ?? 0, venues: venues.count ?? 0 }
})

const scaleText = computed(() => {
  const s = scale.value
  if (!s?.films)
    return ''
  // 全形空白寫成跳脫字元：字面貼進原始碼會被 lint 擋（也容易在複製貼上時被吃掉）
  return `${s.films.toLocaleString('zh-Hant-TW')} 部台灣上映作品\u3000${s.venues} 家可選影城`
})

/**
 * 四個價值主張，**按 SPEC 的重要性排序**取前面幾個。
 * David 說「紀錄、圖表…」＝ 第一個與第四個，所以那兩個給完整的一句，
 * 中間兩個收成一句帶過。四條全部給等重的版面就不叫「簡單說明」了。
 */
const POINTS = [
  { k: '記得住台灣的片名', v: '片名以文化部影視局核准的正式名稱為準，不是翻譯出來的。' },
  { k: '記得住你在哪看的', v: '全台影城與影廳的官方主檔，連版本與廳別都留得下來。' },
  { k: '看得見自己的軌跡', v: '年表、時段、影城分布——十年下來的樣子，一頁看完。' },
] as const
</script>

<template>
  <div>
    <section class="relative isolate overflow-hidden border-b border-default">
      <!--
        海報牆。整塊 aria-hidden + pointer-events-none：它是壁紙，
        不是內容。每一張 alt=""，螢幕閱讀器完全跳過。
      -->
      <div class="pointer-events-none absolute inset-0 -z-10 overflow-hidden select-none" aria-hidden="true">
        <div class="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1 opacity-55 saturate-[.55] dark:opacity-40">
          <img
            v-for="(path, i) in wallTiles"
            :key="i"
            :src="`https://image.tmdb.org/t/p/w185${path}`"
            alt=""
            aria-hidden="true"
            :loading="i < 12 ? 'eager' : 'lazy'"
            decoding="async"
            class="aspect-[2/3] w-full object-cover"
          >
        </div>
        <!--
          實色遮罩（不是漸層，§0），放在圖片之後 ⇒ 疊在上面，負責把前景文字的對比拉到可讀範圍。
          ⚠️ **量的時候不能只看 CSS 往上找背景色**：遮罩與海報是前景文字的**兄弟節點**不是祖先，
             「往上走找第一個不透明背景」會量到乾淨的紙底，得到一個好看但假的數字（4.99 vs 真實 4.11）。
             正確算法是把整疊合成起來再對 P 取 0 與 255 兩端算下界（腳本在 scratchpad/contrast-worst.mjs）。
        -->
        <div class="absolute inset-0 bg-default/25" />
      </div>

      <!--
        ★ 文字放在**不透明的紙面板**上不是直接壓在海報牆上。前一版是「全幅海報牆 + 88% 遮罩」，
          量出來次要文字最差只有 4.11:1（低於 AA），而且為了救對比得把海報壓到幾乎看不見。
          改成面板之後牆可以放到 55% 真的看得出是海報牆，文字坐在乾淨的紙上（實測 8:1 以上）。
          方角、無陰影、無圓角 SaaS 卡片語彙（§0）。
      -->
      <div class="mx-auto max-w-3xl px-4 py-16 sm:py-24">
        <div class="bg-default px-6 py-10 sm:px-10 sm:py-12">
          <h1 class="text-4xl font-bold tracking-tight text-highlighted sm:text-5xl">
            影記 filmnote
          </h1>
          <p class="mt-4 text-lg leading-relaxed text-default">
            記下你在台灣看的每一場電影。
          </p>

          <dl class="mt-8 space-y-3">
            <div v-for="p in POINTS" :key="p.k">
              <dt class="font-semibold text-highlighted">
                {{ p.k }}
              </dt>
              <!--
                ★ 刻意用 `text-default` 不是 `text-muted`：實測 `text-muted` 對 `bg-default` 本來就只有
                  **4.56:1**（亮色），海報牆再壓一點就掉到 **4.11:1**——低於 WCAG AA 的 4.5。
                  海報牆底下的次要文字一律升一階，這是對背景的回應，不是改共用色票。
              -->
              <dd class="text-default">
                {{ p.v }}
              </dd>
            </div>
          </dl>

          <!--
          ★ 登入狀態只在 client 端決定。fallback 一定要是「未登入」那一顆——
            被烤進 CDN 的是 fallback，見檔頭第②道防線。
        -->
          <div class="mt-10">
            <ClientOnly>
              <UButton v-if="user" to="/app" size="lg">
                進入我的紀錄
              </UButton>
              <UButton v-else to="/login" size="lg">
                用 Google 登入開始記錄
              </UButton>
              <template #fallback>
                <UButton to="/login" size="lg">
                  用 Google 登入開始記錄
                </UButton>
              </template>
            </ClientOnly>
            <p class="mt-3 text-sm text-default">
              票價只有你自己看得到，除非你自己打開。
            </p>
          </div>
        </div>
      </div>
    </section>

    <p v-if="scaleText" class="mx-auto max-w-3xl px-4 py-6 text-sm text-muted tabular-nums">
      {{ scaleText }}
    </p>
  </div>
</template>
