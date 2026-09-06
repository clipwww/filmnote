<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { MyRecord } from '~/composables/useMyRecords'
import type { Database } from '~/types/database.types'
import { shortTime } from '~/utils/format-datetime'
import { costText, dateBand, venueSegment } from '~/utils/ticket'

/**
 * `/app/records` — 全部紀錄（`SCREENS.md §10`）。
 *
 * ── 2026-09-06：從票根卡列表改成表格 ───────────────────────────────────
 * David：「紀錄管理用 Table + 一些簡易 Filter」。這是**這一頁的呈現改變，
 * 不是 `TicketCard` 退場**——`/u/`、`/film/` 的「誰看過」、匯入預覽都還在用它，
 * 而且這一頁的刪除確認框裡仍然是票根卡（要確認「刪的是哪一筆」時，
 * 一張看得出是什麼的卡片比一列表格好）。
 *
 * 兩種呈現各自對的地方：
 *   · 票根卡是**一筆一筆看**——公開頁、單筆分享、確認框。
 *   · 表格是**橫著比**——「我在哪家戲院花最多」「哪些沒填票價」要對齊欄位才看得出來。
 * `/app/records` 的定位是「可以動手改東西的地方」（§10），所以它是後者。
 *
 * ── 篩選維度是從真實資料長出來的 ───────────────────────────────────────
 * 年份／影城／版本／有無票價。前三個的選項直接從**當年**的紀錄取相異值——
 * 不從全部紀錄取，否則會出現一堆選了就 0 筆的選項，而使用者無從得知為什麼。
 * 「有無票價」是第四個維度：174 筆裡有 5 筆沒有金額，那正是要補資料的那幾筆。
 *
 * ⚠️ 不用 `UTable` 的 `virtualize`：它要求容器有確定高度（踩雷 #54），
 * 而這一頁的容器是隨內容長的。改用原本就有的分批載入——單一年份大多在 30 筆
 * 以內，攤開也不會變成一萬 px 的頁面。
 */
useSeoMeta({ title: '全部紀錄' })

const supabase = useSupabaseClient<Database>()
const toast = useToast()

const { records, status, refresh } = useMyRecords()

/* ── 篩選 ─────────────────────────────────────────────────────────────── */
const years = computed(() => [...new Set(records.value.map(r => r.year))])
const selectedYear = ref<string | null>(null)
/** null 代表「還沒選過」⇒ 用最近的一年；'' 代表使用者選了「全部」。 */
const activeYear = computed(() => selectedYear.value ?? years.value[0] ?? '')

const byYear = computed(() =>
  activeYear.value ? records.value.filter(r => r.year === activeYear.value) : records.value)

const ALL = '__all__'
const venue = ref(ALL)
const format = ref(ALL)
const cost = ref(ALL)

/** 選項只從當年的紀錄長出來：選了就 0 筆的選項比沒有選項更難用。 */
function options(values: (string | null | undefined)[], allLabel: string) {
  const seen = [...new Set(values.map(v => v?.trim()).filter((v): v is string => !!v))].sort()
  return [{ label: allLabel, value: ALL }, ...seen.map(v => ({ label: v, value: v }))]
}
const venueOptions = computed(() => options(byYear.value.map(r => r.venueName), '所有影城'))
const formatOptions = computed(() => options(byYear.value.map(r => r.formatLabel), '所有版本'))
const costOptions = [
  { label: '票價不限', value: ALL },
  { label: '有填票價', value: 'has' },
  { label: '沒填票價', value: 'none' },
]

/** 分批載入的一批。單一年份大多在 30 筆以內，攤開也不會變成一萬 px 的頁面。 */
const PAGE = 24
const shown = ref(PAGE)

// 換年份時把其餘篩選重設：留著一個當年不存在的影城，畫面會是空的而且看不出原因。
watch(activeYear, () => {
  venue.value = ALL
  format.value = ALL
  cost.value = ALL
  shown.value = PAGE
})

const filtered = computed(() => byYear.value.filter((r) => {
  if (venue.value !== ALL && r.venueName?.trim() !== venue.value)
    return false
  if (format.value !== ALL && r.formatLabel?.trim() !== format.value)
    return false
  if (cost.value === 'has' && (r.cost === null || r.cost === undefined))
    return false
  if (cost.value === 'none' && r.cost !== null && r.cost !== undefined)
    return false
  return true
}))

