import { expect, test, type Page } from '@playwright/test';

// 只替换 API 返回，页面、会话运行时、图表和布局均使用生产实现；数据为自动化测试数据。
const session = {
  id: 'station-inspector', name: '测试分组巡检', archived: false,
  created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
};

const axisSummary = { count: 3, change: 0.002 };

const gnssResult = (id: string, stationName: string, beginDay: string, points: Array<[string, number | null]>) => ({
  type: 'tool', id: `${id}-result`, tool_call_id: id, name: 'get_daily_gnss_data',
  content: '模型专用内容不得展示', status: 'success',
  artifact: {
    version: 1, kind: 'gnss_series', status: 'success',
    data: {
      station_name: stationName, begin_time: `${beginDay} 00:00:00`, end_time: '2026-11-03 00:00:00',
      timezone: 'Asia/Shanghai', total_points: points.length, returned_points: points.length, downsampled: false,
      points: points.map(([time, north]) => ({ time, n: north, e: 200.002, u: 300.003 })),
      summary: {
        n: axisSummary, e: axisSummary, u: axisSummary,
        gaps: [{ from: '2026-11-02 00:00:00', to: '2026-11-02 06:00:00', missing_hours: 6 }],
      },
    },
    sources: [{ name: '自动化测试数据' }],
  },
});

const points: Array<[string, number | null]> = [
  ['2026-11-01 00:00:00', 100.001],
  ['2026-11-02 00:00:00', null],
  ['2026-11-03 00:00:00', 100.003],
];

const messages = [
  { type: 'human', id: 'question-1', content: '查看测试分组近期变化' },
  { type: 'ai', id: 'query-1', content: [], tool_calls: [
    { id: 'gnss-a', name: 'get_daily_gnss_data', args: {} },
    { id: 'gnss-b', name: 'get_daily_gnss_data', args: {} },
    { id: 'weather-failed', name: 'query_weather', args: {} },
  ] },
  gnssResult('gnss-a', '测试点 A', '2026-11-01', points),
  gnssResult('gnss-b', '测试点 B', '2026-11-01', points),
  { type: 'tool', id: 'weather-result', tool_call_id: 'weather-failed', name: 'query_weather',
    status: 'error', content: '气象服务暂不可用，未取得本次降雨数据。' },
  { type: 'ai', id: 'answer-1', content: [
    { type: 'reasoning', reasoning: 'PRIVATE_CHAIN_SHOULD_NOT_RENDER' },
    { type: 'text', text: '测试点 A 需要优先复核。气象数据本次未取得，暂不能核查降雨关联。' },
  ] },
];

async function openInvestigation(page: Page, width: number, history: readonly unknown[] = messages) {
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [session] }));
  await page.route('**/api/sessions/station-inspector', (route) => route.fulfill({ json: session }));
  await page.route('**/api/sessions/station-inspector/state', (route) => route.fulfill({
    json: { values: { messages: history }, latest_run: { id: 'run-1', status: 'success' } },
  }));
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/?threadId=station-inspector');
  await expect(page.getByText('测试点 A 需要优先复核')).toBeVisible();
}

const inspector = (page: Page) => page.locator('[data-station-inspector]');
const stationEntry = (page: Page) => page.getByRole('button', { name: '查看 测试点 A 的依据' });

