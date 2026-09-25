<script setup lang="ts">
import { apiErrorText } from '~/utils/admin-format'
import { parseTmdbId } from '~/utils/tmdb-id'

/**
 * 從 TMDB 匯入新作品（CLI `scripts/tmdb-import-new-releases.ts` 的後台版）。
 * ⚠️ 檔名前綴的 `-` 不可省：`pages/` 底下沒有它會冒出一條路由（踩雷 #131）。
 */
/*
 * 兩個入口：① 搜片名或貼 TMDB 網址／id——清單裡沒有的片走這條（例如《奧德賽》7/17 上映，
 * 兩個多月後已掉出 TMDB 的「上映中」）；② 台灣上映清單，與 CLI 同一份。
 * ★ 一律先預覽再寫入，而寫入端會**自己重跑一次預覽**：這裡的勾選只能縮小範圍。
 * 寫進去的作品要等「刷新快照」才有海報與簡介——所以這一區放在刷新的正上方。
 */

interface Candidate {
  id: number
  title: string
  original_title: string
  releaseDate: string | null
  twReleaseDate: string | null
  posterPath: string | null
}
interface Preview {
  known: Candidate[]
  suspected: { release: Candidate, hits: { id: string, title_zh: string, title_original: string, origin: string }[] }[]
  fresh: Candidate[]
  blocked: Candidate[]
  notFound: number[]
  librarySize: number
  evidence: {
    releases: Record<number, { runtime: number | null, twReleaseDate: string | null }>
    films: Record<string, { runtimeMinutes: number | null, releaseYear: number | null, firstSeenRocYear: number | null, country: string | null, hasUgcPoster: boolean, pendingUgc: boolean }>
  }
}
interface ImportResult {
  written: number
  readback: { tmdbId: number, titleZh: string, origin: string, titleZhSource: string, ok: boolean }[]
}
type Source
  = | { kind: 'search', q: string }
    | { kind: 'ids', ids: number[] }
    | { kind: 'releases', pages: number }

const toast = useToast()

const mode = ref<'search' | 'releases'>('search')
const q = ref('')
const pages = ref(3)
const PAGE_OPTIONS = [1, 2, 3, 4, 5].map(n => ({ label: `${n} 頁（約 ${n * 20} 部）`, value: n }))

const source = ref<Source | null>(null)
const preview = ref<Preview | null>(null)
const picked = ref<number[]>([])
const running = ref<'preview' | 'import' | null>(null)
const confirming = ref(false)
const result = ref<ImportResult | null>(null)

async function runPreview() {
  const text = q.value.trim()
  if (mode.value === 'search' && !text)
    return
  const id = mode.value === 'search' ? parseTmdbId(text) : null
  const next: Source = mode.value === 'releases'
    ? { kind: 'releases', pages: pages.value }
    : id ? { kind: 'ids', ids: [id] } : { kind: 'search', q: text }

  running.value = 'preview'
  confirming.value = false
  result.value = null
  try {
    preview.value = await $fetch<Preview>('/api/admin/tmdb/import-preview', { method: 'POST', body: { source: next } })
    source.value = next
    // 清單模式預設全選（那是 CLI 的行為）；搜尋結果是一堆同名的片，預設不勾，要人挑。
    picked.value = next.kind === 'search' ? [] : preview.value.fresh.map(c => c.id)
  }
  catch (e) {
    preview.value = null
    toast.add({ title: '預覽失敗', description: apiErrorText(e), color: 'error' })
  }
  finally {
    running.value = null
  }
}

function toggle(id: number, on: boolean) {
  picked.value = on ? [...new Set([...picked.value, id])] : picked.value.filter(x => x !== id)
}

/** 搜尋結果改送 ids：片名以 TMDB 明細為準，不是搜尋結果（伺服器也拒收 search）。 */
const importBody = computed(() => {
  const s = source.value
  if (!s)
    return null
  if (s.kind === 'releases')
    return { source: s, only: picked.value }
  return { source: { kind: 'ids', ids: picked.value } }
})

