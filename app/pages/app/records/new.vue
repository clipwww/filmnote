<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { FilmOption } from '~/composables/useFilmSearch'
import type { VenueOption } from '~/composables/useRecordOptions'
import type { RecordForm } from '~/schemas/record'
import type { Database } from '~/types/database.types'
import { recordSchema, toRecordRow } from '~/schemas/record'

definePageMeta({ layout: 'default' })
useSeoMeta({ title: '記一場' })

const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()
const toast = useToast()

const { venues } = useVenueOptions()
const { read: readLastVenue, write: writeLastVenue } = useLastVenue()
const { save: saveDraft, take: takeDraft, clear: clearDraft } = useRecordDraft()
const { term: filmTerm, items: filmItems, loading: filmLoading, queried: filmQueried } = useFilmSearch()

/**
 * 「今天」是使用者所在地的今天。`watched_on` 存的是台北牆上時間的日期（schema 用 date + time
 * 刻意避開時區）⇒ 取本地日期即可，**不要**經過 `toISOString()`：那會轉成 UTC，
 * 台灣時間早上 8 點前記的紀錄會被記成前一天。
 */
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// UForm 的 state 是單一 reactive 物件，欄位名要與 zod schema 的 key 一致，
// UFormField 的 name 才對得上錯誤訊息。
const state = reactive<{
  film: FilmOption | undefined
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
  film: undefined,
  watchedOn: todayLocal(), // US-5：預設今天
  watchedTime: '',
  venueId: undefined,
  ticketCount: null,
  cost: null,
  hallLabel: '',
  formatCode: undefined,
  memo: '',
  isPublic: true,
})

const formats = ref<{ code: string, label: string }[]>([])
const saving = ref(false)

onMounted(async () => {
  state.venueId = readLastVenue() ?? undefined // US-6：記住上次選的影城

  /**
     * 從 `/app/films/new` 回來時把草稿接回去（`SCREENS §11`）。「找不到片」這條路不該懲罰
     * 已經填完日期、影城、票價的人。take 是**取走**：接回來之後草稿就該消失，
     * 否則下次乾淨地開新表單會冒出上次的殘骸。
     */
  const draft = takeDraft()
  if (draft) {
    for (const [k, v] of Object.entries(draft)) {
      if (v !== undefined && k in state)
        (state as Record<string, unknown>)[k] = v ?? undefined
    }
    if (draft.film)
      state.film = draft.film
  }

  const { data } = await supabase
    .from('screening_format')
    .select('code,label')
    .eq('active', true)
    .order('sort_order')
  formats.value = data ?? []
})

/**
 * 去新增作品之前先把整份表單存起來。連結改成按鈕是為了這一步——
 * 直接用 `<NuxtLink>` 會在存檔之前就離開，使用者回來時是一張空表單。
 */
async function goCreateFilm() {
  saveDraft({ ...state, film: state.film ?? null })
  await navigateTo({
    path: '/app/films/new',
    query: { title: filmQueried.value || filmTerm.value, from: 'records' },
  })
}

