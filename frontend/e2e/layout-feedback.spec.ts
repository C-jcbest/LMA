import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/suggestions', (route) => route.fulfill({ json: { questions: [] } }));
  await page.route('**/api/stations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/inspections/latest', (route) => route.fulfill({
    json: { running: null, latest_attempt: null, inspection: null, stations: [] },
  }));
});

// 只替换 HTTP 边界，实际运行页面、官方 Runtime、抽屉与列表交互。
const sessions = [
  { id: 'layout-first', name: '测点近期调查', archived: false, created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T02:00:00Z' },
  { id: 'layout-second', name: '同组对比调查', archived: false, created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z' },
];

async function mockSessions(page: Page) {
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: sessions }));
  await page.route('**/api/sessions/layout-*', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({ json: sessions.find((session) => session.id === id) });
  });
  await page.route('**/api/sessions/layout-*/state', (route) => route.fulfill({
    json: { values: { messages: [] }, latest_run: null },
  }));
}

test('窄屏切换已有会话、当前会话与新会话后关闭抽屉，桌面导航仍保持展开', async ({ page }) => {
  await mockSessions(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeInViewport();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBe(320);
  const navigation = page.getByRole('button', { name: '打开导航' });
  const drawer = page.getByRole('dialog', { name: '导航', exact: true });

  for (const session of [sessions[0], sessions[1], sessions[1]]) {
    await navigation.click();
    await drawer.getByRole('button', { name: session.name, exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page).toHaveURL(new RegExp('threadId=' + session.id));
    await expect(page.locator('header')).toContainText(session.name);
  }

  await navigation.click();
  await drawer.getByRole('button', { name: '今日', exact: true }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page).toHaveURL(/page=home/);
  await expect(page).toHaveURL(/threadId=/);

  await navigation.click();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(drawer).not.toBeVisible();
  await page.getByRole('button', { name: sessions[0].name, exact: true }).click();
  await expect(page.getByRole('complementary', { name: '导航' })).toBeVisible();
  await page.getByRole('button', { name: '折叠侧边栏' }).click();
  await expect(page.getByRole('complementary', { name: '导航' })).not.toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(page.getByRole('complementary', { name: '导航' })).toBeVisible();
});

test('列表失败在窄屏直接可见，失败重试不循环，恢复后保留草稿', async ({ page }) => {
  let requestCount = 0;
  let serviceAvailable = false;
  await page.route('**/api/sessions?*', async (route) => {
    requestCount += 1;
    if (!serviceAvailable) {
      await route.fulfill({ status: 503, json: { detail: 'PRIVATE_BACKEND_DIAGNOSTIC' } });
      return;
    }
    await route.fulfill({ json: sessions });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('会话列表尚未载入');
  await expect(page.getByText('PRIVATE_BACKEND_DIAGNOSTIC')).toHaveCount(0);
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await input.fill('未发送的调查问题');
  await page.getByRole('button', { name: '打开导航' }).click();
  const drawer = page.getByRole('dialog', { name: '导航', exact: true });
  await expect(drawer.getByRole('alert')).toContainText('会话列表尚未载入');
  await drawer.getByRole('button', { name: '重试', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('会话列表尚未载入');
  expect(requestCount).toBe(2);

  serviceAvailable = true;
  await drawer.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭导航' }).click();
  await expect(input).toHaveValue('未发送的调查问题');
  expect(requestCount).toBe(3);
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('button', { name: sessions[0].name, exact: true })).toBeVisible();
});

test('记录搜索查询全量接口，失败可重试并打开未加载记录', async ({ page }) => {
  await mockSessions(page);
  let fail = true;
  const remote = { ...sessions[0], id: 'layout-remote', name: '很早的测点调查' };
  await page.route('**/api/sessions?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (!params.has('search')) return route.fulfill({ json: sessions });
    expect(params.get('search')).toBe('远端测点');
    return route.fulfill(fail ? { status: 503, json: {} } : { json: [remote] });
  });
  await page.route('**/api/sessions/layout-remote', (route) => route.fulfill({ json: remote }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=records');
  await page.getByRole('searchbox', { name: '搜索会话' }).fill('远端测点');
  await expect(page.getByRole('alert')).toContainText('搜索结果尚未载入');
  fail = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: /很早的测点调查/ }).click();
  await expect(page).toHaveURL(/threadId=layout-remote/);
});
