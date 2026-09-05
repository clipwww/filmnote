<script setup lang="ts">
import type { FilmOption } from '~/composables/useFilmSearch'
import type { VenueOption } from '~/composables/useRecordOptions'
import type { Database } from '~/types/database.types'

definePageMeta({ layout: 'default' })
useSeoMeta({ title: '記一筆' })

const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()
const toast = useToast()

const { venues } = useVenueOptions()
const { read: readLastVenue, write: writeLastVenue } = useLastVenue()
const { term: filmTerm, items: filmItems, loading: filmLoading } = useFilmSearch()

// USelectMenu 的 v-model 型別是 T | undefined（不是 null），三個選單欄位一律用 undefined
const film = ref<FilmOption | undefined>()
const venueId = ref<string | undefined>()
// US-5：日期預設今天。最常見的情境是「剛看完就記」，不該需要任何額外操作。
const watchedOn = ref(todayInTaipei())
const watchedTime = ref('')
// 以下全部選填（US-8）
const ticketCount = ref<number | null>(null)
const cost = ref<number | null>(null)
const hallLabel = ref('')
const formatCode = ref<string | undefined>()
const memo = ref('')
const isPublic = ref(true)

const formats = ref<{ code: string, label: string }[]>([])
const saving = ref(false)

onMounted(async () => {
  venueId.value = readLastVenue() ?? undefined
  const { data } = await supabase
    .from('screening_format')
    .select('code,label')
    .eq('active', true)
    .order('sort_order')
  formats.value = data ?? []
})

/**
 * 「今天」是使用者所在地的今天。
 *
 * 這個欄位存的是台北牆上時間的日期（schema 用 watched_on date +
 * watched_time time，刻意避開 timestamptz），所以取本地日期即可，
 * 不要經過 toISOString()——那會轉成 UTC，台灣時間早上 8 點前記的紀錄
 * 會被記成前一天。
 */
function todayInTaipei(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const canSave = computed(() => !!film.value && !!venueId.value && !!watchedOn.value)

async function save() {
  if (!canSave.value || !user.value?.sub)
    return
  saving.value = true
  try {
    // 票價寫進獨立的 viewing_record_cost 表，不是 viewing_record 的欄位。
    // RLS 只能遮「列」不能有條件地遮「欄」，show_cost 這條規則因此必須靠
    // 結構來強制，而不是靠每支 API 記得把欄位拿掉。
    const { data: inserted, error } = await supabase
      .from('viewing_record')
      .insert({
        user_id: user.value.sub,
        film_id: film.value!.id,
        venue_id: venueId.value!,
        watched_on: watchedOn.value,
        watched_time: watchedTime.value || null,
        ticket_count: ticketCount.value,
        hall_label: hallLabel.value || null,
        format_code: formatCode.value ?? null,
        memo: memo.value || null,
        visibility: isPublic.value ? 'public' : 'private',
      })
      .select('id')
      .single()
    if (error)
      throw error

    if (cost.value != null && cost.value >= 0) {
      const { error: costError } = await supabase
        .from('viewing_record_cost')
        .insert({ record_id: inserted.id, amount: cost.value })
      if (costError) {
        // 紀錄已經建立了，票價沒寫進去不該讓整筆消失——明說哪一半失敗，
        // 使用者可以到編輯頁補。
        toast.add({ title: '紀錄已建立，但票價沒存成功', description: costError.message, color: 'warning' })
      }
    }

    writeLastVenue(venueId.value ?? null)
    toast.add({ title: '記下來了', color: 'success' })
    await navigateTo('/app/records')
  }
  catch (e) {
    toast.add({ title: '存檔失敗', description: (e as Error).message, color: 'error' })
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-xl px-4 py-8">
    <h1 class="text-2xl font-bold tracking-tight">
      記一筆
    </h1>
    <p class="mt-1 text-sm text-muted">
      片名、日期、場所填完就能存，其餘都可以之後再補。
    </p>

    <form class="mt-8 space-y-5" @submit.prevent="save">
      <UFormField label="看了什麼" required>
        <!--
          ignore-filter：過濾交給 Postgres，不要讓 reka-ui 對 2,669 筆做子字串比對。
          v-model:search-term 把輸入接到 useFilmSearch。
          value-key 未設 ⇒ v-model 綁的是整個物件（踩雷 #51），這裡正是想要的。
        -->
        <USelectMenu
          v-model="film"
          v-model:search-term="filmTerm"
          :items="filmItems"
          :loading="filmLoading"
          ignore-filter
          label-key="title_zh"
          placeholder="輸入片名（中文或原文）"
          class="w-full"
          size="lg"
        >
          <template #item-label="{ item }">
            {{ filmLabel(item) }}
          </template>
          <template #empty>
            <div class="px-2 py-3 text-sm">
              <p v-if="!filmTerm">
                輸入片名開始搜尋
              </p>
              <p v-else>
                找不到「{{ filmTerm }}」。
                <NuxtLink to="/app/films/new" class="underline underline-offset-4">
                  手動新增這部片
                </NuxtLink>
              </p>
            </div>
          </template>
        </USelectMenu>
      </UFormField>

      <div class="grid grid-cols-2 gap-4">
        <UFormField label="哪天看的" required>
          <UInput v-model="watchedOn" type="date" class="w-full" size="lg" />
        </UFormField>
        <UFormField label="幾點" hint="選填">
          <UInput v-model="watchedTime" type="time" class="w-full" size="lg" />
        </UFormField>
      </div>

      <UFormField label="在哪看的" required>
        <USelectMenu
          v-model="venueId"
          :items="venues"
          value-key="id"
          label-key="name"
          placeholder="選擇影城或場合"
          class="w-full"
          size="lg"
        >
          <template #item-label="{ item }">
            {{ (item as VenueOption).name }}
            <span v-if="(item as VenueOption).city" class="text-muted">· {{ (item as VenueOption).city }}</span>
          </template>
        </USelectMenu>
      </UFormField>

      <UCollapsible>
        <UButton variant="ghost" color="neutral" trailing-icon="i-lucide-chevron-down" block>
          其他細節（選填）
        </UButton>
        <template #content>
          <div class="space-y-5 pt-4">
            <div class="grid grid-cols-2 gap-4">
              <UFormField label="票數">
                <UInputNumber v-model="ticketCount" :min="1" :max="99" class="w-full" />
              </UFormField>
              <UFormField label="票價" hint="預設不公開">
                <UInputNumber v-model="cost" :min="0" class="w-full" />
              </UFormField>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <UFormField label="影廳">
                <UInput v-model="hallLabel" placeholder="如 IMAX 廳" class="w-full" />
              </UFormField>
              <UFormField label="版本">
                <USelectMenu
                  v-model="formatCode"
                  :items="formats"
                  value-key="code"
                  label-key="label"
                  placeholder="數位／IMAX…"
                  class="w-full"
                />
              </UFormField>
            </div>
            <UFormField label="備註">
              <UTextarea v-model="memo" :rows="3" :maxlength="2000" class="w-full" />
            </UFormField>
            <UFormField>
              <USwitch v-model="isPublic" label="公開這筆紀錄" :description="isPublic ? '會出現在你的個人頁' : '只有你看得到'" />
            </UFormField>
          </div>
        </template>
      </UCollapsible>

      <UButton type="submit" size="lg" block :loading="saving" :disabled="!canSave">
        存起來
      </UButton>
    </form>
  </div>
</template>
