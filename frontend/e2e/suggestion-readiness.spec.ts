import { expect, test } from '@playwright/test';

test('推荐请求被阻塞时首页可输入，迟到结果不覆盖草稿或自动发送', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/inspections/latest', (route) => route.fulfill({
    json: { running: null, latest_attempt: null, inspection: null, stations: [] },
  }));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let runs = 0;
  await page.route('**/api/sessions/*/runs*', (route) => {
    runs += 1;
    return route.abort();
  });
  await page.route('**/api/suggestions', async (route) => {
    await blocked;
    await route.fulfill({ json: { questions: ['演示点 近 90 天，位移趋势如何？'] } });
  });
  // 推荐只在首页：新调查从首页开始，输入框上方是推荐。
  await page.goto('/?page=home');
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await input.fill('保留这段未发送的草稿');
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled();
  const response = page.waitForResponse('**/api/suggestions');
  release();
  await response;
  // 草稿非空时推荐不出现，也不改写草稿。
  await expect(input).toHaveValue('保留这段未发送的草稿');
  await expect(page.getByRole('list', { name: '推荐问题' })).toHaveCount(0);
  await input.fill('');
  await page.getByRole('button', { name: '演示点 近 90 天，位移趋势如何？' }).click();
  await expect(input).toHaveValue('演示点 近 90 天，位移趋势如何？');
  await expect(input).toBeFocused();
  expect(runs).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('侧栏新调查回到首页并聚焦输入框，空会话页不再单独推荐', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/inspections/latest', (route) => route.fulfill({
    json: { running: null, latest_attempt: null, inspection: null, stations: [] },
  }));
  let suggestionRequests = 0;
  await page.route('**/api/suggestions', (route) => {
    suggestionRequests += 1;
    return route.fulfill({ json: { questions: [] } });
  });
  await page.goto('/?page=conversation');
  await expect(page.getByRole('heading', { name: '从一个问题开始' })).toBeVisible();
  expect(suggestionRequests).toBe(0);
  await page.getByRole('button', { name: '新调查', exact: true }).first().click();
  await expect(page).toHaveURL(/page=home/);
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeFocused();
});
