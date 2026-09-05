<script setup lang="ts">
// v2 的 useSupabaseUser() 回傳 JWT claims 不是 User 物件：
// 用 user.sub，沒有 user.id（踩雷 #13）。
const user = useSupabaseUser()
const supabase = useSupabaseClient()

async function signOut() {
  await supabase.auth.signOut()
  await navigateTo('/login')
}
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-12">
    <h1 class="text-2xl font-semibold">
      我的紀錄
    </h1>
    <p class="mt-2 text-muted">
      已登入：{{ user?.email ?? user?.sub ?? '(未取得)' }}
    </p>
    <pre class="mt-6 overflow-x-auto rounded bg-elevated p-4 text-xs">{{ { sub: user?.sub, email: user?.email } }}</pre>
    <UButton variant="soft" color="neutral" class="mt-6" @click="signOut">
      登出
    </UButton>
  </div>
</template>
