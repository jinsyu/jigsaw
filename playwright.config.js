import { defineConfig, devices } from '@playwright/test';
import { RT_LOG_FILE } from './tests/e2e/support/rt-log.js';

const PORT = 4173;
const CLOCK_TESTS = /disconnect\.spec\.js$/;

// Do not run pnpm test:e2e and pnpm test:db at the same time on one local stack: the DB tests'
// rt servers restore every open class of the database when they start (and count them against
// their limits), and their clean-up and restart checks change rows the E2E tests are using.
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.js',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node scripts/serve.mjs',
      env: { PORT: String(PORT) },
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: !process.env.CI,
    },
    // rt server against the local Supabase stack (teacher screens since T21, students in T22).
    // Every test opens classes as the same local test teacher, in parallel: room above the
    // per-teacher limits (production keeps the defaults, server/src/config.js).
    // Locally an rt server that is already running is reused (reuseExistingServer): one started
    // by hand with `pnpm rt:dev` lacks these limits (and keeps classes from earlier runs), so stop
    // it before pnpm test:e2e, or start it with the same RT_* variables.
    {
      command: 'node scripts/rt-dev.mjs',
      env: { PORT: '3400', RT_MAX_OPEN_PER_TEACHER: '200', RT_MAX_OPEN_SESSIONS: '400', RT_UPLOADS_PER_HOUR: '1000', RT_LOG_FILE },
      url: 'http://127.0.0.1:3400/health',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    { name: 'phone-360', testIgnore: CLOCK_TESTS, use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
    { name: 'phone-390', testIgnore: CLOCK_TESTS, use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'tablet-1024', testIgnore: CLOCK_TESTS, use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 }, hasTouch: true } },
    { name: 'desktop-1440', testIgnore: CLOCK_TESTS, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // Tests that move the rt server's clock forward (one-minute rule) affect every class on it,
    // so they run alone, after all the others.
    {
      name: 'clock-390',
      testMatch: CLOCK_TESTS,
      dependencies: ['phone-360', 'phone-390', 'tablet-1024', 'desktop-1440'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
