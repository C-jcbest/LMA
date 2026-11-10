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

const stationTimeline = {
  station_uuid: '测试点 A', station_name: '测试点 A', group_name: 'K3 分组',
  series: gnssResult('timeline', '2026-11-01 00:00:00').artifact.data,
  records: [{
    session_id: 'report-session', session_name: '测试分组巡检', status: '需人工复核',
    reason: '长期同向变化', created_at: '2026-11-08T00:00:00Z',
  }],
};

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
  await page.route('**/api/inspections/latest', (route) => route.fulfill({
    json: { running: null, latest_attempt: null, inspection: null, stations: [] },
  }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: [session] }));
  await page.route('**/api/sessions/report-session', (route) => route.fulfill({ json: session }));
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({
    json: { values: { messages }, latest_run: { id: 'run-1', status: 'success' } },
  }));
}

const inspector = (page: Page) => page.locator('[data-station-inspector]');

test('普通 AI 消息的标题、列表和长表格在窄屏保持可读', async ({ page }) => {
  await mockApi(page);
  const markdown = [
    '## 近期变化分析',
    '北向位移仍在缓慢累积，整体趋势与前一周一致。重点关注以下两项变化。',
    '- 北向累计变化约 **2 mm**，方向保持一致。',
    '- 东向与高程变化相对平稳。',
    '',
    '### 监测数据',
    '| 测点 | 北向变化 | 东向变化 | 高程变化 | 分析时间窗口 |',
    '| --- | --- | --- | --- | --- |',
    '| SCWM-04 | -18.0 mm | 2.1 mm | 0.7 mm | 2026-08-01T00:00:00+08:00 |',
    '',
    '> 从变化形态看，更倾向于缓慢的持续变形。',
  ].join('\n');
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({
    json: { values: { messages: [messages[0], { type: 'ai', id: 'plain-answer', content: markdown }] }, latest_run: null },
  }));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/?threadId=report-session');
  const answer = page.locator('[data-role=assistant]');
  await expect(answer.getByRole('heading', { name: '近期变化分析' })).toBeVisible();
  await expect(answer.getByRole('table')).toBeVisible();
  const tableRegion = answer.getByRole('region', { name: '数据表格，可横向滚动' });
  expect(await tableRegion.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const columnHeader = await answer.getByRole('columnheader', { name: '东向变化' }).boundingBox();
  expect(columnHeader!.height).toBeLessThan(60);
  const viewportElement = page.locator('[data-slot=aui_thread-viewport]');
  expect(await viewportElement.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await viewportElement.evaluate((element) => { element.scrollTop = 0; });
});

test('简报分层、复制及依据时间窗口定位', async ({ page, context }) => {
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
  await page.getByRole('button', { name: /查看依据 1：/ }).first().click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await expect(inspector(page).getByRole('radio', { name: /11-01 至 11-03/ })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: /查看依据 2：/ }).first().click();
  await expect(inspector(page).getByRole('radio', { name: /08-01 至 11-03/ })).toHaveAttribute('aria-checked', 'true');
});