for (const width of [320, 390, 768, 1024, 1440]) {
  test(`${width}px 结论优先，测点时间轴可打开并恢复草稿与焦点`, async ({ page }) => {
    await openInvestigation(page, width);
    const input = page.getByRole('textbox', { name: '输入监测问题' });
    await input.fill('保留的追问草稿');

    await expect(page.getByRole('alert')).toContainText('气象服务暂不可用');
    await expect(page.getByText('PRIVATE_CHAIN_SHOULD_NOT_RENDER')).toHaveCount(0);
    await expect(page.getByText('模型专用内容不得展示')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const processHeight = (await page.locator('[data-slot="investigation"]').boundingBox())!.height;
    expect(processHeight).toBeLessThan(180);

    await stationEntry(page).click();
    await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
    await expect(inspector(page).locator('canvas').first()).toBeVisible();
    const box = (await inspector(page).boundingBox())!;
    expect(box.y).toBe(0);
    expect(box.height).toBe(900);
    expect(box.x + box.width).toBeCloseTo(width);
    if (width < 1024) {
      expect(box.width).toBe(width);
    } else {
      const inputBox = (await input.boundingBox())!;
      expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(box.x);
      await input.fill('并排核查时仍可追问');
    }
    expect(await inspector(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await page.getByRole('tab', { name: '明细' }).click();
    await expect(inspector(page).getByRole('cell', { name: '—', exact: true })).toBeVisible();
    await expect(inspector(page).getByText('自动化测试数据')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(inspector(page)).toHaveCount(0);
    await expect(input).toHaveValue(width < 1024 ? '保留的追问草稿' : '并排核查时仍可追问');
    await expect(stationEntry(page)).toBeFocused();
    await expect(input).toBeInViewport();
  });
}

test('调查过程默认折叠，展开后每一步都能定位到对应测点', async ({ page }) => {
  await openInvestigation(page, 1440);
  const process = page.getByRole('button', { name: /已调查 2 个测点 · 3 项查询/ });
  await expect(page.getByText('GNSS 数据获取失败')).toHaveCount(0);
  await process.click();
  await page.getByRole('button', { name: /已获取 GNSS 监测数据.*测试点 B/ }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 B' })).toBeVisible();
  await page.getByRole('button', { name: '上一个测点' }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
});

test('框选时间段后可带入追问，还原后恢复完整窗口', async ({ page }) => {
  await openInvestigation(page, 1440);
  await stationEntry(page).click();
  const canvas = inspector(page).locator('canvas').first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 140, { steps: 8 });
  await page.mouse.up();

  // 外观更新必须保留图表实例和用户正在核查的时间段。
  await expect(inspector(page).getByRole('button', { name: '追问这段' })).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  await page.getByRole('radio', { name: '深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(inspector(page).getByRole('button', { name: '追问这段' })).toBeVisible();
  expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);

  await inspector(page).getByRole('button', { name: '追问这段' }).click();
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await expect(input).toHaveValue(/^测试点 A 2026-11-\d\d \d\d:\d\d 至 2026-11-\d\d \d\d:\d\d 这段发生了什么？$/);
  await expect(input).toBeFocused();

  await inspector(page).getByRole('button', { name: '还原' }).click();
  await expect(inspector(page).getByRole('button', { name: '追问这段' })).toHaveCount(0);
});

test('聊天和依据的分隔线可拖动，关闭重开及刷新保留宽度，窄屏不覆盖桌面偏好', async ({ page }) => {
  const chartWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('[ECharts]')) {
      chartWarnings.push(message.text());
    }
  });
  await openInvestigation(page, 1920);
  await stationEntry(page).click();
  const handle = page.getByRole('separator', { name: '调整聊天与依据宽度' });
  const canvas = inspector(page).locator('canvas').first();
  await expect(canvas).toBeVisible();
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(896);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, 300, { steps: 16 });
  expect(await page.evaluate(() => localStorage.getItem('lma-inspector-width'))).toBeNull();
  await page.mouse.up();
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(736);
  expect(await page.evaluate(() => localStorage.getItem('lma-inspector-width'))).toBe('736');

  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(746);
  await page.getByRole('button', { name: '关闭依据' }).click();
  await expect(inspector(page)).toHaveCount(0);
  await stationEntry(page).click();
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(746);
  await page.reload();
  await stationEntry(page).click();
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(746);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(390);
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect.poll(async () => (await inspector(page).boundingBox())?.width).toBe(664);
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(746);
  await expect.poll(async () => (await page.locator('[data-navigation-docked]').boundingBox())!.width).toBe(260);
  await page.screenshot({ path: test.info().outputPath('workbench-light.png'), animations: 'disabled' });
  await page.getByRole('radio', { name: '深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: test.info().outputPath('workbench-dark.png'), animations: 'disabled' });
  expect(chartWarnings).toEqual([]);
});

test('场地地图随依据宽度调整画布，不依赖窗口 resize', async ({ page }) => {
  // 瓦片是外部服务，本用例只验证本地画布和布局，不请求真实地图数据。
  await page.route('https://**/*', (route) => route.abort());
  const site = {
    type: 'tool', id: 'site-result', tool_call_id: 'site-a', name: 'inspect_site_environment',
    content: '自动化测试场地', status: 'success',
    artifact: {
      version: 1, kind: 'site_environment', status: 'success',
      data: {
        version: 1, observed_at: '2026-11-09T00:00:00Z', coordinate_system: 'WGS84',
        center_station: { station_uuid: 'test-a', station_name: '测试点 A', longitude: 120, latitude: 30, coordinate_system: 'WGS84' },
        group_stations: [], faults: { available: false, note: '自动化测试数据，无真实断层结论' },
        layer_sources: { geology_tiles: '', geology_source_layer: 'units', fault_source_layer: 'lines' },
      },
    },
  };
  const history = [
    messages[0],
    { ...messages[1], tool_calls: [...messages[1].tool_calls!, { id: 'site-a', name: 'inspect_site_environment', args: {} }] },
    ...messages.slice(2, -1), site, messages.at(-1),
  ];
  await openInvestigation(page, 1920, history);
  await stationEntry(page).click();
  await inspector(page).getByRole('tab', { name: '场地', exact: true }).click();
  const map = inspector(page).locator('.maplibregl-map');
  const canvas = map.locator('canvas');
  await expect(canvas).toBeVisible();
  const originalWidth = (await canvas.boundingBox())!.width;
  const handle = page.getByRole('separator', { name: '调整聊天与依据宽度' });
  await handle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeLessThan(originalWidth);
  await expect.poll(async () => Math.abs((await canvas.boundingBox())!.width - await map.evaluate((element) => element.clientWidth))).toBeLessThan(1);
});

test('切换屏宽和会话时不残留依据，宽度不足时会话导航改为抽屉', async ({ page }) => {
  await openInvestigation(page, 1440);
  await stationEntry(page).click();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: '会话导航' })).toHaveCount(0);

  await page.getByRole('button', { name: '打开会话列表' }).click();
  await expect(page.getByRole('dialog', { name: '会话列表', exact: true })).toBeVisible();
  await expect(inspector(page)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  // 跨越并排断点时检查器会重新挂载为全屏形态。
  await expect.poll(async () => (await inspector(page).boundingBox())?.width).toBe(390);
  await page.getByRole('button', { name: '关闭依据' }).click();
  await expect(inspector(page)).toHaveCount(0);

  await stationEntry(page).click();
  await page.getByRole('button', { name: '关闭依据' }).click();
  await page.getByRole('button', { name: '打开会话列表' }).click();
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByRole('heading', { name: '今天要查哪个测点？' })).toBeVisible();
  await expect(inspector(page)).toHaveCount(0);
});
