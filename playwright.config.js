import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
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
    // rt server against the local Supabase stack (screens move to it in T21-T22).
    {
      command: 'node scripts/rt-dev.mjs',
      env: { PORT: '3400' },
      url: 'http://127.0.0.1:3400/health',
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    { name: 'phone-360', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true } },
    { name: 'phone-390', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'tablet-1024', use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 768 }, hasTouch: true } },
    { name: 'desktop-1440', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
});
