<script setup lang="ts">
import { useStaffGate } from './-admin-shared'

/**
 * 「你不是 staff」這件事的畫面。
 *
 * ⚠️ **這不是安全機制。** 真正的門在資料庫：`film_read` / `takedown_staff` /
 * `report_read` 那幾條 policy 的 `is_staff()` 分支，以及 `approve_film()`、
 * `merge_films()`、`admin_takedown()` 進門先問的那一句。把這個元件整個刪掉，
 * 非 staff 一樣什麼都拿不到——只是畫面會變成「沒有待審核的作品」，
 * 而那句話對非 staff 是**謊話**。
 *
 * 所以這裡問一次 `is_staff()`，只為了讓錯誤訊息是真的。
 * 「能打開這一頁」不等於「是 staff」，前端不做這個假設。
 */
const { isStaff, checking, error } = useStaffGate()
</script>

<template>
  <div v-if="checking" class="mx-auto max-w-5xl px-4 py-8">
    <USkeleton class="h-8 w-40" />
    <USkeleton class="mt-6 h-96 w-full rounded-sm" />
  </div>

  <div v-else-if="!isStaff" class="mx-auto max-w-xl px-4 py-16">
    <h1 class="text-2xl font-bold tracking-tight">
      這一區只有審核人員能進來
    </h1>
    <p class="mt-3 text-muted">
      你的帳號沒有審核權限。就算硬進來也看不到任何資料——每一列都由資料庫的
      權限規則擋著，不是靠這一頁藏起來。
    </p>
    <p v-if="error" class="mt-3 text-sm text-muted">
      （查詢權限時發生錯誤：{{ error.message }}）
    </p>
    <UButton to="/app" class="mt-6" variant="soft" color="neutral">
      回到我的紀錄
    </UButton>
  </div>

  <slot v-else />
</template>
