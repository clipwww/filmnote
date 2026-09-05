<script setup lang="ts">
import type { Database } from '~/types/database.types'

useSeoMeta({ title: '設定' })

const supabase = useSupabaseClient<Database>()
const user = useSupabaseUser()
const toast = useToast()

const username = ref('')
const newUsername = ref('')
const showCost = ref(false)
const saving = ref(false)

await useAsyncData('settings', async () => {
  if (!user.value?.sub)
    return null
  const { data } = await supabase
    .from('profile')
    .select('username,show_cost')
    .eq('id', user.value.sub)
    .maybeSingle()
  if (data) {
    username.value = data.username
    newUsername.value = data.username
    showCost.value = data.show_cost
  }
  return data
}, { server: false, watch: [user] })

/**
 * US-30：主動開啟票價公開。
 *
 * 這個開關只改 profile.show_cost 一個布林值——票價本身不需要搬動，
 * 因為 cost_read policy 是即時判斷的（紀錄公開 且 作者已開 show_cost）。
 * 關掉的瞬間，所有人的查詢就再也讀不到那些列，零資料遷移。
 */
async function toggleShowCost(value: boolean) {
  if (!user.value?.sub)
    return
  const { error } = await supabase.from('profile').update({ show_cost: value }).eq('id', user.value.sub)
  if (error) {
    showCost.value = !value
    toast.add({ title: '設定失敗', description: error.message, color: 'error' })
    return
  }
  toast.add({ title: value ? '票價已公開' : '票價已改回不公開', color: 'success' })
}

/** US-24/25：改名走 RPC，舊名保留為 historical 供 301，且不會被別人搶走。 */
async function rename() {
  if (!newUsername.value || newUsername.value === username.value)
    return
  saving.value = true
  const { data, error } = await supabase.rpc('rename_username', { p_new: newUsername.value })
  saving.value = false
  if (error) {
    toast.add({ title: '改名失敗', description: error.message, color: 'error' })
    return
  }
  username.value = data as string
  newUsername.value = data as string
  toast.add({ title: '已改名', description: '舊網址仍會轉向到新的個人頁', color: 'success' })
}

/** US-46：匯出。RPC 是 SECURITY INVOKER，最壞情況也只倒出呼叫者本來看得到的。 */
async function exportData() {
  const { data, error } = await supabase.rpc('export_my_data')
  if (error) {
    toast.add({ title: '匯出失敗', description: error.message, color: 'error' })
    return
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `filmnote-${username.value}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="mx-auto max-w-xl px-4 py-8 space-y-10">
    <h1 class="text-2xl font-bold tracking-tight">
      設定
    </h1>

    <section>
      <h2 class="font-semibold">
        使用者名稱
      </h2>
      <p class="mt-1 text-sm text-muted">
        個人頁網址是 /u/{{ username }}。改名之後舊網址仍會轉向過來。
      </p>
      <div class="mt-3 flex gap-2">
        <UInput v-model="newUsername" class="flex-1" />
        <UButton :loading="saving" :disabled="newUsername === username" @click="rename">
          改名
        </UButton>
      </div>
    </section>

    <section>
      <h2 class="font-semibold">
        票價公開
      </h2>
      <p class="mt-1 text-sm text-muted">
        預設不公開。開啟後，你「公開的紀錄」上的票價才會被別人看到；私密紀錄的票價永遠只有你看得到。
      </p>
      <USwitch v-model="showCost" class="mt-3" label="公開我的票價" @update:model-value="toggleShowCost" />
    </section>

    <section>
      <h2 class="font-semibold">
        匯出
      </h2>
      <p class="mt-1 text-sm text-muted">
        下載全部紀錄的 JSON，你的資料不被鎖在這個服務裡。
      </p>
      <UButton variant="soft" color="neutral" class="mt-3" icon="i-lucide-download" @click="exportData">
        匯出我的紀錄
      </UButton>
    </section>
  </div>
</template>
