import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // 文件内仍串行；只有会话生命周期文件写入 API，其余文件使用页面级 HTTP mock。
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:25174',
    // 页面按浏览器本地时区解析和显示业务时间，测试浏览器固定为业务时区，与办公电脑一致。
    timezoneId: 'Asia/Shanghai',
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
      command: 'node e2e/start-api.mjs',
      url: 'http://127.0.0.1:21420/health',
      env: {
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1 --port 25174 --strictPort',
      env: { LMA_API_PROXY_TARGET: 'http://127.0.0.1:21420' },
      url: 'http://127.0.0.1:25174',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
