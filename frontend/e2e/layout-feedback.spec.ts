import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/suggestions', (route) => route.fulfill({ json: { questions: [] } }));
  await page.route('**/api/stations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/inspections/latest', (route) => route.fulfill({
    json: { running: null, latest_attempt: null, inspection: null, stations: [] },
  }));
});

test('新调查静默推荐一次，填入后保留编辑权，窄屏不溢出', async ({ page }, testInfo) => {
  await mockSessions(page);
  let requests = 0;
  await page.route('**/api/suggestions', async (route) => {
    requests += 1;
    await route.fulfill({ json: { questions: ['哪些测点近期值得关注？', '比较测点在共同有效时段的变化', '近期降雨与位移变化有关吗？'] } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=conversation');
  await expect(page.getByRole('heading', { name: '从一个问题开始' })).toBeVisible();
  await expect(page.getByRole('button', { name: '哪些测点近期值得关注？' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('新调查-390px.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '哪些测点近期值得关注？' }).click();
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await expect(input).toHaveValue('哪些测点近期值得关注？');
  await expect(input).toBeFocused();
  await input.fill('我自己的问题');
  expect(requests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('推荐失败静默收起且不阻塞输入，减少动态效果生效', async ({ page }) => {
  await mockSessions(page);
  await page.route('**/api/suggestions', (route) => route.fulfill({ status: 503, json: {} }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?page=conversation');
  await expect(page.getByRole('heading', { name: '从一个问题开始' })).toBeVisible();
  await expect(page.locator('.new-investigation [aria-hidden].space-y-3')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.locator('.new-investigation-intro').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await page.getByRole('textbox', { name: '输入监测问题' }).fill('继续提问');
  await expect(page.getByRole('button', { name: '发送消息' })).toBeEnabled();
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
  await expect(page.getByText('外观', { exact: true })).toHaveCount(0);
  // 外观是低频设置，放在导航底部而不是每个页面的标题栏。
  const theme = page.getByRole('complementary', { name: '导航' }).getByRole('radiogroup', { name: '外观主题' });
  await expect(theme).toBeVisible();
  await expect(page.getByRole('main').getByRole('radiogroup', { name: '外观主题' })).toHaveCount(0);
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

test('非当天巡检突出历史状态，当天结果保留正常标题', async ({ page }) => {
  await mockSessions(page);
  let finishedAt = '2020-01-01T00:00:00Z';
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: {
    running: null, latest_attempt: null, inspection: { id: 'snapshot', finished_at: finishedAt },
    stations: [{ station_uuid: 'a', station_name: 'A', group_name: '', screening: '未见明显变化', reasons: [], metrics: {}, trend: [], previous_screening: null, last_conclusion: null }],
  } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('上次巡检');
  await expect(page.locator('time')).toContainText('2020');
  finishedAt = new Date().toISOString();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('1 个测点未见明显变化');
});
