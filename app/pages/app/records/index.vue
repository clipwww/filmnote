<script setup lang="ts">
import type { Database } from '~/types/database.types'

useSeoMeta({ title: '我的紀錄' })

const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()
const toast = useToast()

// RLS 讓使用者只讀得到自己的紀錄（外加公開的別人），這裡再以 user_id 明確限定。
const { data, refresh, status } = await useAsyncData('my-records', async () => {
  if (!user.value?.sub)
    return []
  const { data, error } = await supabase
    .from('viewing_record')
    .select('id,watched_on,watched_time,visibility,memo,hall_label,format_code,ticket_count,film_id,venue_id')
    .eq('user_id', user.value.sub)
    .order('watched_on', { ascending: false })
    .order('watched_time', { ascending: false, nullsFirst: false })
    .limit(500)
  if (error)
    throw error

  const filmIds = [...new Set(data.map(r => r.film_id))]
  const venueIds = [...new Set(data.map(r => r.venue_id))]
  const [films, venues, costs] = await Promise.all([
    supabase.from('film').select('id,slug,title_zh,title_original').in('id', filmIds),
    supabase.from('venue').select('id,name').in('id', venueIds),
    supabase.from('viewing_record_cost').select('record_id,amount').in('record_id', data.map(r => r.id)),
  ])
  const fm = new Map((films.data ?? []).map(f => [f.id, f]))
  const vm = new Map((venues.data ?? []).map(v => [v.id, v]))
  const cm = new Map((costs.data ?? []).map(c => [c.record_id, c.amount]))
  return data.map(r => ({ ...r, film: fm.get(r.film_id), venue: vm.get(r.venue_id), cost: cm.get(r.id) ?? null }))
}, { server: false, watch: [user] })

const records = computed(() => data.value ?? [])
const { formatLabel } = useScreeningFormats()

async function remove(id: string) {
  const { error } = await supabase.from('viewing_record').delete().eq('id', id)
  if (error) {
    toast.add({ title: '刪除失敗', description: error.message, color: 'error' })
    return
  }
  toast.add({ title: '已刪除', color: 'success' })
  await refresh()
}
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

    <p v-if="status === 'pending'" class="mt-8 text-muted">
      載入中…
    </p>
    <p v-else-if="!records.length" class="mt-8 text-muted">
      還沒有任何紀錄。
    </p>

    <ul v-else class="mt-6 divide-y divide-default rounded-lg border border-default">
      <li v-for="r in records" :key="r.id" class="flex items-start gap-3 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="font-medium">
            {{ r.film?.title_zh || r.film?.title_original || '（作品不明）' }}
            <UBadge v-if="r.visibility === 'private'" variant="soft" color="neutral" size="sm">
              私密
            </UBadge>
          </p>
          <p class="mt-0.5 text-sm text-muted">
            {{ metaLine(
              dateTimeText(r.watched_on, r.watched_time),
              r.venue?.name,
              r.hall_label,
              formatLabel(r.format_code),
              r.cost != null ? `NT$ ${Number(r.cost).toLocaleString('zh-Hant-TW')}` : null,
            ) }}
          </p>
          <p v-if="r.memo" class="mt-1 text-sm">
            {{ r.memo }}
          </p>
        </div>
        <div class="flex shrink-0 gap-1">
          <UButton :to="`/app/records/${r.id}/edit`" variant="ghost" color="neutral" icon="i-lucide-pencil" size="sm" aria-label="編輯" />
          <UButton variant="ghost" color="error" icon="i-lucide-trash-2" size="sm" aria-label="刪除" @click="remove(r.id)" />
        </div>
      </li>
    </ul>
  </div>
</template>
