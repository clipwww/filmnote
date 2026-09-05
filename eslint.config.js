import antfu from '@antfu/eslint-config'
import oxlint from 'eslint-plugin-oxlint'

export default antfu(
  {
    type: 'lib',
    typescript: true,
    vue: false,
    ignores: ['tests/fixtures/**', '.data/**'],
  },
  // oxlint 已在儲存時處理的規則在此關閉，避免兩個 linter 重複回報
  ...oxlint.configs['flat/recommended'],
)