test('今日页只列建议调查的测点，点击进入测点页直接看数据，不调用模型', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: inspection }));
  let runRequests = 0;
  await page.route('**/api/sessions/*/runs', (route) => {
    runRequests += 1;
    return route.abort();
  });
  const timelineQueries: string[] = [];
  await page.route('**/api/stations/*/timeline*', (route) => {
    timelineQueries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: stationTimeline });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: /3 个测点.*1 个.*建议调查/ })).toBeVisible();
  expect(await page.locator('[data-slot=aui_thread-viewport]').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('list', { name: '建议调查的测点' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('上次巡检未见明显变化')).toBeVisible();
  await expect(page.getByText('上次调查：持续关注')).toBeVisible();
  await expect(page.getByRole('button', { name: /1 个未见明显变化.*1 个数据待核查.*全部测点/ })).toBeVisible();

  await page.getByRole('button', { name: '查看 测试点 A' }).click();
  await expect(page).toHaveURL(/station=/);
  await expect(page.getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await expect(page.getByText('北向净变化')).toBeVisible();
  await expect(page.getByRole('img', { name: '测试点 A 位移时间轴' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(runRequests).toBe(0);

  await page.getByRole('radio', { name: '30 天' }).click();
  await expect.poll(() => timelineQueries.at(-1)).toBe('?days=30');

  // 历次调查从测点的记录里打开；窄屏切到对话面板显示那次的简报。
  await page.getByRole('button', { name: /需人工复核.*长期同向变化/ }).click();
  await expect(page).toHaveURL(/threadId=report-session/);
  await expect(page.getByText(report.conclusion)).toBeVisible();
  expect(runRequests).toBe(0);
});

test('历史巡检全部缺测时不暗示正常，数据问题在测点列表里说明', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: {
    ...inspection,
    stations: [inspectionRow('测试点 C', '数据不足', { reasons: ['最近 48 小时没有数据'] })],
  } }));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '1 个测点，没有建议调查的' })).toBeVisible();
  await expect(page.getByText('未见明显变化')).toHaveCount(0);
  await page.getByRole('button', { name: /1 个数据待核查/ }).click();
  await expect(page).toHaveURL(/page=stations/);
  await expect(page.getByRole('list', { name: '测点列表' }).getByRole('listitem')).toHaveCount(1);
});

test('巡检中断后可重新启动，显示进度并恢复结果', async ({ page }) => {
  await mockApi(page);
  let state: Record<string, unknown> = {
    running: null, inspection: null, stations: [],
    latest_attempt: { id: 'interrupted-run', status: 'interrupted', finished_at: '2026-11-09T08:30:00+08:00', total_stations: 3, completed_stations: 1 },
  };
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
  await expect(page.getByRole('alert')).toContainText('巡检已中断');
  const input = page.getByRole('textbox', { name: '输入监测问题' });
  await input.fill('保留我的调查问题');
  await page.getByRole('button', { name: '开始巡检' }).click();
  await expect(page.getByRole('button', { name: '巡检中 1/3' })).toBeDisabled();
  expect(startCount).toBe(1);

  state = inspection;
  await expect(page.getByRole('heading', { name: /1 个.*建议调查/ })).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole('button', { name: '重新巡检' })).toBeEnabled();
  await expect(input).toHaveValue('保留我的调查问题');
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
  await expect(page.getByRole('alert')).toContainText('本次巡检未更新结果', { timeout: 10000 });
  await expect(page.getByRole('alert')).toContainText('当前显示上次记录');
  await expect(page.getByRole('button', { name: '查看 测试点 A' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新巡检' })).toBeEnabled();
  await page.waitForTimeout(2500);
  expect(reads).toBe(initialReads + 1);
  expect(maximumRequests).toBe(1);
  expect(abortedRequests).toEqual([]);
});

test('测点列表把建议调查的排在前面，可按状态筛选和搜索', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: inspection }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=stations');

  const rows = page.getByRole('list', { name: '测点列表' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('测试点 A');
  await expect(rows.last()).toContainText('测试点 B');

  await page.getByRole('radio', { name: '数据待核查' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('测试点 C');

  await page.getByRole('radio', { name: '全部' }).click();
  await page.getByRole('searchbox', { name: '搜索测点' }).fill('点 B');
  await expect(rows).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('调查记录写出涉及的测点和结论，点击回到那次对话', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [
    { session_id: 'report-session', station_name: '测试点 A', status: '需人工复核' },
    { session_id: 'report-session', station_name: '测试点 B', status: '未见明显变化' },
  ] }));
  await page.goto('/?page=records');

  const records = page.getByRole('region', { name: '调查记录' });
  await expect(records.getByText('测试点 A、测试点 B · 需人工复核')).toBeVisible();
  await records.getByText('测试分组巡检').click();
  await expect(page).toHaveURL(/threadId=report-session/);
  await expect(page).not.toHaveURL(/page=records/);
  await expect(page.getByText(report.conclusion)).toBeVisible();
});
