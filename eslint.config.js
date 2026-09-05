import antfu from '@antfu/eslint-config'
import oxlint from 'eslint-plugin-oxlint'

export default antfu(
  {
    type: 'lib',
    typescript: true,
    vue: false,
    ignores: ['tests/fixtures/**', '.data/**'],
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