const hasNarrowed = computed(() => venue.value !== ALL || format.value !== ALL || cost.value !== ALL)
function clearFilters() {
  venue.value = ALL
  format.value = ALL
  cost.value = ALL
}

watch(filtered, () => {
  shown.value = PAGE
})
const visible = computed(() => filtered.value.slice(0, shown.value))
const hasMore = computed(() => filtered.value.length > shown.value)

/* ── 表格 ─────────────────────────────────────────────────────────────── */
const columns: TableColumn<MyRecord>[] = [
  { accessorKey: 'watchedOn', header: '日期' },
  { id: 'film', header: '作品' },
  { id: 'venue', header: '影城' },
  { accessorKey: 'formatLabel', header: '版本' },
  { accessorKey: 'ticketCount', header: '張' },
  { accessorKey: 'cost', header: '票價' },
  { id: 'actions', header: '' },
]

/* ── 刪除（破壞性動作一律二次確認，§10 品質底線）───────────────────────── */
const pending = ref<MyRecord | null>(null)
const deleting = ref(false)
/** UModal 的 open 要 boolean，pending 存的是「哪一筆」，中間需要一層轉換。 */
const confirmOpen = computed({
  get: () => pending.value !== null,
  set: (v: boolean) => {
    if (!v)
      pending.value = null
  },
})

