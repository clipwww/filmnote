<script setup lang="ts">
import type { Database } from '~/types/database.types'
import { agoText, dayText } from './-admin-shared'
import AdminShell from './-AdminShell.vue'
import StaffGate from './-StaffGate.vue'

/**
 * `/admin/reports` —— 片名／影城錯誤回報（US-49/50）。`SCREENS §14` ④、視覺稿 ④。
 *
 * 三個佇列裡內容最單純的一個：誰、回報哪一筆、說哪裡錯了、目前的值是什麼。
 *
 * ── 結案走 `admin_resolve_report()`（0011）───────────────────
 * 我上一輪回報說「缺 UPDATE grant」。backend 查出來比那更糟：
 * `data_report` **一條 staff policy 都沒有**（只有 `report_insert` /
 * `report_read`）⇒ 就算補 grant 也不會動。0011 補了 policy、`staff_reply`
 * 欄位與 RPC，現在結案是真的做得到的。
 *
 * `staff_reply` **回報者看得到**（`report_read` 讓 reporter 讀自己那幾筆），
 * 所以它是寫給對方看的，不是內部備註。駁回沒填理由會被 DB 擋（23514）——
 * 沒有理由的駁回，回報者只會再回報一次同一件事。
 *
 * ── ⚠️ 「照著改」在這一頁**只代表「我受理了」，不代表系統幫你改** ──
 * `film.title_zh` 的權威來源是影視局開放資料（`title_zh_source = 'gov'`），
 * 被人工覆蓋之後下次資料更新會打架。修正要進覆蓋層——`source_authority`
 * 已經有 `admin` 這一格，但**覆蓋層本身還沒有設計**。在那之前這一頁
 * 不提供任何直接改片名的入口，按鈕文案也不敢寫成「照著改」：
 * 寧可少一個功能，不要多一個會被下次匯入靜默洗掉的功能。已回報。
 */
definePageMeta({ layout: 'default' })
useSeoMeta({ title: '資料回報', robots: 'noindex, nofollow' })

const supabase = useSupabaseClient<Database>()

const STATUS_LABEL: Record<string, string> = {
  open: '待處理',
  accepted: '已採納',
  rejected: '未採納',
}

const KIND_LABEL: Record<string, string> = {
  film: '作品',
  venue: '影城',
}

interface ReportRow {
  id: number
  reporter_id: string | null
  subject_kind: string
  subject_key: string
  body: string
  status: string
  created_at: string
  /** 結案理由。**回報者看得到**，所以是寫給對方的。 */
  staff_reply: string | null
  resolved_at: string | null
  reporter: string | null
}

const { data, status: listStatus, refresh } = useAsyncData('admin-reports', async () => {
  const { data: rows, error } = await supabase
    .from('data_report')
    .select('id,reporter_id,subject_kind,subject_key,body,status,created_at,staff_reply,resolved_at')
    // 待處理的排前面，同一組內先進先出
    .order('created_at', { ascending: true })
  if (error)
    throw error

  const ids = [...new Set((rows ?? []).map(r => r.reporter_id).filter((v): v is string => !!v))]
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: profiles } = await supabase.from('profile').select('id,username').in('id', ids)
    for (const p of profiles ?? [])
      names.set(p.id, p.username)
  }

  return (rows ?? [])
    .map(r => ({ ...r, reporter: r.reporter_id ? names.get(r.reporter_id) ?? null : null }) as ReportRow)
    .sort((a, b) => {
      const openA = a.status === 'open' ? 0 : 1
      const openB = b.status === 'open' ? 0 : 1
      return openA - openB || a.created_at.localeCompare(b.created_at)
    })
}, { server: false })

const reports = computed(() => data.value ?? [])
const openCount = computed(() => reports.value.filter(r => r.status === 'open').length)

const selectedId = ref<number | null>(null)
const selected = computed(() => reports.value.find(r => r.id === selectedId.value) ?? null)

/**
 * 「目前的值是什麼」——回報只給了一個 key，承辦要能看到現況才判斷得了。
 * `subject_key` 對作品可能是 uuid，也可能是 `film_identity` 的鍵
 * （`gov:…` / `tmdb:…` / `slug:…`），所以 uuid 以外一律走 `resolve_film()`。
 */
