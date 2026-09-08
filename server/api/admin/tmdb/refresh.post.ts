import type { Database } from '~/types/database.types'
import { z } from 'zod'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * TMDB 快照刷新的**手動觸發**（管理後台）。
 *
 * ── 這支不是要取代 cron ────────────────────────────────────────────────────
 * `vercel.json` 的兩條排程原封不動，這支是**附加**的。它存在的理由跟「cron 能
 * 不能用」無關（cron 在所有方案都能用，Hobby 每專案 100 條、最短一天一次）：
 *   1. cron 目前唯一的觀測面是 `console.log`——站上看不出它昨天有沒有跑
 *   2. 失敗了沒有重試入口，要重跑只能拿 CRON_SECRET 去 curl
 *   3. 剛匯入一批作品時要等到隔天 03:00（而且會浮動到 03:59）
 *
 * ── ★ 為什麼是 POST，而 cron 那支必須是 GET ────────────────────────────────
 * 「必須是 GET」那條限制只適用於 **Vercel Cron 的觸發方式**（它一律發 GET，設成
 * POST 會靜默失敗）。這一支是瀏覽器發起的**變更操作**，用 POST 才對。不要為了
 * 跟 cron 長得一樣而改成 GET——那會讓一個會改資料庫的端點可以被連結、被預抓。
 *
 * ── ★ 授權：三步，順序不可調換 ─────────────────────────────────────────────
 *   ① `serverSupabaseUser(event)`：沒登入就 401
 *   ② 用**使用者自己的** client 問 `is_staff()`：不是 true 就 403
 *   ③ 通過②之後，`runTmdbRefresh()` 內部才會去拿 `serviceSupabase()`
 * 決策本體與理由寫在 `server/utils/admin-auth.ts`，這裡只負責接線。
 *
 * ⚠️ **不 import `assertCronCaller`，`CRON_SECRET` 不出現在這條路徑上的任何地方**
 *   （不進 payload、不進 runtimeConfig.public、不進錯誤訊息）。也不用「後端拿
 *   secret 去 fetch 自己的 /api/cron/*」那種代理作法：多一跳、多一個逾時，而且
 *   在 Vercel 上自己打自己是另一次函式呼叫。直接呼叫 `runTmdbRefresh()`。
 *
 * ⚠️ 踩雷 #26：service role 在這裡**只用來執行工作，不用來做授權判斷**。
 *   授權已經在 ② 由資料庫決定完了。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 時間預算——夾子在 server/utils/admin-tmdb-options.ts，這裡只記「為什麼不敢調大」
// ─────────────────────────────────────────────────────────────────────────────
/**
 * ★ `server/utils/tmdb-refresh.ts` 的註解寫「Hobby 方案曾是 10 秒」，那是**過去式
 *   而且沒有出處**。查證後的現況（Vercel 官方文件
 *   https://vercel.com/docs/functions/limitations#max-duration ，該頁
 *   last_updated 2026-08-24，查證日期 2026-09-07）：**啟用 fluid compute 時**
 *   Node.js runtime 的 Hobby 預設與上限都是 300 秒。
 *
 * ⚠️ **但「本專案有沒有啟用 fluid compute」在 repo 裡查不到**（那是 Vercel
 *   Settings → Functions → Default Max Duration，不在版控裡），而沒啟用的舊專案
 *   預設低得多。⇒ 把 300 秒當成本專案的事實去推導上限，就是這個 repo 反覆記載的
 *   「推論寫成事實」。對抗式覆核（2026-09-08）點名了這一條。
 *
 * ⇒ 因此夾子取的是**在最壞假設下也活得下來**的值（預設 8 秒 / 上限 25 秒），
 *   而不是逼近 300 秒。被砍的症狀很難看：回來的是 Vercel 的錯誤頁而不是我們的
 *   JSON，前端取不到 `data.statusMessage`，畫面只剩一句沒頭沒尾的狀態碼，
 *   而資料庫那側留下一批 `attempts` 沒加、`next_refresh_at` 沒推的列。
 *
 * ⚠️ 還有一件跟直覺不同的事，調整預算前要知道：**預算只決定「還要不要再取新
 *   工作」，不會砍掉已經在飛的請求。** 最壞情況下一個 in-flight 請求還要跑完
 *   `TmdbClient` 的整套退避（maxRetries=5，429 的退避是 2+4+8+16+32 ＝ **62 秒**
 *   純睡眠）。也就是 `elapsedMs` 最壞可以是 budget + 62 秒有餘。
 *
 * ⇒ 要調高上限之前，先去確認 Default Max Duration，不要只因為「文件寫 300 秒」就改。
 *
 * 這不影響可用性：這支端點的設計就是「按一次推進一批，按不完再按」——
 * `runTmdbRefresh` 以時間收尾而不是以筆數收尾，沒做完的列 `next_refresh_at`
 * 仍 ≤ now()，下一次按下去會再被 view 給出來。
 */

const bodySchema = z.object({
  limit: z.coerce.number().int().optional(),
  budgetMs: z.coerce.number().int().optional(),
})

export default defineEventHandler(async (event) => {
  // ① + ②。★ 這兩行在任何 service_role 的東西出現之前。
  const staff = await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    // ⚠️ `serverSupabaseClient` ＝ 帶請求裡那個使用者 JWT 的 client。
    //    ★ 換成 service role 的後果跟直覺相反：`is_staff()` 查的是
    //      `profile_private.id = auth.uid()`，而 service role 的 auth.uid() 是
    //      NULL ⇒ 回 false ⇒ **連 David 自己都會被擋**（2026-09-07 實測）。
    //      真正會開門的是「為了修那個 403 而把這一步拿掉或改成 is_service_context()」。
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  const parsed = bodySchema.safeParse((await readBody(event).catch(() => ({}))) ?? {})
  if (!parsed.success)
    throw createError({ statusCode: 422, statusMessage: 'limit / budgetMs 必須是整數' })

  // 先走共用的解析（它負責 NaN、負數、上下限的收斂），再夾一次 Vercel 那條線。
  // 兩層不是重複：共用那一支的上限是 30 分鐘，對排程合理，對「有人在瀏覽器前面
  // 等，而且函式隨時可能被砍」完全不合理。
  //
  // ★ 夾子本體在 `server/utils/admin-tmdb-options.ts`，**不寫在這個檔裡**：
  //   這個檔 import 了 `#supabase/server`，vitest 載不進來 ⇒ 寫在這裡的邏輯
  //   一條斷言都守不到（對抗式覆核 2026-09-08 實測：把夾子刪掉，14 條全綠）。
  const options = clampManualOptions(parsed.data)

  // ③ 到這裡才動 service role——`runTmdbRefresh()` 內部呼叫 `serviceSupabase()`。
  const report = await runTmdbRefresh(options)

  // 與 cron 那支刻意重複：出事時 Vercel 的函式日誌是最先看得到的地方，
  // 而查資料庫需要另一套權限。多記一個 `by`，因為這一次是人按的。
  // eslint-disable-next-line no-console -- 管理動作的稽核日誌
  console.log('[admin/tmdb/refresh]', JSON.stringify({ by: staff.id, options, ...report }))

  // ★ 把實際生效的 options 一起回去。使用者送 90 秒被夾成 60 秒時，畫面上要
  //   看得到「實際用了 60 秒」，而不是靜默地跑了另一個數字。
  return { ...report, options }
})
