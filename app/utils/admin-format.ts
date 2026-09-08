/**
 * 管理後台的兩支純顯示函式。**放在 `utils/` 而不是 `pages/admin/-admin-shared.ts`
 * 的唯一理由：它們要能被 vitest 載入。**
 *
 * `-admin-shared.ts` 吃 Nuxt 的 auto-import（`useSupabaseClient` / `useAsyncData`
 * / `computed`）也用了 `~/types/…` 別名，而 `tsconfig.pipeline.json` 的程式
 * （`include` 含 `tests`）兩者都不認識 ⇒ 測試檔一 import 它，
 * `pnpm typecheck:pipeline` 就噴 `TS2304` 與 `TS2307`，**而 `typecheck:app` 是綠的**。
 *
 * ⇒ 既有慣例：被測試 import 的模組必須自足。純函式搬進 `utils/`，不要放寬 tsconfig。
 */

/**
 * `2026-09-05T18:29:18.9+00:00` → `2026/09/05 18:29`（**台北牆上時間**）。
 *
 * ⚠️ 與 `dayText()` 的分工：那一支只給日期（佇列列表上精確到天就夠了），
 * 這一支用在「最後一次刷新是什麼時候」這種需要對帳的地方——差在小時的事件
 * 只印日期，會讓「今天凌晨跑過」跟「今天下午跑過」看起來一模一樣。
 *
 * ⚠️ 不用 `app/utils/format-datetime.ts` 的 `watchedAtText()`：那一支吃的是
 * `date` + `time` 兩個欄位（`watched_on` 是資料庫的 date 型別，沒有時區），
 * 這裡吃的是 `timestamptz` 的 ISO 字串，語意不同，硬套會拿到偏一個時區的答案。
 *
 * 格式不合時回空字串，不做「盡量拼湊」——拼湊出來的時間只會掩蓋資料問題。
 */
export function stampText(iso: string | null | undefined): string {
  if (!iso)
    return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  // ★ 分隔符在字串裡就組好。Vue 的 whitespace 預設是 'condense'，在 template
  //   裡用相鄰插值加空白會被摺掉（`app/utils/format-datetime.ts` 檔頭同一個坑）。
  return `${get('year')}/${get('month')}/${get('day')} ${get('hour')}:${get('minute')}`
}

/**
 * 我們自己的 `/api/**` 端點丟回來的錯誤，翻成人看得懂的話。
 *
 * `createError({ statusMessage })` 經過 `$fetch` 之後會落在 `data.statusMessage`，
 * 而不是 `message`（`message` 那裡是 `[POST] "/api/…": 403 Forbidden` 這種東西）。
 * 順序刻意是 data → 頂層 → message：最具體的在前面。
 *
 * ⚠️ 與 `pgErrorText()` 不同：那一支收的是 PostgREST 直接回的錯（前端自己查表時），
 * 這一支收的是 `$fetch` 包過的 `FetchError`。兩者的欄位長得完全不一樣。
 *
 * ⚠️ `app/pages/admin/films.vue` 裡有一份同樣邏輯的區域 `errText()`。我這一輪沒有
 * 授權改那個檔，所以沒有把它換過來——回報裡已註記，日後合併時刪掉那一份即可。
 */
export function apiErrorText(e: unknown): string {
  const err = e as { statusMessage?: string, data?: { statusMessage?: string }, message?: string }
  return err?.data?.statusMessage ?? err?.statusMessage ?? err?.message ?? '未知錯誤'
}
