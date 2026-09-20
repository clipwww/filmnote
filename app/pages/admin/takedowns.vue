<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { dayText } from './-admin-shared'
import AdminShell from './-AdminShell.vue'
import StaffGate from './-StaffGate.vue'

/**
 * `/admin/takedowns` —— DMCA 承辦（US-51~54、`SCREENS §14` ③）。跟另外兩個佇列的差別：
 * **漏掉一筆的後果是法律責任不是資料品質** ⇒ 不按受理時間排、按期限排，快到期的用 error 色，
 * 而**全站只有這裡用紅色**。通知人的姓名與 email 完整顯示（§90-6），**不要自作主張改成遮蔽**。
 */
/*
 * 所有日期與天數都讀 DB，前端絕不自己算工作日：trigger 用 `business_days_after()` 算
 * §90-9 的 10 個工作日與 14 個工作日，剩餘天數走 `business_days_between()`。前端自己算就是
 * 兩份定義，而它們**一定**會在國定假日那題上分岔。
 */
/*
 * ⚠️ 誠實話：`business_days_*` **只扣週末不扣國定假日**（春節、清明、端午、中秋都沒扣）
 * ⇒ 算出來的期限偏早。偏早對平台是保守的，但它是已知的近似值不是權威。
 */
/*
 * ⚠️ 我上一輪回報「forwarded_at 寫不進去 ⇒ trigger 從不觸發 ⇒ 期限永遠 null」，**那是推論
 * 而且是錯的**。實測：trigger 是 `before insert or update of forwarded_at`，INSERT 那次就會觸發。
 * 真正的缺陷比較細：§90-9 的起算點是「**轉送**」，錨在 `received_at` 上算出來的不是法定那一個，
 * 而且平台無法舉證自己何時轉送過。`admin_forward_counter_notice()` 就是補這一步。
 */
/*
 * 寫入一律走 RPC 不靠 `grant update`：這三張表是法遵證據，給 update 權限等於讓任何 staff
 * 改得動 claimant_name／received_at——**竄改證據**。RPC 只動流程欄位，時間戳是伺服器端的
 * `now()`，客戶端沒辦法把「我們何時通知使用者」往前補登。
 */
/*
 * ⚠️ 「已收到訴訟證明」按不下去：`notice_status` 有 `litigation_notified`，但整個 schema
 * **沒有任何地方寫得進它**（grep 過 0001–0011，只有 enum 定義那一行）。維持 disabled 並寫明
 * 原因，不假裝它會動。已回報。
 */
definePageMeta({ layout: 'default' })
useSeoMeta({ title: 'DMCA 承辦', robots: 'noindex, nofollow' })

const supabase = useSupabaseClient<Database>()
const toast = useToast()

type NoticeStatus = Database['public']['Enums']['notice_status']

const STATUS_LABEL: Record<NoticeStatus, string> = {
  received: '已受理',
  rejected: '已駁回',
  actioned: '已取下',
  counter_received: '已提出回復通知',
  counter_forwarded: '回復通知已轉送',
  restored: '已回復',
  litigation_notified: '已收到訴訟證明',
}

interface CounterRow {
  id: number
  notice_id: number
  profile_id: string
  reason: string
  received_at: string
  forwarded_at: string | null
  litigation_deadline_at: string | null
  restore_deadline_at: string | null
  restored_at: string | null
}

interface ActionRow {
  id: number
  notice_id: number
  subject_kind: string
  film_id: string | null
  record_id: string | null
  acted_at: string
  restored_at: string | null
}

interface NoticeRow {
  id: number
  status: NoticeStatus
  claimant_name: string
  claimant_email: string
  claimant_phone: string | null
  work_description: string
  target_url: string
  target_film_id: string | null
  target_record_id: string | null
  received_at: string
  actioned_at: string | null
  notified_user_at: string | null
  note: string | null
  counter: CounterRow | null
  actions: ActionRow[]
  /** 期限排序用：最近的一個未過的法定期限（DB 算好的值，前端不重算）。 */
  deadlineAt: string | null
  deadlineKind: string | null
}

