import { expect, test, type Page } from '@playwright/test';

// 只替换 API 返回，页面、会话运行时、图表和布局均使用生产实现；数据为自动化测试数据。
const session = {
  id: 'station-inspector', name: '测试分组巡检', archived: false,
  created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
};

const axisSummary = { count: 3, change: 0.002 };

const gnssResult = (id: string, stationName: string, beginDay: string, points: Array<[string, number | null]>) => ({
  type: 'tool', id: `${id}-result`, tool_call_id: id, name: 'get_displacement',
  content: '模型专用内容不得展示', status: 'success',
  artifact: {
    version: 1, kind: 'gnss_series', status: 'success',
    data: {
      station_uuid: stationName === '测试点 A' ? 'test-a' : 'test-b',
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
    { id: 'gnss-a', name: 'get_displacement', args: {} },
    { id: 'gnss-b', name: 'get_displacement', args: {} },
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
  await page.route('**/api/stations', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: { running: null, latest_attempt: null, inspection: null, stations: [] } }));
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

test('已存证的失败原因在过程折叠时可见，不展示模型专用正文', async ({ page }) => {
  const history = messages.map((message) => {
    if (message.id !== 'weather-result') {
      return message;
    }
    return {
      ...message, content: 'MODEL_ONLY',
      artifact: {
        version: 1, kind: 'acquisition_failure', status: 'error',
        data: { station_uuid: 'test-a', station_name: '测试点 A', requested_station: 'test-a',
          message: '气象服务暂不可用，未取得本次降雨数据。' },
        error: { code: 'unavailable', category: 'business',
          message: '气象服务暂不可用，未取得本次降雨数据。', retryable: false },
      },
    };
  });
  await openInvestigation(page, 320, history);
  await expect(page.getByText('气象服务暂不可用，未取得本次降雨数据。', { exact: false })).toBeVisible();
  await expect(page.getByText('MODEL_ONLY')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /查询记录 · 2 项已获取/ })).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
});

