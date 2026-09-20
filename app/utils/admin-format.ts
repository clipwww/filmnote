/**
 * 管理後台的兩支純顯示函式。**放在 `utils/` 而不是 `pages/admin/-admin-shared.ts` 的唯一理由：
 * 它們要能被 vitest 載入。** 那個檔吃 auto-import 也用了 `~/types/…` 別名，而
 * `tsconfig.pipeline.json` 兩者都不認識 ⇒ 測試一 import 就噴 `TS2304` 與 `TS2307`，
 * **而 `typecheck:app` 是綠的**。⇒ 被測試 import 的模組必須自足，不要放寬 tsconfig。
 */

/**
 * `…T18:29:18.9+00:00` → `2026/09/05 18:29`（**台北牆上時間**）。與 `dayText()` 的分工：那支
 * 只給日期（佇列列表精確到天就夠），這支用在「最後一次刷新是什麼時候」這種需要對帳的地方
 * ——差在小時的事件只印日期，會讓「今天凌晨跑過」跟「今天下午跑過」看起來一模一樣。
 */
/*
 * ⚠️ 不用 `format-datetime.ts` 的 `watchedAtText()`：那支吃的是 `date` + `time` 兩個欄位
 * （沒有時區），這裡吃的是 `timestamptz` 的 ISO 字串，硬套會拿到偏一個時區的答案。
 * 格式不合時回空字串，不做「盡量拼湊」。
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
 * 我們自己的 `/api/**` 端點丟回來的錯誤，翻成人看得懂的話。`createError({ statusMessage })`
 * 經過 `$fetch` 之後會落在 `data.statusMessage` 而不是 `message`（那裡是
 * `[POST] "/api/…": 403 Forbidden`）。順序刻意是 data → 頂層 → message：最具體的在前面。
 */
/*
 * ⚠️ 與 `pgErrorText()` 不同：那支收的是 PostgREST 直接回的錯，這支收的是 `$fetch` 包過的
 * `FetchError`，兩者的欄位長得完全不一樣。
 * ⚠️ `admin/films.vue` 裡有一份同樣邏輯的區域 `errText()`（那一輪沒有授權改那個檔），
 * 日後合併時刪掉那一份即可。
 */
export function apiErrorText(e: unknown): string {
  const err = e as { statusMessage?: string, data?: { statusMessage?: string }, message?: string }
  return err?.data?.statusMessage ?? err?.statusMessage ?? err?.message ?? '未知錯誤'
}
