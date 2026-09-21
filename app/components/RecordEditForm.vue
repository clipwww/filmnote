<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { FilmOption } from '~/composables/useFilmSearch'
import type { MyRecord } from '~/composables/useMyRecords'
import type { VenueOption } from '~/composables/useRecordOptions'
import type { RecordForm } from '~/schemas/record'
import type { Database } from '~/types/database.types'
import { recordSchema, toRecordRow } from '~/schemas/record'

/**
 * 抽屜裡的「編輯一筆紀錄」表單（2026-09-21，David 第 1、2 條）。
 *
 * ⚠️ **不自己重打一次資料庫**：`MyRecord` 已經帶齊這張表單要的每一個欄位
 * （`useMyRecords.ts`），呼叫端直接把那一列傳進來即可。這同時繞開了踩雷 `#251`
 * ——「點一列才載入詳情」那個陷阱要靠序號守 `picked` 才安全，不載就沒有那個問題。
 */
/*
 * ⚠️ 呼叫端必須給 `:key="record.id"`：`refresh()` 會換掉 `records` 的 identity，
 * key 不變才不會重掛、才不會把使用者正在打的字清掉。
 */
const props = defineProps<{ record: MyRecord }>()
const emit = defineEmits<{ saved: [], cancel: [] }>()

const supabase = useSupabaseClient<Database>()
const toast = useToast()
const { venues } = useVenueOptions()
// ★ 版本選項走 `useScreeningFormats()` 而不是像 `new.vue` 自己再查一次 `screening_format`：
//   表格的 `formatLabel` 用的就是它，同一個 useAsyncData key ⇒ 這裡是零成本的。
const { formats } = useScreeningFormats()
const { term: filmTerm, items: filmItems, loading: filmLoading, queried: filmQueried } = useFilmSearch()

/**
 * 目前這一部片，拼成 `USelectMenu` 認得的 `FilmOption`。
 * ⚠️ `MyRecord` 沒有 `release_year`／`country` ⇒ **預填的那一項不會帶年份**，
 * 搜尋換上去的才會（`filmLabel()` 有年份才印）。這是刻意的取捨：為了年份去動
 * `useMyRecords.ts` 會撞到 `/app` 儀表板（它是共用的，交接 §4.2）。
 */
function currentFilm(record: MyRecord): FilmOption {
  return {
    id: record.filmId,
    slug: record.film?.slug ?? null,
    title_zh: record.film?.titleZh ?? null,
    title_original: record.film?.titleOriginal ?? null,
    release_year: null,
    country: null,
  }
}

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
  film: currentFilm(props.record),
  watchedOn: props.record.watchedOn,
  // `watched_time` 是 `HH:mm:ss`，`<input type="time">` 要的是 `HH:mm`。
  watchedTime: props.record.watchedTime?.slice(0, 5) ?? '',
  venueId: props.record.venueId ?? undefined,
  ticketCount: props.record.ticketCount ?? null,
  cost: props.record.cost === null || props.record.cost === undefined ? null : Number(props.record.cost),
  hallLabel: props.record.hallLabel ?? '',
  formatCode: props.record.formatCode ?? undefined,
  memo: props.record.memo ?? '',
  isPublic: !props.record.isPrivate,
})

const saving = ref(false)
/** 載入時原本就有票價列，才需要在清空時去刪它（沿用 `edit.vue` 的老規矩）。 */
const hadCost = ref(props.record.cost !== null && props.record.cost !== undefined)

