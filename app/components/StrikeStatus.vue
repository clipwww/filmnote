<script setup lang="ts">
import type { Database } from '~/types/database.types'

/**
 * 三振狀態（`SCREENS §15.5`）。放在 `/app/settings` 的帳號區塊**不是藏在 `/legal`**：
 * `/legal/terms` 第 6 節寫著「三次涉有侵權情事應終止服務」，條款寫了但使用者查不到自己有
 * 幾次，**第三次就是突襲**——§90-4 要求「確實履行」，查不到的計數在使用者那側等於不存在。
 */
/*
 * `strike_count = 0` 時整個區塊不出現：沒有事的人不需要被提醒有三振制度。這不是把資訊藏起來
 * （制度本身寫在條款裡），這一區是「你自己的狀態」，而沒有狀態就不該有版面。
 */
/*
 * ⚠️ 計數只能來自資料庫，不可以自己算也不可以快取：`admin_restore()` 會把該次通知造成的三振
 * `revoked_at` 掉、由 trigger 重算，而使用者在意的正是「我申訴成功了沒」⇒ `getCachedData`
 * 直接回 undefined。拿列表 `length` 當計數也不行——那是第二份判斷，會跟 trigger 分岔。
 */
const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()

interface StrikeRow {
  id: number
  created_at: string
  note: string | null
  noticeUrl: string | null
  work: string | null
}

const { data } = await useAsyncData('strike-status', async () => {
  if (!user.value?.sub)
    return null

  const { data: priv } = await supabase
    .from('profile_private')
    .select('strike_count,service_status,suspended_at')
    .eq('id', user.value.sub)
    .maybeSingle()

  // 計數是 DB 的欄位，不是下面那個列表的長度。
  const count = priv?.strike_count ?? 0
  if (!priv || count < 1)
    return { count: 0, status: priv?.service_status ?? 'active', suspendedAt: null, strikes: [] as StrikeRow[] }

  const { data: strikes } = await supabase
    .from('copyright_strike')
    .select('id,created_at,note,notice_id')
    .eq('profile_id', user.value.sub)
    .is('revoked_at', null)
    .order('created_at', { ascending: true })

  // 通知本身只有「被取下的當事人」讀得到（0006 的 takedown_affected_user），
  // 而那條 policy 比對的是 target_record_id / target_film_id。對不上就讀不到，
  // 那不是錯誤——顯示層退回只給日期，不要因此讓整區消失。
  const noticeIds = (strikes ?? []).map(s => s.notice_id).filter((v): v is number => v !== null)
  const { data: notices } = noticeIds.length
    ? await supabase.from('takedown_notice').select('id,target_url,work_description').in('id', noticeIds)
    : { data: [] }
  const byId = new Map((notices ?? []).map(n => [n.id, n]))

  return {
    count,
    status: priv.service_status,
    suspendedAt: priv.suspended_at,
    strikes: (strikes ?? []).map(s => ({
      id: s.id,
      created_at: s.created_at,
      note: s.note,
      noticeUrl: s.notice_id ? byId.get(s.notice_id)?.target_url ?? null : null,
      work: s.notice_id ? byId.get(s.notice_id)?.work_description ?? null : null,
    })),
  }
}, {
  server: false,
  watch: [user],
  // 見檔頭：申訴成功之後，畫面必須跟著回到正確的數字。
  getCachedData: () => undefined,
})

const remaining = computed(() => Math.max(0, 3 - (data.value?.count ?? 0)))

/** 文案照 DS §8：說發生了什麼跟怎麼修，不道歉、不模糊。 */
const statusText = computed(() => {
  switch (data.value?.status) {
    case 'terminated':
      return '你的帳號已終止。公開的紀錄與個人頁都已停止提供。'
    case 'limited':
      return '你的帳號目前受限。再有一次就會終止全部服務。'
    default:
      return remaining.value === 1
        ? '再有一次就會限制服務，第三次會終止。'
        : `再有 ${remaining.value} 次會終止全部或部分服務。`
  }
})

function dateText(iso: string) {
  return new Intl.DateTimeFormat('zh-Hant-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso)).replace(/\//g, '-')
}
</script>

<template>
  <!-- strike_count = 0 ⇒ 整區不出現（§15.5）。沒有事的人不需要被提醒。 -->
  <section v-if="data && data.count > 0">
    <h2 class="font-semibold">
      著作權通知
    </h2>
    <p class="mt-1 text-sm text-toned">
      {{ `你目前有 ${data.count} 次涉有侵權情事的紀錄。${statusText}` }}
    </p>

    <ul class="mt-3 divide-y divide-default border border-default rounded-sm">
      <li v-for="(s, i) in data.strikes" :key="s.id" class="px-3 py-2.5 text-sm">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="text-muted tabular-nums">{{ `第 ${i + 1} 次` }}</span>
          <span class="text-muted tabular-nums">{{ dateText(s.created_at) }}</span>
        </div>
        <p v-if="s.work" class="mt-1 text-toned">
          {{ s.work }}
        </p>
        <p v-if="s.noticeUrl" class="mt-0.5 break-words text-[13px] text-muted">
          {{ s.noticeUrl }}
        </p>
        <p v-if="!s.work && !s.noticeUrl" class="mt-1 text-[13px] text-muted">
          這一次的通知內容不在你的可讀範圍內。要查明細請用著作權政策上的窗口聯絡我們。
        </p>
        <p v-if="s.note" class="mt-1 text-[13px] text-muted">
          {{ s.note }}
        </p>
      </li>
    </ul>

    <p class="mt-3 text-[13px] text-muted">
      認為某一次通知並無侵權情事的話，可以提出回復通知——入口在被取下的那筆紀錄上。
      制度本身寫在
      <NuxtLink to="/legal/copyright#s5" class="text-primary hover:underline">
        著作權政策第 5 節
      </NuxtLink>
      與
      <NuxtLink to="/legal/terms#s6" class="text-primary hover:underline">
        服務條款第 6 節
      </NuxtLink>
      。
    </p>
  </section>
</template>