const subjectText = ref<string | null>(null)
const subjectLoading = ref(false)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─────────────────────────────────────────────────────────────────────────────
// 結案
// ─────────────────────────────────────────────────────────────────────────────
const toast = useToast()
const acting = ref(false)
const resolving = ref<'accepted' | 'rejected' | null>(null)
const reply = ref('')

const resolveOpen = computed({
  get: () => resolving.value !== null,
  set: (v: boolean) => {
    if (!v) {
      resolving.value = null
      reply.value = ''
    }
  },
})

function askResolve(status: 'accepted' | 'rejected') {
  reply.value = ''
  resolving.value = status
}

async function doResolve() {
  const r = selected.value
  const status = resolving.value
  if (!r || !status)
    return
  acting.value = true
  try {
    // 「駁回一定要有理由」由 DB 擋（23514），這裡不重寫一份判斷。
    const { error } = await supabase.rpc('admin_resolve_report', {
      p_report_id: r.id,
      p_status: status,
      p_reply: reply.value.trim(),
    })
    if (error)
      throw error
    resolving.value = null
    reply.value = ''
    toast.add({ title: status === 'accepted' ? '已標記為採納' : '已回覆並結案', color: 'success' })
    await refresh()
  }
  catch (e) {
    const err = e as { code?: string, message?: string }
    toast.add({
      title: '沒有結成',
      description: err.code === '42501' ? '需要審核權限（資料庫回 42501）' : err.message ?? '未知錯誤',
      color: 'error',
    })
  }
  finally {
    acting.value = false
  }
}

watch(selected, async (r) => {
  subjectText.value = null
  if (!r)
    return
  subjectLoading.value = true
  try {
    if (r.subject_kind === 'venue') {
      const { data: v } = await supabase
        .from('venue')
        .select('name,city,status,kind')
        .eq('id', r.subject_key)
        .maybeSingle()
      subjectText.value = v ? metaLine(v.name, v.city, v.status, v.kind) : '找不到這個影城'
      return
    }

    let filmId: string | null = UUID_RE.test(r.subject_key) ? r.subject_key : null
    if (!filmId) {
      const { data: resolved } = await supabase.rpc('resolve_film', { p_key: r.subject_key })
      filmId = (resolved as string | null) ?? null
    }
    if (!filmId) {
      subjectText.value = '對不到片庫裡的任何一部作品'
      return
    }
    const { data: f } = await supabase
      .from('film')
      .select('title_zh,title_original,title_zh_source,country,release_year,runtime_minutes')
      .eq('id', filmId)
      .maybeSingle()
    subjectText.value = f
      ? metaLine(
          displayTitle(f.title_zh) || '（沒有中文片名）',
          f.title_original || null,
          f.release_year ? String(f.release_year) : null,
          f.country,
          f.runtime_minutes ? `${f.runtime_minutes} 分鐘` : null,
          `片名來源：${f.title_zh_source}`,
        )
      : '找不到這部作品'
  }
  finally {
    subjectLoading.value = false
  }
})
</script>

