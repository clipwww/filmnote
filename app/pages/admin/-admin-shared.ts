import type { Database } from '~/types/database.types'

/**
 * `/admin/**` 三個佇列共用的東西。
 *
 * ★ 為什麼放在 `app/pages/admin/` 底下而不是 `app/composables/`：
 *   這一輪 `app/composables/**`、`app/components/**`、`app/utils/**` 全部屬於
 *   另一個前端 session，兩邊同時改同一個檔案會互相覆蓋。`admin` 專用的東西
 *   放在自己的目錄裡，日後真的有第二個呼叫端再搬出去。
 *
 * ★ 檔名的 `-` 前綴是 Nuxt 的 `ignorePrefix`（預設就是 `-`）：`pages/` 底下
 *   的 `.ts` 一樣會被掃成路由，加了前綴才不會冒出一條 `/admin/-admin-shared`。
 *   顯式 `import` 不受它影響（那走 Vite 的解析，不看 nuxt 的 ignore 清單）。
 */

/**
 * 頁面層的 staff 二次確認。
 *
 * ⚠️ **這不是授權，授權在資料庫。** `film_read` / `takedown_staff` 那些 policy
 * 才是真的門，而 `serverSupabaseServiceRole` 完全不做身分檢查（踩雷 #26）。
 * 這裡問一次 `is_staff()` 的理由只有一個：**不要讓非 staff 看到一個空的佇列，
 * 然後以為系統壞了。** RLS 會把每一列都濾掉，畫面上是「沒有待審核的作品」——
 * 那句話對非 staff 是謊話。所以先問，再決定要畫佇列還是畫「你沒有權限」。
 *
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

/** `2026-09-04T…` → `2 天前`。給佇列列表用，精確到天就夠了。 */
export function agoText(iso: string | null | undefined): string {
  if (!iso)
    return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then))
    return ''
  const days = Math.floor((Date.now() - then) / 86_400_000)
  if (days <= 0)
    return '今天'
  if (days === 1)
    return '昨天'
  return `${days} 天前`
}

/**
 * 距離某個時間點還剩幾個**日曆天**（過期回負數）。
 *
 * ⚠️ **這不是工作日。** `SCREENS §14` 與視覺稿要的是「剩 N 個工作日」，而
 * 工作日只能由資料庫算——`counter_notice_deadlines` trigger 用
 * `business_days_after()` 算出 `litigation_deadline_at` / `restore_deadline_at`，
 * 前端再自己算一次就是兩個會分岔的答案，而分岔的那個會出現在法定期限上。
 *
 * 資料庫目前只給得出「期限是哪一天」，沒有「還剩幾個工作日」（缺一支
 * `business_days_between`）。所以畫面上的權威值是**期限日期本身**，這個
 * 日曆天數只用來決定緊急程度的門檻與排序，而且標籤上明寫「天」不寫「工作日」。
 */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso)
    return null
  const target = new Date(iso).getTime()
  if (Number.isNaN(target))
    return null
  return Math.ceil((target - Date.now()) / 86_400_000)
}

/** `2026-09-22T16:00:00Z` → `2026-09-22`（台北牆上日期）。 */
export function dayText(iso: string | null | undefined): string {
  if (!iso)
    return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return ''
  // 全站的日期語意都是台北牆上時間，這裡跟著走，不用瀏覽器本地時區。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/**
 * PostgREST 的錯誤翻成人看得懂的話。
 *
 * `42501` 是 RPC 裡 `is_staff()` 擋下的，`PGRST301`／401 是沒登入。
 * 其餘原樣顯示——猜錯的訊息比原始訊息更難查。
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
