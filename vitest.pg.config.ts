import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['kernel/src/**/*.pg.test.ts', 'runtime/studio/test/**/*.pg.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
