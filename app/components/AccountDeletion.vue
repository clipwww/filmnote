<script setup lang="ts">
import type { Database } from '~/types/database.types'

/**
 * US-47 帳號刪除。**隱私權政策第 5 節寫著「你隨時可以刪除帳號與所有資料」**
 * ——在這一區出現之前，那是一句我們聲明了但使用者做不到的話。
 *
 * 資料層在 `0009_account_deletion.sql`，端點在 `server/api/account/delete.post.ts`。
 * 這裡只做三件事：**先給預覽、要求打字確認、把結果如實講完**。
 *
 * ── 為什麼一定要先預覽 ───────────────────────────────────────────────
 * 刪除是不可逆的，而「會刪掉什麼」在這個資料模型裡**不是顯而易見的**：
 * 你自建的作品只要已核准、被別人的紀錄用到、或已合併到別的作品，就**不會**
 * 跟著消失——它留在公共片庫，只是不再指向你。使用者有權在按下去之前知道這件事，
 * 而不是事後才發現「我建的片還在」或反過來擔心「我把別人的紀錄弄壞了」。
 * `account_deletion_preview()` 存在就是為了這件事，而且它與端點清 bucket 時
 * 用的是**同一份判準**（`account_purgeable_films`）——不是兩份會漂移的條件。
 *
 * ── 為什麼是打字確認而不是「你確定嗎？」 ─────────────────────────────
 * 端點的 `confirm` 欄位要求等於自己的 username，比對不過回 422 且**一列都不動**。
 * 0009 拿掉了兩階段刪除的殘骸（`deletion_requested_at`），誤刪的緩衝改由這裡負責：
 * 它比緩衝期好的地方是它是同步的——使用者當下就知道自己在做什麼，
 * 不必依賴一個「三十天後真的會有東西去執行」的排程。
 *
 * ⚠️ 成功之後**不要自動跳走**，但也**不要讓人繼續用這一頁**。
 * cookie 已經被端點清掉、profile 也沒了，這一頁再發任何一個查詢都會回 401
 * ——那看起來像壞掉，不像刪成功。所以做法是：把結果留在同一個對話框裡讓人讀完
 *（那是他最後一次看到自己資料的機會），由他自己按鈕離開。
 * 對話框本身不查任何東西，停在那裡是安全的。
 */
const props = defineProps<{ username: string }>()

const supabase = useSupabaseClient<Database>()
const toast = useToast()

interface Preview {
  username: string
  records: number
  films_to_delete: { id: string, poster_path: string | null }[]
  films_to_keep: number
  usernames_to_reserve: number
  strikes_retained: number
  counter_notices_retained: number
}

interface DeleteResult {
  deleted: { username: string, records: number, films: number, posters: number, usernamesReserved: number }
  retained: { filmsAnonymised: number, copyrightRecords: number }
}

const preview = ref<Preview | null>(null)
const loadingPreview = ref(false)
const confirmOpen = ref(false)
const confirmText = ref('')
const deleting = ref(false)
const errorText = ref('')
const result = ref<DeleteResult | null>(null)

async function loadPreview() {
  loadingPreview.value = true
  errorText.value = ''
  const { data, error } = await supabase.rpc('account_deletion_preview')
  loadingPreview.value = false
  if (error) {
    errorText.value = `拿不到預覽：${error.message}`
    return
  }
  preview.value = data as unknown as Preview
}

/** 打字確認：大小寫不敏感，跟端點的判斷一致（手機第一個字母常被自動大寫）。 */
const confirmOk = computed(() =>
  confirmText.value.trim().toLowerCase() === props.username.toLowerCase())

async function doDelete() {
  if (!confirmOk.value)
    return
  deleting.value = true
  errorText.value = ''
  try {
    result.value = await $fetch<DeleteResult>('/api/account/delete', {
      method: 'POST',
      body: { confirm: confirmText.value.trim() },
    })
  }
  catch (e) {
    const err = e as { statusCode?: number, statusMessage?: string, data?: { statusMessage?: string } }
    errorText.value = err.data?.statusMessage || err.statusMessage || '刪除失敗，請稍後再試一次。'
    toast.add({ title: '沒有刪除', description: errorText.value, color: 'error' })
  }
  finally {
    deleting.value = false
  }
}
</script>

