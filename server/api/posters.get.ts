import { z } from 'zod'

/**
 * 首頁海報牆的資料來源（`SCREENS §1`）。
 * ★ **海報一律由前端熱連結 `image.tmdb.org`**：只回路徑，不回完整網址、不 proxy、
 *   不轉存。這是合規硬約束不是效能考量——TMDB 訂閱買到的是存取 API 的權利，
 *   不是使用海報的權利（著作權屬片商）。
 */
// 取樣的 `home_poster_wall()` 是 SECURITY INVOKER ⇒ 沿用 film_public 的 RLS，
// 未審核作品的海報不會出現在首頁背景上。
//
// ⚠️ 用 `defineCachedEventHandler` 而不是 cache-control：routeRules 對 `/api` 底下一律
//    no-store，所以 HTTP 層的快取這裡拿不到；這支快取的是 handler 的計算結果。
//    這只有在「回應與觀看者無關」時才安全——匿名 client、不讀 session、cache key 只由
//    query 組成，三個條件都成立。**加入任何依賴登入狀態的東西之前，先把快取拿掉。**

const querySchema = z.object({
  /**
   * 一次要幾張。上限釘在 RPC 裡（200），這裡只把爛輸入正規化。
   * ★ 超出範圍**夾到邊界**不是退回預設：`.max(200).catch(60)` 會讓 `?limit=99999`
   *   得到 60——呼叫端要的是愈多愈好，卻拿到比預設還少的量而且沒有任何訊息。
   */
  limit: z.coerce.number().catch(60).transform(n =>
    Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 200) : 60),
  /**
   * 取樣種子。同一個 seed 給同一批 ⇒ SSR 與 hydration 一致、也才快取得起來。
   * 不給就用當前的快取視窗當 seed：牆每 5 分鐘換一批，同一視窗內所有人看到的一樣。
   */
  seed: z.string().trim().max(64).optional(),
})

const CACHE_SECONDS = 300

export default defineCachedEventHandler(async (event) => {
  const q = querySchema.parse(getQuery(event))
  const seed = q.seed ?? String(Math.floor(Date.now() / (CACHE_SECONDS * 1000)))

  const db = publicSupabase()
  const { data, error } = await db.rpc('home_poster_wall', {
    p_limit: q.limit,
    p_seed: seed,
  })

  if (error) {
    // 不要退回空陣列：首頁會安靜地沒有背景，而沒人知道是壞了還是片庫真的沒海報。
    throw createError({ statusCode: 500, statusMessage: `取海報失敗：${error.message}` })
  }

  const rows = (data ?? []) as { film_id: string, slug: string | null, poster_path: string }[]

  return {
    seed,
    count: rows.length,
    // ★ 給路徑（`/abc.jpg`）不是完整網址：尺寸由版面決定，固定在後端只會逼前端
    //   下載過大的圖。前端自己組 `https://image.tmdb.org/t/p/{size}{path}`。
    items: rows.map(r => ({ filmId: r.film_id, slug: r.slug, path: r.poster_path })),
  }
}, {
  maxAge: CACHE_SECONDS,
  // cache key 只含 query，不含任何身分（見檔頭的三個條件）。
  getKey: event => `posters:${getQuery(event).limit ?? 60}:${getQuery(event).seed ?? 'auto'}`,
  // 名稱只影響 Nitro storage 的分組，寫清楚方便除錯。
  name: 'home-posters',
})
