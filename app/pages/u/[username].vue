<script setup lang="ts">
import type { StatSegment } from '~/utils/stat-line'

const route = useRoute()
const username = computed(() => String(route.params.username))

const { data, error } = await useFetch(() => `/api/u/${username.value}`, {
  key: () => `u-${username.value}`,
})

if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusMessage ?? '載入失敗',
    fatal: true,
  })
}

const profile = computed(() => data.value?.profile)
const items = computed(() => data.value?.items ?? [])
const counts = computed(() => data.value?.counts)

const config = useRuntimeConfig()
const displayName = computed(() => profile.value?.displayName || profile.value?.username || '')

useSeoMeta({
  title: () => `${displayName.value} 的觀影紀錄`,
  description: () => profile.value?.bio
    || `${displayName.value} 在影記記錄了 ${counts.value?.records ?? 0} 次觀影。`,
  ogType: 'profile',
  ogTitle: () => `${displayName.value} 的觀影紀錄`,
  ogUrl: () => `${config.public.siteUrl}/u/${username.value}`,
})

const { formatLabel } = useScreeningFormats()

/** `公開了 174 場、132 部作品，去過 14 個場所`（§4.4，不做成 stat tile） */
const countSegments = computed<StatSegment[]>(() => {
  const c = counts.value
  if (!c)
    return []
  return [
    { prefix: '公開了', value: String(c.records), suffix: '場、' },
    { value: String(c.films), suffix: '部作品，去過' },
    { value: String(c.venues), suffix: '個場所' },
  ]
})

/**
 * 174 筆全部平鋪會產生一個 17,000px 的頁面——功能對，但沒有人能用。
 * 依年份分組並漸進式載入：先給最近的一批，其餘按需展開。
 *
 * 這是 client 端的分頁。真正的 server 端分頁需要 /api/u/[username] 支援
 * offset/limit，那支在 backend 手上——目前 API 一次回最多 200 筆，
 * 超過 200 筆的使用者會缺資料，已回報。
 */
const PAGE = 24
const shown = ref(PAGE)
watch(username, () => {
  shown.value = PAGE
})

/**
 * API 的形狀 → `TicketCard` 的形狀。四個呼叫端的原始資料長得都不一樣，
 * 對映一次比讓元件認四種形狀便宜。
 *
 * `cost` 恆為 null：公開頁**完全不給金額**（見 `/api/u/[username]` 檔頭——
 * 聚合是推論通道，不是安全邊界）。金額由 `UserSpendSummary` 帶著觀看者
 * 自己的 session 在 client 端另外取。
 */
const cards = computed(() => items.value.map(r => ({
  id: r.id ?? '',
  year: String(r.watchedOn ?? '').slice(0, 4) || '未知',
  watchedOn: r.watchedOn,
  watchedTime: r.watchedTime,
  venueName: r.venue?.name ?? null,
  hallLabel: r.hallLabel,
  formatLabel: formatLabel(r.formatCode),
  ticketCount: r.ticketCount,
  cost: null,
  memo: r.memo,
  film: {
    slug: r.film?.slug ?? null,
    titleZh: r.film?.title_zh ?? null,
    titleOriginal: r.film?.title_original ?? null,
    tmdbPosterPath: r.film?.tmdb_poster_path ?? null,
  },
})))

const visible = computed(() => cards.value.slice(0, shown.value))
const hasMore = computed(() => cards.value.length > shown.value)
/** 依年份分組，讓長列表有可掃描的錨點。 */
const grouped = computed(() => groupByYear(visible.value))
</script>

<template>
  <div v-if="profile" class="mx-auto max-w-4xl px-4 py-10">
    <header class="flex items-center gap-4">
      <UAvatar :src="profile.avatarUrl ?? undefined" :alt="displayName" size="xl" />
      <div class="min-w-0">
        <h1 class="text-2xl font-bold tracking-tight">
          {{ displayName }}
        </h1>
        <p class="text-muted">
          @{{ profile.username }}
        </p>
      </div>
    </header>

    <p v-if="profile.bio" class="mt-4 leading-relaxed">
      {{ profile.bio }}
    </p>

    <!--
      §4.4：數字不做成 stat tile。「大數字 + 小標籤 + 一排補充數據」是儀表板的
      預設長相，也正是 §0 要避開的東西。排成一行有量詞的句子。
    -->
    <StatLine v-if="counts" class="mt-8" :segments="countSegments" />

    <!--
      票價一律在 client 端補：SSR 以匿名視角 render，作者本人的票價（以及
      show_cost 開啟後的公開票價）由瀏覽器帶著自己的 session 去取。
      這樣 SSR 產出的 HTML 與 __NUXT_DATA__ 裡永遠不會有金額。
    -->
    <ClientOnly>
      <UserSpendSummary :username="profile.username" />
      <template #fallback>
        <!-- 只佔位不畫框：畫一個框再換成沒有框的內容會像「載入完就壞掉」 -->
        <div class="mt-6 h-14" />
      </template>
    </ClientOnly>

    <section class="mt-10">
      <h2 class="text-lg font-semibold">
        觀影紀錄
      </h2>
      <p v-if="!items.length" class="mt-2 text-muted">
        還沒有公開的觀影紀錄。
      </p>
      <template v-else>
        <div v-for="g in grouped" :key="g.year" class="mt-6">
          <h3 class="text-sm font-semibold text-muted tabular-nums">
            {{ g.year }} 年
          </h3>
          <ul class="mt-2 space-y-2">
            <li v-for="r in g.rows" :key="r.id">
              <TicketCard :record="r" />
            </li>
          </ul>
        </div>

        <div v-if="hasMore" class="mt-6 flex justify-center">
          <UButton variant="soft" color="neutral" @click="shown += PAGE">
            再顯示 {{ Math.min(PAGE, cards.length - shown) }} 筆（共 {{ cards.length }} 筆）
          </UButton>
        </div>
      </template>
    </section>
  </div>
</template>
