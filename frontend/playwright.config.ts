import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:25174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node e2e/stub-services.mjs',
      url: 'http://127.0.0.1:19090/health',
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: '..\\..\\backend\\.venv\\Scripts\\langgraph.exe dev --config .\\langgraph.json --port 21420 --no-browser --no-reload --allow-blocking',
      cwd: './e2e',
      url: 'http://127.0.0.1:21420/ok',
      env: {
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        LANGGRAPH_API_NO_USAGE_STATS: '1',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 25174 --strictPort',
      env: { LMA_LANGGRAPH_PROXY_TARGET: 'http://127.0.0.1:21420' },
      url: 'http://127.0.0.1:25174',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