async function runImport() {
  if (!importBody.value || !picked.value.length)
    return
  running.value = 'import'
  try {
    result.value = await $fetch<ImportResult>('/api/admin/tmdb/import', { method: 'POST', body: importBody.value })
    confirming.value = false
    // 下面「TMDB 快取維護」的到期數字要跟著變，不然剛匯入的看起來像沒進佇列。
    await refreshNuxtData('admin-tmdb-status')
    // 同一批不能再匯一次：重新預覽，剛寫進去的會移到「已收錄」。
    const s = source.value
    if (s) {
      preview.value = await $fetch<Preview>('/api/admin/tmdb/import-preview', { method: 'POST', body: { source: s } })
      picked.value = []
    }
  }
  catch (e) {
    toast.add({ title: '匯入失敗', description: apiErrorText(e), color: 'error' })
  }
  finally {
    running.value = null
  }
}

/*
 * ② 補 TMDB id。一次只補一對（一部 TMDB × 一部既有作品），確認時兩側的片長並排——
 * 片長是唯一擋得住「片名相近但根本是另一部片」的訊號（0018 的交叉驗證）。
 * 多個候選時每個各一顆，不替人選第一個。
 */
const linking = ref<{ tmdbId: number, filmId: string } | null>(null)
const linkRunning = ref(false)

async function runLink() {
  const l = linking.value
  if (!l)
    return
  linkRunning.value = true
  try {
    const r = await $fetch<{ ok: boolean }>('/api/admin/tmdb/link', { method: 'POST', body: l })
    toast.add(r.ok
      ? { title: `已補上 TMDB ${l.tmdbId}`, description: '中文片名維持原本的官方片名。海報與簡介等「刷新快照」。', color: 'success' }
      : { title: '補上了，但讀回來的狀態不對', description: '請回報（片名來源或識別鍵與預期不同）。', color: 'error' })
    linking.value = null
    await refreshNuxtData('admin-tmdb-status')
    const s = source.value
    if (s)
      preview.value = await $fetch<Preview>('/api/admin/tmdb/import-preview', { method: 'POST', body: { source: s } })
  }
  catch (e) {
    toast.add({ title: '補 TMDB id 失敗', description: apiErrorText(e), color: 'error' })
  }
  finally {
    linkRunning.value = false
  }
}

function minutes(n: number | null | undefined) {
  return n ? `${n} 分` : '片長不明'
}

const badReadback = computed(() => result.value?.readback.filter(r => !r.ok) ?? [])

function poster(path: string | null) {
  return path ? `https://image.tmdb.org/t/p/w92${path}` : null
}
</script>

