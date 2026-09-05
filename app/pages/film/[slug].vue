<script setup lang="ts">
const route = useRoute()
const slug = computed(() => String(route.params.slug))

// SSR 期間走 /api/film/[slug]，那支明確用匿名 client ⇒ 輸出與觀看者無關，
// 才能安全地被 ISR 快取（§3 注意事項 1）。
const { data, error } = await useFetch(() => `/api/film/${slug.value}`, {
  key: () => `film-${slug.value}`,
})

if (error.value) {
  throw createError({
    statusCode: error.value.statusCode ?? 500,
    statusMessage: error.value.statusMessage ?? '載入失敗',
    fatal: true,
  })
}

const film = computed(() => data.value?.film)
const certificates = computed(() => data.value?.certificates ?? [])
const watchers = computed(() => data.value?.watchers ?? [])

const config = useRuntimeConfig()

// ★ 每個值都必須是 getter：直接傳值只會抓到 render 當下的快照（踩雷 #7）。
// ★ 不用已 deprecated 的 useServerSeoMeta（踩雷 #6）。
useSeoMeta({
  title: () => film.value?.title_zh || film.value?.title_original || '作品',
  description: () => film.value?.overview
    || `${film.value?.title_zh ?? ''}（${film.value?.title_original ?? ''}）的觀影紀錄與分級資訊。`,
  ogType: 'video.movie',
  ogTitle: () => film.value?.title_zh || film.value?.title_original || '作品',
  ogDescription: () => film.value?.overview || undefined,
  ogUrl: () => `${config.public.siteUrl}/film/${slug.value}`,
  // OG 圖只用 TMDB 原圖直連，絕不 pipe 進自己的生成器（§6.2）
  ogImage: () => film.value?.tmdb_poster_path
    ? `https://image.tmdb.org/t/p/w500${film.value.tmdb_poster_path}`
    : undefined,
})

const ratings = computed(() =>
  [...new Set(certificates.value.map(c => c.rating).filter(Boolean))].join('、'))

function formatRuntime(mins: number | null | undefined) {
  if (!mins)
    return null
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h} 小時 ${m} 分` : `${m} 分`
}
</script>

<template>
  <div v-if="film" class="mx-auto max-w-5xl px-4 py-10">
    <div class="flex flex-col gap-8 sm:flex-row">
      <div class="w-full max-w-[220px] shrink-0">
        <FilmPoster
          :title-zh="film.title_zh"
          :title-original="film.title_original"
          :tmdb-poster-path="film.tmdb_poster_path"
          size="w342"
          eager
        />
      </div>

      <div class="min-w-0 flex-1">
        <h1 class="text-2xl font-bold tracking-tight sm:text-3xl">
          {{ film.title_zh || film.title_original }}
        </h1>
        <p v-if="film.title_original && film.title_original !== film.title_zh" class="mt-1 text-muted">
          {{ film.title_original }}
        </p>

        <dl class="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div v-if="film.country">
            <dt class="text-muted">
              國別
            </dt>
            <dd>{{ film.country }}</dd>
          </div>
          <div v-if="formatRuntime(film.runtime_minutes)">
            <dt class="text-muted">
              片長
            </dt>
            <dd>{{ formatRuntime(film.runtime_minutes) }}</dd>
          </div>
          <div v-if="ratings">
            <dt class="text-muted">
              分級
            </dt>
            <dd>{{ ratings }}</dd>
          </div>
          <div v-if="film.language">
            <dt class="text-muted">
              語言
            </dt>
            <dd>{{ film.language }}</dd>
          </div>
        </dl>

        <p v-if="film.overview" class="mt-6 leading-relaxed">
          {{ film.overview }}
        </p>
      </div>
    </div>

    <section v-if="certificates.length" class="mt-12">
      <h2 class="text-lg font-semibold">
        分級核准紀錄
      </h2>
      <p class="mt-1 text-sm text-muted">
        同一部片可能因跨年度重映或不同語言版本而有多張證明書，共 {{ certificates.length }} 張。
      </p>
      <ul class="mt-4 divide-y divide-default rounded-sm border border-default">
        <li v-for="c in certificates" :key="c.id" class="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-sm">
          <span class="font-mono text-muted">{{ c.roc_year }} 年</span>
          <span class="font-mono">{{ c.permit_no }}</span>
          <span v-if="c.rating">{{ c.rating }}</span>
          <span v-if="c.version_note" class="text-muted">{{ c.version_note }}</span>
        </li>
      </ul>
    </section>

    <section class="mt-12">
      <h2 class="text-lg font-semibold">
        誰看過這部片
      </h2>
      <p v-if="!watchers.length" class="mt-2 text-sm text-muted">
        還沒有人公開記錄過這部片。
      </p>
      <ul v-else class="mt-4 flex flex-wrap gap-2">
        <li v-for="w in watchers" :key="w.id ?? w.username ?? ''">
          <NuxtLink
            :to="`/u/${w.username}`"
            class="inline-flex items-center gap-2 rounded-sm border border-default px-3 py-1 text-sm hover:bg-elevated"
          >
            <span>{{ w.username }}</span>
            <span class="text-muted">{{ w.watched_on }}</span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>
