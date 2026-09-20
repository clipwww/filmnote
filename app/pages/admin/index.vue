<script setup lang="ts">
import StaffGate from './-StaffGate.vue'
import TmdbMaintenance from './-TmdbMaintenance.vue'

/**
 * `/admin` —— 管理後台首頁。⚠️ **這一頁的行為變了**：在這一輪之前它只是一個轉向到
 * `/admin/films`。現在是一張真的頁面，因為 TMDB 維護沒有別的地方可以放（`-AdminShell.vue`
 * 的分頁列寫死三個佇列、開新路由也不在授權範圍內，而授權清單點名了 `index.vue`）。
 */
/*
 * 代價是最常走的那條路多了一次點擊；補償是那三顆按鈕就是原本的目的地，視覺語彙跟
 * `AdminShell` 的分頁列一模一樣。⚠️ 進了任何佇列之後，`AdminShell` 的分頁列**沒有回到
 * `/admin` 的入口**，回來的路是 `AppNav` 的「管理後台」；要不要補第四格是 David 的決定。
 */
/*
 * ★ 授權跟其他三頁一樣由 `StaffGate` 包著，但**那不是安全機制**（見它的檔頭）。真正的門在
 * 資料庫，而這一頁底下的三支端點各自守自己的門：① 登入 → ② 使用者自己的 client 問
 * `is_staff()` → ③ 才動 service role。
 */
definePageMeta({ layout: 'default' })
useSeoMeta({ title: '管理後台', robots: 'noindex, nofollow' })

/** 與 `-AdminShell.vue` 的 `QUEUES` 一致。那個檔案這一輪不歸我改，所以先各寫一份。 */
const QUEUES = [
  { to: '/admin/films', label: '作品審核', icon: 'i-lucide-clapperboard' },
  { to: '/admin/takedowns', label: 'DMCA 承辦', icon: 'i-lucide-scale' },
  { to: '/admin/reports', label: '資料回報', icon: 'i-lucide-message-square-warning' },
] as const
</script>

<template>
  <StaffGate>
    <div class="mx-auto max-w-5xl px-4 py-8">
      <h1 class="text-2xl font-bold tracking-tight">
        管理後台
      </h1>

      <!-- 三個佇列的入口。橫向捲的是這一條，不是頁面（§10 品質底線）。 -->
      <nav class="mt-4 -mx-4 overflow-x-auto px-4">
        <div class="flex w-max gap-1.5">
          <UButton
            v-for="q in QUEUES"
            :key="q.to"
            :to="q.to"
            :icon="q.icon"
            size="sm"
            variant="soft"
            color="neutral"
          >
            {{ q.label }}
          </UButton>
        </div>
      </nav>

      <div class="mt-6">
        <TmdbMaintenance />
      </div>
    </div>
  </StaffGate>
</template>
