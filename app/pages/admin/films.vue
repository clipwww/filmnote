<script setup lang="ts">
import type { FilmOption } from '~/composables/useFilmSearch'
import type { Database } from '~/types/database.types'
import { agoText, dayText } from './-admin-shared'
import AdminShell from './-AdminShell.vue'
import StaffGate from './-StaffGate.vue'

/**
 * `/admin/films` —— UGC 作品審核（US-19）＋ 重複作品合併（US-20）。
 * `SCREENS §14` ①②、視覺稿 `docs/design/mockups/admin.html`。
 *
 * ── 端點都已經在了，這一頁只是介面 ──────────────────────────
 * `POST /api/admin/films/[id]/approve`（`approve_film` RPC）
 * `POST /api/admin/films/merge`（`merge_films` RPC）
 * 審核佇列**不需要端點**：staff 靠 `film_read` policy 的 `is_staff()` 分支
 * 直接查 PostgREST（BUILD_PLAN §5 Step 7 第 3 點）。
 *
 * ── 佇列一律查 `film_review_queue` view（0011）───────────────
 * ⚠️ 不要自己在前端組 `review_state = 'pending'`。實測（2026-09-06）：
 *    DB 裡 pending 有 19 列，而其中 **16 列的 `merged_into_film_id` 不是 null**
 *    ——那是舊 log 匯入時建的 UGC 佔位，人工對照表比對到正片之後被
 *    `merge_films` 併掉了，但 `review_state` 留在 `pending`（`merge_films`
 *    不改它，也**不該**改：「被合併」是另一個維度的狀態）。
 *    那 16 部全是片庫裡已經有正確版本的片名，**按下「通過」會把重複作品
 *    放進公共片庫，而合併正是為了消除它們**。
 *
 * ── 審核不搬檔案 ──────────────────────────────────────────────
 * 單一 private bucket + RLS 讀取把關。`approve_film()` 一改狀態，
 * `ugc_poster_read` policy 的判定結果就變了，海報同時從「只有作者與 staff
 * 讀得到」變成「所有人讀得到」。**檔案從頭到尾沒有移動過**，所以駁回是
 * 真的可逆（backend 交接筆記 §4）。
 */
definePageMeta({ layout: 'default' })
useSeoMeta({ title: '作品審核', robots: 'noindex, nofollow' })

const supabase = useSupabaseClient<Database>()
const toast = useToast()

/** 佇列列的欄位——列表只要畫得出「片名 + 誰 + 多久以前」就好。 */
interface QueueRow {
  id: string
  title_zh: string
  title_original: string
  created_at: string
  created_by: string | null
  creator: string | null
}

/** 詳情與並排比對要的完整一列。 */
interface FilmDetail {
  id: string
  title_zh: string
  title_original: string
  country: string | null
  release_year: number | null
  runtime_minutes: number | null
  tmdb_id: number | null
  origin: string
  review_state: string
  visibility: string
  ugc_poster_path: string | null
  created_at: string
  creator: string | null
  /** 被幾筆 viewing_record 引用。**這是這個畫面最重要的一個數字。** */
  refs: number
  /** 政府核准紀錄。合併時判斷「是不是同一部片」的唯一依據（§14）。 */
  certificates: CertRow[]
}