async function onSubmit(event: FormSubmitEvent<RecordForm>) {
  const form = event.data
  saving.value = true
  try {
    /*
     * ★ **單一 UPDATE，永遠不是「刪掉再新增」**：`id` 與 `created_at` 必須原封不動
     * （David 第 2 條的驗收就是這個），`viewing_record_cost` 也是靠 `record_id` 掛著，
     * 換一個 id 等於把票價孤兒化。
     * ⚠️ `film_id` 跟其他欄位一起送：RLS 的 `record_update` 只在 `with check` 要求
     * `film_usable_by(film_id, auth.uid())`，**沒有把 `film_id` 釘成常數**（活體查過）
     * ⇒ 換片是被允許的，換到已移除／已合併的片才會被擋。
     */
    const { error } = await supabase
      .from('viewing_record')
      .update({ ...toRecordRow(form), film_id: form.film.id })
      .eq('id', props.record.id)
    if (error)
      throw error

    // 票價在另一張表，三種情況要分開處理。
    // ★ null 是「刪掉這筆票價」，0 是「真的沒花錢」——不可混為一談。
    if (form.cost === null) {
      if (hadCost.value) {
        const { error: de } = await supabase
          .from('viewing_record_cost')
          .delete()
          .eq('record_id', props.record.id)
        if (de)
          throw de
        hadCost.value = false
      }
    }
    else {
      const { error: ce } = await supabase
        .from('viewing_record_cost')
        .upsert({ record_id: props.record.id, amount: form.cost }, { onConflict: 'record_id' })
      if (ce)
        throw ce
      hadCost.value = true
    }

    toast.add({ title: '已更新', color: 'success' })
    emit('saved')
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
  <!-- @keydown：注音選字按 Enter 不該把表單送出去，見 useImeGuard -->
  <UForm
    :schema="recordSchema"
    :state="state"
    class="space-y-5"
    @submit="onSubmit"
    @keydown="blockSubmitWhileComposing"
  >
    <!--
      ⚠️ 作品可改（David 第 2 條：「選錯作品不用刪掉重建」）。形狀照抄 `new.vue` 的作品選擇：
      `ignore-filter` 把過濾交給 Postgres（2,669 筆不可以送進瀏覽器比對，踩雷 #50），
      未設 `value-key` ⇒ v-model 綁整個物件（踩雷 #51），正是 `recordSchema` 要的形狀。
    -->
    <UFormField label="看了什麼" name="film" required>
      <USelectMenu
        v-model="state.film"
        v-model:search-term="filmTerm"
        :items="filmItems"
        :loading="filmLoading"
        ignore-filter
        label-key="title_zh"
        placeholder="輸入片名（中文或原文）"
        class="w-full"
      >
        <template #item-label="{ item }">
          {{ filmLabel(item) }}
        </template>
        <!--
          空狀態一律用 `filmQueried` 而不是 `filmTerm`，否則在 debounce 與查詢往返的幾百毫秒內，
          會拿剛打的字配上一次的空結果，使用者在字還沒查之前就先看到「找不到」。
          ⚠️ 這裡**不給「手動新增這部片」那條路**：那條路會離開頁面，而這個抽屜存在的理由
             正是不要離開頁面（第 1 條）。要新增作品仍然走 `/app/records/new` 那條交棒。
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
            </p>
          </div>
        </template>
      </USelectMenu>
    </UFormField>

    <div class="grid grid-cols-2 gap-4">
      <UFormField label="哪天看的" name="watchedOn" required>
        <UInput v-model="state.watchedOn" type="date" class="w-full" />
      </UFormField>
      <UFormField label="幾點" name="watchedTime" hint="選填">
        <UInput v-model="state.watchedTime" type="time" class="w-full" />
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
      >
        <!-- `venue.name` 有 3 列是空字串，分隔的半形空白寫在 span 自己的文字節點裡
             （whitespace 'condense' 會刪掉含換行的純空白節點）。形狀同 `new.vue`。 -->
        <template #item-label="{ item }">
          <span>{{ (item as VenueOption).name }}</span>
          <span v-if="(item as VenueOption).city" class="text-muted"> ({{ (item as VenueOption).city }})</span>
        </template>
      </USelectMenu>
    </UFormField>

    <div class="grid grid-cols-2 gap-4">
      <UFormField label="票數" name="ticketCount">
        <UInputNumber v-model="state.ticketCount" :min="1" :max="99" class="w-full" />
      </UFormField>
      <UFormField label="票價" name="cost" hint="留空＝刪除票價；0＝招待票">
        <template #default>
          <UInputNumber v-model="state.cost" :min="0" class="w-full" />
        </template>
      </UFormField>
    </div>

    <div class="grid grid-cols-2 gap-4">
      <UFormField label="影廳" name="hallLabel">
        <UInput v-model="state.hallLabel" placeholder="如 IMAX 廳" class="w-full" />
      </UFormField>
      <!--
        ⚠️ 版本欄是**補回一個本來就該在的欄位**（交接 §2.1）：舊的 `[id]/edit.vue` 有載入
           `state.formatCode`、`toRecordRow` 也有送出，但 template 裡沒有對應的輸入元件
           ⇒ 版本在編輯畫面上**改不了**（值會原樣存回，不會被清掉，所以沒人發現）。
      -->
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

    <div class="flex gap-3">
      <UButton type="submit" :loading="saving">
        儲存
      </UButton>
      <UButton variant="ghost" color="neutral" @click="emit('cancel')">
        取消
      </UButton>
    </div>
  </UForm>
</template>
