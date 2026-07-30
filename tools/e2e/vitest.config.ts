import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The E2E harness composes the real service spine in-process; keep runs serial and deterministic.
    pool: 'threads',
    sequence: { shuffle: false },
  },
});