interface CertRow {
  id: string
  permit_no: string
  roc_year: number
  rating: string | null
  title_zh: string
  title_original: string
  runtime_minutes: number | null
  country: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// 佇列
// ─────────────────────────────────────────────────────────────────────────────
const { data: queue, status: queueStatus, refresh: refreshQueue } = useAsyncData('admin-film-queue', async () => {
  const { data, error } = await supabase
    // ★ 一律查 `film_review_queue`（0011），不要自己在前端組 review_state 條件。
    //   與 0002 的 `venue_option` 同一個模式：「什麼叫待審」只能有一個定義。
    //   少任何一個條件的症狀都很具體——少了 merged 就是整排按得下去的殭屍
    //   （實測 16 列），少了 origin='ugc' 就會撈到政府資料。
    .from('film_review_queue')
    .select('id,title_zh,title_original,created_at,created_by')
    // 先進先出。審核是佇列不是收件匣，最舊的那一筆等最久。
    .order('created_at', { ascending: true })
  if (error)
    throw error

  const rows = data ?? []
  // 作者名另外查一次，不用 PostgREST 的巢狀 select。多一次往返換掉一個
  // 「embed 名稱寫錯只會靜默回 null」的失敗模式——這一頁沒有 staff 帳號可以
  // 實測（見交接），能少一個猜測就少一個。
  const ids = [...new Set(rows.map(r => r.created_by).filter((v): v is string => !!v))]
  const names = new Map<string, string>()
  if (ids.length) {
    const { data: profiles } = await supabase.from('profile').select('id,username').in('id', ids)
    for (const p of profiles ?? [])
      names.set(p.id, p.username)
  }
  return rows.map(r => ({ ...r, creator: r.created_by ? names.get(r.created_by) ?? null : null })) as QueueRow[]
}, { server: false })

const queueRows = computed(() => queue.value ?? [])

const selectedId = ref<string | null>(null)
/** 佇列刷新後，原本選中的那一筆可能已經不在（剛審完）——就放掉選擇。 */
watch(queueRows, (rows) => {
  if (selectedId.value && !rows.some(r => r.id === selectedId.value))
    selectedId.value = null
})

// ─────────────────────────────────────────────────────────────────────────────
// 詳情
// ─────────────────────────────────────────────────────────────────────────────
async function loadDetail(id: string): Promise<FilmDetail | null> {
  const { data: film, error } = await supabase
    .from('film')
    .select('id,title_zh,title_original,country,release_year,runtime_minutes,tmdb_id,origin,review_state,visibility,ugc_poster_path,created_at,created_by')
    .eq('id', id)
    .maybeSingle()
  if (error || !film)
    return null

  // 被引用筆數：head + count，不把 174 列拉回瀏覽器。staff 讀得到全部
  // viewing_record（record_staff policy），所以這個數字含**別人的**紀錄——
  // 而那正是它存在的理由：退回一部作品會波及誰。
  const { count } = await supabase
    .from('viewing_record')
    .select('id', { count: 'exact', head: true })
    .eq('film_id', id)

  const { data: certs } = await supabase
    .from('certificate')
    .select('id,permit_no,roc_year,rating,title_zh,title_original,runtime_minutes,country')
    .eq('film_id', id)
    .order('roc_year', { ascending: false })

  let creator: string | null = null
  if (film.created_by) {
    const { data: p } = await supabase.from('profile').select('username').eq('id', film.created_by).maybeSingle()
    creator = p?.username ?? null
  }

  return { ...film, refs: count ?? 0, certificates: (certs ?? []) as CertRow[], creator } as FilmDetail
}

const detail = ref<FilmDetail | null>(null)
const detailLoading = ref(false)
/** 片庫裡的相近作品。null = 還沒查；[] = 查過了但沒有。兩者畫面不同。 */
const similar = ref<FilmOption[] | null>(null)

watch(selectedId, async (id) => {
  resetMerge()
  detail.value = null
  similar.value = null
  if (!id)
    return
  detailLoading.value = true
  detail.value = await loadDetail(id)
  detailLoading.value = false
  if (detail.value)
    await findSimilar(detail.value)
})

// ─────────────────────────────────────────────────────────────────────────────
// 「片庫裡有沒有像的？」—— 系統先查好，不要叫人自己去搜
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 視覺稿把這件事講得很重：**審核的實際工作有一半是判斷「這是不是重複」，
 * 讓人自己去搜等於把系統該做的事推給人。查不到就明說查不到，不要留白。**
 *
 * 作法是把片名切成幾段當 needle 去比 `search_text`（那是
 * `lower(title_zh || ' ' || title_original)` 的 generated column，trgm 索引就建在它上面）。
 *
 * ⚠️ 這是**提示**不是判定。它不會、也不該自動合併任何東西——「林口威秀」
 *    配到「樹林秀泰影城」那個教訓（BUILD_PLAN §5 Step 10 ④）在片名上一樣成立：
 *    **錯配比不配更糟，因為不配看得見、錯配看不見。**
 *
 * ⚠️ **這裡有兩個一開始寫錯、而且是實測才看出來的地方**（2026-09-06）：
 *
 * ① **拉丁字母的字不可以切片。** 原本對長度 > 4 的字取 `slice(0,3)` 與
 *    `slice(-3)`，那對中文成立（「青凪…劇場版」的頭尾都是有意義的詞），
 *    對英文則產生 `min` / `zza` / `fat` 這種**幾乎命中所有片名**的碎片。
 *    ⇒ 拉丁字只用**整個字**、而且長度要 ≥ 4；切片只對 CJK 做。
 *
 * ② **`limit()` 沒有排序等於隨機取樣。** 原本是 `.or(...).limit(8)`，
 *    Postgres 回哪 8 列完全看它高興 ⇒ **真正相近的那一部可能整個被擠掉**。
 *    實測：查「zzadmin 沙丘 2」時列出了《哈利波特》《魔戒二部曲》，
 *    而片庫裡真的有的《沙丘：第二部》**一次都沒出現過**。
 *
 * 這兩個加起來的後果不是「提示不準」而已——每一列旁邊都有一顆
 * 「合併到這一部…」，而合併是不可逆的。**一個會亂建議的提示，比沒有提示危險。**
 *
 * 現在的作法：撈寬一點（40 列）回來，在前端按**命中的 needle 總長度**排序，
 * 並要求至少 4 分才顯示（一個 2 字中文詞 + 另一個，或一個 4 字以上的英文字）。
 * 沒有東西達標就老實說查不到——視覺稿要的就是這個：「查不到就明說查不到」。
 */
interface Needle {
  text: string
  /** 權重＝長度。中文 2 字已經很有辨識度，英文要 4 字才算數。 */
  weight: number
}

function needlesFor(titleZh: string, titleOriginal: string | null): Needle[] {
  // PostgREST 的 `or=` 與 LIKE 都有自己的元字元，非字母數字與 CJK 一律當分隔
  const clean = (s: string) => s
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9]+/gu, ' ')
    .trim()

  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
  const out = new Map<string, number>()

  for (const raw of [titleZh, titleOriginal ?? '']) {
    for (const word of clean(raw).split(' ').filter(Boolean)) {
      if (cjk.test(word)) {
        // CJK：整段 + 滑動 3-gram（中文沒有空白，詞的邊界只能用 n-gram 逼近）
        if (word.length >= 2)
          out.set(word, word.length)
        for (let i = 0; i + 3 <= word.length && i < 6; i++)
          out.set(word.slice(i, i + 3), 3)
      }
      else if (word.length >= 4) {
        // 拉丁：只用整個字。3 字以下（the / two / iii）辨識度太低，寧可不查
        out.set(word, word.length)
      }
    }
  }
  return [...out.entries()].map(([text, weight]) => ({ text, weight })).slice(0, 10)
}

