<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { RecordEditForm } from '~/schemas/record'
import type { Database } from '~/types/database.types'
import { recordEditSchema, toRecordRow } from '~/schemas/record'

useSeoMeta({ title: '編輯紀錄' })

const route = useRoute()
const id = String(route.params.id)
const supabase = useSupabaseClient<Database>()
const toast = useToast()
const { venues } = useVenueOptions()

const state = reactive<{
  watchedOn: string
  watchedTime: string
  venueId: string | undefined
  ticketCount: number | null
  cost: number | null
  hallLabel: string
  formatCode: string | undefined
  memo: string
  isPublic: boolean
}>({
  watchedOn: '',
  watchedTime: '',
  venueId: undefined,
  ticketCount: null,
  cost: null,
  hallLabel: '',
  formatCode: undefined,
  memo: '',
  isPublic: true,
})

const filmTitle = ref('')
const saving = ref(false)
/** 載入時原本就有票價列，才需要在清空時去刪它。 */
const hadCost = ref(false)

const { status } = await useAsyncData(`record-${id}`, async () => {
  const { data, error } = await supabase
    .from('viewing_record')
    .select('watched_on,watched_time,venue_id,ticket_count,hall_label,format_code,memo,visibility,film_id')
    .eq('id', id)
    .maybeSingle()
  if (error)
    throw error
  if (!data)
    throw createError({ statusCode: 404, statusMessage: '找不到這筆紀錄', fatal: true })

  state.watchedOn = data.watched_on
  state.watchedTime = data.watched_time?.slice(0, 5) ?? ''
  state.venueId = data.venue_id
  state.ticketCount = data.ticket_count
  state.hallLabel = data.hall_label ?? ''
  state.formatCode = data.format_code ?? undefined
  state.memo = data.memo ?? ''
  state.isPublic = data.visibility === 'public'

  const [{ data: film }, { data: c }] = await Promise.all([
    supabase.from('film').select('title_zh,title_original').eq('id', data.film_id).maybeSingle(),
    supabase.from('viewing_record_cost').select('amount').eq('record_id', id).maybeSingle(),
  ])
  filmTitle.value = film?.title_zh || film?.title_original || '（作品不明）'
  if (c) {
    state.cost = Number(c.amount)
    hadCost.value = true
  }
  return true
}, { server: false })

async function onSubmit(event: FormSubmitEvent<RecordEditForm>) {
  const form = event.data
  saving.value = true
  try {
    const { error } = await supabase.from('viewing_record').update(toRecordRow(form)).eq('id', id)
    if (error)
      throw error

    // 票價在另一張表，三種情況要分開處理。
    // ★ null 是「刪掉這筆票價」，0 是「真的沒花錢」——不可混為一談。
    if (form.cost === null) {
      if (hadCost.value) {
        const { error: de } = await supabase.from('viewing_record_cost').delete().eq('record_id', id)
        if (de)
          throw de
        hadCost.value = false
      }
    }
    else {
      const { error: ce } = await supabase
        .from('viewing_record_cost')
        .upsert({ record_id: id, amount: form.cost }, { onConflict: 'record_id' })
      if (ce)
        throw ce
      hadCost.value = true
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
      <!-- @keydown：注音選字按 Enter 不該把表單送出去，見 useImeGuard -->
      <UForm
        :schema="recordEditSchema"
        :state="state"
        class="mt-6 space-y-5"
        @submit="onSubmit"
        @keydown="blockSubmitWhileComposing"
      >
        <div class="grid grid-cols-2 gap-4">
          <UFormField label="哪天看的" name="watchedOn" required>
            <UInput v-model="state.watchedOn" type="date" class="w-full" />
          </UFormField>
          <UFormField label="幾點" name="watchedTime">
            <UInput v-model="state.watchedTime" type="time" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="在哪看的" name="venueId" required>
          <USelectMenu v-model="state.venueId" :items="venues" value-key="id" label-key="name" class="w-full" />
        </UFormField>
        <div class="grid grid-cols-2 gap-4">
          <UFormField label="票數" name="ticketCount">
            <UInputNumber v-model="state.ticketCount" :min="1" :max="99" class="w-full" />
          </UFormField>
          <UFormField label="票價" name="cost" hint="留空＝刪除票價；0＝招待票">
            <UInputNumber v-model="state.cost" :min="0" class="w-full" />
          </UFormField>
        </div>
        <UFormField label="影廳" name="hallLabel">
          <UInput v-model="state.hallLabel" class="w-full" />
        </UFormField>
        <UFormField label="備註" name="memo">
          <UTextarea v-model="state.memo" :rows="3" :maxlength="2000" class="w-full" />
        </UFormField>
        <UFormField>
          <USwitch v-model="state.isPublic" label="公開這筆紀錄" />
        </UFormField>
        <div class="flex gap-3">
          <UButton type="submit" :loading="saving">
            儲存
          </UButton>
          <UButton to="/app/records" variant="ghost" color="neutral">
            取消
          </UButton>
        </div>
      </UForm>
    </template>
  </div>
</template>
