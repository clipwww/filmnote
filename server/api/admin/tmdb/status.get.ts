import type { Database } from '~/types/database.types'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * TMDB 維護的**唯讀**現況。管理後台一進頁面就問它。
 *
 * ── 為什麼一定要有這一支 ───────────────────────────────────────────────────
 * David 的困擾不只是「不能手動跑」，而是**站上完全看不出 cron 有沒有在追上進度**。
 * cron 目前唯一的觀測面是 `console.log`，那要開 Vercel 的函式日誌才看得到。
 *
 * `TmdbRefreshReport.due` 是「view 中到期待刷新的**總**列數，不受 limit 影響」，
 * 零 schema 變更就拿得到——但它只在**跑完一輪之後**才會出現在報告裡。
 * 「按了才知道」正好把這個功能的用途弄反：管理者需要的是**先看到數字，再決定
 * 要不要按**。所以這一支存在。
 *
 * ── ★ 這是 GET，但授權跟兩支 POST 完全一樣 ─────────────────────────────────
 * 它讀的是 `tmdb_refresh_due`，而那個 view **只 grant 給 service_role**
 * （9999_grants.sql:85）——也就是說這一支非用 service role 不可，於是它跟兩支
 * POST 一樣需要自己守門：① 登入 → ② `is_staff()` → ③ 才 `serviceSupabase()`。
 *
 * 「GET 只是讀，不用那麼嚴」在這裡是錯的：它讀的是全站快照的統計，而且用的是
 * 一個 RLS 完全讓開的 client。
 *
 * ⚠️ 輸出永遠不可快取。`nuxt.config.ts` 的 routeRules 已對 `/api/**` 設
 *   `cache-control: no-store`，這裡不另外設，但別把這條路由搬出 `/api/**`。
 */
export default defineEventHandler(async (event) => {
  // ① + ②。★ 在任何 service_role 的東西出現之前。
  await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    // ⚠️ 使用者自己的 client。換成 service role 的話 `is_staff()` 回 **false**
    //    （auth.uid() 是 NULL），連 David 自己都會被擋——見 admin-auth.ts 的說明。
    isStaff: async () => (await serverSupabaseClient<Database>(event)).rpc('is_staff'),
  })

  // ③ 通過授權之後才拿 service role。
  const db = serviceSupabase()

  // ── 到期待刷新 ─────────────────────────────────────────────────────────
  // `head: true` ⇒ 只要 count，不把 2,400 列搬回來。
  const { count: due, error: dueError } = await db
    .from('tmdb_refresh_due')
    .select('film_id', { count: 'exact', head: true })

  if (dueError)
    throw createError({ statusCode: 500, statusMessage: `讀取 tmdb_refresh_due 失敗：${dueError.message}` })

  // ── 追蹤中的總列數 ─────────────────────────────────────────────────────
  // 只有 due 沒有分母的話，「0」看起來跟「壞掉了」一樣。2,480 分之 0 才讀得懂。
  const { count: tracked, error: trackedError } = await db
    .from('film_tmdb_snapshot')
    .select('film_id', { count: 'exact', head: true })

  if (trackedError)
    throw createError({ statusCode: 500, statusMessage: `讀取 film_tmdb_snapshot 失敗：${trackedError.message}` })

  // ── 到期待清除 ─────────────────────────────────────────────────────────
  /**
   * ★ 條件逐字對齊 `purge_expired_tmdb_cache()` 的 WHERE（0005）：
   *     expires_at <= now()
   *     and (payload is not null or poster_path is not null or overview is not null)
   *   兩邊分岔的話，畫面上的數字會跟按下去的結果對不上，而那種不一致最難查。
   *
   * ⚠️ `now()` 這裡取的是 Node 的時鐘、RPC 取的是資料庫的時鐘，兩者會差幾百
   *   毫秒。對一個「還有幾列」的顯示值無所謂，但別把它當成精確的預測值。
   *
   * ★ 這一段**失敗不會讓整支端點 500**，而是回 `purgeableError` 讓畫面把錯誤
   *   顯示出來。理由：待刷新才是這一頁的主要資訊，不該被次要的一個統計拖垮。
   *   但也**不吞掉**錯誤——靜靜地少一個數字，比壞掉更難發現。
   */
  const nowIso = new Date().toISOString()
  const { count: purgeable, error: purgeError } = await db
    .from('film_tmdb_snapshot')
    .select('film_id', { count: 'exact', head: true })
    .lte('expires_at', nowIso)
    .or('payload.not.is.null,poster_path.not.is.null,overview.not.is.null')

  // ── 最後一次有快照被更新的時間 ─────────────────────────────────────────
  /**
   * ⚠️ **這不等於「cron 上次執行的時間」。** 一輪 cron 若跑到 `due = 0`，它什麼
   *   都不會寫，這個時間就不會動。所以它只能回答「最近一次真的有東西被刷新是
   *   什麼時候」——UI 上的標籤必須照這個意思寫，不可以寫成「上次排程執行」。
   *   真正的「每一輪有沒有跑、跑出什麼」需要一張執行歷史表，那是另一項需求
   *   （見回報的 open_for_david）。
   */
  // ⚠️ 錯誤**不能吞**——理由跟上面 purgeable 那一段一字不差，而這一段原本吞了
  //   （對抗式覆核 2026-09-08 抓到）。吞掉的話 `lastFetchedAt` 會是 null，畫面顯示
  //   「—」，而那跟「這張表從來沒有任何一列被 fetch 過」在畫面上**一模一樣**。
  //   管理者會據此判斷「cron 從沒跑過」並開始追一個不存在的問題。
  //   降級要看得見。
  const { data: latest, error: latestError } = await db
    .from('film_tmdb_snapshot')
    .select('fetched_at')
    .not('fetched_at', 'is', null)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    due: due ?? 0,
    tracked: tracked ?? 0,
    purgeable: purgeError ? null : (purgeable ?? 0),
    purgeableError: purgeError ? purgeError.message : null,
    lastFetchedAt: latestError ? null : (latest?.fetched_at ?? null),
    lastFetchedError: latestError ? latestError.message : null,
    checkedAt: nowIso,
  }
})
