import { antfu } from '@antfu/eslint-config'
import oxlint from 'eslint-plugin-oxlint'

export default antfu(
  {
    type: 'app',
    typescript: true,
    // oxlint 的 vue/* 只有 46 條且完全不看 <template>，
    // template a11y 與 require-v-for-key 只有 eslint-plugin-vue 有。
    vue: true,
    formatters: { css: true },
    // docs/** 是設計流程的產生物（規格、建置計畫、調研），非手寫原始碼；
    // 用 markdown 規則去挑它們的格式只會製造雜訊。
    ignores: [
      'tests/fixtures/**',
      '.data/**',
      '.nuxt/**',
      '.output/**',
      '.vercel/**',
      'app/types/database.types.ts',
      'supabase/migrations/**',
      'docs/**',
      '.omc/**',
    ],
  },
  {
    // 匯入管線仍以函式庫規範對待
    files: ['src/**/*.ts'],
    rules: { 'antfu/no-top-level-await': 'error' },
  },
  {
    // CLI 進入點：console 輸出與 top-level await 是它們的本職，不是疏漏。
    files: ['src/pipeline/ingest-*.ts', 'scripts/**/*.ts', 'server/api/cron/**/*.ts'],
    rules: {
      'no-console': 'off',
      'antfu/no-top-level-await': 'off',
    },
  },
  {
    // Nuxt 的檔案系統慣例與 antfu 的命名規則衝突
    files: ['app/pages/**/*.vue', 'app/layouts/**/*.vue', 'app/app.vue', 'app/error.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  // oxlint 已在儲存時處理的規則在此關閉，避免兩個 linter 重複回報。必須放最後。
  ...oxlint.configs['flat/recommended'],
)
