<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui'
import type { TakedownForm } from '~/schemas/takedown'
import { filmSlugFromUrl, normalizeTargetUrl, takedownSchema, toTakedownPayload } from '~/schemas/takedown'

/**
 * `/legal/dmca` — 侵權通知（`SCREENS §15.3`、著作權法 §90-4 第 3 款、§90-6）。
 *
 * ⚠️ **這一頁是表單，不是文件。** `legal_doc_kind` 這個 enum 只有三個值，
 * 沒有 dmca——那不是遺漏。著作權人來到這一頁只有一個目的，讓他先讀完一份條款
 * 再填表是在增加放棄率，所以這裡**不做「文件 + 底下一個表單」**。
 *
 * ⚠️ **未登入可提交。** 著作權人幾乎不會是我們的使用者，要求註冊等於關掉這個窗口，
 * 而窗口沒開就不符 §90-4 第 3 款。`supabase.redirectOptions.include` 只涵蓋
 * `/app` 與 `/admin`，這一頁不在裡面——**不要把它加進去**。
 *
 * ── 這張表在 API 層是單向的 ───────────────────────────────────────────
 * `anon` 有 INSERT grant、沒有 SELECT grant（實測 42501，比 RLS 更早擋下）。
 * 所以送出後**沒有任何東西可以讀回來**：`/api/legal/notice` 連 id 都不回
 * （「呼叫者讀不到這張表，給了 id 也沒有用途，只是多一個可枚舉的數字」）。
 * 這決定了成功畫面長什麼樣：不去查、不假裝有進度、把副本留在使用者手上。
 *
 * ⚠️ 「送出後你在這個網站上讀不到自己送過什麼」寫在**表單最上面**不是送出後才說
 * ——它會改變使用者怎麼填信箱，而信箱是我們唯一能回覆的管道（§15.3）。
 */
const config = useRuntimeConfig()
const form = useTemplateRef('form')

useSeoMeta({
  title: '侵權通知',
  description: '如果影記上有內容侵害你的著作權，用這張表通知我們。不需要註冊、不需要登入。',
  // 找得到才叫「公告窗口」（§90-4 第 3 款）。這一頁必須可被索引。
  robots: 'index, follow',
})

const state = reactive({
  claimantName: '',
  claimantEmail: '',
  claimantPhone: '',
  workDescription: '',
  targetUrl: '',
  statementGoodFaith: false as boolean,
})

/* ── 網址回顯 ───────────────────────────────────────────────────────────
   §15.3 要這個回顯有兩個作用：(a) 讓 `target_film_id` 真的被填進去，
   admin 才不必自己對一次網址；(b) 大幅減少誤報——很多誤報是網址貼錯。

   ⚠️ 解析規則跟伺服器**逐字相同**（見 schemas/takedown.ts 的 `filmSlugFromUrl`）。
   這裡認得出、伺服器認不出的話，使用者會以為我們已經定位到那一筆，
   而 admin 打開來看到的 `target_film_id` 是空的。
   ⚠️ 解析不到就留空並**照常收件**，不要擋。 */
interface ResolvedFilm {
  slug: string
  titleZh: string | null
  titleOriginal: string | null
  tmdbPosterPath: string | null
}

const resolved = ref<ResolvedFilm | null>(null)
const resolving = ref(false)
let resolveSeq = 0
let resolveTimer: ReturnType<typeof setTimeout> | undefined

async function resolveTarget() {
  const slug = filmSlugFromUrl(state.targetUrl)
  if (!slug) {
    resolved.value = null
    resolving.value = false
    return
  }
  const seq = ++resolveSeq
  resolving.value = true
  try {
    const data = await $fetch(`/api/film/${encodeURIComponent(slug)}`)
    // 慢回來的舊請求不可以蓋掉新的答案——網址是一個字一個字改出來的。
    if (seq !== resolveSeq)
      return
    resolved.value = data?.film
      ? {
          slug,
          titleZh: data.film.title_zh ?? null,
          titleOriginal: data.film.title_original ?? null,
          tmdbPosterPath: data.film.tmdb_poster_path ?? null,
        }
      : null
  }
  catch {
    // 404／網路錯誤都只是「認不出來」。收件不受影響。
    if (seq === resolveSeq)
      resolved.value = null
  }
  finally {
    if (seq === resolveSeq)
      resolving.value = false
  }
}

