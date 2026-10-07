import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js', 'tests/server/**/*.test.js'],
    // Needs the local Supabase stack: run with pnpm test:db.
    exclude: ['tests/server/db/**', '**/node_modules/**'],
  },
});
