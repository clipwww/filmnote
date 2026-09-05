export default defineAppConfig({
  ui: {
    // paper / amber 兩組色階定義在 app/assets/css/main.css 的 @theme。
    // colors.js 的 generateShades() 會產生 var(--color-paper-50, )，
    // paper 不在 tailwindcss/colors 裡所以 fallback 是空的——完全依賴 @theme。
    colors: { primary: 'amber', neutral: 'paper' },
  },
})
