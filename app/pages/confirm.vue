<script setup lang="ts">
// OAuth callback。@nuxtjs/supabase 會自行對此路徑加 { ssr: false }，
// 不要在 routeRules 再寫一次（踩雷 #14）。
const user = useSupabaseUser()

watchEffect(() => {
  if (user.value)
    navigateTo('/app', { replace: true })
})
</script>

<template>
  <div class="mx-auto max-w-md px-4 py-24 text-center text-muted">
    登入中…
  </div>
</template>