async function confirmRemove() {
  const target = pending.value
  if (!target)
    return
  deleting.value = true
  const { error } = await supabase.from('viewing_record').delete().eq('id', target.id)
  deleting.value = false
  if (error) {
    toast.add({ title: '刪不掉', description: error.message, color: 'error' })
    return
  }
  pending.value = null
  toast.add({ title: '刪掉了', color: 'success' })
  await refresh()
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-8">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        全部紀錄
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一場
      </UButton>
    </div>

    <div v-if="status === 'pending'" class="mt-8 space-y-2">
      <USkeleton v-for="i in 8" :key="i" class="h-11 w-full rounded-sm" />
    </div>

    <p v-else-if="!records.length" class="mt-8 text-muted">
      還沒有任何紀錄。
    </p>

    <template v-else>
      <!-- 年份切換。捲軸自己橫向捲，頁面 body 永遠不橫向捲（§10 品質底線）。 -->
      <div class="mt-6 -mx-4 overflow-x-auto px-4">
        <div class="flex w-max gap-1.5">
          <UButton
            v-for="y in years"
            :key="y"
            :variant="activeYear === y ? 'solid' : 'ghost'"
            :color="activeYear === y ? 'primary' : 'neutral'"
            size="sm"
            class="tabular-nums"
            @click="selectedYear = y"
          >
            {{ y }}
          </UButton>
          <UButton
            :variant="activeYear === '' ? 'solid' : 'ghost'"
            :color="activeYear === '' ? 'primary' : 'neutral'"
            size="sm"
            @click="selectedYear = ''"
          >
            全部（{{ records.length }}）
          </UButton>
        </div>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2">
        <USelect v-model="venue" :items="venueOptions" size="sm" class="min-w-40 max-w-64" />
        <USelect v-model="format" :items="formatOptions" size="sm" class="min-w-28" />
        <USelect v-model="cost" :items="costOptions" size="sm" class="min-w-28" />
        <UButton
          v-if="hasNarrowed"
          variant="ghost"
          color="neutral"
          size="sm"
          icon="i-lucide-x"
          @click="clearFilters"
        >
          清掉篩選
        </UButton>
        <span class="ms-auto text-sm text-muted tabular-nums">{{ `${filtered.length} 筆` }}</span>
      </div>

      <!--
        ⚠️ 表格在自己的容器裡橫向捲，頁面 body 永遠不橫向捲（§10）。
        375px 放不下七欄是必然的，硬塞只會讓每一欄都斷成兩三行。
      -->
      <div class="mt-4 overflow-x-auto rounded-sm border border-default">
        <UTable :data="visible" :columns="columns" class="min-w-3xl">
          <template #watchedOn-cell="{ row }">
            <!-- 日期帶的同一套寫法：Jul / 26 Sun / 16:00（David 2026-09-06）。
                 跟票根卡一致——使用者不會覺得同一份資料在兩頁該長得不一樣。 -->
            <div class="leading-tight tabular-nums whitespace-nowrap">
              <div class="text-highlighted">
                {{ `${dateBand(row.original.watchedOn)?.month ?? ''} ${row.original.watchedOn.slice(8)}` }}
                <span class="text-muted">{{ dateBand(row.original.watchedOn)?.weekday }}</span>
              </div>
              <div class="text-[12px] text-muted">
                {{ shortTime(row.original.watchedTime) ?? '—' }}
              </div>
            </div>
          </template>

          <template #film-cell="{ row }">
            <div class="min-w-0 max-w-72">
              <NuxtLink
                v-if="row.original.film?.slug"
                :to="`/film/${row.original.film.slug}`"
                class="block truncate text-highlighted hover:underline underline-offset-4"
              >
                {{ row.original.film?.titleZh || row.original.film?.titleOriginal || '（作品不明）' }}
              </NuxtLink>
              <span v-else class="block truncate text-muted">
                {{ row.original.film?.titleZh || '（作品待審核）' }}
              </span>
              <span
                v-if="row.original.film?.titleOriginal && row.original.film.titleOriginal !== row.original.film.titleZh"
                class="block truncate text-[12px] text-muted"
              >
                {{ row.original.film.titleOriginal }}
              </span>
            </div>
          </template>

          <template #venue-cell="{ row }">
            <div class="max-w-64 truncate">
              {{ venueSegment(row.original) ?? '—' }}
            </div>
          </template>

          <template #formatLabel-cell="{ row }">
            <span class="whitespace-nowrap">{{ row.original.formatLabel ?? '—' }}</span>
          </template>

          <template #ticketCount-cell="{ row }">
            <span class="tabular-nums">{{ row.original.ticketCount ?? '—' }}</span>
          </template>

          <!-- 票價三態必須看得出差別（§4.3）：null 是「沒有」、0 是「免費」。 -->
          <template #cost-cell="{ row }">
            <span class="tabular-nums" :class="costText(row.original.cost) ? '' : 'text-dimmed'">
              {{ costText(row.original.cost) ?? '—' }}
            </span>
          </template>

          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-1">
              <UButton
                :to="`/app/records/${row.original.id}/edit`"
                variant="ghost"
                color="neutral"
                icon="i-lucide-pencil"
                size="sm"
                aria-label="編輯這筆"
              />
              <UButton
                variant="ghost"
                color="error"
                icon="i-lucide-trash-2"
                size="sm"
                aria-label="刪掉這筆"
                @click="pending = row.original"
              />
            </div>
          </template>
        </UTable>
      </div>

      <!-- 篩到 0 筆時要說得出「放寬哪一個」，不然使用者只看到一張空表（DS §8）。 -->
      <p v-if="!filtered.length" class="mt-4 text-sm text-muted">
        {{ hasNarrowed ? '這幾個篩選條件下沒有紀錄。' : `${activeYear || '全部'} 沒有紀錄。` }}
        <UButton v-if="hasNarrowed" variant="link" color="primary" size="sm" class="p-0" @click="clearFilters">
          清掉篩選
        </UButton>
      </p>

      <div v-if="hasMore" class="mt-4 flex justify-center">
        <UButton variant="soft" color="neutral" @click="shown += PAGE">
          {{ `再顯示 ${Math.min(PAGE, filtered.length - shown)} 筆（共 ${filtered.length} 筆）` }}
        </UButton>
      </div>
    </template>

    <UModal v-model:open="confirmOpen" title="刪掉這筆">
      <template #body>
        <p>
          刪掉之後救不回來。
        </p>
        <!-- 確認框裡用票根卡不用表格列：要確認「刪的是哪一筆」時，
             一張看得出是什麼的卡片比一列對齊的欄位好。 -->
        <div v-if="pending" class="mt-4">
          <TicketCard :record="pending" :link-film="false" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="pending = null">
            算了
          </UButton>
          <UButton color="error" :loading="deleting" @click="confirmRemove">
            刪掉這筆
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
