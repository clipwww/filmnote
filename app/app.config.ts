export default defineAppConfig({
  ui: {
    // paper / amber 兩組色階定義在 app/assets/css/main.css 的 @theme。
    // colors.js 的 generateShades() 會產生 var(--color-paper-50, )，
    // paper 不在 tailwindcss/colors 裡所以 fallback 是空的——完全依賴 @theme。
    colors: { primary: 'amber', neutral: 'paper' },

    /**
     * Toggle 關閉態要有一圈看得見的邊界（WCAG 1.4.11 要 3:1，原本只有 1.36:1）。
     *
     * Nuxt UI 的 switch `base` 本來就是 `border-2 border-transparent`（那兩格是留給
     * focus ring 的偏移用的），所以這裡**不新增邊框、只把既有那一圈在關閉態染上顏色**
     * ——尺寸與版面完全不動。開啟態維持琥珀實心，不套用。
     * 色值在 `main.css` 的 `--fn-switch-off-border`（亮暗各一個，見那裡的量測）。
     */
    switch: {
      slots: {
        base: 'data-[state=unchecked]:border-[var(--fn-switch-off-border)]',
      },
    },

    /**
     * ── 全站 z-index 階（DS §10「固定的 z-index 階，不用任意值」）─────────────
     *
     *    30  頂部導覽列（`app/layouts/default.vue` 的 <header>）
     *    50  所有覆蓋層：Modal / Drawer / Slideover / DropdownMenu / ContextMenu
     *        / Select / SelectMenu / Popover / Tooltip
     *   100  Toaster（`.nuxt/ui/toaster.ts` 的 viewport 自帶 `z-[100]`，不用動）
     *
     * ⚠️ 為什麼非做不可（這是「把頂欄改成 sticky」真正的代價）：
     *    Nuxt UI 4 的這九個主題**一個 z-index 都沒有**（`.nuxt/ui/modal.ts` 的 overlay
     *    逐字只有 `fixed inset-0`），而 `UApp` 的 `portal` prop 預設是 `"body"`，
     *    所以它們是 body 裡排在 `#__nuxt` 之後、`z-index: auto` 的定位元素。
     *    CSS 繪製順序裡「z:auto／0」那一步在「z > 0」之前 ⇒ 導覽列只要拿到正的 z，
     *    就會畫在遮罩與對話框**之上**：遮罩蓋住全頁、導覽列浮在遮罩上還亮著，
     *    而對話框照樣打得開、功能照樣正常——只有「看起來不對」。
     *    reka-ui 全 dist 只有 `Popper/PopperContent.js` 會抄 content 算出來的 z
     *    （抄到的是 auto），vaul-vue 零 z-index ⇒ 沒有任何一層會自己救自己。
     *
     * ⚠️ 這裡列的比「今天用得到的」多：`popover` / `tooltip` / `slideover` /
     *    `contextMenu` 目前全 repo 尚未使用。它們不 render 就不產生任何 CSS，
     *    成本是零；漏掉的成本則是「下一個加 UTooltip 的人要記得回來補一行」。
     *    這一階是正確性的地基，不要靠記性維護。
     *
     * 機制：`tv({ extend: theme, ...appConfig.ui?.<name> })` 是**合併**不是取代，
     * 衝突由 tailwind-merge 解——上面的 `switch` 覆寫走的就是同一條路。
     * 這幾個 slot 原本沒有任何 z 類別 ⇒ 不需要 `!`（踩雷 #186 那條「要蓋掉元件主題
     * 得寫 important」只適用於有既有類別互相競爭的情況）。
     */
    modal: { slots: { overlay: 'z-50', content: 'z-50' } },
    drawer: { slots: { overlay: 'z-50', content: 'z-50' } },
    slideover: { slots: { overlay: 'z-50', content: 'z-50' } },
    dropdownMenu: { slots: { content: 'z-50' } },
    contextMenu: { slots: { content: 'z-50' } },
    select: { slots: { content: 'z-50' } },
    selectMenu: { slots: { content: 'z-50' } },
    popover: { slots: { content: 'z-50' } },
    tooltip: { slots: { content: 'z-50' } },
  },
})
