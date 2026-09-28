import type { Database } from '~/types/database.types'

/**
 * `/admin/**` 三個佇列共用的東西。放在 `pages/admin/` 底下而不是 `composables/`：那一輪
 * 共用層屬於另一個 session，兩邊同時改同一個檔會互相覆蓋；日後真的有第二個呼叫端再搬出去。
 */
/*
 * ★ 檔名的 `-` 前綴是 Nuxt 的 `ignorePrefix`：`pages/` 底下的 `.ts` 一樣會被掃成路由，
 * 加了前綴才不會冒出一條 `/admin/-admin-shared`。顯式 `import` 不受它影響（那走 Vite 的解析）。
 */

/**
 * 頁面層的 staff 二次確認。⚠️ **這不是授權，授權在資料庫**（`film_read`／`takedown_staff`
 * 那些 policy 才是門，而 `serverSupabaseServiceRole` 完全不做身分檢查，踩雷 #26）。
 */
/*
 * 問一次 `is_staff()` 的理由只有一個：**不要讓非 staff 看到一個空的佇列然後以為系統壞了**。
 * RLS 會把每一列都濾掉，畫面上是「沒有待審核的作品」——那句話對非 staff 是謊話。
 * 換句話說：拿掉這段程式，安全性不變，只是錯誤訊息會變成假的。
 */
export function useStaffGate() {
  const supabase = useSupabaseClient<Database>()

  const { data, status, error } = useAsyncData('admin-is-staff', async () => {
    const { data, error } = await supabase.rpc('is_staff')
    if (error)
      throw error
    return data === true
  }, {
    // 這幾頁是 SPA 語意（`SCREENS §14`）。伺服器端不預先算，避免 hydration 落差。
    server: false,
  })

  return {
    isStaff: computed(() => data.value === true),
    /** 還在問的時候兩種畫面都不畫——閃一下「你沒有權限」比多等 200ms 糟。 */
    checking: computed(() => status.value === 'idle' || status.value === 'pending'),
    error,
  }
}

// `agoText`／`dayText` 已搬到 `~/utils/admin-format`（台北日曆天、vitest 測得到）。原本在這裡的
// `daysUntil()`（日曆天剩餘天數）零呼叫端已刪：期限剩幾個工作日由 `takedowns.vue` 問 DB 的
// `business_days_between()`，前端自己算日曆天就是第二份定義（`adminui.md` §3 第 3 點）。

/**
 * PostgREST 的錯誤翻成人看得懂的話。`42501` 是 RPC 裡 `is_staff()` 擋下的、
 * `PGRST301`／401 是沒登入。其餘原樣顯示——猜錯的訊息比原始訊息更難查。
 */
export function pgErrorText(e: { code?: string, message?: string } | null | undefined): string {
  if (!e)
    return ''
  if (e.code === '42501')
    return '需要審核權限（資料庫回 42501）'
  return e.message ?? '未知錯誤'
}

/**
 * 三個佇列共用的欄位對照，給並排比對用。
 * `label` 是給人看的，`get` 從一列 film 取值並轉成字串（空值一律回空字串，
 * 由呼叫端決定要不要畫「—」）。
 */
export interface FieldSpec<T> {
  label: string
  get: (row: T) => string
}
