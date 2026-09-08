<script setup lang="ts">
import StaffGate from './-StaffGate.vue'
import TmdbMaintenance from './-TmdbMaintenance.vue'

/**
 * `/admin` —— 管理後台的首頁。
 *
 * ── ⚠️ 這一頁的行為變了，變更本身要說清楚 ──────────────────────────────────
 * 在這一輪之前，`/admin` **只是一個轉向**（`navigateTo('/admin/films')`），理由是
 * 「三個佇列裡唯一每次打開都可能有東西的那一個」。
 *
 * 現在它是一張真的頁面，因為 TMDB 維護沒有別的地方可以放：
 *   · `-AdminShell.vue` 的分頁列寫死三個佇列，而那個檔案這一輪不歸我改
 *   · `app/pages/admin/` 底下開新路由（例如 `tmdb.vue`）也不在我的授權範圍內
 * ⇒ 授權清單裡點名了 `index.vue`，就是要把它變成落腳處。
 *
 * 代價是 David 最常走的那條路（`AppNav` →「管理後台」→ 作品審核）多了一次點擊。
 * 補償是下面那三顆按鈕就是原本的目的地，而且視覺語彙跟 `AdminShell` 的分頁列
 * 一模一樣——點下去之後的世界完全沒變。
 *
 * ⚠️ 進了任何一個佇列之後，`AdminShell` 的分頁列**沒有回到 `/admin` 的入口**
 *   （那個檔案這一輪不歸我改）。回來的路是 `AppNav` 的「管理後台」。
 *   要不要在 `AdminShell` 補第四格，是 David 的決定，已寫進交接。
 *
 * ── 為什麼不是轉向到 `/admin/tmdb` ────────────────────────────────────────
 * 同一個理由：那需要一個新的路由檔。而且真要說的話，「後台首頁＝看得到全站
 * 維護現況 + 通往各佇列」比「後台首頁＝立刻把你丟到某個佇列」更像首頁。
 *
 * ★ 授權跟其他三頁一樣由 `StaffGate` 包著，但**那不是安全機制**（見它的檔頭）。
 *   真正的門在資料庫，而這一頁底下的 `/api/admin/tmdb/**` 三支端點各自守自己的門：
 *   ① 登入 → ② 使用者自己的 client 問 `is_staff()` → ③ 才動 service role。
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
