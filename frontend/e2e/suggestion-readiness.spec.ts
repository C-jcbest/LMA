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