<template>
  <section>
    <h2 class="font-semibold">
      刪除帳號
    </h2>
    <p class="mt-1 text-sm text-muted">
      刪掉帳號與所有紀錄。這件事不可逆，也沒有緩衝期——按下去就是現在。
      想留一份資料的話，先用上面的「匯出我的紀錄」。
    </p>

    <UButton
      v-if="!preview"
      variant="soft"
      color="neutral"
      class="mt-3"
      icon="i-lucide-list-checks"
      :loading="loadingPreview"
      @click="loadPreview"
    >
      看看會刪掉什麼
    </UButton>

    <template v-else>
      <!--
        ⚠️ 「你建的作品可能不會跟著消失」這一條要講清楚，而且要講在按鈕之前。
        使用者對刪除最常見的兩種誤解正好相反：一種以為東西都會留著，
        一種怕自己會把別人的紀錄弄壞。這一份預覽同時回答了兩邊。
      -->
      <dl class="mt-3 border border-default rounded-sm text-sm divide-y divide-default">
        <div class="flex items-baseline justify-between gap-4 px-3 py-2">
          <dt>你的觀影紀錄</dt>
          <dd class="tabular-nums text-highlighted">
            {{ `${preview.records} 筆全部刪除` }}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 px-3 py-2">
          <dt>你自建、還沒有別人用到的作品</dt>
          <dd class="tabular-nums text-highlighted">
            {{ `${preview.films_to_delete.length} 部刪除（含海報）` }}
          </dd>
        </div>
        <!--
          ⚠️ 這一列的理由**不只一個**，措辭不可以只寫其中一個。
          `account_purgeable_films` 排除的情況有四種：已核准（進了公共片庫）、
          被別人的紀錄引用、被合併到別的作品、出現在合併紀錄裡。
          實測 David 的 16 部全部落在「已被合併」那一條（2026-09-05 匯入時
          人工對照表指定的），如果這裡只寫「被別人引用」，那對他就是一句錯的話。
        -->
        <div v-if="preview.films_to_keep" class="flex items-baseline justify-between gap-4 px-3 py-2">
          <dt>
            你自建、但不會跟著刪掉的作品
            <span class="block text-[13px] text-muted">已經進入公共片庫、被別人的紀錄用到，或已合併到其他作品的都會留下——刪掉它們會弄壞不屬於你的東西。它們留在片庫，但不再指向你。</span>
          </dt>
          <dd class="tabular-nums text-highlighted">
            {{ `${preview.films_to_keep} 部保留` }}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 px-3 py-2">
          <dt>
            你用過的使用者名稱
            <span class="block text-[13px] text-muted">保留起來不再開放註冊，外面流傳的舊連結才不會指到另一個人身上。</span>
          </dt>
          <dd class="tabular-nums text-highlighted">
            {{ `${preview.usernames_to_reserve} 個隔離` }}
          </dd>
        </div>
        <div
          v-if="preview.strikes_retained + preview.counter_notices_retained > 0"
          class="flex items-baseline justify-between gap-4 px-3 py-2"
        >
          <dt>
            著作權處理紀錄
            <span class="block text-[13px] text-muted">著作權法第六章之一要求保留，但已經切斷與你的關聯。</span>
          </dt>
          <dd class="tabular-nums text-highlighted">
            {{ `${preview.strikes_retained + preview.counter_notices_retained} 筆保留` }}
          </dd>
        </div>
      </dl>

      <UButton color="error" variant="soft" class="mt-3" @click="confirmOpen = true">
        我要刪除帳號
      </UButton>
    </template>

    <p v-if="errorText" class="mt-2 text-[13px] text-error">
      {{ errorText }}
    </p>

    <!-- 破壞性動作用 UModal 二次確認（DS §10），而且確認方式是打字不是點頭 -->
    <UModal v-model:open="confirmOpen" title="刪除帳號">
      <template #body>
        <!-- 刪完了：這是他最後一次看到這些數字，讀完再自己離開 -->
        <template v-if="result">
          <p class="text-sm text-highlighted">
            {{ `帳號 ${result.deleted.username} 已經刪除。` }}
          </p>
          <ul class="mt-2 text-sm text-toned space-y-1">
            <li>{{ `觀影紀錄 ${result.deleted.records} 筆、自建作品 ${result.deleted.films} 部、海報 ${result.deleted.posters} 個已刪除。` }}</li>
            <li v-if="result.retained.filmsAnonymised">
              {{ `${result.retained.filmsAnonymised} 部作品留在公共片庫，已不再指向你。` }}
            </li>
            <li v-if="result.retained.copyrightRecords">
              {{ `${result.retained.copyrightRecords} 筆著作權處理紀錄依法保留，已切斷與你的關聯。` }}
            </li>
            <li>{{ `${result.deleted.usernamesReserved} 個使用者名稱已隔離，不會被別人註冊走。` }}</li>
          </ul>
          <p class="mt-3 text-[13px] text-muted">
            你已經登出了。用同一個 Google 帳號再登入的話會是一個全新的帳號。
          </p>
        </template>

        <template v-else>
          <p class="text-sm text-toned">
            刪除之後無法復原，我們也救不回來。確定的話，請在下面打出你的使用者名稱。
          </p>
          <p class="mt-2 text-sm text-highlighted tabular-nums">
            {{ username }}
          </p>
          <UInput
            v-model="confirmText"
            class="mt-3 w-full"
            autocomplete="off"
            :placeholder="username"
            @keydown="blockSubmitWhileComposing"
          />
          <p v-if="errorText" class="mt-2 text-[13px] text-error">
            {{ errorText }}
          </p>
        </template>
      </template>
      <template #footer>
        <div class="flex flex-wrap gap-3">
          <UButton v-if="result" to="/" external>
            回到首頁
          </UButton>
          <template v-else>
            <UButton
              color="error"
              :disabled="!confirmOk"
              :loading="deleting"
              @click="doDelete"
            >
              永久刪除
            </UButton>
            <UButton color="neutral" variant="ghost" @click="confirmOpen = false">
              取消
            </UButton>
          </template>
        </div>
      </template>
    </UModal>
  </section>
</template>
