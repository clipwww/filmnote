<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

/**
 * `/app` — 登入後看到的第一個畫面（`SCREENS.md §9`）。
 *
 * 版面是**垂直長卷，一個 band 一張圖**，不是 2×2 的卡片牆。目前落地到 band 0：
 * 年度量詞句 + 票根卡列表。§9 的四張圖（出席圖、時段熱點、月度趨勢、影城分布）
 * 還沒接上——刻意的順序：SPEC 的四個價值主張裡有三個（片名、影城、票價）
 * 在列表就看得到，統計是第四個。**不要為了先做圖表而讓紀錄列表繼續空著。**
 *
 * 這頁在 `nuxt.config.ts` 是 `ssr: false` 且需登入，所以資料一律 client 端取。
 */
const user = useSupabaseUser()
const supabase = useSupabaseClient()

useSeoMeta({ title: '我的紀錄' })

const { records, status } = useMyRecords()

/** 174 筆全部平鋪會是一個一萬多 px 的頁面。跟 `/u/` 一樣分批顯示。 */
const PAGE = 24
const shown = ref(PAGE)
const visible = computed(() => records.value.slice(0, shown.value))
const hasMore = computed(() => records.value.length > shown.value)
const groups = computed(() => groupByYear(visible.value))

/**
 * 量詞句算的是**那一年的全部**，不是目前載入的那幾筆——
 * 捲動不該讓「2026 年看了 24 場」的數字跟著跳。
 */
const totalsByYear = computed(() => {
  const m = new Map<string, ReturnType<typeof yearTotals>>()
  for (const g of groupByYear(records.value))
    m.set(g.year, yearTotals(g.rows))
  return m
})

/** `2026 年看了 24 場、41 張票，花了 NT$9,860`（§4.4） */
function segmentsFor(year: string): StatSegment[] {
  const t = totalsByYear.value.get(year)
  if (!t)
    return []
  const spend = t.spend > 0 ? costText(t.spend) : null
  return [
    { value: year, suffix: '年看了' },
    { value: String(t.records), suffix: '場、' },
    { value: String(t.tickets), suffix: spend ? '張票，花了' : '張票' },
    ...(spend ? [{ value: spend }] : []),
  ]
}

async function signOut() {
  await supabase.auth.signOut()
  await navigateTo('/login')
}

/**
 * 空狀態的淡化示意圖：一年份的出席格。刻意用固定的偽亂數而不是 Math.random，
 * 免得每次 render 長不一樣（這頁雖然沒有 SSR，但「示意圖會閃」一樣是缺陷）。
 */
const demoCells = Array.from({ length: 7 * 26 }, (_, i) => {
  // 線性的 (i * k) % n 會在格線上排成明顯的斜紋，看起來像壞掉的圖不像資料。
  // 這裡用 murmur 的收尾混合把相鄰的 i 打散。
  let h = Math.imul(i + 1, 0x9E3779B1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85EBCA6B)
  h ^= h >>> 13
  return (h >>> 0) % 1000 / 1000
})
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-8">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        我的紀錄
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一筆
      </UButton>
    </div>

    <!-- §9.4：載入態是結構性骨架不是轉圈，否則資料到位時整頁往下跳（CLS）。 -->
    <div v-if="status === 'pending'" class="mt-8 space-y-2">
      <USkeleton v-for="i in 6" :key="i" class="h-[92px] w-full rounded-sm" />
    </div>

    <!--
      §9.3 全新帳號：四張圖同時空是這頁最尷尬的狀態，所以**不畫空圖**。
      一個明確的下一步動作，加一張淡化的示意圖說明「這裡會長出什麼」。
      David 有 174 筆永遠看不到這個狀態，但新使用者第一眼就是它。
    -->
    <section v-else-if="!records.length" class="mt-10">
      <p class="text-lg">
        還沒有東西可以看。
      </p>
      <p class="mt-1 text-muted">
        記下第一場，這裡就會開始長出來。
      </p>
      <UButton to="/app/records/new" size="lg" class="mt-6">
        記下你的第一場
      </UButton>

      <div class="mt-10 rounded-sm border border-default p-4">
        <p class="text-sm text-muted">
          記下幾場之後，這裡會長成你的出席圖：
        </p>
        <div
          class="mt-3 grid grid-flow-col grid-rows-7 gap-[3px] overflow-hidden opacity-30"
          aria-hidden="true"
        >
          <span
            v-for="(c, i) in demoCells"
            :key="i"
            class="size-2.5 rounded-[2px] bg-inverted"
            :style="{ opacity: c > 0.72 ? c : 0.08 }"
          />
        </div>
      </div>
    </section>

    <template v-else>
      <section v-for="g in groups" :key="g.year" class="mt-10 first:mt-8">
        <StatLine :segments="segmentsFor(g.year)" />
        <p v-if="totalsByYear.get(g.year)?.spendIsPartial" class="mt-1 text-sm text-dimmed">
          其中 {{ totalsByYear.get(g.year)?.missingCost }} 筆沒有記票價，金額不是全年總額。
        </p>

        <ul class="mt-4 space-y-2">
          <li v-for="r in g.rows" :key="r.id">
            <TicketCard :record="r" />
          </li>
        </ul>
      </section>

      <div v-if="hasMore" class="mt-6 flex justify-center">
        <UButton variant="soft" color="neutral" @click="shown += PAGE">
          再顯示 {{ Math.min(PAGE, records.length - shown) }} 筆（共 {{ records.length }} 筆）
        </UButton>
      </div>
    </template>

    <div class="mt-12 border-t border-default pt-6">
      <!-- shrink-0：375px 下沒有它，按鈕文字會被壓成「管理紀 錄」 -->
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UButton to="/app/records" variant="ghost" color="neutral" size="sm" icon="i-lucide-list" class="shrink-0">
          管理紀錄
        </UButton>
        <UButton to="/app/settings" variant="ghost" color="neutral" size="sm" icon="i-lucide-settings" class="shrink-0">
          設定
        </UButton>
        <UButton variant="ghost" color="neutral" size="sm" class="ml-auto shrink-0" @click="signOut">
          登出
        </UButton>
      </div>
      <p v-if="user?.email" class="mt-3 text-xs text-dimmed">
        已登入：{{ user.email }}
      </p>
    </div>
  </div>
</template>
