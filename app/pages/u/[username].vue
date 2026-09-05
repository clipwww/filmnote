<script setup lang="ts">
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

function fmtTime(t: string | null | undefined) {
  return t ? t.slice(0, 5) : null
}
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

    <dl v-if="counts" class="mt-8 grid grid-cols-3 gap-4">
      <div class="rounded-lg border border-default px-4 py-3">
        <dt class="text-sm text-muted">
          公開紀錄
        </dt>
        <dd class="text-2xl font-semibold tabular-nums">
          {{ counts.records }}
        </dd>
      </div>
      <div class="rounded-lg border border-default px-4 py-3">
        <dt class="text-sm text-muted">
          不同作品
        </dt>
        <dd class="text-2xl font-semibold tabular-nums">
          {{ counts.films }}
        </dd>
      </div>
      <div class="rounded-lg border border-default px-4 py-3">
        <dt class="text-sm text-muted">
          去過的場所
        </dt>
        <dd class="text-2xl font-semibold tabular-nums">
          {{ counts.venues }}
        </dd>
      </div>
    </dl>

    <!--
      票價一律在 client 端補：SSR 以匿名視角 render，作者本人的票價（以及
      show_cost 開啟後的公開票價）由瀏覽器帶著自己的 session 去取。
      這樣 SSR 產出的 HTML 與 __NUXT_DATA__ 裡永遠不會有金額。
    -->
    <ClientOnly>
      <UserSpendSummary :username="profile.username" />
      <template #fallback>
        <div class="mt-8 h-20 rounded-lg border border-default" />
      </template>
    </ClientOnly>

    <section class="mt-10">
      <h2 class="text-lg font-semibold">
        觀影紀錄
      </h2>
      <p v-if="!items.length" class="mt-2 text-muted">
        還沒有公開的觀影紀錄。
      </p>
      <ul v-else class="mt-4 divide-y divide-default rounded-lg border border-default">
        <li v-for="r in items" :key="r.id ?? ''" class="flex gap-4 px-4 py-3">
          <div class="w-12 shrink-0">
            <FilmPoster
              :title-zh="r.film?.title_zh"
              :title-original="r.film?.title_original"
              :tmdb-poster-path="r.film?.tmdb_poster_path"
              size="w185"
            />
          </div>
          <div class="min-w-0 flex-1">
            <NuxtLink v-if="r.film?.slug" :to="`/film/${r.film.slug}`" class="font-medium hover:underline underline-offset-4">
              {{ r.film.title_zh || r.film.title_original }}
            </NuxtLink>
            <span v-else class="font-medium text-muted">（作品待審核）</span>
            <p class="mt-0.5 text-sm text-muted">
              {{ r.watchedOn }}<span v-if="fmtTime(r.watchedTime)"> {{ fmtTime(r.watchedTime) }}</span>
              <span v-if="r.venue"> · {{ r.venue.name }}</span>
              <span v-if="r.hallLabel"> · {{ r.hallLabel }}</span>
              <span v-if="r.formatCode"> · {{ r.formatCode }}</span>
            </p>
            <p v-if="r.memo" class="mt-1 text-sm leading-relaxed">
              {{ r.memo }}
            </p>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
