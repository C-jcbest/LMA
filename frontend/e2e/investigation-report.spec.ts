import { expect, test, type Page } from '@playwright/test';

// 只替换 API 返回，页面、会话运行时和布局均使用生产实现；数据为自动化测试数据。
const session = {
  id: 'report-session', name: '测试分组巡检', archived: false,
  created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
};

const axisSummary = { count: 2, change: 0.002 };

const gnssResult = (id: string, beginTime: string) => ({
  type: 'tool', id: `${id}-result`, tool_call_id: id, name: 'get_daily_gnss_data', content: '模型专用内容不得展示', status: 'success',
  artifact: {
    version: 1, kind: 'gnss_series', status: 'success',
    data: {
      station_name: '测试点 A', begin_time: beginTime, end_time: '2026-11-03 00:00:00', timezone: 'Asia/Shanghai',
      total_points: 2, returned_points: 2, downsampled: false,
      points: [{ time: beginTime, n: 100, e: 200, u: 300 }, { time: '2026-11-03 00:00:00', n: 100.002, e: 200, u: 300 }],
      summary: { n: axisSummary, e: axisSummary, u: axisSummary, gaps: [] },
    },
  },
});

const report = {
  conclusion: '测试点 A 需要优先复核，测试点 B 未见明显变化。',
  stations: [
    { station_name: '测试点 B', status: '未见明显变化', reason: '三个方向均无持续变化', acceleration: '未见持续加速', data_quality: '数据完整' },
    { station_name: '测试点 A', status: '需人工复核', reason: '长期同向变化', acceleration: '无法判断', data_quality: '一次缺测' },
  ],
  findings: [
    { level: 'fact', text: '北向净变化约 2 mm', evidence: ['gnss-short'] },
    { level: 'analysis', text: '长期趋势仍在延续', evidence: ['gnss-long', 'gnss-short'] },
    { level: 'inference', text: '可能与坡体缓慢变形有关', evidence: [] },
  ],
  next_steps: ['现场核查观测墩'],
};

const messages = [
  { type: 'human', id: 'question-1', content: '测试点 A 最近怎么样？' },
  { type: 'ai', id: 'query-1', content: [], tool_calls: [
    { id: 'gnss-long', name: 'get_daily_gnss_data', args: {} },
    { id: 'gnss-short', name: 'get_daily_gnss_data', args: {} },
  ] },
  gnssResult('gnss-long', '2026-08-01 00:00:00'),
  gnssResult('gnss-short', '2026-11-01 00:00:00'),
  { type: 'ai', id: 'report-1', content: [], tool_calls: [{ id: 'report-call', name: 'submit_investigation_report', args: {} }] },
  {
    type: 'tool', id: 'report-result', tool_call_id: 'report-call', name: 'submit_investigation_report', content: '{}', status: 'success',
    artifact: { version: 1, kind: 'investigation_report', status: 'success', data: report },
  },
];

const inspectionRow = (name: string, screening: string, fields: Record<string, unknown> = {}) => ({
  station_uuid: name, station_name: name, group_name: 'K3 分组', screening, reasons: [], metrics: {},
  trend: [0, 1, 2, 3], previous_screening: null, last_conclusion: null, ...fields,
});

const inspection = {
  running: null,
  latest_attempt: {
    id: 'inspection-1', status: 'success', finished_at: '2026-11-09T08:30:00+08:00',
    total_stations: 3, completed_stations: 3,
  },
  inspection: { id: 'inspection-1', finished_at: '2026-11-09T08:30:00+08:00' },
  stations: [
    inspectionRow('测试点 A', '建议调查', {
      reasons: ['北向 90 天持续同向变化，约 -11.9 mm'], previous_screening: '未见明显变化',
      last_conclusion: { status: '持续关注', reason: '缓慢累积', session_id: 'report-session', created_at: '2026-11-08T00:00:00Z' },
    }),
    inspectionRow('测试点 B', '未见明显变化'),
    inspectionRow('测试点 C', '数据不足', { reasons: ['最近 48 小时没有数据'] }),
  ],
};

async function mockApi(page: Page) {
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [session] }));
  await page.route('**/api/sessions/report-session', (route) => route.fulfill({ json: session }));
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({
    json: { values: { messages }, latest_run: { id: 'run-1', status: 'success' } },
  }));
}

const inspector = (page: Page) => page.locator('[data-station-inspector]');

test('简报先给结论，按优先级列测点，事实与推断分开', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?threadId=report-session');

  const reportRegion = page.getByRole('region', { name: '调查简报' });
  await expect(reportRegion.getByText(report.conclusion)).toBeVisible();
  await expect(reportRegion.getByRole('button', { name: /查看 测试点/ }).first()).toHaveAccessibleName('查看 测试点 A 的依据');
  for (const heading of ['观测事实', '分析判断', '专业推断', '建议']) {
    await expect(reportRegion.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(page.getByText('模型专用内容不得展示')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /已调查 1 个测点 · 2 项查询/ })).toBeVisible();

  const copy = page.locator('[data-role="assistant"]').last().getByRole('button', { name: '复制', exact: true });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('## 专业推断');
});

test('点击依据编号定位到对应的时间窗口', async ({ page }) => {
  await mockApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?threadId=report-session');

  await page.getByRole('button', { name: /查看依据 1：/ }).first().click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await expect(inspector(page).getByRole('radio', { name: /11-01 至 11-03/ })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: /查看依据 2：/ }).first().click();
  await expect(inspector(page).getByRole('radio', { name: /08-01 至 11-03/ })).toHaveAttribute('aria-checked', 'true');
});