/** 至少要這麼像才值得放到管理者眼前。低於這個分數的「建議」只會製造誤合併。 */
const SIMILAR_MIN_SCORE = 4

async function findSimilar(f: FilmDetail) {
  const needles = needlesFor(f.title_zh, f.title_original)
  if (!needles.length) {
    similar.value = []
    return
  }
  const { data } = await supabase
    .from('film')
    .select('id,slug,title_zh,title_original,release_year,country,review_state,search_text')
    .is('merged_into_film_id', null)
    .neq('id', f.id)
    .or(needles.map(n => `search_text.like.*${n.text}*`).join(','))
    // 撈寬一點才有得排。排序在前端做——PostgREST 排不了「命中幾個 needle」
    .limit(40)

  const scored = (data ?? []).map((row) => {
    const hay = (row.search_text ?? `${row.title_zh} ${row.title_original ?? ''}`).toLowerCase()
    const score = needles.reduce((s, n) => (hay.includes(n.text) ? s + n.weight : s), 0)
    return { row, score }
  }).filter(x => x.score >= SIMILAR_MIN_SCORE).sort((a, b) => b.score - a.score).slice(0, 5)

  similar.value = scored.map(x => x.row as unknown as FilmOption)
}

// ─────────────────────────────────────────────────────────────────────────────
// 通過 / 退回
// ─────────────────────────────────────────────────────────────────────────────
const acting = ref(false)

async function approve(id: string) {
  acting.value = true
  try {
    await $fetch(`/api/admin/films/${id}/approve`, { method: 'POST', body: { approve: true } })
    toast.add({ title: '已通過，進公共片庫', color: 'success' })
    selectedId.value = null
    await refreshQueue()
  }
  catch (e) {
    toast.add({ title: '審核失敗', description: errText(e), color: 'error' })
  }
  finally {
    acting.value = false
  }
}

