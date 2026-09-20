import type { Database } from '~/types/database.types'
import { serverSupabaseClient, serverSupabaseUser } from '#supabase/server'

/**
 * TMDB 維護的**唯讀**現況（管理後台一進頁面就問它）。存在的理由是「先看到數字再決定
 * 要不要按」：`due` 本來只在跑完一輪之後才出現在報告裡，而 cron 唯一的觀測面是
 * `console.log`，要開 Vercel 函式日誌才看得到。
 */
// ★ 這是 GET，授權卻跟兩支 POST 一樣（① 登入 → ② is_staff() → ③ 才 serviceSupabase）：
//   它讀的 `tmdb_refresh_due` 只 grant 給 service_role（9999_grants.sql:85）⇒ 非用
//   service role 不可。「GET 只是讀不用那麼嚴」在這裡是錯的。
// ⚠️ 輸出永遠不可快取（routeRules 對 `/api` 底下設 no-store，別把這條路由搬出去）。
export default defineEventHandler(async (event) => {
  // ① + ②。★ 在任何 service_role 的東西出現之前。
  await assertStaffFrom({
    user: () => serverSupabaseUser(event),
    // ⚠️ 必須是使用者自己的 client；換成 service role 連 David 都會被擋（見 admin-auth.ts）。
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
  // ★ 條件必須逐字對齊 `purge_expired_tmdb_cache()` 的 WHERE（0005）：兩邊分岔時畫面
  //   數字會跟按下去的結果對不上，而那種不一致最難查。⚠️ 這裡的 now() 是 Node 的時鐘、
  //   RPC 是資料庫的，差幾百毫秒——當顯示值可以，別當精確預測。
  // ★ 這一段失敗不讓整支 500，而是回 `purgeableError` 讓畫面顯示；但也不吞掉——
  //   靜靜地少一個數字比壞掉更難發現。
  const nowIso = new Date().toISOString()
  const { count: purgeable, error: purgeError } = await db
    .from('film_tmdb_snapshot')
    .select('film_id', { count: 'exact', head: true })
    .lte('expires_at', nowIso)
    .or('payload.not.is.null,poster_path.not.is.null,overview.not.is.null')

  // ── 最後一次有快照被更新的時間 ─────────────────────────────────────────
  // ⚠️ 這**不等於「cron 上次執行的時間」**：跑到 due = 0 的那一輪什麼都不會寫，這個
  //   時間就不會動。UI 標籤只能寫「最近一次真的有東西被刷新」。
  // ⚠️ 錯誤不能吞（2026-09-08 對抗式覆核抓到這裡原本吞了）：吞掉的話 lastFetchedAt 是
  //   null、畫面顯示「—」，跟「這張表從來沒有一列被 fetch 過」**一模一樣**，管理者會
  //   據此判斷「cron 從沒跑過」並開始追一個不存在的問題。降級要看得見。
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
