/**
 * 輸入法「組字中」保護。實體注音打「鬼」是 ㄍ→ㄍㄨ→ㄍㄨㄟ→ㄍㄨㄟˇ→上屏，前四步都是
 * composition 中間態而瀏覽器照樣每步發 `input` ⇒ 拿去查一定 0 筆，使用者在選完字之前會先
 * 看到「找不到」閃四次。日文、韓文、拼音同理。
 */
/*
 * Vue 原生 `v-model` 有這層保護，但 **Nuxt UI 的 `UInput` 是自己接 `@input`**（實測 4.11.0 的
 * `onInput` 直接 `updateInput(value)`）⇒ 任何拿 `UInput` 做「邊打邊查」的地方都要自己補。
 * `USelectMenu` **不用**補（走 reka-ui 的 `ListboxFilter`，那支有 `useComposing()`，見 §7 #80）。
 */
/*
 * 用法：`const { composing, handlers } = useImeGuard(schedule)`、
 * `watch(q, v => { if (!composing.value) schedule(v) })`、`<UInput v-model="q" v-bind="handlers" />`。
 * `handlers` 不是 `UInput` 的 prop，會經由 `$attrs` 落到底層的原生 `<input>`。
 */
export function useImeGuard(onCommit?: (value: string) => void) {
  const composing = ref(false)

  function onCompositionstart() {
    composing.value = true
  }

  function onCompositionend(event: CompositionEvent) {
    composing.value = false
    // compositionend 與最後一次 input 的先後順序各家瀏覽器不一致（Chromium/Firefox 是
    // compositionend → input，Safari 反過來）⇒ 直接從 DOM 讀最終值，不賭 input 還會不會來。
    // 兩種順序都成立：若 input 後到，它會再排一次同樣的查詢，debounce 會併掉。
    const el = event.target as HTMLInputElement | null
    onCommit?.(el?.value ?? '')
  }

  return { composing, handlers: { onCompositionstart, onCompositionend } }
}

/**
 * 組字中的 Enter 不要送出表單。實測（Chrome 152 / CDP，§7 #81）：組字中且 keyCode 229 無
 * keypress（真實輸入法交給頁面的形狀）不會送出；**組字中但 keyCode 13 有 keypress
 * （輸入法沒攔住）會送出**，即使 `isComposing=true`。
 */
/*
 * 也就是說平常沒事是因為**輸入法在 OS 層把 Enter 吃掉了**，不是瀏覽器有保護：Blink 的
 * implicit submission 掛在 keypress 上、完全不看 `isComposing`——只要哪個平台的輸入法把
 * Enter 放行（Windows 微軟注音、Android 軟鍵盤都有前科），選字按 Enter 就會直接送出一筆紀錄。
 */
export function blockSubmitWhileComposing(event: KeyboardEvent) {
  if (event.key !== 'Enter')
    return
  // keyCode 229 是「這個按鍵被輸入法吃掉了」的跨平台訊號
  if (event.isComposing || event.keyCode === 229)
    event.preventDefault()
}
