import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '#pipeline': fileURLToPath(new URL('./src', import.meta.url)),
      // 過渡期：src/ 內尚有未轉換的 ~/ import（見 tsconfig.pipeline.json）
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
})
