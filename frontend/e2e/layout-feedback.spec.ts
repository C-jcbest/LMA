import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
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

test('主题选择覆盖系统偏好并跨刷新保留，跟随系统仍响应变化', async ({ page }) => {
  await mockSessions(page);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: '浅色主题', exact: true }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: '浅色主题', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: '深色主题', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radio', { name: '跟随系统主题' }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'dark');
});

test('导航拖动只在松开后保存，折叠、刷新和跨屏宽后保留尺寸与草稿', async ({ page }) => {
  await mockSessions(page);
  await page.setViewportSize({ width: 1280, height: 844 });
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await input.fill('调整布局时保留的草稿');
  const handle = page.getByRole('separator', { name: '调整导航宽度' });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, 300, { steps: 20 });
  expect(await page.evaluate(() => localStorage.getItem('lma-navigation-width'))).toBeNull();
  await expect.poll(async () => (await page.locator('[data-navigation-docked]').boundingBox())!.width).toBe(360);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('lma-navigation-width'))).toBe('360');
  await expect(input).toHaveValue('调整布局时保留的草稿');
  await page.getByRole('button', { name: '折叠侧边栏' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧边栏' })).toBeVisible();
  await page.getByRole('button', { name: '展开侧边栏' }).click();
  await expect.poll(async () => (await page.locator('[data-navigation-docked]').boundingBox())!.width).toBe(360);

  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).click();
  const drawer = page.getByRole('dialog', { name: '导航', exact: true });
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBe(288);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect.poll(async () => (await page.locator('[data-navigation-docked]').boundingBox())!.width).toBe(360);

  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '350');
  await handle.dblclick();
  await expect(handle).toHaveAttribute('aria-valuenow', '260');
});

test('抽屉可调整宽度并重新打开，Esc 撤销拖动且不会残留拖动状态', async ({ page }) => {
  await mockSessions(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const navigation = page.getByRole('button', { name: '打开导航' });
  const drawer = page.getByRole('dialog', { name: '导航', exact: true });
  await navigation.click();
  expect(await drawer.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  const handle = drawer.getByRole('separator', { name: '调整导航宽度' });
  await handle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBe(300);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(385, 300, { steps: 12 });
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBe(358);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBe(300);
  expect(await page.evaluate(() => localStorage.getItem('lma-navigation-width'))).toBe('300');
  await expect(page.locator('html')).not.toHaveAttribute('data-panel-resizing', '');
  await page.keyboard.press('Escape');
  await navigation.click();
  await expect.poll(async () => (await drawer.boundingBox())!.width).toBe(300);
  await expect.poll(async () => (await drawer.boundingBox())!.x).toBe(0);
});

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
  await expect(page).not.toHaveURL(/threadId=/);

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
