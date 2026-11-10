import { expect, test, type Page } from '@playwright/test';

// 只替换 API 返回，页面、会话运行时和布局均使用生产实现；数据为自动化测试数据。
const session = {
  id: 'report-session', name: '测试分组巡检', archived: false,
  created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
};

const axisSummary = { count: 2, change: 0.002 };
const support = {
  evidence_id: 'E123abc', station_uuid: '11111111-1111-1111-1111-111111111111',
  begin_time: '2026-11-01 00:00:00', end_time: '2026-11-03 00:00:00',
  claim: 'numeric_change', axis: 'n', rationale: '北向窗口净变化支持该发现',
};

const gnssResult = (id: string, beginTime: string) => ({
  type: 'tool', id: `${id}-result`, tool_call_id: id, name: 'get_daily_gnss_data', content: '模型专用内容不得展示', status: 'success',
  artifact: {
    version: 1, kind: 'gnss_series', status: 'success',
    data: {
      station_uuid: support.station_uuid,
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
    { station_uuid: '22222222-2222-2222-2222-222222222222', begin_time: support.begin_time, end_time: support.end_time, supports: [{ ...support, station_uuid: '22222222-2222-2222-2222-222222222222' }], station_name: '测试点 B', status: '未见明显变化', reason: '三个方向均无持续变化', acceleration: '未见持续加速', data_quality: '数据完整' },
    { station_uuid: support.station_uuid, begin_time: support.begin_time, end_time: support.end_time, supports: [support], station_name: '测试点 A', status: '需人工复核', reason: '长期同向变化', acceleration: '无法判断', data_quality: '一次缺测' },
  ],
  findings: [
    { level: 'fact', text: '北向净变化约 2 mm', supports: [support], evidence: ['gnss-short'] },
    { level: 'analysis', text: '长期趋势仍在延续', supports: [support], evidence: ['gnss-long', 'gnss-short'] },
    { level: 'inference', text: '可能与坡体缓慢变形有关', supports: [support], evidence: ['gnss-short'] },
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
    session_id: 'report-session', anchor_id: 'report-call', session_name: '测试分组巡检', status: '需人工复核',
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
  await page.route('**/api/stations', (route) => route.fulfill({ json: inspection.stations.map(({ station_uuid, station_name, group_name }) => ({ station_uuid, station_name, group_name })) }));
  await page.route('**/api/inspections/latest', (route) => route.fulfill({
    json: { running: null, latest_attempt: null, inspection: null, stations: [] },
  }));
  await page.route('**/api/sessions/conclusions', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sessions?*', (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.has('station_uuid') ? [] : [session] }));
  await page.route('**/api/sessions/report-session', (route) => route.fulfill({ json: session }));
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({
    json: { values: { messages }, latest_run: { id: 'run-1', status: 'success' } },
  }));
  await page.route('**/api/sessions/*/investigations', (route) => route.fulfill({ json: [] }));
}

const inspector = (page: Page) => page.locator('[data-station-inspector]');

test('今日列表按页面宽度排列测点、趋势和变化量', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: inspection }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const row = page.getByRole('button', { name: '查看 测试点 A', exact: true });
  await expect(row).toBeVisible();
  const columns = () => row.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
  expect(await columns()).toBe(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(columns).toBe(2);
  expect(await page.getByRole('region', { name: '今日页面', exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('首页提问创建独立调查，原会话草稿不被覆盖', async ({ page }) => {
  await mockApi(page);
  let created = 0;
  const runs: string[] = [];
  await page.route('**/api/sessions', (route) => {
    created += 1;
    return route.fulfill({ json: { ...session, id: 'new-home-session' } });
  });
  await page.route('**/api/sessions/new-home-session', (route) => route.fulfill({ json: { ...session, id: 'new-home-session' } }));
  await page.route('**/api/title', (route) => route.fulfill({ json: { title: '新调查' } }));
  await page.route('**/api/sessions/*/runs', (route) => {
    runs.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 503, json: { detail: '测试故障' } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?threadId=report-session');
  const composer = page.getByRole('textbox', { name: '输入监测问题' });
  await composer.fill('原会话未完成的草稿');
  await page.getByRole('button', { name: '今日', exact: true }).click();
  expect(created).toBe(0);
  await expect(composer).toHaveValue('');
  await composer.fill('调查一个新的问题');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => runs).toEqual(['/api/sessions/new-home-session/runs']);
  expect(created).toBe(1);
  await page.getByRole('button', { name: '测试分组巡检', exact: true }).click();
  await expect(composer).toHaveValue('原会话未完成的草稿');
  await expect(page.locator('.aui-message-error-root')).toHaveCount(0);
});

test('390px 会话加载失败不挡住测点数据，局部重试恢复调查', async ({ page }, testInfo) => {
  await mockApi(page);
  let failSessions = true;
  await page.route('**/api/sessions?*', (route) => {
    if (new URL(route.request().url()).searchParams.has('station_uuid')) {
      return route.fulfill(failSessions ? { status: 503, json: { detail: '测试故障' } } : { json: [] });
    }
    return route.fulfill({ json: [session] });
  });
  await page.route('**/api/stations/*/timeline?*', (route) => route.fulfill({ json: stationTimeline }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?station=A');
  await expect(page.getByRole('region', { name: '测点数据' })).toBeVisible();
  await expect(page.getByText('北向净变化', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: '测试点 A 位移时间轴' }).locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('测点局部失败-数据仍可用-390px.png') });
  await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('调查记录尚未载入');
  failSessions = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeEnabled();
  await page.getByRole('radio', { name: '数据', exact: true }).click();
  await expect(page.getByText('北向净变化', { exact: true })).toBeVisible();
});

test('完成的调查不显示虚假的待解决事项', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/sessions/*/investigations', (route) => route.fulfill({ json: [{
    id: 'completed-investigation', status: 'completed', progress: {
      goal: '复核测点 A', covered: ['A'], unresolved: [], stage_conclusion: '已完成复核',
      targets: [{ target_id: 'A', question: '复核测点 A' }],
    },
  }] }));
  await page.goto('/?threadId=report-session');
  await page.getByText('调查进度', { exact: true }).click();
  await expect(page.getByText('已完成复核', { exact: true })).toBeVisible();
  await expect(page.getByText('待解决：尚未记录', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '继续调查', exact: true })).toHaveCount(0);
});

test('320px 独立数值证据可查看两窗口与共同有效时段，无需视觉结果', async ({ page }) => {
  await mockApi(page);
  const feature = { count: 4, net_change_mm: 3, robust_slope_mm_day: 1, max_step_mm: 1,
    begin_time: '2026-11-02 00:00:00', end_time: '2026-11-03 00:00:00',
    jump_persistence: '待观察', method: 'Theil–Sen', limitations: [] };
  const history = [
    { type: 'human', id: 'numerical-question', content: '复核数值' },
    { type: 'ai', id: 'numerical-call', content: [], tool_calls: [{ id: 'numeric-1', name: 'analyze_gnss_numerically', args: {} }] },
    { type: 'tool', id: 'numerical-result', tool_call_id: 'numeric-1', name: 'analyze_gnss_numerically', status: 'success', content: '{}',
      artifact: { version: 1, kind: 'numerical', status: 'success', data: {
        station_uuid: '11111111-1111-1111-1111-111111111111', station_name: '测试点 A', sampling: 'hourly', points: [],
        begin_time: '2026-11-01 00:00:00', end_time: '2026-11-04 00:00:00', features: { n: feature },
        comparisons: { n: { first: feature, second: feature, velocity_difference_mm_day: null, speed_ratio: null, limitation: '倍率不构成加速结论' },
          station_names: { b: '测试点 B' }, common_period: { n: { b: feature } } },
      } } },
    { type: 'ai', id: 'numerical-answer', content: '数值复核完成，末端仍待观察。' },
  ];
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: history }, latest_run: null } }));
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?threadId=report-session');
  await page.getByRole('button', { name: '查看 测试点 A 的依据', exact: true }).click();
  await expect(inspector(page).getByText('两个窗口比较')).toBeVisible();
  await expect(inspector(page).getByText('共同有效时段比较')).toBeVisible();
  await expect(inspector(page).getByText('测试点 B', { exact: true })).toBeVisible();
  expect(await inspector(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test('调查进度保留覆盖范围，继续调查由用户点击后发送且不覆盖草稿', async ({ page }, testInfo) => {
  await mockApi(page);
  const investigationId = '44444444-4444-4444-4444-444444444444';
  await page.route('**/api/sessions/*/investigations', (route) => route.fulfill({ json: [{
    id: investigationId, status: 'interrupted', progress: {
      goal: '复核两个测点', covered: ['A'], unresolved: ['B尚未复核'], stage_conclusion: 'A已完成',
      targets: ['A', 'B'].map((key) => ({
        target_id: key, station_uuid: key, question: `复核测点${key}`, evidence_ids: [],
        outcome: key === 'A' ? 'answered' : 'pending', result: key === 'A' ? 'A已完成' : '',
        begin_time: '2026-11-01T00:00:00', end_time: '2026-11-08T00:00:00',
      })),
    },
  }] }));
  const requests: Array<{ messages: Array<{ content: string }>; resume_investigation_id: string }> = [];
  await page.route('**/api/sessions/*/runs', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { detail: '测试执行服务暂不可用' } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?threadId=report-session');
  await page.getByText('调查进度', { exact: true }).click();
  await expect(page.getByText('已覆盖：1 / 2 项')).toBeVisible();
  await expect(page.getByText(/待调查：复核测点B/)).toBeVisible();
  await expect(page.getByText(/待调查：复核测点A/)).toHaveCount(0);
  const composer = page.getByRole('textbox', { name: '输入监测问题' });
  await composer.fill('我还没写完的问题');
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: '继续调查', exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]!.messages[0]!.content).toBe('继续调查');
  expect(requests[0]!.resume_investigation_id).toBe(investigationId);
  await expect(page.getByText(investigationId, { exact: false })).toHaveCount(0);
  await expect(composer).toHaveValue('我还没写完的问题');
  await expect(page.getByRole('alert')).toContainText('本次回答未完成');
  await expect(page.locator('.aui-message-error-root')).toHaveCount(0);
  await page.getByRole('radio', { name: '深色主题', exact: true }).click();
  await expect(page.getByRole('radio', { name: '深色主题', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.locator('[data-role=user]').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('续查与局部反馈-390px.png') });
});

test('数据分析使用九月正文模板，正文引用仍可打开当前依据', async ({ page }, testInfo) => {
  await mockApi(page);
  const evidence = gnssResult('gnss-short', '2026-11-01 00:00:00');
  const history = [
    messages[0], messages[1],
    { ...evidence, artifact: { ...evidence.artifact, evidence_id: 'E123abc' } },
    { type: 'ai', id: 'markdown-report', content: '## 调查结论\n\n**测试点 A 需要持续关注。** 北向仍有同向变化，近期未见持续加速。\n\n### 一、数据现象\n\n北向本时段净变化约 **2 mm**。[1](#evidence-E123abc)\n\n### 二、滑坡推断\n\n这种变化可能与坡体缓慢变形有关。\n\n### 三、建议与风险提示\n\n- 继续观察长期趋势，并核查观测墩状态。' },
  ];
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: history }, latest_run: null } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?threadId=report-session');
  await expect(page.getByRole('heading', { name: '调查结论' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '一、数据现象' })).toBeVisible();
  await expect(page.getByText('E123abc', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /查看依据 1/ }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await page.getByRole('button', { name: '关闭依据' }).click();
  await expect(page.getByRole('button', { name: /查看依据 1/ })).toBeFocused();
  await page.locator('[data-slot=aui_thread-viewport]').evaluate((element) => { element.scrollTop = 0; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await page.screenshot({ path: testInfo.outputPath('九月模板-390px.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole('heading', { name: '调查结论' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('九月模板-1440px.png'), fullPage: true });
});

test('今日切换测点只恢复各自最新调查，草稿互不串站且浏览不创建会话', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/inspections/latest', (route) => route.fulfill({ json: { ...inspection, stations: inspection.stations.map((row) => ({ ...row, screening: '建议调查' })) } }));
  const stationSessions = { A: { ...session, id: 'station-A', name: 'A 的调查' }, B: { ...session, id: 'station-B', name: 'B 的调查' } };
  await page.route('**/api/sessions?*', (route) => {
    const station = new URL(route.request().url()).searchParams.get('station_uuid');
    const selected = station?.endsWith('A') ? stationSessions.A : stationSessions.B;
    return route.fulfill({ json: station ? [selected] : [session] });
  });
  await page.route('**/api/sessions/station-*', (route) => {
    const name = route.request().url().endsWith('A') ? 'A' : 'B';
    return route.fulfill({ json: stationSessions[name] });
  });
  await page.route('**/api/sessions/station-*/state', (route) => {
    const name = route.request().url().includes('station-A') ? 'A' : 'B';
    return route.fulfill({ json: { values: { messages: [{ type: 'human', id: `q-${name}`, content: `分析测试点 ${name}` }, { type: 'ai', id: `a-${name}`, content: `这是测试点 ${name} 的最新调查` }] }, latest_run: null } });
  });
  await page.route('**/api/stations/*/timeline*', (route) => {
    const name = decodeURIComponent(route.request().url()).includes('测试点 A') ? '测试点 A' : '测试点 B';
    return route.fulfill({ json: { ...stationTimeline, station_uuid: name, station_name: name, series: { ...stationTimeline.series, station_name: name } } });
  });
  let creations = 0;
  await page.route('**/api/sessions', (route) => { creations += 1; return route.abort(); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=home&threadId=report-session');
  await page.getByRole('button', { name: '查看 测试点 A', exact: true }).click();
  await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
  await expect(page.getByText('这是测试点 A 的最新调查')).toBeVisible();
  await expect(page.getByText(report.conclusion)).toHaveCount(0);
  await page.getByRole('textbox', { name: '输入监测问题' }).fill('A 的草稿');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '查看 测试点 B', exact: true }).click();
  await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
  await expect(page.getByText('这是测试点 B 的最新调查')).toBeVisible();
  await expect(page.getByText('这是测试点 A 的最新调查')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toHaveValue('');
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '查看 测试点 A', exact: true }).click();
  await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toHaveValue('A 的草稿');
  expect(creations).toBe(0);
});

for (const scenario of ['单点', '全部平稳', '资料有限']) {
  test(`简报状态：${scenario}`, async ({ page }, testInfo) => {
    await mockApi(page);
    const variant = structuredClone(report);
    if (scenario === '单点') {
      variant.stations = [report.stations[1]!];
      variant.conclusion = '测试点 A 的长期同向变化需要复核。';
    } else if (scenario === '全部平稳') {
      variant.conclusion = '本次两个测点均未见明显变化。';
      variant.stations = report.stations.map((station) => ({ ...station, status: '未见明显变化', reason: '三个方向均无持续变化', acceleration: '未见持续加速', data_quality: '数据完整' }));
      variant.findings = [];
      variant.next_steps = [];
    } else {
      variant.conclusion = '测试点 A 最近 48 小时缺少监测记录。';
      variant.stations = [{ ...report.stations[1]!, status: '数据不足', reason: '最近 48 小时没有数据', data_quality: '缺少近期记录' }];
      variant.findings = [];
      variant.next_steps = ['检查测点采集与传输记录'];
    }
    const history = messages.map((message) => message.id === 'report-result'
      ? { ...message, artifact: { version: 1, kind: 'investigation_report', status: 'success', data: variant } }
      : message);
    await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: history }, latest_run: null } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?threadId=report-session');
    const reportRegion = page.getByRole('region', { name: '调查简报' });
    await expect(reportRegion.getByText(variant.conclusion)).toBeVisible();
    if (scenario === '全部平稳') {
      await expect(reportRegion.locator('summary')).toHaveText('2 个测点未见明显变化');
      await reportRegion.locator('summary').click();
      await expect(reportRegion.getByText('三个方向均无持续变化')).toHaveCount(2);
    } else {
      await expect(reportRegion.getByText('2 个测点未见明显变化', { exact: true })).toHaveCount(0);
      await expect(reportRegion.getByRole('heading', { name: '查看 测试点 A 的依据' })).toBeVisible();
    }
    await expect(reportRegion.getByText('无法判断', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.locator('[data-slot=aui_thread-viewport]').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`简报-${scenario}.png`), fullPage: true });
  });
}

for (const anchor of ['report-call', 'plain-answer']) {
  test(`调查记录定位 ${anchor}，而不是会话末尾`, async ({ page }) => {
    await mockApi(page);
    const history = [
      ...messages,
      { type: 'human', id: 'followup', content: '接下来观察什么？' },
      { type: 'ai', id: 'plain-answer', content: '继续观察北向趋势。' },
      { type: 'human', id: 'latest-question', content: '展开说明' },
      { type: 'ai', id: 'latest-answer', content: Array.from({ length: 50 }, (_, index) => `${index + 1}. 后续分析内容`).join('\n') },
    ];
    await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: history }, latest_run: null } }));
    await page.route('**/api/stations/*/timeline*', (route) => route.fulfill({ json: {
      ...stationTimeline, records: [{ ...stationTimeline.records[0], anchor_id: anchor }],
    } }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?station=测试点 A');
    await page.getByRole('button', { name: /需人工复核.*长期同向变化/ }).click();
    await expect(page).toHaveURL(new RegExp(`result=${anchor}`));
    const target = anchor === 'report-call' ? page.getByText(report.conclusion) : page.getByText('继续观察北向趋势。');
    await expect(target).toBeInViewport();
  });
}