test('今日关注把需要看的测点放在最前，点击只填入输入框', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: inspection }));
  let runRequests = 0;
  await page.route('**/api/sessions/*/runs', (route) => {
    runRequests += 1;
    return route.abort();
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '今日关注' })).toBeVisible();
  await expect(page.getByRole('list', { name: '建议调查的测点' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('此前未见明显变化')).toBeVisible();
  await expect(page.getByRole('button', { name: /未见明显变化 1 个/ })).toBeVisible();

  await page.getByRole('button', { name: '调查 测试点 A' }).click();
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await expect(input).toHaveValue(/^调查 测试点 A 的近期变化。初筛线索：北向/);
  await expect(input).toBeFocused();
  expect(runRequests).toBe(0);

  await page.getByRole('button', { name: '打开 测试点 A 的上次调查' }).click();
  await expect(page).toHaveURL(/threadId=report-session/);
  await expect(page.getByText(report.conclusion)).toBeVisible();
});

test('巡检进行中显示进度，完成后展示结果，失败不影响直接提问', async ({ page }) => {
  await mockApi(page);
  let state: Record<string, unknown> = { running: null, latest_attempt: null, inspection: null, stations: [] };
  let startCount = 0;
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: state }));
  await page.route('**/api/inspections', (route) => {
    startCount += 1;
    state = {
      running: { total_stations: 3, completed_stations: 1 },
      latest_attempt: { id: 'inspection-2', status: 'running', finished_at: null, total_stations: 3, completed_stations: 1 },
      inspection: null, stations: [],
    };
    return route.fulfill({ status: 202, json: { id: 'inspection-2' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '今天要查哪个测点？' })).toBeVisible();
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('button', { name: '巡检中 1/3' })).toBeDisabled();
  expect(startCount).toBe(1);

  state = inspection;
  await expect(page.getByRole('heading', { name: '今日关注' })).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole('button', { name: '重新巡检' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('巡检慢请求可完成且不并发，后台失败保留上次结果并停止轮询', async ({ page }) => {
  await mockApi(page);
  let reads = 0;
  let activeRequests = 0;
  let maximumRequests = 0;
  let failNextRead = false;
  const abortedRequests: string[] = [];
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/inspections/latest')) {
      abortedRequests.push(request.failure()?.errorText ?? 'failed');
    }
  });
  await page.route('**/api/inspections/latest', async (route) => {
    reads += 1;
    let state;
    if (failNextRead) {
      state = { ...inspection, latest_attempt: { ...inspection.latest_attempt, id: 'slow-run', status: 'error' } };
    } else {
      state = {
        ...inspection,
        running: { total_stations: 3, completed_stations: 1 },
        latest_attempt: { ...inspection.latest_attempt, id: 'slow-run', status: 'running', finished_at: null, completed_stations: 1 },
      };
    }
    if (failNextRead) {
      activeRequests += 1;
      maximumRequests = Math.max(maximumRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.fulfill({ json: state });
      activeRequests -= 1;
      return;
    }
    await route.fulfill({ json: state });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '巡检中 1/3' })).toBeDisabled();
  const initialReads = reads;
  // 开发模式首次挂载可能取消一次读取；这里只检查随后运行中的慢轮询。
  abortedRequests.length = 0;
  failNextRead = true;
  await expect(page.getByRole('alert')).toContainText('最近一次巡检失败', { timeout: 10000 });
  await expect(page.getByRole('alert')).toContainText('下方保留上次成功结果');
  await expect(page.getByRole('button', { name: '调查 测试点 A' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新巡检' })).toBeEnabled();
  await page.waitForTimeout(2500);
  expect(reads).toBe(initialReads + 1);
  expect(maximumRequests).toBe(1);
  expect(abortedRequests).toEqual([]);
});

test('首次巡检中断明确提示，输入框和重新启动仍可用', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: {
    running: null, inspection: null, stations: [],
    latest_attempt: { id: 'interrupted-run', status: 'interrupted', finished_at: '2026-11-09T08:30:00+08:00', total_stations: 3, completed_stations: 1 },
  } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('最近一次巡检已中断');
  await expect(page.getByRole('alert')).toContainText('你仍可直接提问');
  await expect(page.getByRole('button', { name: '开始巡检' })).toBeEnabled();
  await page.getByRole('textbox', { name: '输入监测问题' }).fill('保留我的调查问题');
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toHaveValue('保留我的调查问题');
});

test('多分组选单可筛选，重新巡检移除所选分组后恢复全部', async ({ page }) => {
  await mockApi(page);
  let state = {
    ...inspection,
    stations: Array.from({ length: 7 }, (_, index) => (
      inspectionRow(`测点 ${index + 1}`, '建议调查', { group_name: `分组 ${index + 1}` })
    )),
  };
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: state }));
  await page.route('**/api/inspections', (route) => {
    state = { ...inspection, stations: inspection.stations.map((station) => ({ ...station, group_name: '新分组' })) };
    return route.fulfill({ status: 202, json: { id: 'new-groups' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const groupSelect = page.getByRole('combobox', { name: '分组' });
  await groupSelect.selectOption('分组 7');
  const stations = page.getByRole('list', { name: '建议调查的测点' });
  await expect(stations.getByRole('listitem')).toHaveCount(1);
  await expect(stations.getByRole('button', { name: '调查 测点 7' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.getByRole('button', { name: '重新巡检' }).click();
  await expect(groupSelect).toHaveCount(0);
  await expect(stations.getByRole('button', { name: '调查 测试点 A' })).toBeVisible();
});