const { data, status: listStatus, refresh } = useAsyncData('admin-takedowns', async () => {
  const { data: notices, error } = await supabase
    .from('takedown_notice')
    .select('id,status,claimant_name,claimant_email,claimant_phone,work_description,target_url,target_film_id,target_record_id,received_at,actioned_at,notified_user_at,note')
    .order('received_at', { ascending: false })
  if (error)
    throw error
  const rows = notices ?? []
  if (!rows.length)
    return [] as NoticeRow[]

  const ids = rows.map(r => r.id)
  const [{ data: counters }, { data: actions }] = await Promise.all([
    supabase
      .from('counter_notice')
      .select('id,notice_id,profile_id,reason,received_at,forwarded_at,litigation_deadline_at,restore_deadline_at,restored_at')
      .in('notice_id', ids),
    supabase
      .from('takedown_action')
      .select('id,notice_id,subject_kind,film_id,record_id,acted_at,restored_at')
      .in('notice_id', ids),
  ])

  return rows.map((n) => {
    const counter = (counters ?? []).find(c => c.notice_id === n.id) ?? null
    // 兩個法定期限取比較近的那一個當排序鍵。兩個都是 DB 算的。
    const candidates: [string, string | null][] = [
      ['對方提出訴訟證明', counter?.restored_at ? null : counter?.litigation_deadline_at ?? null],
      ['必須回復內容', counter?.restored_at ? null : counter?.restore_deadline_at ?? null],
    ]
    const live = candidates.filter((c): c is [string, string] => !!c[1]).sort((a, b) => a[1].localeCompare(b[1]))
    return {
      ...n,
      counter,
      actions: (actions ?? []).filter(a => a.notice_id === n.id),
      deadlineAt: live[0]?.[1] ?? null,
      deadlineKind: live[0]?.[0] ?? null,
    } as NoticeRow
  }).sort((a, b) => {
    // 有法定期限的排前面，並依期限由近到遠；其餘依受理時間由新到舊。
    if (a.deadlineAt && b.deadlineAt)
      return a.deadlineAt.localeCompare(b.deadlineAt)
    if (a.deadlineAt)
      return -1
    if (b.deadlineAt)
      return 1
    return b.received_at.localeCompare(a.received_at)
  })
}, { server: false })

const notices = computed(() => data.value ?? [])
const selectedId = ref<number | null>(null)
const selected = computed(() => notices.value.find(n => n.id === selectedId.value) ?? null)

/** 「還在處理中」＝ 尚未回復也尚未駁回。列表表頭用它算數字。 */
const openCount = computed(() => notices.value.filter(n => n.status !== 'restored' && n.status !== 'rejected').length)

/**
 * 剩餘**工作日**，由 `business_days_between()` 算（0011）。未來回正數、今天回 0、
 * 已逾期回負數——逾期不回 0 是刻意的：「今天到期」與「已經遲了三天」在這個佇列裡是
 * 完全不同的兩件事。一次把畫面上會用到的期限全部問完，不要一列一次往返。
 */
const workdaysLeft = ref<Map<string, number>>(new Map())

async function loadWorkdays(rows: NoticeRow[]) {
  const targets = [...new Set(rows.map(r => r.deadlineAt).filter((v): v is string => !!v))]
  const next = new Map<string, number>()
  const now = new Date().toISOString()
  for (const at of targets) {
    const { data, error } = await supabase.rpc('business_days_between', { p_from: now, p_to: at })
    if (!error && typeof data === 'number')
      next.set(at, data)
  }
  workdaysLeft.value = next
}

watch(notices, rows => loadWorkdays(rows), { immediate: true })

/** 期限 chip 的文字與緊急程度。**日期是權威值，天數由 DB 算。** */
function deadlineChip(n: NoticeRow): { text: string, urgent: boolean } | null {
  if (!n.deadlineAt)
    return null
  const when = dayText(n.deadlineAt)
  const days = workdaysLeft.value.get(n.deadlineAt)
  if (days === undefined) {
    // 還沒問回來就只給日期。**不要在這裡自己算一個日曆天頂替**——
    // 那正是「兩份定義」的開端，而分岔的那個會出現在法定期限上。
    return { text: when, urgent: false }
  }
  if (days < 0)
    return { text: `${when} 已逾期 ${-days} 個工作日`, urgent: true }
  if (days === 0)
    return { text: `${when}（今天到期）`, urgent: true }
  return { text: `${when}（剩 ${days} 個工作日）`, urgent: days <= 3 }
}

