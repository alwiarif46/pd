import { defineConfig, devices } from '@playwright/test';

// Smoke tests against the built app served by `vite preview` (run `pnpm build` first; CI job e2e-web does).
// Browser: `pnpm exec playwright install --with-deps chromium` (CI). Locally PLAYWRIGHT_BROWSERS_PATH may already hold one.
const PORT = Number(process.env.PD_E2E_WEB_PORT ?? 4173);

export default defineConfig({
  testDir: './e2e',
  // Output stays out of git (.gitignore: test-results/, playwright-report/).
  outputDir: './test-results',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]] : 'list',
  forbidOnly: !!process.env.CI,
  retries: 0,
  fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