for (const width of [320, 1440]) {
  test(`${width}px 结论优先，测点时间轴可打开并恢复草稿与焦点`, async ({ page }) => {
    await openInvestigation(page, width);
    const input = page.getByRole('textbox', { name: '输入监测问题' });
    await input.fill('保留的追问草稿');

    await expect(page.getByText('气象服务暂不可用，未取得本次降雨数据。')).toHaveCount(0);
    await expect(page.getByText('测试点 A 需要优先复核。气象数据本次未取得，暂不能核查降雨关联。')).toBeVisible();
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
    await inspector(page).getByText(/^原始坐标/).click();
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
  const process = page.getByRole('button', { name: /查询记录 · 2 项已获取/ });
  await expect(page.getByText('GNSS 数据获取失败')).toHaveCount(0);
  await process.click();
  await page.getByRole('button', { name: /已获取位移数据.*测试点 B/ }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 B' })).toBeVisible();
  await page.getByRole('button', { name: '上一个测点' }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
});

test('框选时间段后就地追问或放大，还原后恢复完整窗口', async ({ page }) => {
  await openInvestigation(page, 1440);
  await page.getByRole('textbox', { name: '输入监测问题' }).fill('也看看东向变化');
  await stationEntry(page).click();
  const canvas = inspector(page).locator('canvas').first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 140, { steps: 8 });
  await page.mouse.up();

  // 外观更新必须保留图表实例和用户正在核查的时间段。
  const selectionBar = inspector(page).getByRole('toolbar', { name: '所选时间段' });
  await expect(selectionBar.getByRole('button', { name: '问这段' })).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  // 依据并排时侧栏收为导航条，外观设置在展开的导航里。
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('radio', { name: '深色主题', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(selectionBar.getByRole('button', { name: '问这段' })).toBeVisible();
  expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  await inspector(page).getByRole('tab', { name: '明细', exact: true }).click();
  await expect(canvas).toBeHidden();
  await inspector(page).getByRole('tab', { name: '时间轴', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(selectionBar.getByRole('button', { name: '问这段' })).toBeVisible();
  expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);

  await selectionBar.getByRole('button', { name: '问这段' }).click();
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await expect(input).toHaveValue(/^也看看东向变化\n测试点 A（UUID：test-a） 2026-11-\d\d \d\d:\d\d 至 2026-11-\d\d \d\d:\d\d 这段发生了什么？$/);
  await expect(input).toBeFocused();

  await expect(selectionBar).toHaveCount(0);

  // 放大是选区上的次要操作；放大后可还原。
  await page.mouse.move(box.x + box.width * 0.3, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 140, { steps: 8 });
  await page.mouse.up();
  await selectionBar.getByRole('button', { name: '放大所选时间段' }).click();
  await expect(inspector(page).getByRole('button', { name: '问当前范围' })).toBeVisible();
  await inspector(page).getByRole('button', { name: '还原' }).click();
  await expect(inspector(page).getByRole('button', { name: '问当前范围' })).toHaveCount(0);
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
  await expect.poll(async () => (await inspector(page).boundingBox())?.width).toBeCloseTo(390, 1);
  await page.setViewportSize({ width: 1024, height: 844 });
  // 1024 宽时侧栏收为 48px 导航条：1024 - 48 - 360（对话最小宽度）。
  await expect.poll(async () => (await inspector(page).boundingBox())?.width).toBe(616);
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBe(746);
  await expect.poll(async () => (await page.locator('[data-navigation-docked]').boundingBox())!.width).toBe(260);
  await page.getByRole('radio', { name: '深色主题', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(chartWarnings).toEqual([]);
});

test('地图密钥缺失和非法坐标不会遮掉场地资料或破坏依据面板', async ({ page }) => {
  await page.route('**/api/map-config', (route) => route.fulfill({ json: { amap_token: null } }));
  const site = {
    type: 'tool', id: 'site-result', tool_call_id: 'site-a', name: 'inspect_site_environment',
    content: '自动化测试场地', status: 'success',
    artifact: {
      version: 1, kind: 'site_environment', status: 'success',
      data: {
        version: 1, observed_at: '2026-11-09T00:00:00Z', coordinate_system: 'WGS84',
        center_station: { station_uuid: 'test-a', station_name: '测试点 A', longitude: 120, latitude: 30, coordinate_system: 'WGS84' },
        group_stations: [{ station_uuid: 'invalid', station_name: '坐标填反的测试点', longitude: 39.87, latitude: 116.48, coordinate_system: 'WGS84' }],
        faults: { available: false, note: '自动化测试数据，无真实断层结论' },
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
  const timelineCanvas = inspector(page).locator('canvas').first();
  await expect(timelineCanvas).toBeVisible();
  const originalTimelineCanvas = await timelineCanvas.elementHandle();
  await inspector(page).getByRole('tab', { name: '场地', exact: true }).click();
  await expect(inspector(page).getByText('未配置高德地图密钥，暂时无法加载地图。')).toBeVisible();
  await expect(inspector(page).getByText(/以下测点坐标缺失或超出经纬度范围，未绘制：坐标填反的测试点/)).toBeVisible();
  await expect(inspector(page).getByText('30.000000, 120.000000')).toBeVisible();
  await expect(inspector(page).getByRole('radio', { name: '卫星图', exact: true })).toBeChecked();
  await expect(inspector(page).getByRole('button', { name: '地层（区域图）', exact: true })).toHaveCount(0);
  await expect(inspector(page).getByRole('button', { name: '构造线', exact: true })).toHaveCount(0);
  await inspector(page).getByRole('radio', { name: '普通地图', exact: true }).click();
  await expect(inspector(page).getByRole('radio', { name: '普通地图', exact: true })).toBeChecked();
  const handle = page.getByRole('separator', { name: '调整聊天与依据宽度' });
  const originalWidth = (await inspector(page).boundingBox())!.width;
  await handle.focus();
  await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBeLessThan(originalWidth);
  await expect(inspector(page).getByText('30.000000, 120.000000')).toBeVisible();
  await expect(inspector(page).getByText('现场环境地图渲染异常')).toHaveCount(0);
  await inspector(page).getByRole('tab', { name: '时间轴', exact: true }).click();
  expect(await timelineCanvas.evaluate((element, original) => element === original, originalTimelineCanvas)).toBe(true);
});

test('切换屏宽和会话时不残留依据，宽度不足时会话导航改为抽屉', async ({ page }) => {
  await openInvestigation(page, 1440);
  await stationEntry(page).click();
  await expect(inspector(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: '导航' })).toHaveCount(0);

  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.getByRole('dialog', { name: '导航', exact: true })).toBeVisible();
  await expect(inspector(page)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.setViewportSize({ width: 390, height: 844 });
  // 跨越并排断点时检查器会重新挂载为全屏形态。
  await expect.poll(async () => (await inspector(page).boundingBox())?.width).toBe(390);
  await page.getByRole('button', { name: '关闭依据' }).click();
  await expect(inspector(page)).toHaveCount(0);

  await stationEntry(page).click();
  await page.getByRole('button', { name: '关闭依据' }).click();
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('button', { name: '今日', exact: true }).click();
  // 返回今日保留会话，只收起消息视图。
  await expect(page.getByText('测试点 A 需要优先复核')).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toHaveValue('');
  await expect(inspector(page)).toHaveCount(0);
});
