import { z } from 'zod'

/**
 * 首頁海報牆的資料來源（`SCREENS §1`）。
 *
 * ★ **海報一律由前端熱連結 `image.tmdb.org`。** 這支只回**路徑**，
 *   不回完整網址、不做 proxy、不轉存、不快取圖片到我們的網域。
 *   那是合規硬約束不是效能考量：TMDB 的訂閱買到的是「合法存取 API 的權利」，
 *   不是「合法使用海報的權利」——海報著作權屬片商。
 *   任何「幫使用者代理一下比較快」的改動都會踩破這一條。
 *
 * ★ 只回 `film_public`（已核准且公開）。取樣在 `home_poster_wall()` 裡，
 *   它是 SECURITY INVOKER ⇒ 沿用 film_public 的 RLS，未審核作品的海報
 *   不會出現在首頁背景上。
 *
 * ── 為什麼用 defineCachedEventHandler 而不是 cache-control ───────────────
 * `nuxt.config.ts` 的 routeRules 對 `/api/**` 一律 `cache-control: no-store`
 * （那是對的：多數 API 回應與觀看者有關）。所以 HTTP 層的快取這裡拿不到。
 *
 * `defineCachedEventHandler` 快取的是**這支 handler 的計算結果**（存在 Nitro
 * 自己的 storage 裡），與回應標頭無關 ⇒ 首頁每 300 秒重新生成一次時，
 * 這支不會每次都打 DB。
 *
 * ⚠️ 這個做法只有在「回應與觀看者無關」時才安全，否則會把 A 的資料發給 B。
 *    這支用的是匿名 client（`publicSupabase()`）、不讀任何 session、
 *    cache key 只由 query 組成——三個條件都成立才可以這樣用。
 *    **在這支加入任何依賴登入狀態的東西之前，先把快取拿掉。**
 */

const querySchema = z.object({
  /** 一次要幾張。上限釘在 RPC 裡（200），這裡只是把爛輸入正規化。 */
  // ★ 超出範圍要**夾到邊界**，不是退回預設值。`.max(200).catch(60)` 會讓
  //   `?limit=99999` 得到 60——呼叫端要的是「愈多愈好」，卻拿到比預設還少的量，
  //   而且沒有任何訊息。夾到 200 才是它想要的。
  limit: z.coerce.number().catch(60).transform(n =>
    Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 200) : 60),
  /**
   * 取樣種子。同一個 seed 給同一批 ⇒ SSR 與 hydration 一致、也才快取得起來。
   * 不給的話用**當前的快取視窗**當 seed：牆每 5 分鐘換一批，而同一個視窗內
   * 所有人看到的都一樣。
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
    // 不要退回空陣列：首頁會安靜地變成沒有背景，而沒有人會知道是壞了還是
    // 片庫真的沒有海報。
    throw createError({ statusCode: 500, statusMessage: `取海報失敗：${error.message}` })
  }

  const rows = (data ?? []) as { film_id: string, slug: string | null, poster_path: string }[]

  return {
    seed,
    count: rows.length,
    /**
     * ★ 給的是 TMDB 的路徑（`/abc.jpg`），不是完整網址。
     *   前端自己組 `https://image.tmdb.org/t/p/{size}{path}` ——尺寸由版面決定，
     *   把它固定在後端只會逼前端下載過大的圖。
     */
    items: rows.map(r => ({ filmId: r.film_id, slug: r.slug, path: r.poster_path })),
  }
}, {
  maxAge: CACHE_SECONDS,
  // cache key 只含 query，不含任何身分（見檔頭的三個條件）。
  getKey: event => `posters:${getQuery(event).limit ?? 60}:${getQuery(event).seed ?? 'auto'}`,
  // 名稱只影響 Nitro storage 的分組，寫清楚方便除錯。
  name: 'home-posters',
})
