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
  },
})
