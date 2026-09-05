/**
 * 輸入法「組字中」保護。
 *
 * ── 為什麼需要它 ──────────────────────────────────────────────
 * 實體注音鍵盤打「鬼」的過程是 ㄍ → ㄍㄨ → ㄍㄨㄟ → ㄍㄨㄟˇ → 上屏「鬼」。
 * 前四步都是 **composition 中間態**：瀏覽器照樣每一步都發 `input` 事件，
 * 但那些注音符號不是使用者要查的東西——拿去查一定是 0 筆，使用者會在選完字
 * 之前先看到「找不到」閃四次。日文（かな）、韓文（한글）、拼音同理。
 *
 * Vue 原生的 `v-model` 有內建這層保護（會掛 compositionstart/end 並在組字中
 * 跳過 onInput），但 **Nuxt UI 的 `UInput` 是自己接 `@input`**，沒有這層——
 * 實測 @nuxt/ui 4.11.0 的 `Input.vue`：`onInput` 直接 `updateInput(value)`。
 * 所以任何拿 `UInput` 做「邊打邊查」的地方都要自己補。
 *
 * `USelectMenu` **不用**補：它的搜尋框走 reka-ui 的 `ListboxFilter`，
 * 那支有 `useComposing()`，組字中不更新 `searchTerm`（reka-ui 2.10.3 實測，
 * 見 BUILD_PLAN §7 #80）。若哪天把它換成裸的 `UInput`，這層就要自己加回來。
 *
 * ── 用法 ──────────────────────────────────────────────────────
 * ```ts
 * const { composing, handlers } = useImeGuard(schedule)
 * watch(q, (v) => { if (!composing.value) schedule(v) })
 * ```
 * ```vue
 * <UInput v-model="q" v-bind="handlers" />
 * ```
 * `handlers` 不是 `UInput` 的 prop，會經由 `$attrs` 落到底層的原生 `<input>`。
 */
export function useImeGuard(onCommit?: (value: string) => void) {
  const composing = ref(false)

  function onCompositionstart() {
    composing.value = true
  }

  function onCompositionend(event: CompositionEvent) {
    composing.value = false
    // compositionend 與最後一次 input 的先後順序各家瀏覽器不一致
    // （Chromium/Firefox 是 compositionend → input，Safari 反過來），
    // 所以直接從 DOM 讀最終值，不賭 input 事件還會不會來。
    // 兩種順序都成立：若 input 後到，它會再排一次同樣的查詢，debounce 會併掉。
    const el = event.target as HTMLInputElement | null
    onCommit?.(el?.value ?? '')
  }

  return { composing, handlers: { onCompositionstart, onCompositionend } }
}

/**
 * 組字中的 Enter 不要送出表單。掛在 `<UForm @keydown="...">` 上。
 *
 * ── 實測（Chrome 152 / CDP，見 BUILD_PLAN §7 #81）───────────────
 * | 情境 | keydown | 表單送出 |
 * |---|---|---|
 * | 組字中，`keyCode 229` 無 keypress（真實輸入法交給頁面的形狀） | key='Process' | **否** |
 * | 組字中，`keyCode 13` 有 keypress（輸入法沒攔住） | isComposing=true | **是** ← |
 * | 沒有組字，`keyCode 13`（對照組） | isComposing=false | 是 |
 *
 * 也就是說：平常沒事，是因為**輸入法在 OS 層把 Enter 吃掉了**，不是因為
 * 瀏覽器有保護。Blink 的 implicit submission 掛在 keypress 上，完全不看
 * `isComposing`——只要哪個平台的輸入法把 Enter 放行（Windows 微軟注音、
 * Android 軟鍵盤都有前科），選字按 Enter 就會直接送出一筆紀錄。
 *
 * 這條防線的成本是三行，擋掉的是「使用者按 Enter 選字，結果紀錄存出去了」。
 */
export function blockSubmitWhileComposing(event: KeyboardEvent) {
  if (event.key !== 'Enter')
    return
  // keyCode 229 是「這個按鍵被輸入法吃掉了」的跨平台訊號
  if (event.isComposing || event.keyCode === 229)
    event.preventDefault()
}
