import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['kernel/src/**/*.pg.test.ts', 'runtime/studio/test/intake-mineru.pg.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