<template>
  <StaffGate>
    <AdminShell
      title="資料回報"
      :list-heading="listStatus === 'pending' ? '載入中…' : `待處理 ${openCount}`"
      :has-selection="!!selected"
    >
      <template #list>
        <li v-if="listStatus !== 'pending' && !reports.length" class="px-4 py-6 text-sm text-muted">
          目前沒有任何回報。
        </li>
        <li v-for="r in reports" :key="r.id">
          <button
            type="button"
            class="w-full cursor-pointer border-b border-default px-4 py-2.5 text-left"
            :class="selectedId === r.id ? 'bg-primary/10 border-l-2 border-l-primary pl-[14px]' : ''"
            @click="selectedId = r.id"
          >
            <span class="block text-sm font-semibold leading-snug text-highlighted">{{ `#${r.id} ${KIND_LABEL[r.subject_kind] ?? r.subject_kind}` }}</span>
            <span class="mt-0.5 block text-xs text-muted">{{ metaLine(r.reporter, agoText(r.created_at), r.status === 'open' ? null : STATUS_LABEL[r.status]) }}</span>
          </button>
        </li>
      </template>

      <template #blank>
        <p class="py-8 text-center text-sm text-muted">
          {{ reports.length ? '左邊選一筆來看。' : '這個佇列現在是空的。回報從作品頁與影城頁的「這裡有錯」進來。' }}
        </p>
      </template>

      <template #detail>
        <template v-if="selected">
          <h2 class="text-lg font-semibold tracking-tight text-highlighted">
            {{ `#${selected.id} ${KIND_LABEL[selected.subject_kind] ?? selected.subject_kind}資料有誤` }}
          </h2>
          <p class="mt-0.5 text-sm text-muted">
            {{ metaLine(selected.reporter ?? '匿名', `${dayText(selected.created_at)} 回報`, STATUS_LABEL[selected.status] ?? selected.status) }}
          </p>

          <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
            <dt class="text-muted">
              回報的標的
            </dt>
            <dd class="break-words text-highlighted">
              {{ selected.subject_key }}
            </dd>
            <dt class="text-muted">
              目前的值
            </dt>
            <dd class="text-highlighted">
              {{ subjectLoading ? '查詢中…' : subjectText }}
            </dd>
          </dl>

          <section class="mt-4">
            <h3 class="text-sm text-muted">
              他說哪裡錯了
            </h3>
            <p class="mt-1 whitespace-pre-wrap text-highlighted">
              {{ selected.body }}
            </p>
          </section>

          <!-- 已經結案的：把結果攤開，否則承辦不知道上次回了什麼 -->
          <section v-if="selected.status !== 'open'" class="mt-4 border-l-2 border-default pl-3">
            <h3 class="text-sm text-muted">
              {{ metaLine(STATUS_LABEL[selected.status] ?? selected.status, selected.resolved_at ? dayText(selected.resolved_at) : null) }}
            </h3>
            <p class="mt-1 whitespace-pre-wrap text-highlighted">
              {{ selected.staff_reply || '（沒有留下理由）' }}
            </p>
          </section>

          <div v-if="selected.status === 'open'" class="mt-5 flex flex-wrap gap-2.5 border-t border-default pt-4">
            <UButton @click="askResolve('accepted')">
              受理，我會去修
            </UButton>
            <UButton variant="outline" color="neutral" @click="askResolve('rejected')">
              不改，回覆理由
            </UButton>
          </div>

          <p class="mt-3 text-xs leading-relaxed text-muted">
            ⚠️ 「受理」只是把這筆回報結案並回覆對方，<strong>系統不會幫你改片名</strong>。
            <code>film.title_zh</code> 的權威來源是影視局開放資料，人工覆蓋之後下一次資料更新會打架——
            修正要進覆蓋層（<code>title_zh_source</code> 已經有 <code>admin</code> 這一格），而覆蓋層本身還沒有設計。
            所以這顆鈕不叫「照著改」：它沒有那個能力，寫成那樣會讓人以為改好了。
          </p>
        </template>
      </template>
    </AdminShell>

    <UModal v-model:open="resolveOpen" :title="resolving === 'accepted' ? '受理這筆回報' : '不改，回覆理由'">
      <template #body>
        <p class="text-sm">
          <template v-if="resolving === 'accepted'">
            會把這筆標記為已採納並把你寫的話回覆給回報者。<strong>系統不會動任何資料</strong>，實際的修正要另外做。
          </template>
          <template v-else>
            回報者看得到這段話。<strong>沒有理由的駁回，對方只會再回報一次同一件事。</strong>
          </template>
        </p>
        <UFormField
          label="回覆給回報者"
          class="mt-4"
          :required="resolving === 'rejected'"
          help="這是寫給對方看的，不是內部備註。"
        >
          <UTextarea v-model="reply" :rows="3" class="w-full" placeholder="例如：謝謝回報，這個片名是影視局核准的正式寫法，我們以政府資料為準。" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="resolveOpen = false">
            算了
          </UButton>
          <UButton
            :loading="acting"
            :disabled="resolving === 'rejected' && !reply.trim()"
            @click="doResolve"
          >
            {{ resolving === 'accepted' ? '受理並回覆' : '回覆並結案' }}
          </UButton>
        </div>
      </template>
    </UModal>
  </StaffGate>
</template>
