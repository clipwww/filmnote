<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { FilmOption } from '~/composables/useFilmSearch'
import type { FilmForm } from '~/schemas/film'
import type { Database } from '~/types/database.types'
import type { ResizedImage } from '~/utils/image'
import type { TicketCardRecord } from '~/utils/ticket'
import { filmSchema, toFilmRow } from '~/schemas/film'
import { POSTER_MAX_EDGE, resizePoster } from '~/utils/image'

/**
 * `/app/films/new` — 手動新增作品（`SCREENS.md §11`、US-13~18）。
 *
 * **這是流程的一部分，不是錯誤處理。** 它是「找不到片」這條路的終點，也是
 * 硬約束 (1) 最重要的落點——必須讀起來像流程的下一步，不像錯誤畫面，
 * 也不像後台表單。帶著已輸入的片名進來，第一個欄位已經填好。
 *
 * ── 建立的順序不能換 ─────────────────────────────────────────
 * 1. 先 insert `film`（拿到 id）
 * 2. 再上傳海報到 `ugc-poster/{film_id}/…`
 * 3. **再把路徑寫回 `film.ugc_poster_path`**
 *
 * 第 2 步不能先做：`ugc_poster_write` policy 的 `with check` 要求
 * `exists (select 1 from film where id = ugc_poster_film(name) and created_by = auth.uid())`，
 * 也就是**檔名裡的那個 film 必須已經存在而且是你的**，否則整個上傳被 RLS 擋掉。
 *
 * 第 3 步最容易漏，而且漏了很難查：上傳成功、審核後 anon 也讀得到，但
 * `film.ugc_poster_path` 還是 null ⇒ `film_public.ugc_poster_path` 是 null ⇒
 * **畫面退回文字卡片，而海報其實已經公開可讀**（BUILD_PLAN §5 Step 7 第 1 點）。
 *
 * ── 審核不搬檔 ───────────────────────────────────────────────
 * 單一 private bucket + RLS 把關，不是雙 bucket 搬檔（那個架構在 §1.1 修正 C
 * 已被否決）。`approve_film()` 一改審核狀態，同一個檔案就從「只有作者與 staff
 * 讀得到」變成「所有人讀得到」。讀取一律走 signed URL。
 */
const route = useRoute()
const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()
const toast = useToast()
const { merge: mergeDraft } = useRecordDraft()

useSeoMeta({ title: '新增作品' })

/**
 * 兩個入口，兩種收尾（§11）。**差別只在返回目標與按鈕文案，表單本身完全一樣。**
 * 從 `/app/records/new` 來的人手上有一筆記到一半的紀錄；從 `/search` 來的人沒有。
 */
const fromRecords = computed(() => route.query.from === 'records')
const backLabel = computed(() => (fromRecords.value ? '回到記錄' : '回到搜尋'))
const submitLabel = computed(() => (fromRecords.value ? '建立並繼續記錄' : '建立並記一場'))

const state = reactive<{
  titleZh: string
  titleOriginal: string
  country: string
  releaseYear: number | null
  runtimeMinutes: number | null
}>({
  // 從搜尋帶過來的字。這是「第一個欄位已經填好」那一半。
  titleZh: String(route.query.title ?? ''),
  titleOriginal: '',
  country: '',
  releaseYear: null,
  runtimeMinutes: null,
})

/**
 * 國別的建議清單：片庫裡已經出現過的國名，依出現次數排序。
 * 只取 `country` 一欄，2,764 列約 60KB——這一頁很少被打開，換到的是
 * 「新增的作品跟既有資料用同一組國名」。
 */