// ─────────────────────────────────────────────────────────────────────────────
// 標的：取下與三振都要知道「是哪一部作品／哪一筆紀錄」和「是誰的」
// ─────────────────────────────────────────────────────────────────────────────
interface TargetInfo {
  kind: 'film' | 'record' | null
  label: string
  /** 被指控的使用者。三振要用它，沒有它就不該讓人按三振。 */
  profileId: string | null
  username: string | null
}

const target = ref<TargetInfo | null>(null)
const targetLoading = ref(false)

watch(selected, async (n) => {
  target.value = null
  if (!n)
    return
  targetLoading.value = true
  try {
    if (n.target_film_id) {
      const { data: f } = await supabase
        .from('film')
        .select('id,title_zh,title_original,created_by')
        .eq('id', n.target_film_id)
        .maybeSingle()
      const username = f?.created_by ? await usernameOf(f.created_by) : null
      target.value = {
        kind: 'film',
        label: f ? `${displayTitle(f.title_zh) || f.title_original || '未命名'}（作品）` : '找不到這部作品',
        profileId: f?.created_by ?? null,
        username,
      }
    }
    else if (n.target_record_id) {
      const { data: r } = await supabase
        .from('viewing_record')
        .select('id,user_id,watched_on,film_id')
        .eq('id', n.target_record_id)
        .maybeSingle()
      const username = r?.user_id ? await usernameOf(r.user_id) : null
      target.value = {
        kind: 'record',
        label: r ? `${r.watched_on} 的一筆觀影紀錄` : '找不到這筆紀錄',
        profileId: r?.user_id ?? null,
        username,
      }
    }
    else {
      // §90-4 只要求通知人指出「涉嫌侵權之內容」，URL 是必填、id 不是。
      // 對不上具體那一列時要老實說，不要讓承辦以為系統認得。
      target.value = { kind: null, label: '通知裡沒有指到具體的作品或紀錄，只有網址', profileId: null, username: null }
    }
  }
  finally {
    targetLoading.value = false
  }
})

