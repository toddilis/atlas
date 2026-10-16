import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  timeout: 180_000,
  use: { baseURL: 'http://127.0.0.1:3002', screenshot: 'on', trace: 'retain-on-failure' },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3002/login',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