watch(() => state.targetUrl, () => {
  clearTimeout(resolveTimer)
  resolveTimer = setTimeout(resolveTarget, 400)
})

/**
 * 離開欄位時把網址補完整並**寫回輸入框**。
 * 使用者看得到我們改了什麼，也改得回來——這跟悄悄替他決定不是同一件事。
 * 只有路徑（`/film/abc`）時補上本站來源；那是他從網址列複製一半的常見情形。
 */
function normalizeUrlField() {
  const raw = state.targetUrl.trim()
  if (!raw)
    return
  const origin = String(config.public.siteUrl || '').replace(/\/+$/, '')
  state.targetUrl = normalizeTargetUrl(raw.startsWith('/') && origin ? `${origin}${raw}` : raw)
}

/* ── 送出 ──────────────────────────────────────────────────────────── */
const submitting = ref(false)
const submitError = ref('')
/** 送出成功後留在記憶體裡的副本。**唯一的來源是使用者剛剛打的字**，不是查回來的。 */
const submitted = ref<TakedownForm | null>(null)
const copied = ref(false)

const receiptText = computed(() => {
  const s = submitted.value
  if (!s)
    return ''
  return [
    '影記 — 侵權通知副本',
    `送出時間：${new Date().toISOString()}`,
    `姓名／單位：${s.claimantName}`,
    `電子郵件：${s.claimantEmail}`,
    `電話：${s.claimantPhone?.trim() || '（未填）'}`,
    `主張被侵權的著作：\n${s.workDescription}`,
    `侵權內容網址：${s.targetUrl}`,
    '善意聲明：已勾選',
  ].join('\n')
})

