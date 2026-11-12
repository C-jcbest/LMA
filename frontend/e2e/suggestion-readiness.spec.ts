import { expect, test } from '@playwright/test';

test('推荐请求被阻塞时可输入，迟到结果不覆盖草稿或自动发送', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  await page.route('**/api/sessions/*/runs*', (route) => {
    runs += 1;
    return route.abort();
  });
  await page.route('**/api/suggestions', async (route) => {
    await blocked;
    await route.fulfill({ json: { questions: ['演示点的位移趋势如何？'] } });
  });
  await page.goto('/?page=conversation');
  await expect(page.getByRole('heading', { name: '从一个问题开始' })).toBeVisible();
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await input.fill('保留这段未发送的草稿');
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled();
  const response = page.waitForResponse('**/api/suggestions');
  release();
  await response;
  await expect(page.locator('.new-investigation [aria-hidden].space-y-3')).toHaveCount(0);
  await expect(input).toHaveValue('保留这段未发送的草稿');
  await expect(page.locator('.new-investigation-question')).toHaveCount(0);
  await input.fill('');
  await page.getByRole('button', { name: '演示点的位移趋势如何？' }).click();
  await expect(input).toHaveValue('演示点的位移趋势如何？');
  await expect(input).toBeFocused();
  expect(runs).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const width of [320, 1280]) {
  test(`推荐等待与首屏可操作分别计时（${width}px）`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
    const measurements = [];
    for (const delay of [0, 1200, 6000]) {
      let requests = 0;
      await page.route('**/api/suggestions', async (route) => {
        requests += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        await route.fulfill({ json: { questions: ['演示点（2026-11-01至2026-11-07）：位移趋势如何？'] } });
      });
      await page.goto('/?page=conversation');
      await expect(page.getByRole('heading', { name: '从一个问题开始' })).toBeVisible();
      const input = page.getByRole('textbox', { name: '输入监测问题' });
      await input.fill('我正在编辑的草稿');
      await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled();
      const interactiveMs = await page.evaluate(() => performance.now());
      await expect.poll(() => requests).toBe(1);
      // 草稿仍在时迟到的推荐不应出现或触发 Run；清空后才能看到推荐。
      await expect(page.locator('.new-investigation-question')).toHaveCount(0);
      await input.fill('');
      const question = page.getByRole('button', { name: /演示点/ });
      await expect(question).toBeVisible();
      const suggestionsMs = await page.evaluate(() => performance.now());
      await question.click();
      await expect(input).toHaveValue('演示点（2026-11-01至2026-11-07）：位移趋势如何？');
      await expect(input).toBeFocused();
      expect(requests).toBe(1);
      if (delay === 6000) {
        expect(interactiveMs).toBeLessThan(delay);
      }
      measurements.push({ width, delay, interactiveMs, suggestionsMs });
      await page.unroute('**/api/suggestions');
    }
    console.log('SUGGESTION_READINESS', JSON.stringify(measurements));
    await testInfo.attach('首屏与推荐计时', { body: JSON.stringify(measurements), contentType: 'application/json' });
  });
}
