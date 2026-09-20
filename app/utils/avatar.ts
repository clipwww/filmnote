/**
 * 頭像網址的純函式。**放在這裡而不是 `composables/useMyAvatar.ts` 的唯一理由：它要能被
 * vitest 載入。** 那支吃 Nuxt 的 auto-import，而 `tsconfig.pipeline.json`（include 含 tests）
 * 不認識那些全域名字 ⇒ 測試檔一 import 它，`typecheck:pipeline` 就噴一串 `TS2304`，
 * **而 `typecheck:app` 是綠的**——兩個 typecheck 看到的世界不一樣。
 */
/*
 * ⇒ 既有慣例：被測試 import 的模組必須自足（`ticket`、`stats`、`chart-theme`、
 * `format-datetime` 全都是）。純函式搬進 `utils/`，不要去放寬 tsconfig。
 */

/**
 * 從一包 OAuth metadata 裡挑出可以直接放進 `<img src>` 的頭像網址。① **順序** `avatar_url`
 * → `picture`：Google 兩個 key 都給而且實測值完全相同，所以順序今天沒有差別；寫死它是為了
 * 讓「挑哪一個」是我們決定的，而不是物件的 key 順序決定的。
 */
/*
 * ② **只收 `https://`**——這是衛生不是安全控制（值來自 GoTrue 簽的 token，不經過使用者輸入）：
 *    它擋的是 `http://` 造成的混合內容，以及 metadata 形狀變了之後把一坨非網址塞進 `<img src>`。
 *    （`javascript:` 放在 `<img src>` 本來就不會執行，別把這條寫成防 XSS。）
 * ③ **回 `null` 而不是 `undefined`**：呼叫端一律 `?? undefined`，「沒有」只有一種寫法。
 */
export function pickAvatarUrl(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object')
    return null

  const bag = metadata as Record<string, unknown>
  for (const key of ['avatar_url', 'picture'] as const) {
    const value = bag[key]
    if (typeof value === 'string' && value.startsWith('https://'))
      return value
  }
  return null
}
