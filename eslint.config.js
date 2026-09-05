import antfu from '@antfu/eslint-config'
import oxlint from 'eslint-plugin-oxlint'

export default antfu(
  {
    type: 'lib',
    typescript: true,
    vue: false,
    // BUILD_PLAN.md 是設計流程的產生物，非手寫原始碼；
    // 用 markdown 規則去挑它的格式只會製造雜訊。
    ignores: ['tests/fixtures/**', '.data/**', 'BUILD_PLAN.md'],
  },
  {
    // CLI 進入點：console 輸出與 top-level await 是它們的本職，
    // 不是疏漏。函式庫程式碼仍受原規則約束。
    files: ['src/pipeline/ingest-*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'antfu/no-top-level-await': 'off',
    },
  },
  // oxlint 已在儲存時處理的規則在此關閉，避免兩個 linter 重複回報
  ...oxlint.configs['flat/recommended'],
)
