import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', workers: 1, fullyParallel: false,
  use: { baseURL: process.env.FITBRIDGE_TEST_URL ?? 'http://localhost:8788', browserName: 'chromium' },
  webServer: process.env.FITBRIDGE_TEST_URL ? undefined : {
    command: 'npm run build && node scripts/browser-server.ts', url: 'http://localhost:8788/health',
    timeout: 120_000, reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
  },
  reporter: process.env.CI ? 'github' : 'list',
});