/**
 * 退回是破壞性動作，走 `UModal` 二次確認（`DS §10`）。
 *
 * **理由是必填的，而且是資料庫在擋**（`approve_film()` 沒收到 note 就丟 23514，
 * 端點翻成 422）。這裡的 `disabled` 只是不要讓人白按一次——真正的把關在下面，
 * 前端不重寫一份判斷（兩份一定會漂移）。
 * 理由存進 `film.review_note`，**作者讀得到**（`film_read` 讓作者讀自己的作品），
 * 所以它是寫給對方看的，不是內部備註。
 */
const rejectOpen = ref(false)
const rejectNote = ref('')

async function reject(id: string) {
  acting.value = true
  try {
    await $fetch(`/api/admin/films/${id}/approve`, {
      method: 'POST',
      body: { approve: false, note: rejectNote.value.trim() },
    })
    rejectOpen.value = false
    rejectNote.value = ''
    toast.add({ title: '已退回', color: 'success' })
    selectedId.value = null
    await refreshQueue()
  }
  catch (e) {
    toast.add({ title: '退回失敗', description: errText(e), color: 'error' })
  }
  finally {
    acting.value = false
  }
}

function errText(e: unknown): string {
  const err = e as { statusMessage?: string, data?: { statusMessage?: string }, message?: string }
  return err?.data?.statusMessage ?? err?.statusMessage ?? err?.message ?? '未知錯誤'
}

// ─────────────────────────────────────────────────────────────────────────────
// 合併（US-20）
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 「把右邊合併到左邊，左邊是保留的那一部。」
 *
 * ⚠️ **`merge_films()` 會把 `viewing_record.film_id` 改指到勝方，不是「一列都不動」。**
 *    BUILD_PLAN §5 Step 7 第 4 點與 `0001` §4 的註解都寫著「viewing_record 一列
 *    都不動」，那是舊設計的殘留而且**實作是對的**：所有公開讀取路徑
 *    （`record_read` / `record_is_public` / `viewing_record_public`）都直接 join
 *    `film_id` 並要求 `merged_into_film_id is null`，紀錄若還指著敗方就會整批從
 *    公開頁消失。使用者真正在乎的不變量是「一筆紀錄都不會不見」，由
 *    `film_merge_log.moved_records` 記下來——端點會把那個數字回給我們，
 *    所以合併成功的 toast 說得出「搬了幾筆」，而不是只有一句 ok。
 */
const mergeOpen = ref(false)
const { term: filmTerm, items: filmItems, loading: filmLoading, queried: filmQueried } = useFilmSearch()
/**
 * ⚠️ `USelectMenu` 的 v-model 是 `T | undefined`，不是 `T | null`
 * （前一棒交接筆記 §2.2 已經記過一次）。用 null 會 typecheck 紅，
 * 而且 reka-ui 清空選擇時寫回的就是 undefined。
 */
const mergePick = ref<FilmOption | undefined>()
const mergeOther = ref<FilmDetail | null>(null)
const mergeOtherLoading = ref(false)
/** false = 佇列裡這一部是敗方（預設）；true = 交換，佇列裡這一部留下。 */
const swapped = ref(false)
const mergeReason = ref('')
const mergeConfirmOpen = ref(false)

function resetMerge() {
  mergeOpen.value = false
  mergePick.value = undefined
  mergeOther.value = null
  swapped.value = false
  mergeReason.value = ''
  mergeConfirmOpen.value = false
  filmTerm.value = ''
}

watch(mergePick, async (pick) => {
  mergeOther.value = null
  if (!pick)
    return
  mergeOtherLoading.value = true
  mergeOther.value = await loadDetail(pick.id)
  mergeOtherLoading.value = false
  if (!mergeReason.value && detail.value && mergeOther.value)
    mergeReason.value = ''
})

/** 左＝保留（勝方），右＝併掉（敗方）。「交換左右」只翻轉這個對映。 */
const winner = computed(() => (swapped.value ? detail.value : mergeOther.value))
const loser = computed(() => (swapped.value ? mergeOther.value : detail.value))

/**
 * 並排比對的欄位。**相同的欄位不需要人看，不同的才要**——所以每一列
 * 自己算差異，畫面只把不同的那幾格標起來（視覺稿 ②）。
 */
const ORIGIN_LABEL: Record<string, string> = {
  gov: '政府核准片名',
  tmdb: 'TMDB',
  ugc: '使用者新增（UGC）',
}

interface CompareRow {
  label: string
  a: string
  b: string
  diff: boolean
}

