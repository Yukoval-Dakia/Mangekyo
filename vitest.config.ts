import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['kernel/src/**/*.test.ts', 'modules/**/*.test.ts', 'executors/**/*.test.ts', 'scripts/**/*.test.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.pg.test.ts'],
  },
});
