/**
 * 前端的台北牆上時間入口（Nuxt 會自動匯入這裡具名轉出的函式）。本體在 `src/time/taipei.ts`：
 * `src/**` 不能 import `app/`（`tsconfig.pipeline.json` 的 `~` 指向 `src/`），反方向才兩邊都型別檢查得過。
 */
// ⚠️ 被 vitest 載入的 `app/utils/*` 要引用本體時走 `#pipeline/time/taipei`，不要走 `~/utils/taipei-time`：
// 測試端的 `~` 解析到 `src/`，會 TS2307（`typecheck:app` 卻是綠的）。
export {
  taipeiAgoText,
  taipeiCalendarDaysBetween,
  taipeiDateText,
  taipeiDateTimeText,
  taipeiToday,
  taipeiYearMonth,
} from '#pipeline/time/taipei'