const compareRows = computed<CompareRow[]>(() => {
  const w = winner.value
  const l = loser.value
  if (!w || !l)
    return []
  const fields: [string, (f: FilmDetail) => string][] = [
    ['來源', f => ORIGIN_LABEL[f.origin] ?? f.origin],
    ['原文', f => f.title_original || '—'],
    ['國別', f => f.country || '—'],
    ['年份', f => (f.release_year ? String(f.release_year) : '—')],
    ['片長', f => (f.runtime_minutes ? `${f.runtime_minutes} 分鐘` : '—')],
    ['TMDB', f => (f.tmdb_id ? String(f.tmdb_id) : '—')],
    ['被引用', f => `${f.refs} 筆`],
  ]
  return fields.map(([label, get]) => {
    const a = get(w)
    const b = get(l)
    return { label, a, b, diff: a !== b }
  })
})

const canMerge = computed(() =>
  !!winner.value && !!loser.value && winner.value.id !== loser.value.id && mergeReason.value.trim().length > 0)

async function doMerge() {
  const w = winner.value
  const l = loser.value
  if (!w || !l)
    return
  acting.value = true
  try {
    const res = await $fetch<{ movedRecords: number | null }>('/api/admin/films/merge', {
      method: 'POST',
      body: { loserId: l.id, winnerId: w.id, reason: mergeReason.value.trim() },
    })
    mergeConfirmOpen.value = false
    toast.add({
      title: '合併完成',
      // 「搬了幾筆」是這個動作唯一能證明「紀錄一筆都沒少」的數字，一定要說出來
      description: res.movedRecords === null
        ? '（讀不回搬動筆數，請到 film_merge_log 確認）'
        : `${res.movedRecords} 筆紀錄改指向保留的那一部`,
      color: 'success',
    })
    resetMerge()
    selectedId.value = null
    await refreshQueue()
  }
  catch (e) {
    toast.add({ title: '合併失敗', description: errText(e), color: 'error' })
  }
  finally {
    acting.value = false
  }
}

function pickSimilarAsWinner(f: FilmOption) {
  mergeOpen.value = true
  mergePick.value = f
  swapped.value = false
}
</script>

