<script setup lang="ts">
import type { Database } from '~/types/database.types'

useSeoMeta({ title: '編輯紀錄' })

const route = useRoute()
const id = String(route.params.id)
const supabase = useSupabaseClient<Database>()
const toast = useToast()
const { venues } = useVenueOptions()

const watchedOn = ref('')
const watchedTime = ref('')
const venueId = ref<string | undefined>()
const ticketCount = ref<number | null>(null)
const cost = ref<number | null>(null)
const hallLabel = ref('')
const memo = ref('')
const isPublic = ref(true)
const saving = ref(false)
const filmTitle = ref('')
const hadCost = ref(false)

const { status } = await useAsyncData(`record-${id}`, async () => {
  const { data, error } = await supabase
    .from('viewing_record')
    .select('watched_on,watched_time,venue_id,ticket_count,hall_label,memo,visibility,film_id')
    .eq('id', id)
    .maybeSingle()
  if (error)
    throw error
  if (!data)
    throw createError({ statusCode: 404, statusMessage: '找不到這筆紀錄', fatal: true })

  watchedOn.value = data.watched_on
  watchedTime.value = data.watched_time?.slice(0, 5) ?? ''
  venueId.value = data.venue_id
  ticketCount.value = data.ticket_count
  hallLabel.value = data.hall_label ?? ''
  memo.value = data.memo ?? ''
  isPublic.value = data.visibility === 'public'

  const [{ data: film }, { data: c }] = await Promise.all([
    supabase.from('film').select('title_zh,title_original').eq('id', data.film_id).maybeSingle(),
    supabase.from('viewing_record_cost').select('amount').eq('record_id', id).maybeSingle(),
  ])
  filmTitle.value = film?.title_zh || film?.title_original || '（作品不明）'
  if (c) {
    cost.value = Number(c.amount)
    hadCost.value = true
  }
  return true
}, { server: false })

async function save() {
  saving.value = true
  try {
    const { error } = await supabase
      .from('viewing_record')
      .update({
        watched_on: watchedOn.value,
        watched_time: watchedTime.value || null,
        venue_id: venueId.value!,
        ticket_count: ticketCount.value,
        hall_label: hallLabel.value || null,
        memo: memo.value || null,
        visibility: isPublic.value ? 'public' : 'private',
      })
      .eq('id', id)
    if (error)
      throw error

    // 票價在另一張表，要分開處理三種情況：新增、更新、清空
    if (cost.value == null && hadCost.value) {
      await supabase.from('viewing_record_cost').delete().eq('record_id', id)
    }
    else if (cost.value != null) {
      const { error: ce } = await supabase
        .from('viewing_record_cost')
        .upsert({ record_id: id, amount: cost.value }, { onConflict: 'record_id' })
      if (ce)
        throw ce
    }

    toast.add({ title: '已更新', color: 'success' })
    await navigateTo('/app/records')
  }
  catch (e) {
    toast.add({ title: '更新失敗', description: (e as Error).message, color: 'error' })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-xl px-4 py-8">
    <h1 class="text-2xl font-bold tracking-tight">
      編輯紀錄
    </h1>
    <p v-if="status === 'pending'" class="mt-6 text-muted">
      載入中…
    </p>
    <template v-else>
      <p class="mt-1 text-muted">
        {{ filmTitle }}
      </p>
      <form class="mt-6 space-y-5" @submit.prevent="save">
        <div class="grid grid-cols-2 gap-4">
          <UFormField label="哪天看的" required>
            <UInput v-model="watchedOn" type="date" class="w-full" />
          </UFormField>
          <UFormField label="幾點">
            <UInput v-model="watchedTime" type="time" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="在哪看的" required>
          <USelectMenu v-model="venueId" :items="venues" value-key="id" label-key="name" class="w-full" />
        </UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField label="票數">
            <UInputNumber v-model="ticketCount" :min="1" :max="99" class="w-full" />
          </UFormField>
          <UFormField label="票價" hint="清空即刪除">
            <UInputNumber v-model="cost" :min="0" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="影廳">
          <UInput v-model="hallLabel" class="w-full" />
        </UFormField>
        <UFormField label="備註">
          <UTextarea v-model="memo" :rows="3" :maxlength="2000" class="w-full" />
        </UFormField>
        <UFormField>
          <USwitch v-model="isPublic" label="公開這筆紀錄" />
        </UFormField>
        <div class="flex gap-3">
          <UButton type="submit" :loading="saving">
            儲存
          </UButton>
          <UButton to="/app/records" variant="ghost" color="neutral">
            取消
          </UButton>
        </div>
      </form>
    </template>
  </div>
</template>