<template>
  <section class="overflow-hidden rounded-sm border border-default bg-default">
    <header class="border-b border-default px-5 py-3">
      <h2 class="font-semibold">
        從 TMDB 匯入新作品
      </h2>
      <p class="mt-1 max-w-2xl text-sm text-muted">
        片庫裡還沒有的作品直接以 TMDB 資料建立（片名來源標成 TMDB，日後政府核准資料進來時會換成官方片名）。
        先預覽，確定之後才寫入。
      </p>
    </header>

    <div class="border-b border-default px-5 py-4">
      <div class="flex gap-1.5">
        <UButton size="sm" :variant="mode === 'search' ? 'solid' : 'soft'" color="neutral" icon="i-lucide-search" @click="mode = 'search'">
          搜片名／TMDB 網址
        </UButton>
        <UButton size="sm" :variant="mode === 'releases' ? 'solid' : 'soft'" color="neutral" icon="i-lucide-list" @click="mode = 'releases'">
          台灣上映清單
        </UButton>
      </div>

      <form class="mt-4 flex flex-wrap items-end gap-3" @submit.prevent="runPreview">
        <UFormField v-if="mode === 'search'" label="片名、TMDB 網址或 id" class="w-full sm:w-96">
          <UInput v-model="q" placeholder="例如：奧德賽，或 themoviedb.org/movie/1368337" class="w-full" />
        </UFormField>
        <UFormField v-else label="每張清單讀幾頁" class="w-48">
          <USelect v-model="pages" :items="PAGE_OPTIONS" class="w-full" />
        </UFormField>
        <UButton type="submit" icon="i-lucide-eye" :loading="running === 'preview'" :disabled="running !== null">
          預覽
        </UButton>
      </form>
      <p v-if="mode === 'releases'" class="mt-2 max-w-2xl text-xs text-muted">
        TMDB 的「上映中」只涵蓋最近幾週。上映比較久的片不會出現在這裡，改用上面的搜尋。
      </p>
    </div>

    <!-- 常駐容器，理由同 `-TmdbMaintenance.vue`：live region 要先存在，讀屏才會播報。 -->
    <div aria-live="polite" class="px-5 py-5">
      <template v-if="result">
        <UAlert
          :color="badReadback.length ? 'error' : 'success'"
          variant="soft"
          :title="`寫入 ${result.written} 部`"
          :description="badReadback.length
            ? `其中 ${badReadback.length} 部讀回來的來源不是 TMDB（${badReadback.map(r => r.tmdbId).join('、')}）——片名會被標成官方核准的，請回報。`
            : '讀回確認：全部是 TMDB 來源、已核准。海報與簡介要等下面的「刷新快照」跑過才會出現。'"
        />
      </template>

      <template v-if="preview">
        <p class="mt-4 text-sm text-muted tabular-nums">
          片庫 {{ preview.librarySize.toLocaleString('en-US') }} 部 ·
          可匯入 {{ preview.fresh.length }} · 疑似已存在 {{ preview.suspected.length }} · 已收錄 {{ preview.known.length }}
        </p>

        <UAlert
          v-if="preview.blocked.length"
          class="mt-3"
          color="error"
          variant="soft"
          :title="`${preview.blocked.length} 部已經有 TMDB 識別鍵，整批不能匯入`"
          description="它們會走資料庫的更新分支（會把上映年份寫成 9999）。這不該發生，請回報。"
        />
        <UAlert
          v-if="preview.notFound.length"
          class="mt-3"
          color="warning"
          variant="soft"
          :title="`TMDB 查無 ${preview.notFound.join('、')}`"
        />

        <!-- ③ 可匯入 -->
        <ul v-if="preview.fresh.length" class="mt-4 divide-y divide-default rounded-sm border border-default">
          <li v-for="c in preview.fresh" :key="c.id" class="flex items-center gap-3 px-3 py-2">
            <UCheckbox
              :model-value="picked.includes(c.id)"
              :aria-label="`匯入 ${c.title || c.original_title}`"
              @update:model-value="v => toggle(c.id, v === true)"
            />
            <img v-if="poster(c.posterPath)" :src="poster(c.posterPath)!" alt="" loading="lazy" class="h-12 w-8 shrink-0 rounded-xs object-cover">
            <div v-else class="h-12 w-8 shrink-0 rounded-xs bg-elevated" />
            <div class="min-w-0">
              <p class="truncate font-medium">
                {{ c.title || c.original_title }}
              </p>
              <p class="truncate text-xs text-muted">
                {{ c.original_title }} · TMDB {{ c.id }}
                <template v-if="c.twReleaseDate">
                  · 台灣上映 {{ c.twReleaseDate }}
                </template>
                <template v-else-if="c.releaseDate">
                  · 首映 {{ c.releaseDate }}
                </template>
              </p>
            </div>
          </li>
        </ul>
        <p v-else class="mt-4 text-sm text-muted">
          沒有可以匯入的作品。
        </p>

        <!-- ② 疑似已存在：不新增，改替既有那部補 TMDB id -->
        <div v-if="preview.suspected.length" class="mt-5">
          <p class="text-sm font-medium">
            疑似已存在（{{ preview.suspected.length }}）
          </p>
          <p class="mt-0.5 max-w-2xl text-xs text-muted">
            片名對得上片庫裡一部沒有 TMDB id 的作品——該做的是替那部補 id，不是新增一部。
            <strong>先比片長</strong>：片名相同但片長差很多，通常是另一部片。
          </p>
          <ul class="mt-2 space-y-3">
            <li v-for="s in preview.suspected" :key="s.release.id" class="rounded-sm border border-default px-3 py-2 text-sm">
              <p class="font-medium">
                TMDB {{ s.release.id }}：{{ s.release.title || s.release.original_title }}
                <span class="font-normal text-muted">· {{ s.release.original_title }} · {{ minutes(preview.evidence.releases[s.release.id]?.runtime) }}
                  · {{ preview.evidence.releases[s.release.id]?.twReleaseDate ? `台灣上映 ${preview.evidence.releases[s.release.id]!.twReleaseDate}` : (s.release.releaseDate ? `首映 ${s.release.releaseDate}` : '上映日不明') }}</span>
              </p>
              <div v-for="h in s.hits" :key="h.id" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-3">
                <span>↳ 片庫：{{ h.title_zh || h.title_original }}</span>
                <span class="text-xs text-muted tabular-nums">
                  {{ h.title_original }} · {{ minutes(preview.evidence.films[h.id]?.runtimeMinutes) }}
                  <template v-if="preview.evidence.films[h.id]?.firstSeenRocYear">· 核准 {{ preview.evidence.films[h.id]!.firstSeenRocYear }} 年</template>
                  <template v-if="preview.evidence.films[h.id]?.country">· {{ preview.evidence.films[h.id]!.country }}</template>
                </span>
                <span v-if="preview.evidence.films[h.id]?.pendingUgc" class="text-xs text-warning">
                  還在審核中的使用者新增作品，先到「作品審核」處理
                </span>
                <template v-else-if="linking?.tmdbId === s.release.id && linking?.filmId === h.id">
                  <span class="text-xs">
                    確定把 TMDB {{ s.release.id }} 補到這一部？
                    <template v-if="preview.evidence.films[h.id]?.hasUgcPoster"><strong class="text-warning">使用者上傳的海報會被清掉。</strong></template>
                  </span>
                  <UButton size="xs" :loading="linkRunning" @click="runLink">
                    確定補上
                  </UButton>
                  <UButton size="xs" color="neutral" variant="ghost" :disabled="linkRunning" @click="linking = null">
                    取消
                  </UButton>
                </template>
                <UButton
                  v-else
                  size="xs"
                  variant="soft"
                  icon="i-lucide-link"
                  :disabled="linkRunning || running !== null"
                  @click="linking = { tmdbId: s.release.id, filmId: h.id }"
                >
                  補上 TMDB id
                </UButton>
              </div>
            </li>
          </ul>
        </div>

        <!-- ① 已收錄 -->
        <details v-if="preview.known.length" class="mt-5 text-sm">
          <summary class="cursor-pointer text-muted">
            已收錄（{{ preview.known.length }}）
          </summary>
          <p class="mt-2 text-muted">
            {{ preview.known.map(c => c.title || c.original_title).join('、') }}
          </p>
        </details>

        <div v-if="preview.fresh.length && !preview.blocked.length" class="mt-5 flex flex-wrap items-center gap-3">
          <UButton
            v-if="!confirming"
            icon="i-lucide-download"
            :disabled="!picked.length || running !== null"
            @click="confirming = true"
          >
            匯入勾選的 {{ picked.length }} 部
          </UButton>
          <template v-else>
            <p class="text-sm">
              會直接寫進正式站的片庫，<strong>{{ picked.length }}</strong> 部。確定？
            </p>
            <UButton color="primary" :loading="running === 'import'" :disabled="running !== null" @click="runImport">
              確定匯入
            </UButton>
            <UButton color="neutral" variant="ghost" :disabled="running !== null" @click="confirming = false">
              取消
            </UButton>
          </template>
        </div>
      </template>
    </div>
  </section>
</template>
