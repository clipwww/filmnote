<script setup lang="ts">
const supabase = useSupabaseClient()
const config = useRuntimeConfig()
const pending = ref(false)
const error = ref<string | null>(null)

useSeoMeta({ title: '登入' })

async function signIn() {
  pending.value = true
  error.value = null
  const { error: err } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: `${config.public.siteUrl}/confirm` },
  })
  if (err) {
    error.value = err.message
    pending.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-md px-4 py-24 text-center">
    <h1 class="text-2xl font-semibold">
      登入影記
    </h1>
    <p class="mt-3 text-muted">
      用 Google 帳號登入，不必記另一組密碼。
    </p>
    <UButton
      size="lg"
      class="mt-8"
      :loading="pending"
      icon="i-simple-icons-google"
      @click="signIn"
    >
      使用 Google 繼續
    </UButton>
    <UAlert v-if="error" color="error" variant="soft" class="mt-6" :description="error" />
  </div>
</template>