async function onSubmit(event: FormSubmitEvent<TakedownForm>) {
  submitting.value = true
  submitError.value = ''
  try {
    await $fetch('/api/legal/notice', { method: 'POST', body: toTakedownPayload(event.data) })
    submitted.value = event.data
    copied.value = false
    // 成功畫面在最上面，捲上去才看得到——手機上尤其。
    if (import.meta.client)
      window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  catch (e) {
    const err = e as { statusCode?: number, statusMessage?: string, data?: { statusMessage?: string, data?: { issues?: { path: string, message: string }[] } } }
    const issues = err.data?.data?.issues
    if (issues?.length) {
      // 伺服器那一份 schema 才是把關的那一份。它退件時，把訊息貼回對應的欄位，
      // 不要只丟一句「送出失敗」讓人自己找。
      form.value?.setErrors(issues.map(i => ({ name: i.path, message: i.message })))
      submitError.value = '有幾個欄位需要修正，已標在下面。'
    }
    else if (err.statusCode === 429) {
      submitError.value = '短時間內送出太多次了。請稍後再試，或直接寄到 copyright@filmnote.tw。'
    }
    else {
      submitError.value = err.data?.statusMessage || err.statusMessage || '送出失敗，請稍後再試一次。'
    }
  }
  finally {
    submitting.value = false
  }
}

async function copyReceipt() {
  try {
    await navigator.clipboard.writeText(receiptText.value)
    copied.value = true
  }
  catch {
    // 剪貼簿被擋（非安全來源、權限拒絕）時不要假裝成功——
    // 下面那個 <pre> 本來就是可以整段選起來複製的。
    copied.value = false
    submitError.value = '這個瀏覽器不讓我們寫入剪貼簿，請直接把下面那段選起來複製。'
  }
}

function again() {
  submitted.value = null
  submitError.value = ''
  resolved.value = null
  Object.assign(state, {
    claimantName: '',
    claimantEmail: '',
    claimantPhone: '',
    workDescription: '',
    targetUrl: '',
    statementGoodFaith: false,
  })
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-10">
    <!-- ══ 送出後 ══════════════════════════════════════════════════ -->
    <template v-if="submitted">
      <h1 class="text-[28px]/[1.35] font-bold tracking-tight [font-feature-settings:'palt'_1]">
        通知已經送出
      </h1>

      <div class="mt-5 max-w-[34em] border-s-2 border-primary bg-primary/5 px-4 py-4 rounded-e-sm">
        <!--
          信箱自成一行，跟 /legal/copyright 的受理窗口同一個處理方式：
          夾在中文句子中間的話，中英交界的間距要靠 `text-autospace` 跨元素邊界生效，
          那件事各家實作不一致（DS §2.5 第 4 條量的是同一個文字節點內的情形）。
          自成一行是確定的，順帶讓人比較好核對——這是他唯一能被回覆的地方。
        -->
        <p class="text-highlighted">
          我們會用你填的這個信箱跟你聯絡，後續一律走 email。
        </p>
        <p class="mt-1 font-semibold text-highlighted break-words">
          {{ submitted.claimantEmail }}
        </p>
        <!--
          ⚠️ 這一段不是客套。這張表沒有 SELECT policy，送出的內容我們也回不了
          受理編號給你（`/api/legal/notice` 刻意不回 id）。所以「請自行留存副本」
          是**唯一**能讓通知人手上有東西的做法，而副本只在這一頁的記憶體裡。
        -->
        <p class="mt-2 text-toned">
          這一頁重新整理之後就找不到了，而且你在本站讀不到自己送過什麼——這張表只寫入、不提供查詢。<span class="text-highlighted">下面是你剛剛送出的內容，請先留一份。</span>
        </p>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-3">
        <UButton variant="soft" icon="i-lucide-copy" @click="copyReceipt">
          複製副本
        </UButton>
        <span v-if="copied" class="text-[13px] text-muted">已複製到剪貼簿。</span>
      </div>

      <pre class="mt-3 max-w-[44em] overflow-x-auto whitespace-pre-wrap break-words rounded-sm border border-default bg-elevated px-4 py-3 text-[13px]/[1.7] font-sans">{{ receiptText }}</pre>

      <p v-if="submitError" class="mt-2 text-[13px] text-error">
        {{ submitError }}
      </p>

      <div class="mt-8 flex flex-wrap gap-3">
        <UButton variant="outline" color="neutral" @click="again">
          再送一件
        </UButton>
        <UButton to="/legal/copyright" variant="link" color="neutral">
          看著作權政策
        </UButton>
      </div>
    </template>

    <!-- ══ 表單 ════════════════════════════════════════════════════ -->
    <template v-else>
      <h1 class="text-[28px]/[1.35] font-bold tracking-tight [font-feature-settings:'palt'_1]">
        侵權通知
      </h1>
      <!--
        ⚠️ 中文句子與行內元素之間**不可以斷行**：Vue 的 whitespace 'condense' 會把
        含換行的空白摺成**一個空格**（不是摺掉——那只發生在兩個元素之間），
        於是「…通知對方。 不需要註冊」會多出一個看得見的空隙，而 DS §2.5 又禁止
        在 HTML 裡手打空格補間距。所以這種句子一律排成一行。
      -->
      <p class="mt-2 max-w-[34em] text-toned">
        如果這個網站上有內容侵害你的著作權，用這張表告訴我們。我們收到後會盡快處理並通知對方。<span class="text-highlighted">不需要註冊，也不需要登入。</span>
      </p>

      <!--
        ⚠️ 這一段在**表單最上面**是規格（§15.3），不是排版偏好：
        它會改變使用者怎麼填信箱，事後才講就來不及了。
        用側邊線而不是整塊底色——警示塊在這裡會讀成「出事了」，而他還沒填任何東西。
      -->
      <div class="mt-6 max-w-[34em] border-s-2 border-primary ps-3.5 text-[13px]/[1.7] text-toned">
        <p class="text-highlighted font-semibold">
          先看這一段，它會影響你怎麼填：
        </p>
        <p class="mt-1">
          送出之後，<span class="text-highlighted font-semibold">你在這個網站上讀不到自己送過什麼</span>——這張表只寫入、不提供查詢，因為任何查詢介面都等於揭露「哪些內容被通知過、屬於誰」。
        </p>
        <p class="mt-1">
          我們只能透過<span class="text-highlighted font-semibold">你填的信箱</span>回覆你，後續也一律走 email。<span class="text-highlighted font-semibold">所以信箱一定要填對。</span>
        </p>
      </div>

      <UAlert
        v-if="submitError"
        color="error"
        variant="subtle"
        class="mt-6 max-w-[34em]"
        :description="submitError"
      />

      <UForm
        ref="form"
        :schema="takedownSchema"
        :state="state"
        class="mt-8 space-y-6"
        @submit="onSubmit"
        @keydown="blockSubmitWhileComposing"
      >
        <UFormField label="你的姓名或單位" name="claimantName" required hint="必填" class="max-w-[27rem]">
          <UInput v-model="state.claimantName" placeholder="王小明／○○影業股份有限公司" class="w-full" autocomplete="name" />
        </UFormField>

        <UFormField
          label="電子郵件"
          name="claimantEmail"
          required
          hint="必填"
          class="max-w-[27rem]"
          help="這是我們唯一能回覆你的方式，送出後不能改。"
        >
          <UInput v-model="state.claimantEmail" type="email" placeholder="legal@example.com" class="w-full" autocomplete="email" />
        </UFormField>

        <UFormField label="電話" name="claimantPhone" hint="選填" class="max-w-[27rem]">
          <UInput v-model="state.claimantPhone" placeholder="02-1234-5678" class="w-full" autocomplete="tel" />
        </UFormField>

        <UFormField
          label="你主張被侵權的著作"
          name="workDescription"
          required
          hint="必填"
          class="max-w-[34em]"
          help="寫到能辨識是哪一個著作。例如：電影《○○○》的官方海報，著作權人為○○影業。"
        >
          <UTextarea v-model="state.workDescription" :rows="4" class="w-full" />
        </UFormField>

        <UFormField label="侵權內容的網址" name="targetUrl" required hint="必填" class="max-w-[34em]">
          <UInput
            v-model="state.targetUrl"
            type="url"
            inputmode="url"
            placeholder="https://filmnote.tw/film/…"
            class="w-full"
            @blur="normalizeUrlField"
          />

          <template #help>
            <span v-if="resolving">正在確認這個網址指向哪一筆…</span>
            <span v-else-if="resolved">我們認出這是下面這一部，如果不對請改網址。</span>
            <span v-else-if="filmSlugFromUrl(state.targetUrl)">這個網址我們找不到對應的作品，不影響收件——人工處理時會照你填的網址去看。</span>
            <span v-else>貼上你在本站看到那筆內容的網址。認不出來也照樣收件。</span>
          </template>
        </UFormField>

        <!--
          唯讀票根卡：沒有 `watchedOn` ⇒ 日期帶整條不出現（TicketCard 的 v-if），
          卡片自然變成「一部作品」而不是「一場放映」。這是對的——伺服器解析得出來的
          就是 `target_film_id`，不是 `target_record_id`。畫面上不要多給一個
          我們其實沒有存下來的精確度。
        -->
        <div v-if="resolved" class="max-w-[27rem] -mt-2">
          <TicketCard
            :record="{ film: { slug: resolved.slug, titleZh: resolved.titleZh, titleOriginal: resolved.titleOriginal, tmdbPosterPath: resolved.tmdbPosterPath } }"
            :link-film="false"
          />
        </div>

        <!--
          ⚠️ 善意聲明**不可以縮成「我同意」三個字**（§15.3）。
          它是 §90-6 的要件，必須讓填的人真的讀到自己在聲明什麼。
        -->
        <UFormField name="statementGoodFaith" required label="聲明" hint="必填" class="max-w-[34em]">
          <UCheckbox v-model="state.statementGoodFaith" class="mt-1">
            <template #label>
              <span class="text-[14px]/[1.65]">
                我聲明：本通知所述內容確實侵害我的著作權，我是該著作權人或經合法授權代為主張的人，
                且本通知的內容<span class="font-semibold text-highlighted">基於善意且屬實</span>。我了解不實通知可能須負法律責任。
              </span>
            </template>
          </UCheckbox>
        </UFormField>

        <div class="flex flex-wrap items-center gap-3 pt-2">
          <UButton type="submit" size="lg" :loading="submitting">
            送出通知
          </UButton>
          <UButton to="/legal/copyright" variant="ghost" color="neutral">
            取消
          </UButton>
        </div>
      </UForm>
    </template>
  </div>
</template>
