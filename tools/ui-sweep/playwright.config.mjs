import { defineConfig } from '@playwright/test';

// Chromium only — the sweep measures computed styles, not engine quirks.
// Ports 8148/4173 avoid the usual dev servers (8138/5173).
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: 'node ../../apps/nav/serve.js 8148',
      port: 8148,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite preview --port 4173 --strictPort',
      cwd: '../../apps/plan',
      port: 4173,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
