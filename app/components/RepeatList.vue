<script setup lang="ts">
import type { YearStats } from '~/utils/stats'

/** 多刷排行（`SCREENS.md §9` band 7、US-41）。只列同一年內看過兩次以上的。 */
defineProps<{ items: YearStats['repeats'] }>()
</script>

<template>
  <ul class="space-y-3">
    <li v-for="f in items" :key="f.film_id" class="flex items-center gap-3">
      <div class="w-10 shrink-0">
        <FilmPoster
          :title-zh="f.title_zh"
          :tmdb-poster-path="f.poster_path"
          variant="monogram"
          size="w185"
        />
      </div>
      <NuxtLink
        v-if="f.slug"
        :to="`/film/${f.slug}`"
        class="min-w-0 flex-1 text-sm hover:underline underline-offset-4"
      >
        {{ displayTitle(f.title_zh) || '（作品不明）' }}
      </NuxtLink>
      <span v-else class="min-w-0 flex-1 text-sm text-muted">
        {{ displayTitle(f.title_zh) || '（作品不明）' }}
      </span>
      <span class="shrink-0 text-sm tabular-nums text-highlighted">{{ f.records }} 次</span>
    </li>
  </ul>
</template>
