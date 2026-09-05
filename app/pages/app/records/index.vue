<script setup lang="ts">
import type { MyRecord } from '~/composables/useMyRecords'
import type { Database } from '~/types/database.types'

/**
 * `/app/records` — 完整列表（`SCREENS.md §10`）。
 *
 * 與 `/app` 的分工：`/app` 是儀表板（量詞句 + 圖表 band + 最近的紀錄），
 * 這裡是**可以動手改東西**的地方。兩頁共用 `useMyRecords()` 的同一份
 * `useAsyncData`，互相切換不會重打資料庫。
 *
 * §10 還要求年份／影城／版本三個篩選器，尚未實作。
 */
useSeoMeta({ title: '全部紀錄' })

const supabase = useSupabaseClient<Database>()
const toast = useToast()

const { records, status, refresh } = useMyRecords()

/**
 * ⚠️ 174 筆一次全部攤開是 22,635px 的頁面（實測）。功能對，但沒有人能用——
 * 這正是上一輪「17,481px 的個人頁」那個問題，換一頁再犯一次。
 *
 * 所以預設只顯示最近一年，其餘用年份切換；單一年份內再分批載入。
 * §10 還要求影城與版本兩個篩選器，尚未實作。
 */
const years = computed(() => [...new Set(records.value.map(r => r.year))])
const selectedYear = ref<string | null>(null)
/** null 代表「還沒選過」⇒ 用最近的一年；'' 代表使用者選了「全部」。 */
const activeYear = computed(() => selectedYear.value ?? years.value[0] ?? '')

const PAGE = 24
const shown = ref(PAGE)
watch(activeYear, () => {
  shown.value = PAGE
})

const filtered = computed(() =>
  activeYear.value ? records.value.filter(r => r.year === activeYear.value) : records.value)
const visible = computed(() => filtered.value.slice(0, shown.value))
const hasMore = computed(() => filtered.value.length > shown.value)
const groups = computed(() => groupByYear(visible.value))

/** 破壞性動作一律二次確認（§10 品質底線）。 */
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
  <div class="mx-auto max-w-3xl px-4 py-8">
    <div class="flex items-center justify-between gap-4">
      <h1 class="text-2xl font-bold tracking-tight">
        全部紀錄
      </h1>
      <UButton to="/app/records/new" icon="i-lucide-plus">
        記一筆
      </UButton>
    </div>

    <div v-if="status === 'pending'" class="mt-8 space-y-2">
      <USkeleton v-for="i in 6" :key="i" class="h-[92px] w-full rounded-sm" />
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

      <section v-for="g in groups" :key="g.year" class="mt-8">
        <h2 class="text-sm font-semibold text-muted tabular-nums">
          {{ g.year }} 年 · {{ g.rows.length }} 場
        </h2>
        <ul class="mt-3 space-y-2">
          <li v-for="r in g.rows" :key="r.id">
            <TicketCard :record="r">
              <template #actions>
                <UButton
                  :to="`/app/records/${r.id}/edit`"
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
                  @click="pending = r"
                />
              </template>
            </TicketCard>
          </li>
        </ul>
      </section>

      <div v-if="hasMore" class="mt-6 flex justify-center">
        <UButton variant="soft" color="neutral" @click="shown += PAGE">
          再顯示 {{ Math.min(PAGE, filtered.length - shown) }} 筆（{{ activeYear || '全部' }} 共 {{ filtered.length }} 筆）
        </UButton>
      </div>
    </template>

    <UModal v-model:open="confirmOpen" title="刪掉這筆">
      <template #body>
        <p>
          刪掉之後救不回來。
        </p>
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
