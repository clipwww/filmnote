<script setup lang="ts">
const route = useRoute()
const router = useRouter()

const q = ref(String(route.query.q ?? ''))
// 打字時不要每個字都送一次查詢。@vueuse/nuxt 沒裝（Nuxt UI 只把 @vueuse/core
// 當內部相依，不提供 auto-import），所以自己 debounce。
const debounced = ref(q.value)
let timer: ReturnType<typeof setTimeout> | undefined

function schedule(value: string) {
  clearTimeout(timer)
  timer = setTimeout(() => {
    debounced.value = value
    router.replace({ query: value ? { q: value } : {} })
  }, 300)
}

/**
 * 注音組字中不查。ㄍ → ㄍㄨ → ㄍㄨㄟ → ㄍㄨㄟˇ 這四步都會發 input 事件，
 * 但注音符號查不到任何東西，使用者會在選出「鬼」之前先看到四次「找不到」。
 * `UInput` 沒有這層保護（Vue 原生 v-model 有），細節見 useImeGuard。
 */
const { composing, handlers: imeHandlers } = useImeGuard(schedule)

watch(q, (value) => {
  if (composing.value)
    return
  schedule(value)
})
onBeforeUnmount(() => clearTimeout(timer))

const { data, status } = await useFetch('/api/search', {
  query: { q: debounced },
  watch: [debounced],
})

const items = computed(() => data.value?.items ?? [])

useSeoMeta({
  title: () => (q.value ? `搜尋「${q.value}」` : '搜尋作品'),
  description: '在影記的片庫中以中文或原文片名搜尋作品。',
  robots: 'noindex, follow',
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-10">
    <h1 class="text-2xl font-bold tracking-tight">
      搜尋作品
    </h1>
    <p class="mt-2 text-muted">
      中文片名以文化部影視局核准名為準；原文片名同時比對，用任一種語言都找得到。
    </p>

    <UInput
      v-model="q"
      v-bind="imeHandlers"
      class="mt-6 w-full"
      size="lg"
      icon="i-lucide-search"
      placeholder="片名（中文或原文）"
      :loading="status === 'pending'"
      autofocus
    />

    <p v-if="debounced && status !== 'pending' && !items.length" class="mt-8 text-muted">
      找不到「{{ debounced }}」。
      <NuxtLink
        :to="{ path: '/app/films/new', query: { title: debounced, from: 'search' } }"
        class="underline underline-offset-4"
      >
        手動新增這部片
      </NuxtLink>
      —— 新增後立刻能用於記錄，不必等待審核。
    </p>

    <ul v-if="items.length" class="mt-8 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4">
      <li v-for="f in items" :key="f.id ?? f.slug ?? ''">
        <NuxtLink :to="`/film/${f.slug}`" class="group block">
          <FilmPoster
            :title-zh="f.title_zh"
            :title-original="f.title_original"
            :tmdb-poster-path="f.tmdb_poster_path"
            size="w185"
          />
          <p class="mt-2 text-sm font-medium leading-snug group-hover:underline underline-offset-4">
            {{ f.title_zh || f.title_original }}
          </p>
          <p class="text-xs text-muted">
            {{ [f.country, f.release_year].filter(Boolean).join(' · ') }}
          </p>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