async function usernameOf(id: string): Promise<string | null> {
  const { data } = await supabase.from('profile').select('username').eq('id', id).maybeSingle()
  return data?.username ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// 三個做得到的動作。全部走 RPC，授權在函式裡的 is_staff()。
// ─────────────────────────────────────────────────────────────────────────────
const acting = ref(false)
/** 破壞性動作一律二次確認：哪一個正在確認。 */
const confirming = ref<'takedown' | 'restore' | 'strike' | 'notify' | 'forward' | null>(null)
const actionNote = ref('')

const confirmOpen = computed({
  get: () => confirming.value !== null,
  set: (v: boolean) => {
    if (!v) {
      confirming.value = null
      actionNote.value = ''
    }
  },
})

function ask(kind: NonNullable<typeof confirming['value']>) {
  actionNote.value = ''
  confirming.value = kind
}

async function runConfirmed() {
  const n = selected.value
  const kind = confirming.value
  if (!n || !kind)
    return
  acting.value = true
  try {
    if (kind === 'takedown') {
      const { data: count, error } = await supabase.rpc('admin_takedown', {
        p_notice_id: n.id,
        p_film_id: n.target_film_id as string,
        p_record_id: n.target_record_id as string,
        p_note: actionNote.value.trim(),
      })
      if (error)
        throw error
      toast.add({ title: `已取下 ${count ?? 0} 個標的`, description: '公開頁上會立刻消失，引用它的其他人的公開紀錄也一併消失。', color: 'success' })
    }
    else if (kind === 'restore') {
      const { data: count, error } = await supabase.rpc('admin_restore', {
        p_notice_id: n.id,
        p_note: actionNote.value.trim(),
      })
      if (error)
        throw error
      toast.add({ title: `已回復 ${count ?? 0} 個標的`, description: 'visibility 與 moderation_state 都寫回取下前的值，這次通知造成的三振也一併作廢。', color: 'success' })
    }
    else if (kind === 'notify') {
      // §90-4 第 4 款：轉送通知給使用者。時間戳由伺服器決定，不收參數——
      // 這一欄日後要拿來舉證，客戶端不該有辦法往前補登。
      const { data: at, error } = await supabase.rpc('admin_notify_user', {
        p_notice_id: n.id,
        p_note: actionNote.value.trim(),
      })
      if (error)
        throw error
      toast.add({ title: '已記下轉送時間', description: `${dayText(at as string)}。這是日後舉證「我們有轉送」的那一筆。`, color: 'success' })
    }
    else if (kind === 'forward') {
      const cid = n.counter?.id
      if (!cid)
        throw new Error('這件通知沒有回復通知可以轉送')
      const { data: res, error } = await supabase.rpc('admin_forward_counter_notice', { p_counter_id: cid })
      if (error)
        throw error
      const r = res as { litigation_deadline_at: string, restore_deadline_at: string }
      toast.add({
        title: '已轉送回復通知',
        // 兩個法定期限現在才錨在正確的起算點上（§90-9 從「轉送」起算）
        description: `對方要在 ${dayText(r.litigation_deadline_at)} 前提出訴訟證明；逾期未提出，你要在 ${dayText(r.restore_deadline_at)} 前回復。`,
        color: 'success',
      })
    }
    else {
      const pid = target.value?.profileId
      if (!pid)
        throw new Error('這筆通知對不到具體的使用者，不能記三振')
      const { data: total, error } = await supabase.rpc('admin_add_strike', {
        p_profile_id: pid,
        p_notice_id: n.id,
        p_note: actionNote.value.trim(),
      })
      if (error)
        throw error
      toast.add({
        title: `已記一次三振（目前 ${total ?? '?'} 次）`,
        description: total !== null && total >= 3 ? '第三次：這個帳號的個人頁與全部公開紀錄立刻不可讀。' : undefined,
        color: 'success',
      })
    }
    confirming.value = null
    actionNote.value = ''
    await refresh()
  }
  catch (e) {
    const err = e as { code?: string, message?: string }
    toast.add({
      title: '沒有做成',
      description: err.code === '42501' ? '需要審核權限（資料庫回 42501）' : err.message ?? '未知錯誤',
      color: 'error',
    })
  }
  finally {
    acting.value = false
  }
}

const confirmTitle = computed(() => ({
  takedown: '取下這個標的',
  restore: '回復內容',
  strike: '記一次三振',
  notify: '確認已轉送通知給使用者',
  forward: '確認已轉送回復通知給通知人',
}[confirming.value ?? 'takedown']))

/** 只有這三個是破壞性的，確認鈕才用 error 色。 */
const DESTRUCTIVE = new Set(['takedown', 'strike'])

/** 已經取下、而且還沒回復的標的數。決定「取下」跟「回復」哪一顆有意義。 */
const liveTakedowns = computed(() => selected.value?.actions.filter(a => !a.restored_at).length ?? 0)
</script>

<template>
  <StaffGate>
    <AdminShell
      title="DMCA 承辦"
      :list-heading="listStatus === 'pending' ? '載入中…' : `處理中 ${openCount}`"
      :has-selection="!!selected"
    >
      <template #list>
        <li v-if="listStatus !== 'pending' && !notices.length" class="px-4 py-6 text-sm text-muted">
          目前沒有任何侵權通知。
        </li>
        <li v-for="n in notices" :key="n.id">
          <button
            type="button"
            class="w-full cursor-pointer border-b border-default px-4 py-2.5 text-left"
            :class="selectedId === n.id ? 'bg-primary/10 border-l-2 border-l-primary pl-[14px]' : ''"
            @click="selectedId = n.id"
          >
            <span class="block text-sm font-semibold leading-snug text-highlighted">{{ `#${n.id} ${n.claimant_name}` }}</span>
            <span class="mt-1 block">
              <UBadge
                v-if="deadlineChip(n)"
                :color="deadlineChip(n)!.urgent ? 'error' : 'neutral'"
                variant="outline"
                size="sm"
                class="tabular-nums"
              >{{ deadlineChip(n)!.text }}</UBadge>
              <UBadge v-else color="neutral" variant="outline" size="sm">{{ STATUS_LABEL[n.status] }}</UBadge>
            </span>
          </button>
        </li>
      </template>

      <template #blank>
        <p class="py-8 text-center text-sm text-muted">
          {{ notices.length ? '左邊選一筆來處理。' : '這個佇列現在是空的。侵權通知由 /legal/copyright 的表單進來。' }}
        </p>
      </template>

      <template #detail>
        <template v-if="selected">
          <h2 class="text-lg font-semibold tracking-tight text-highlighted">
            {{ `#${selected.id} ${selected.claimant_name}` }}
          </h2>
          <p class="mt-0.5 text-sm text-muted">
            {{ `${dayText(selected.received_at)} 受理 · ${STATUS_LABEL[selected.status]}` }}
          </p>

          <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
            <dt class="text-muted">
              標的
            </dt>
            <dd class="text-highlighted">
              {{ targetLoading ? '查詢中…' : target?.label }}
            </dd>
            <dt class="text-muted">
              被指控的人
            </dt>
            <dd class="text-highlighted">
              {{ target?.username ?? (targetLoading ? '查詢中…' : '對不到') }}
            </dd>
            <dt class="text-muted">
              主張著作
            </dt>
            <dd class="text-highlighted">
              {{ selected.work_description }}
            </dd>
            <dt class="text-muted">
              通知人信箱
            </dt>
            <!-- 全揭露是 David 的裁定（§90-6 要求轉送通知），不要改成遮蔽 -->
            <dd class="break-words text-highlighted">
              {{ selected.claimant_email }}
            </dd>
            <template v-if="selected.claimant_phone">
              <dt class="text-muted">
                通知人電話
              </dt>
              <dd class="text-highlighted">
                {{ selected.claimant_phone }}
              </dd>
            </template>
            <dt class="text-muted">
              指稱的網址
            </dt>
            <dd class="break-words text-highlighted">
              {{ selected.target_url }}
            </dd>
            <dt class="text-muted">
              已轉送使用者
            </dt>
            <dd class="text-highlighted">
              {{ selected.notified_user_at ? dayText(selected.notified_user_at) : '還沒有（見下方）' }}
            </dd>
            <dt class="text-muted">
              使用者回復通知
            </dt>
            <dd class="text-highlighted">
              {{ selected.counter ? dayText(selected.counter.received_at) : '沒有提出' }}
            </dd>
          </dl>

          <div v-if="selected.counter" class="mt-4 border-l-2 border-primary pl-3">
            <p class="text-sm text-highlighted">
              使用者的主張
            </p>
            <p class="mt-1 whitespace-pre-wrap text-sm text-muted">
              {{ selected.counter.reason }}
            </p>
            <p class="mt-2 text-sm">
              <template v-if="selected.counter.forwarded_at">
                <span class="block text-highlighted">{{ `已於 ${dayText(selected.counter.forwarded_at)} 轉送給通知人。` }}</span>
                <span class="block text-highlighted">{{ `對方要在 ${dayText(selected.counter.litigation_deadline_at)} 前提出訴訟證明。` }}</span>
                <span class="block text-highlighted">{{ `逾期未提出，你必須在 ${dayText(selected.counter.restore_deadline_at)} 前把內容回復。` }}</span>
              </template>
              <span v-else class="block text-muted">
                回復通知還沒轉送給通知人，所以兩個法定期限還沒開始起算。
              </span>
            </p>
          </div>

          <!--
            ⚠️ 「已轉送使用者」與「回復通知已轉送」是**手動勾的不能自動填**：寄出通知是站外行為，
               程式無從得知它真的發生過。自動填只會產生一個看起來已履行、實際沒有的紀錄，
               **而那正是日後要拿來舉證的欄位**。所以它們長得像「我確認我寄了」的動作。
          -->
          <UAlert
            v-if="selected.status !== 'restored'"
            class="mt-5"
            color="neutral"
            variant="subtle"
            title="「已收到訴訟證明」還按不下去"
            description="notice_status 有 litigation_notified 這個值，但整個 schema 沒有任何地方寫得進它（0001–0011 都 grep 過，只有 enum 定義那一行）。已回報，在補上之前這顆維持停用。"
          />

          <div class="mt-5 flex flex-wrap gap-2.5 border-t border-default pt-4">
            <UButton
              v-if="liveTakedowns === 0"
              color="error"
              variant="outline"
              :disabled="!selected.target_film_id && !selected.target_record_id"
              @click="ask('takedown')"
            >
              取下這個標的
            </UButton>
            <UButton v-else :loading="acting" @click="ask('restore')">
              回復內容
            </UButton>
            <UButton
              variant="outline"
              color="error"
              :disabled="!target?.profileId"
              @click="ask('strike')"
            >
              記一次三振
            </UButton>
            <UButton
              v-if="!selected.notified_user_at"
              variant="outline"
              color="neutral"
              @click="ask('notify')"
            >
              我已轉送通知給使用者
            </UButton>
            <UButton
              v-if="selected.counter && !selected.counter.forwarded_at"
              variant="outline"
              color="neutral"
              @click="ask('forward')"
            >
              我已轉送回復通知給通知人
            </UButton>
            <UButton variant="ghost" color="neutral" disabled>
              已收到訴訟證明
            </UButton>
          </div>

          <p v-if="!selected.target_film_id && !selected.target_record_id" class="mt-2 text-xs text-muted">
            這筆通知沒有指到具體的作品或紀錄，`admin_takedown` 需要其中之一才動得了。
          </p>
        </template>
      </template>
    </AdminShell>

    <UModal v-model:open="confirmOpen" :title="confirmTitle">
      <template #body>
        <p v-if="confirming === 'takedown'" class="text-sm">
          標的會立刻從公開頁消失，<strong>引用它的其他人的公開紀錄與票價也一併消失</strong>。
          取下前的 visibility 與 moderation_state 會被拍下來，之後回復是原樣寫回。
        </p>
        <p v-else-if="confirming === 'restore'" class="text-sm">
          內容會回到取下前的狀態（visibility 與 moderation_state 都寫回，不是一律 public），
          這次通知造成的三振也會一併作廢並重算帳號狀態。
        </p>
        <p v-else-if="confirming === 'notify'" class="text-sm">
          這是 <strong>§90-4 第 4 款</strong>的舉證欄位：記下「平台把侵權通知轉送給使用者」的時點。
          <strong>寄信是站外行為，系統無從得知它真的發生過</strong>——所以這顆鈕的意思是
          「我確認我寄了」，不是一個狀態顯示。時間戳由伺服器決定，事後補登不了。
        </p>
        <p v-else-if="confirming === 'forward'" class="text-sm">
          §90-9 的兩個法定期限**從「轉送回復通知給著作權人」起算**，按下去才會錨在正確的日期上。
          同樣是「我確認我寄了」，時間戳由伺服器決定。
        </p>
        <p v-else class="text-sm">
          記在 <strong>{{ target?.username ?? '（對不到使用者）' }}</strong> 身上。
          第二次會讓帳號變成受限，<strong>第三次會終止服務</strong>——個人頁與全部公開紀錄立刻不可讀。
        </p>
        <UFormField label="備註" class="mt-4" help="會寫進 takedown_action / copyright_strike，是日後舉證的一部分。">
          <UInput v-model="actionNote" placeholder="例如：通知齊備，依 §90-4 取下" class="w-full" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="confirmOpen = false">
            算了
          </UButton>
          <UButton
            :color="confirming && DESTRUCTIVE.has(confirming) ? 'error' : 'primary'"
            :loading="acting"
            @click="runConfirmed"
          >
            {{ confirmTitle }}
          </UButton>
        </div>
      </template>
    </UModal>
  </StaffGate>
</template>