<template>
  <StaffGate>
    <AdminShell
      title="作品審核"
      :list-heading="queueStatus === 'pending' ? '載入中…' : `待審核 ${queueRows.length}`"
      :has-selection="!!selectedId"
    >
      <template #list>
        <li v-if="queueStatus !== 'pending' && !queueRows.length" class="px-4 py-6 text-sm text-muted">
          目前沒有待審核的作品。
        </li>
        <li v-for="r in queueRows" :key="r.id">
          <button
            type="button"
            class="w-full cursor-pointer border-b border-default px-4 py-2.5 text-left"
            :class="selectedId === r.id ? 'bg-primary/10 border-l-2 border-l-primary pl-[14px]' : ''"
            @click="selectedId = r.id"
          >
            <span class="block text-sm font-semibold leading-snug text-highlighted">{{ displayTitle(r.title_zh) || r.title_original || '未命名' }}</span>
            <span class="mt-0.5 block text-xs text-muted">{{ metaLine(r.creator, agoText(r.created_at)) }}</span>
          </button>
        </li>
      </template>

      <template #blank>
        <p class="py-8 text-center text-sm text-muted">
          {{ queueRows.length ? '左邊選一筆來處理。' : '這個佇列現在是空的。' }}
        </p>
      </template>

      <template #detail>
        <div v-if="detailLoading" class="space-y-3">
          <USkeleton class="h-7 w-2/3" />
          <USkeleton class="h-4 w-1/2" />
          <USkeleton class="h-40 w-full" />
        </div>

        <template v-else-if="detail">
          <h2 class="text-lg font-semibold tracking-tight text-highlighted">
            {{ displayTitle(detail.title_zh) || detail.title_original || '未命名' }}
          </h2>
          <p class="mt-0.5 text-sm text-muted">
            {{ metaLine(detail.creator ? `${detail.creator} 新增` : '不知道是誰新增的', dayText(detail.created_at), detail.visibility === 'private' ? '目前只有他自己看得到' : null) }}
          </p>

          <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
            <dt class="text-muted">
              原文片名
            </dt>
            <dd class="text-highlighted">
              {{ detail.title_original || '沒有填' }}
            </dd>
            <dt class="text-muted">
              國別 / 年份
            </dt>
            <dd class="text-highlighted">
              {{ metaLine(detail.country, detail.release_year ? String(detail.release_year) : null) || '沒有填' }}
            </dd>
            <dt class="text-muted">
              片長
            </dt>
            <dd class="text-highlighted">
              {{ detail.runtime_minutes ? `${detail.runtime_minutes} 分鐘` : '沒有填' }}
            </dd>
            <dt class="text-muted">
              海報
            </dt>
            <dd class="text-highlighted">
              {{ detail.ugc_poster_path ? '已上傳（通過後自動公開，檔案不搬動）' : '沒有上傳' }}
            </dd>
            <dt class="text-muted">
              被引用
            </dt>
            <dd class="font-semibold text-highlighted tabular-nums">
              {{ detail.refs }} 筆紀錄
            </dd>
          </dl>

          <!-- 「被引用 N 筆」是這個畫面最重要的一行：退回會波及別人已經記好的紀錄 -->
          <UAlert
            v-if="detail.refs > 0"
            class="mt-4"
            color="neutral"
            variant="subtle"
            :description="`已經有 ${detail.refs} 筆觀影紀錄指向這部作品。退回不會刪掉那些紀錄，但那些紀錄會一直不能公開。`"
          />

          <!-- 片庫裡有沒有像的：系統先查好，查不到就明說 -->
          <section class="mt-5 border-l-2 border-default pl-3">
            <h3 class="text-sm font-semibold text-highlighted">
              片庫裡有沒有像的？
            </h3>
            <p v-if="similar === null" class="mt-1 text-sm text-muted">
              查詢中…
            </p>
            <p v-else-if="!similar.length" class="mt-1 text-sm text-muted">
              用片名的幾個切片搜過片庫，沒有相近的作品。
            </p>
            <ul v-else class="mt-1.5 space-y-1.5">
              <li v-for="s in similar" :key="s.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span class="text-highlighted">{{ filmLabel(s) }}</span>
                <UButton size="xs" variant="ghost" color="neutral" @click="pickSimilarAsWinner(s)">
                  合併到這一部…
                </UButton>
              </li>
            </ul>
          </section>

          <div class="mt-5 flex flex-wrap gap-2.5 border-t border-default pt-4">
            <UButton :loading="acting" @click="approve(detail.id)">
              通過，進公共片庫
            </UButton>
            <UButton variant="outline" color="neutral" @click="mergeOpen = !mergeOpen">
              合併到既有作品…
            </UButton>
            <UButton variant="outline" color="error" @click="rejectNote = ''; rejectOpen = true">
              退回
            </UButton>
          </div>

          <!-- ── 合併介面（US-20）──────────────────────────────── -->
          <section v-if="mergeOpen" class="mt-6 border-t border-default pt-5">
            <h3 class="text-base font-semibold text-highlighted">
              把右邊合併到左邊。左邊是保留的那一部。
            </h3>

            <UFormField label="要合併的另一部作品" class="mt-3">
              <USelectMenu
                v-model="mergePick"
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

            <div v-if="mergeOtherLoading" class="mt-4">
              <USkeleton class="h-40 w-full" />
            </div>

            <template v-else-if="winner && loser">
              <div class="mt-4 grid grid-cols-1 overflow-hidden rounded-sm border border-default sm:grid-cols-2">
                <div class="border-b border-default bg-primary/5 px-4 py-3 sm:border-b-0 sm:border-r">
                  <p class="text-xs text-muted">
                    保留
                  </p>
                  <p class="text-base font-semibold text-highlighted">
                    {{ displayTitle(winner.title_zh) || winner.title_original || '未命名' }}
                  </p>
                </div>
                <div class="px-4 py-3">
                  <p class="text-xs text-muted">
                    併掉
                  </p>
                  <p class="text-base font-semibold text-highlighted">
                    {{ displayTitle(loser.title_zh) || loser.title_original || '未命名' }}
                  </p>
                </div>
              </div>

              <!-- 相同的欄位不需要人看，不同的才要 → 只有 diff 的那一格上底色 -->
              <div class="mt-2 overflow-x-auto">
                <table class="w-full min-w-[28rem] text-sm">
                  <tbody>
                    <tr v-for="row in compareRows" :key="row.label" class="border-b border-default last:border-b-0">
                      <th scope="row" class="w-20 py-1.5 pr-3 text-left font-normal text-muted">
                        {{ row.label }}
                      </th>
                      <td class="py-1.5 pr-3 text-highlighted" :class="row.diff ? 'bg-primary/10' : ''">
                        {{ row.a }}
                      </td>
                      <td class="py-1.5 text-highlighted" :class="row.diff ? 'bg-primary/10' : ''">
                        {{ row.b }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <!-- 並排核准紀錄：判斷是否同一部片的依據（§14） -->
              <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div v-for="(side, i) in [winner, loser]" :key="i" class="rounded-sm border border-default px-3 py-2.5">
                  <p class="text-xs text-muted">
                    {{ i === 0 ? '保留' : '併掉' }} 的核准紀錄
                  </p>
                  <p v-if="!side.certificates.length" class="mt-1 text-sm text-muted">
                    沒有政府核准紀錄
                  </p>
                  <ul v-else class="mt-1 space-y-1.5">
                    <li v-for="c in side.certificates" :key="c.id" class="text-sm">
                      <span class="block text-highlighted">{{ metaLine(`${c.roc_year} 年`, c.permit_no, c.rating) }}</span>
                      <span class="block text-xs text-muted">{{ metaLine(c.title_zh, c.title_original, c.runtime_minutes ? `${c.runtime_minutes} 分鐘` : null) }}</span>
                    </li>
                  </ul>
                </div>
              </div>

              <UAlert
                class="mt-4"
                color="neutral"
                variant="subtle"
                :description="`合併之後：「${displayTitle(loser.title_zh) || loser.title_original}」消失，它的 ${loser.refs} 筆紀錄改指向左邊那一部。這個動作不可逆。`"
              />

              <UFormField
                label="合併理由"
                class="mt-4"
                required
                help="會寫進 film_merge_log，半年後回頭看時這是唯一能解釋「為什麼這兩部是同一部」的東西。"
              >
                <UInput v-model="mergeReason" placeholder="例如：同一部片，敗方是匯入時建的 UGC 佔位" class="w-full" />
              </UFormField>

              <div class="mt-4 flex flex-wrap gap-2.5">
                <UButton :disabled="!canMerge" @click="mergeConfirmOpen = true">
                  合併
                </UButton>
                <UButton variant="outline" color="neutral" @click="swapped = !swapped">
                  交換左右
                </UButton>
                <!-- 合併介面最常見的結局是「看完發現不該合併」，那個出口不該藏在取消裡 -->
                <UButton variant="ghost" color="neutral" @click="resetMerge()">
                  不是同一部
                </UButton>
              </div>
            </template>
          </section>
        </template>

        <p v-else class="py-8 text-center text-sm text-muted">
          讀不到這一筆的內容。
        </p>
      </template>
    </AdminShell>

    <!-- 退回：破壞性動作，二次確認 -->
    <UModal v-model:open="rejectOpen" title="退回這部作品">
      <template #body>
        <p class="text-sm">
          退回之後這部作品不會進公共片庫，作者仍然看得到它。海報檔案不會被搬動或刪除，
          之後改成通過就會重新公開——這一步是可逆的。
        </p>
        <p v-if="detail && detail.refs > 0" class="mt-3 text-sm">
          已經有 <span class="font-semibold tabular-nums">{{ detail.refs }}</span> 筆觀影紀錄指向它，那些紀錄會一直不能公開。
        </p>
        <UFormField
          label="退回理由"
          class="mt-4"
          required
          help="作者看得到這段話。他要靠它知道該怎麼改，所以寫「不符規範」等於沒寫。"
        >
          <UTextarea v-model="rejectNote" :rows="3" class="w-full" placeholder="例如：這部片片庫裡已經有了（片名叫「沙丘：第二部」），請改用既有的那一部。" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="rejectOpen = false">
            算了
          </UButton>
          <UButton color="error" :loading="acting" :disabled="!rejectNote.trim()" @click="detail && reject(detail.id)">
            退回
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- 合併：不可逆，二次確認 -->
    <UModal v-model:open="mergeConfirmOpen" title="確定要合併？">
      <template #body>
        <p v-if="winner && loser" class="text-sm">
          「{{ displayTitle(loser.title_zh) || loser.title_original }}」會消失，它的
          <span class="font-semibold tabular-nums">{{ loser.refs }}</span> 筆紀錄改指向
          「{{ displayTitle(winner.title_zh) || winner.title_original }}」。<strong>這個動作不可逆。</strong>
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="mergeConfirmOpen = false">
            算了
          </UButton>
          <UButton :loading="acting" @click="doMerge">
            合併
          </UButton>
        </div>
      </template>
    </UModal>
  </StaffGate>
</template>
