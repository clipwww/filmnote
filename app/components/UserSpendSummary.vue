<script setup lang="ts">
/**
 * 票價摘要。**只在 client 端執行**（呼叫端以 <ClientOnly> 包住）。
 *
 * 用瀏覽器自己的 session 直接打 Supabase，讓 RLS 依觀看者決定看得到哪些票價列：
 *   · 本人           → 全部
 *   · 作者開了 show_cost 且紀錄公開 → 看得到
 *   · 其他            → 空集合
 *
 * 因為 viewing_record_cost 是獨立的「列」，這裡拿到什麼完全由資料庫決定，
 * 前端不需要（也不能）自己判斷該不該顯示。
 *
 * ★ 聚合是推論通道：拿得到的列可能只是全部的一部分，所以一定要標示
 *   「部分票價未公開」，而不是給一個看起來完整的總額。
 */
const props = defineProps<{ username: string }>()

const supabase = useSupabaseClient()
const user = useSupabaseUser()

const { data } = await useAsyncData(
  () => `spend-${props.username}`,
  async () => {
    const { data: profile } = await supabase
      .from('profile')
      .select('id,show_cost')
      .eq('username', props.username)
      .maybeSingle()
    if (!profile?.id)
      return null

    // 這個使用者「公開可見」的紀錄總數（RLS 已過濾）
    const { count: visibleRecords } = await supabase
      .from('viewing_record')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', profile.id)

    // 讀得到票價的那些列。讀不到的列不會出現，也無法從這裡推回金額。
    const { data: costs } = await supabase
      .from('viewing_record_cost')
      .select('amount,currency,viewing_record!inner(user_id)')
      .eq('viewing_record.user_id', profile.id)

    const rows = costs ?? []
    const total = rows.reduce((n, c) => n + Number(c.amount ?? 0), 0)
    return {
      isOwner: user.value?.sub === profile.id,
      showCost: profile.show_cost,
      visibleRecords: visibleRecords ?? 0,
      countedRecords: rows.length,
      total,
      currency: rows[0]?.currency ?? 'TWD',
    }
  },
  { watch: [() => props.username, user], server: false },
)

const partial = computed(() =>
  !!data.value && data.value.countedRecords < data.value.visibleRecords)
</script>

<template>
  <section v-if="data && data.countedRecords > 0" class="mt-8 rounded-lg border border-default px-4 py-3">
    <p class="text-sm text-muted">
      票價合計<span v-if="data.isOwner">（僅你看得到）</span>
    </p>
    <p class="text-2xl font-semibold tabular-nums">
      {{ data.currency }} {{ data.total.toLocaleString('zh-Hant-TW') }}
    </p>
    <p v-if="partial" class="mt-1 text-xs text-muted">
      部分票價未公開，此金額只涵蓋 {{ data.countedRecords }} / {{ data.visibleRecords }} 筆紀錄。
    </p>
  </section>
</template>