async function onSubmit(event: FormSubmitEvent<RecordForm>) {
  if (!user.value?.sub)
    return
  const form = event.data
  saving.value = true
  try {
    // 票價寫進獨立的 viewing_record_cost 表，不是 viewing_record 的欄位——
    // RLS 只能遮「列」不能有條件地遮「欄」，show_cost 這條規則必須靠結構強制。
    const { data: inserted, error } = await supabase
      .from('viewing_record')
      .insert({ ...toRecordRow(form), user_id: user.value.sub, film_id: form.film.id })
      .select('id')
      .single()
    if (error)
      throw error

    // null 代表「沒有票價資料」，0 代表「真的沒花錢」——只有前者不寫入。
    if (form.cost !== null) {
      const { error: costError } = await supabase
        .from('viewing_record_cost')
        .insert({ record_id: inserted.id, amount: form.cost })
      if (costError) {
        // 紀錄已經建立，票價沒寫進去不該讓整筆消失。明說哪一半失敗即可。
        // ★ 不用 color: 'warning'——Nuxt UI 的 warning 預設就是 Tailwind amber，
        //   跟我們的 primary 同色會撞（DESIGN_SYSTEM §1.5）。用 error + 明確文案。
        toast.add({ title: '記好了，但票價沒存成功', description: costError.message, color: 'error' })
      }
    }

    writeLastVenue(form.venueId)
    clearDraft() // 存進去了，草稿沒有理由再留著
    toast.add({ title: '記好了', color: 'success' })
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
      記一場
    </h1>
    <p class="mt-1 text-sm text-muted">
      片名、日期、場所填完就能存，其餘都可以之後再補。
    </p>

    <!-- @keydown：注音選字按 Enter 不該把表單送出去，見 useImeGuard -->
    <UForm
      :schema="recordSchema"
      :state="state"
      class="mt-8 space-y-5"
      @submit="onSubmit"
      @keydown="blockSubmitWhileComposing"
    >
      <UFormField label="看了什麼" name="film" required>
        <!--
          ignore-filter：過濾交給 Postgres，不要讓 reka-ui 對 2,669 筆做子字串比對。
          v-model:search-term 把輸入接到 useFilmSearch。
          value-key 未設 ⇒ v-model 綁的是整個物件（踩雷 #51），這裡正是想要的。
        -->
        <USelectMenu
          v-model="state.film"
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
          <!--
            空狀態一律用 `filmQueried`（items 對應的查詢字串）而不是 `filmTerm`，否則在 debounce 與
            查詢往返的幾百毫秒內，會拿剛打的字配上一次的空結果，使用者在字還沒查之前就先看到「找不到」。
            注音組字中間態由 reka-ui 的 ListboxFilter 擋掉，`filmTerm` 本來就收不到。
          -->
          <template #empty>
            <div class="px-2 py-3 text-sm">
              <p v-if="filmLoading">
                搜尋中…
              </p>
              <p v-else-if="!filmQueried">
                輸入片名開始搜尋
              </p>
              <p v-else>
                找不到「{{ filmQueried }}」。
                <button type="button" class="underline underline-offset-4" @click="goCreateFilm">
                  手動新增這部片
                </button>
              </p>
            </div>
          </template>
        </USelectMenu>
      </UFormField>

      <div class="grid grid-cols-2 gap-4">
        <UFormField label="哪天看的" name="watchedOn" required>
          <UInput v-model="state.watchedOn" type="date" class="w-full" size="lg" />
        </UFormField>
        <UFormField label="幾點" name="watchedTime" hint="選填">
          <UInput v-model="state.watchedTime" type="time" class="w-full" size="lg" />
        </UFormField>
      </div>

      <UFormField label="在哪看的" name="venueId" required>
        <USelectMenu
          v-model="state.venueId"
          :items="venues"
          value-key="id"
          label-key="name"
          placeholder="選擇影城或場合"
          class="w-full"
          size="lg"
        >
          <!--
            ★ 原本是 `{{ name }}` + `<span>· {{ city }}</span>`，而 `venue.name` 有 3 列是空字串
              ⇒ 整列被算繪成只剩「· 台北市」，看起來像選單裡混進了行政區名。
              **症狀在算繪層、病灶在資料層**：用 `where name ~ '(市|縣)$'` 去 DB 找是找不到的（實測 0 列）。
          -->
          <!--
            分隔改成開眼式括號串不用中點（`A · B · C` 是 Letterboxd 的簽名），形狀同 `venueSegment()`。
            ⚠️ 名字與括號之間的半形空白寫在 span 自己的文字節點裡：whitespace 'condense' 會把「含換行的
               純空白節點」整個刪掉，靠版面縮排留不住那個空格。
          -->
          <!--
            ⚠️ 這裡**不做** `name || company_name` 的 fallback：`venue_option` 根本沒有那一欄，而且同一個
               病灶有七個消費面，補在這裡只補得到一個、髒資料還留在 DB 裡繼續繁殖。
               上游 fallback 在 `src/gov/cinema.ts`，人工正名在 `0015_venue_blank_name.sql`。
          -->
          <template #item-label="{ item }">
            <span>{{ (item as VenueOption).name }}</span>
            <span v-if="(item as VenueOption).city" class="text-muted"> ({{ (item as VenueOption).city }})</span>
          </template>
        </USelectMenu>
      </UFormField>

      <!--
        其他細節**直接顯示不收進風琴**（David 2026-09-21）：這六項是「記完之後要回來對帳」
        的欄位（票價、票數、影廳、版本），收起來等於每次都要多點一下才知道自己填了沒。
        ⚠️ 外層的 `space-y-5` 由 `UForm` 提供，攤平後不要再自己補 `pt-4`（那是補風琴按鈕高度的）。
      -->
      <div class="grid grid-cols-2 gap-4">
        <UFormField label="票數" name="ticketCount">
          <UInputNumber v-model="state.ticketCount" :min="1" :max="99" class="w-full" />
        </UFormField>
        <UFormField label="票價" name="cost" hint="留空＝沒記錄；0＝招待票">
          <template #default>
            <UInputNumber v-model="state.cost" :min="0" class="w-full" />
          </template>
        </UFormField>
      </div>
      <div class="grid grid-cols-2 gap-4">
        <UFormField label="影廳" name="hallLabel">
          <UInput v-model="state.hallLabel" placeholder="如 IMAX 廳" class="w-full" />
        </UFormField>
        <UFormField label="版本" name="formatCode">
          <USelectMenu
            v-model="state.formatCode"
            :items="formats"
            value-key="code"
            label-key="label"
            placeholder="數位／IMAX…"
            class="w-full"
          />
        </UFormField>
      </div>
      <UFormField label="備註" name="memo">
        <UTextarea v-model="state.memo" :rows="3" :maxlength="2000" class="w-full" />
      </UFormField>
      <UFormField>
        <USwitch
          v-model="state.isPublic"
          label="公開這筆紀錄"
          :description="state.isPublic ? '會出現在你的個人頁' : '只有你看得到'"
        />
      </UFormField>

      <UButton type="submit" size="lg" block :loading="saving">
        記下來
      </UButton>
    </UForm>
  </div>
</template>