test('未巡检也可浏览测点，进入详情返回保留搜索与会话', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/stations/*/timeline*', (route) => route.fulfill({ json: stationTimeline }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?page=stations&threadId=report-session');
  const search = page.getByRole('searchbox', { name: '搜索测点' });
  await search.fill('点 A');
  const rows = page.getByRole('list', { name: '测点列表' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('未巡检');
  await rows.first().getByRole('button').click();
  await expect(page).toHaveURL(/threadId=report-session/);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  await expect(search).toHaveValue('点 A');
  await expect(rows).toHaveCount(1);
});

test('窄屏切换调查保留数据滚动、图表选区与追问草稿', async ({ page }) => {
  await mockApi(page);
  await page.route('**/api/stations/*/timeline*', (route) => route.fulfill({ json: stationTimeline }));
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto('/?station=测试点 A');
  const data = page.getByRole('region', { name: '测点数据' });
  const canvas = data.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + 140, { steps: 8 });
  await page.mouse.up();
  const ask = data.getByRole('button', { name: '追问这段' });
  await expect(ask).toBeVisible();
  const originalCanvas = await canvas.elementHandle();
  const scrollTop = await data.evaluate((element) => element.scrollTop);
  await page.getByRole('radio', { name: 'AI 调查', exact: true }).click();
  await page.getByRole('textbox', { name: '输入监测问题' }).fill('也看一下东向');
  await page.getByRole('radio', { name: '数据', exact: true }).click();
  await expect(ask).toBeVisible();
  expect(await data.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  expect(await canvas.evaluate((element, original) => element === original, originalCanvas)).toBe(true);
  await ask.click();
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toHaveValue(/^也看一下东向[\s\S]*测试点 A[\s\S]*这段发生了什么/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

for (const width of [320, 390, 1440]) {
  test(`${width}px 简报重点与引用触控区域`, async ({ page }, testInfo) => {
    await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' });
    await page.goto('/?threadId=report-session');
    const reportRegion = page.getByRole('region', { name: '调查简报' });
    await expect(reportRegion.getByText(report.conclusion)).toBeVisible();
    const focused = reportRegion.locator('.report-station').first();
    await expect(focused).toContainText('北向净变化约 2 mm');
    await expect(focused).toContainText('长期趋势仍在延续');
    await expect(reportRegion.getByText('三个方向均无持续变化')).not.toBeVisible();
    const citation = await reportRegion.getByRole('button', { name: /查看依据 1/ }).first().boundingBox();
    expect(citation!.width).toBeGreaterThanOrEqual(32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.locator('[data-slot=aui_thread-viewport]').evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`简报-${width}px.png`), fullPage: true });
  });
}

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
  await expect(reportRegion.getByRole('heading', { name: '建议' })).toBeVisible();
  await expect(reportRegion.getByText('三个方向均无持续变化')).not.toBeVisible();
  await reportRegion.getByText('1 个测点未见明显变化', { exact: true }).click();
  await expect(reportRegion.getByText('三个方向均无持续变化')).toBeVisible();
  await expect(reportRegion.getByText('推断', { exact: true })).toBeVisible();
  await expect(page.getByText('模型专用内容不得展示')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /已调查 1 个测点 · 2 项查询/ })).toBeVisible();

  const copy = page.locator('[data-role="assistant"]').last().getByRole('button', { name: '复制', exact: true });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('## 测试点 A');
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
  expect(await page.getByRole('region', { name: '今日页面', exact: true }).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
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
  await expect(page.getByRole('heading', { name: '1 个测点的数据待核查' })).toBeVisible();
  await expect(page.getByText('未见明显变化')).toHaveCount(0);
  await page.getByRole('button', { name: /1 个数据待核查/ }).click();
  await expect(page).toHaveURL(/page=stations/);
  await page.getByRole('radio', { name: '数据待核查' }).click();
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