const { data: countryOptions } = await useAsyncData('country-options', async () => {
  const { data } = await supabase.from('film_public').select('country').limit(3000)
  const count = new Map<string, number>()
  for (const row of data ?? []) {
    const c = row.country?.trim()
    if (c)
      count.set(c, (count.get(c) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c)
}, { server: false, default: () => [] as string[] })

/** 回到來的地方。從搜尋來的話把字帶回去，不要讓他重打一次。 */
const backTo = computed(() =>
  fromRecords.value
    ? '/app/records/new'
    : { path: '/search', query: state.titleZh ? { q: state.titleZh } : {} })

/* ── 海報：四個狀態（§11）。**每一個都不可以出現破圖圖示。** ────────── */
type PosterState
  = | { kind: 'none' }
    | { kind: 'picked', image: ResizedImage }
    | { kind: 'uploading', image: ResizedImage }
    | { kind: 'pending', image: ResizedImage }
    | { kind: 'failed', image: ResizedImage | null, reason: string }

const poster = ref<PosterState>({ kind: 'none' })
const fileInput = useTemplateRef<HTMLInputElement>('fileInput')

function currentImage(): ResizedImage | null {
  return 'image' in poster.value ? poster.value.image : null
}

function releasePreview() {
  const img = currentImage()
  if (img)
    URL.revokeObjectURL(img.previewUrl)
}

async function acceptFile(file: File | null | undefined) {
  if (!file)
    return
  if (!file.type.startsWith('image/')) {
    poster.value = { kind: 'failed', image: null, reason: '這個檔案不是圖片。' }
    return
  }
  try {
    const image = await resizePoster(file)
    releasePreview()
    poster.value = { kind: 'picked', image }
  }
  catch (e) {
    poster.value = { kind: 'failed', image: null, reason: (e as Error).message }
  }
}

function clearPoster() {
  releasePreview()
  poster.value = { kind: 'none' }
  if (fileInput.value)
    fileInput.value.value = ''
}

onBeforeUnmount(releasePreview)

/* ── 即時票根預覽 ─────────────────────────────────────────────
   存在的理由只有一個：**讓人在按下按鈕之前就看到「沒有海報也是一張完整的票根」**，
   而不是先想像出一個破圖、再被一句安慰的文案安撫。這也是 §0「無海報的卡片要好到
   使用者不會希望它變成海報」唯一能被使用者親眼驗證的地方。 */
function todayLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const previewRecord = computed<TicketCardRecord>(() => ({
  id: 'preview',
  watchedOn: todayLocal(),
  // 影城、場次、票價都是**下一步**才填的。空欄位在票根卡上就是不存在，
  // 不渲染「—」或「未知」佔位（§4.3 的票價規則同一條）。
  film: {
    slug: null,
    titleZh: state.titleZh,
    titleOriginal: state.titleOriginal,
    tmdbPosterPath: null,
    ugcPosterUrl: currentImage()?.previewUrl ?? null,
  },
}))

/* ── 建立 ─────────────────────────────────────────────────── */
const saving = ref(false)
/** 作品已建立、但海報那一半失敗時停在這裡，不把人丟走也不假裝成功。 */
const createdFilm = ref<FilmOption | null>(null)

/**
 * 把作品交棒給 `/app/records/new`：片名已選好，**其餘欄位原樣還在**（§11）。
 * 用 merge 不是 save——草稿裡可能還有使用者離開前填到一半的日期、影城、票價。
 */
async function handOff(film: FilmOption) {
  mergeDraft({ film })
  await navigateTo('/app/records/new')
}

async function uploadPoster(filmId: string, image: ResizedImage): Promise<string> {
  // 路徑約定 `<film_id>/<random>.<ext>`（0001 §14）。前綴必須是 film id，
  // storage policy 的 ugc_poster_film() 就是從第一段切出來的。
  const path = `${filmId}/${crypto.randomUUID()}.jpg`
  const { error } = await supabase.storage
    .from('ugc-poster')
    .upload(path, image.blob, { contentType: 'image/jpeg', upsert: false })
  if (error)
    throw error

  // ★ 沒有這一步，海報存在 storage 裡但畫面永遠不會顯示它。
  const { error: linkError } = await supabase
    .from('film')
    .update({ ugc_poster_path: path })
    .eq('id', filmId)
  if (linkError)
    throw linkError
  return path
}

async function onSubmit(event: FormSubmitEvent<FilmForm>) {
  if (!user.value?.sub)
    return
  saving.value = true
  try {
    const { data: film, error } = await supabase
      .from('film')
      .insert({ ...toFilmRow(event.data), created_by: user.value.sub })
      .select('id,slug,title_zh,title_original,release_year,country,review_state')
      .single()
    if (error)
      throw error

    const option: FilmOption = film
    createdFilm.value = option

    const image = currentImage()
    if (image && poster.value.kind === 'picked') {
      poster.value = { kind: 'uploading', image }
      try {
        await uploadPoster(film.id, image)
        poster.value = { kind: 'pending', image }
      }
      catch (e) {
        // 作品已經建立了，海報失敗不該讓它消失，也不該假裝成功。
        // 停在這一頁，給「換一張」與「就這樣不放海報」兩個真的選項。
        poster.value = { kind: 'failed', image, reason: (e as Error).message }
        return
      }
    }

    toast.add({ title: '建立好了', color: 'success' })
    await handOff(option)
  }
  catch (e) {
    toast.add({ title: '建立失敗', description: (e as Error).message, color: 'error' })
  }
  finally {
    saving.value = false
  }
}

/** 海報失敗後：不放海報，直接繼續。**這必須是一個真的、並列的選項，不是放棄。** */
async function continueWithoutPoster() {
  if (createdFilm.value)
    await handOff(createdFilm.value)
}

async function retryPoster() {
  const film = createdFilm.value
  const image = currentImage()
  if (!film || !image)
    return
  poster.value = { kind: 'uploading', image }
  try {
    await uploadPoster(film.id, image)
    poster.value = { kind: 'pending', image }
    await handOff(film)
  }
  catch (e) {
    poster.value = { kind: 'failed', image, reason: (e as Error).message }
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8">
    <UButton :to="backTo" variant="link" color="neutral" size="sm" icon="i-lucide-arrow-left" class="-ms-2">
      {{ backLabel }}
    </UButton>

    <h1 class="mt-2 text-2xl font-bold tracking-tight">
      新增作品
    </h1>
    <p class="mt-2 text-toned">
      這部片還不在片庫裡。填一點資料就能開始記錄。
    </p>

    <div class="mt-8 grid gap-8 md:grid-cols-[minmax(0,1fr)_260px]">
      <!-- 手機上預覽在表單**上方**（§11），所以它在 DOM 裡排前面、桌機再換到右欄 -->
      <section class="md:order-2">
        <p class="text-sm text-muted">
          這部片在你的紀錄裡會長這樣
        </p>
        <div class="mt-2">
          <TicketCard :record="previewRecord" :link-film="false" />
        </div>
        <p class="mt-2 text-xs text-muted">
          影城與場次在下一步填。預覽即時跟著欄位變——沒有海報也是一張完整的票根。
        </p>
      </section>

      <UForm
        :schema="filmSchema"
        :state="state"
        class="space-y-5 md:order-1"
        @submit="onSubmit"
        @keydown="blockSubmitWhileComposing"
      >
        <UFormField label="中文片名" name="titleZh" required>
          <UInput v-model="state.titleZh" class="w-full" size="lg" autofocus />
          <template v-if="route.query.title" #help>
            從你剛剛搜尋的字帶過來，可以改。
          </template>
        </UFormField>

        <UFormField label="原文片名" name="titleOriginal" hint="選填">
          <UInput v-model="state.titleOriginal" placeholder="ちいかわ" class="w-full" />
        </UFormField>

        <div class="grid grid-cols-2 gap-4">
          <UFormField label="國別" name="country" hint="選填">
            <!--
              ★ 用原生 `<datalist>` 而不是選單元件：國別**必須可以自由輸入**
              （片庫裡沒有的國家不該被擋住），但也**必須跟既有資料一致**——
              目前 2,764 部的國別全部來自政府資料、用語一致（日本 651、
              美國 578、中華民國 403…），一旦有人打「Japan」或「JP」，
              國別分布圖就會多出一個永遠合不起來的分類。
              建 ISO 對照表不是解：政府資料用的是中文國名不是 ISO 碼，對不起來。
              建議清單直接從片庫的相異值長出來，天生跟既有資料一致，也會自己成長。
            -->
            <UInput v-model="state.country" placeholder="日本" list="country-options" class="w-full" />
            <datalist id="country-options">
              <option v-for="c in countryOptions" :key="c" :value="c" />
            </datalist>
          </UFormField>
          <UFormField label="上映年" name="releaseYear" hint="選填">
            <UInputNumber v-model="state.releaseYear" :min="1880" :max="2200" placeholder="2024" :format-options="{ useGrouping: false }" class="w-full" />
          </UFormField>
        </div>

        <UFormField label="片長" name="runtimeMinutes" hint="選填">
          <div class="flex items-center gap-2">
            <UInputNumber v-model="state.runtimeMinutes" :min="1" :max="1200" placeholder="96" class="w-40" />
            <span class="text-sm text-muted">分鐘</span>
          </div>
        </UFormField>

        <!--
          海報跟文字欄位**同一種待遇**（同底色、同邊框），不要做成整份表單裡最重的
          一塊——它是選填的，加重它會把注意力從唯一的必填欄拉走。
          也不用虛線框：那是 SaaS 預設，而且會讀成「這裡是空的」（§11）。
        -->
        <UFormField label="海報" hint="選填">
          <div
            class="rounded-sm border border-default bg-default p-3"
            @dragover.prevent
            @drop.prevent="acceptFile($event.dataTransfer?.files?.[0])"
          >
            <input
              ref="fileInput"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              class="sr-only"
              @change="acceptFile(($event.target as HTMLInputElement).files?.[0])"
            >

            <!-- ① 沒有海報：預設，**也是完成態** -->
            <div v-if="poster.kind === 'none'" class="flex flex-col items-start gap-1">
              <UButton variant="soft" color="neutral" size="sm" icon="i-lucide-image-plus" @click="fileInput?.click()">
                拖曳或點擊上傳
              </UButton>
              <p class="text-xs text-muted">
                長邊會縮到 {{ POSTER_MAX_EDGE }}px。沒有也沒關係——旁邊那張卡現在就是完整的。
              </p>
            </div>

            <div v-else class="flex items-start gap-3">
              <div class="w-12 shrink-0 overflow-hidden rounded-[3px]">
                <img
                  v-if="'image' in poster && poster.image"
                  :src="poster.image.previewUrl"
                  alt="海報預覽"
                  class="aspect-[2/3] w-full object-cover"
                >
                <!-- ② 上傳中：結構性骨架，不用轉圈（§10 品質底線） -->
                <USkeleton v-else class="aspect-[2/3] w-full rounded-[3px]" />
              </div>

              <div class="min-w-0 flex-1 text-sm">
                <template v-if="poster.kind === 'picked'">
                  <p class="text-muted">
                    {{ poster.image.width }}×{{ poster.image.height }}，建立時一起上傳。
                  </p>
                  <div class="mt-1 flex gap-2">
                    <UButton variant="link" color="neutral" size="xs" class="p-0" @click="fileInput?.click()">
                      換一張
                    </UButton>
                    <UButton variant="link" color="neutral" size="xs" class="p-0" @click="clearPoster">
                      不放海報
                    </UButton>
                  </div>
                </template>

                <template v-else-if="poster.kind === 'uploading'">
                  <USkeleton class="h-2 w-full rounded-[1px]" />
                  <p class="mt-2 text-muted">
                    上傳中…
                  </p>
                </template>

                <!-- ③ 待審核 -->
                <template v-else-if="poster.kind === 'pending'">
                  <UBadge variant="soft" color="neutral" size="sm">
                    審核中
                  </UBadge>
                  <p class="mt-1 text-muted">
                    只有你看得到。通過後其他人才看得到。
                  </p>
                </template>

                <!-- ④ 被拒：說發生了什麼與怎麼修，不道歉（§8） -->
                <template v-else>
                  <UBadge variant="soft" color="error" size="sm">
                    沒有存成功
                  </UBadge>
                  <p class="mt-1 text-toned">
                    {{ poster.reason }}
                  </p>
                  <div class="mt-1 flex flex-wrap gap-2">
                    <UButton variant="link" color="neutral" size="xs" class="p-0" @click="fileInput?.click()">
                      換一張
                    </UButton>
                    <UButton v-if="createdFilm" variant="link" color="neutral" size="xs" class="p-0" @click="retryPoster">
                      再試一次
                    </UButton>
                    <!-- 「就這樣不放海報」必須是一個真的、並列的選項，不是放棄（§11） -->
                    <UButton
                      v-if="createdFilm"
                      variant="link"
                      color="neutral"
                      size="xs"
                      class="p-0"
                      @click="continueWithoutPoster"
                    >
                      就這樣不放海報
                    </UButton>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </UFormField>

        <p class="text-sm leading-relaxed text-muted">
          你新增的作品<span class="text-toned">只有你看得到</span>，審核通過後才會進入公共片庫。
          <span class="text-toned">現在就可以拿它記錄</span>，不必等審核。
          之後比對到 TMDB 會自動補上海報與詳細資料。
        </p>

        <div class="flex flex-wrap items-center gap-3">
          <UButton type="submit" size="lg" :loading="saving" :disabled="!state.titleZh.trim() || !!createdFilm">
            {{ submitLabel }}
          </UButton>
          <UButton :to="backTo" variant="ghost" color="neutral">
            取消
          </UButton>
        </div>
      </UForm>
    </div>
  </div>
</template>
