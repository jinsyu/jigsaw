import { defineConfig } from 'vitest/config';

// DB tests against the local Supabase stack (pnpm db:start, then pnpm test:db).
export default defineConfig({
  test: {
    include: ['tests/server/db/**/*.test.js'],
    globalSetup: ['tests/server/db/global-setup.js'],
    // Files share one local stack; run them one after another for stable timing.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
  },
});
