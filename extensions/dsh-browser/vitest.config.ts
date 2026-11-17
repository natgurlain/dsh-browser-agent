import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Many specs cold-import the whole background worker in their first test. On a loaded
    // machine that import alone can pass vitest's 5 s default, so the limit only guards hangs.
    testTimeout: 30_000,
  },
})
