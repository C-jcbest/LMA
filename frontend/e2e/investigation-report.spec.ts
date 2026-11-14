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
  type: 'tool', id: `${id}-result`, tool_call_id: id, name: 'get_displacement', content: '模型专用内容不得展示', status: 'success',
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

const conclusions = {
  stations: [
    { station_uuid: '22222222-2222-2222-2222-222222222222', station_name: '测试点 B', status: '未见明显变化', reason: '三个方向均无持续变化', begin_time: support.begin_time, end_time: support.end_time, evidence: ['E123abc'] },
    { station_uuid: support.station_uuid, station_name: '测试点 A', status: '需人工复核', reason: '长期同向变化', begin_time: support.begin_time, end_time: support.end_time, evidence: ['E123abc'] },
  ],
};
// 只登记结论、没有正文时，界面用各测点原因补出的文字。
const fallbackText = '测试点 A（需人工复核）：长期同向变化';

const messages = [
  { type: 'human', id: 'question-1', content: '测试点 A 最近怎么样？' },
  { type: 'ai', id: 'query-1', content: [], tool_calls: [
    { id: 'gnss-long', name: 'get_displacement', args: {} },
    { id: 'gnss-short', name: 'get_displacement', args: {} },
  ] },
  gnssResult('gnss-long', '2026-08-01 00:00:00'),
  gnssResult('gnss-short', '2026-11-01 00:00:00'),
  { type: 'ai', id: 'report-1', content: [], tool_calls: [{ id: 'report-call', name: 'record_conclusions', args: {} }] },
  {
    type: 'tool', id: 'report-result', tool_call_id: 'report-call', name: 'record_conclusions', content: '{}', status: 'success',
    artifact: { version: 1, kind: 'conclusions', status: 'success', data: conclusions },
  },
];

const stationTimeline = {
  station_uuid: '测试点 A', station_name: '测试点 A', group_name: 'K3 分组',
  series: gnssResult('timeline', '2026-11-01 00:00:00').artifact.data,
  records: [{
    session_id: 'report-session', anchor_id: 'question-1', session_name: '测试分组巡检', status: '需人工复核',
    reason: '长期同向变化', created_at: '2026-11-08T00:00:00Z',
  }],
};

const GROUPS: Record<string, string> = { 建议调查: '需要处理', 未见明显变化: '平稳', 数据不足: '数据问题' };
// 当前判断由服务端给出（station_judgment.py）；这里按巡检结果构造，调查之后有新变化的行另行覆盖。
const inspectionRow = (name: string, screening: string, fields: Record<string, unknown> = {}) => ({
  station_uuid: name, station_name: name, group_name: 'K3 分组', screening, reasons: [], metrics: {},
  trend: [0, 1, 2, 3], previous_screening: null, last_conclusion: null,
  current: {
    status: screening, source: '巡检', at: '2026-11-09T08:30:00+08:00', reason: '', group: GROUPS[screening],
    changed_since_investigation: false, session_id: null,
  },
  ...fields,
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
      reasons: ['近 90 天持续同向变化：北向 -11.9 mm'], previous_screening: '未见明显变化',
      metrics: { net_change_mm: { n: -11.9, e: 5, u: 0 } },
      last_conclusion: { status: '持续关注', reason: '缓慢累积', session_id: 'report-session', created_at: '2026-11-08T00:00:00Z' },
      current: {
        status: '建议调查', source: '巡检', at: '2026-11-09T08:30:00+08:00', reason: '近 90 天持续同向变化：北向 -11.9 mm',
        group: '需要处理', changed_since_investigation: true, session_id: null,
      },
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
}

const inspector = (page: Page) => page.locator('[data-station-inspector]');

/** 章节式正文引用长、短两个窗口；结论登记只作为留档数据随同提交。 */
const proseHistory = () => {
  const withEvidence = (result: ReturnType<typeof gnssResult>, evidenceId: string) => ({
    ...result, artifact: { ...result.artifact, evidence_id: evidenceId },
  });
  return [
    messages[0],
    messages[1],
    withEvidence(gnssResult('gnss-long', '2026-08-01 00:00:00'), 'Elong'),
    withEvidence(gnssResult('gnss-short', '2026-11-01 00:00:00'), 'Eshort'),
    {
      type: 'ai', id: 'report-1', content: [
        '## 调查结论', '', '测试点 A 需要优先复核，测试点 B 未见明显变化。', '',
        '### 一、数据现象', '', '长期窗口北向持续同向变化。[Elong](#evidence-Elong)', '',
        '近期北向净变化约 2 mm。[99](#evidence-Eshort) 与长期趋势一致。[Elong](#evidence-Elong)', '',
        '### 二、滑坡推断', '', '可能与坡体缓慢变形有关。',
      ].join('\n'),
      tool_calls: [{ id: 'report-call', name: 'record_conclusions', args: {} }],
    },
    messages[5],
  ];
};

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

test('调查记录在测点对话栏打开并定位追问', async ({ page }) => {
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
    ...stationTimeline, records: [{ ...stationTimeline.records[0], anchor_id: 'followup' }],
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?station=测试点 A');
  await page.getByRole('button', { name: /需人工复核.*长期同向变化/ }).click();
  // 不离开测点页：窄屏切到 AI 调查，在测点自己的对话栏里打开那次调查。
  await expect(page).toHaveURL(/station=/);
  await expect(page.getByRole('radio', { name: 'AI 调查', exact: true })).toHaveAttribute('aria-checked', 'true');
  const target = page.getByText('接下来观察什么？');
  await expect(target).toBeInViewport();
  await expect(page).toHaveURL(/stationThread=report-session/);
  await expect(page.getByRole('main').getByText('测试分组巡检', { exact: true })).toBeVisible();
  await page.reload();
  await expect(target).toBeInViewport();
  await expect(page.getByRole('radio', { name: 'AI 调查', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: '开始新的测点调查' }).click();
  await expect(page).not.toHaveURL(/stationThread=/);
  await expect(target).toHaveCount(0);
  await page.goBack();
  await expect(target).toBeInViewport();
  await page.getByRole('radio', { name: '数据', exact: true }).click();
  await expect(page.getByRole('button', { name: /需人工复核.*长期同向变化/ })).toHaveAttribute('aria-current', 'true');
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
  // 框选后在选区上方就地出现追问按钮，不需要先缩放。
  const ask = data.getByRole('toolbar', { name: '所选时间段' }).getByRole('button', { name: '问这段' });
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
  const composer = page.getByRole('textbox', { name: '输入监测问题' });
  await expect(composer).toHaveValue('也看一下东向');
  const askTargets = page.getByRole('list', { name: '追问对象' });
  await expect(askTargets.getByRole('listitem')).toHaveText([/^测试点 A · 11月\d+日/]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  // 发送时追问对象作为结构化字段提交，正文不夹带测点编号和时间；发出后标签清空。
  let runBody: { messages: { content: unknown }[]; ask_targets: { station_uuid: string; start: string; end: string }[] } | undefined;
  await page.route('**/api/sessions', (route) => route.fulfill({ json: { ...session, id: 'station-ask-session' } }));
  await page.route('**/api/sessions/station-ask-session', (route) => route.fulfill({ json: { ...session, id: 'station-ask-session' } }));
  await page.route('**/api/title', (route) => route.fulfill({ json: { title: '追问' } }));
  await page.route('**/api/sessions/station-ask-session/runs', (route) => {
    runBody = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: { detail: '测试故障' } });
  });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => runBody?.ask_targets.length).toBe(1);
  expect(runBody!.ask_targets[0]!.station_uuid).toBe(support.station_uuid);
  expect(Date.parse(runBody!.ask_targets[0]!.start)).toBeLessThan(Date.parse(runBody!.ask_targets[0]!.end));
  expect(JSON.stringify(runBody!.messages)).not.toContain('测试点 A');
  await expect(askTargets).toHaveCount(0);
});

test('测点状态、复制导出及引用定位依据时间窗口', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockApi(page);
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: proseHistory() }, latest_run: null } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?threadId=report-session');

  // 判断头按优先级排列：状态、测点、时段和原因直接可见，点测点名打开该测点依据。
  const heads = page.locator('.judgment-head');
  await expect(heads).toHaveCount(2);
  await expect(heads.first()).toContainText('需人工复核');
  await expect(heads.first()).toContainText('长期同向变化');
  await expect(heads.first().getByRole('button', { name: '查看 测试点 A 的依据' })).toBeVisible();
  await expect(page.getByText('模型专用内容不得展示')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /已调查 1 个测点 · 2 项查询/ })).toBeVisible();

  const copy = page.locator('[data-role="assistant"]').last().getByRole('button', { name: '复制', exact: true });
  await copy.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('测点状态：测试点 A：需人工复核；测试点 B：未见明显变化');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('### 一、数据现象');
  expect(copied).toContain('## 依据');
  expect(copied).not.toContain('#evidence-');

  // 位移引用不再另开曲线：滚动到该测点的时间轴卡并切到被引用的窗口。
  const card = page.locator('[data-slot="evidence-card"]').filter({ hasText: '测试点 A 时间轴' });
  const longTab = card.getByRole('tab', { name: /94 天/ });
  const shortTab = card.getByRole('tab', { name: /11-01~11-03/ });
  await page.getByRole('button', { name: /查看依据 1：/ }).first().click();
  await expect(longTab).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /查看依据 2：/ }).first().click();
  await expect(shortTab).toHaveAttribute('aria-selected', 'true');
  await expect(card).toBeInViewport();
  // 在卡片里换窗口后，再点相同引用仍应回到被引用的窗口。
  await longTab.click();
  await page.getByRole('button', { name: /查看依据 2：/ }).first().click();
  await expect(shortTab).toHaveAttribute('aria-selected', 'true');
  // 放大入口打开依据面板，停在卡片当前的窗口。
  await card.getByRole('button', { name: '展开测试点 A 时间轴' }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await expect(inspector(page).getByRole('radio', { name: /11-01 至 11-03/ })).toHaveAttribute('aria-checked', 'true');
});

test('天气和计算引用直接打开对应依据，用户消息显示追问对象', async ({ page }) => {
  await mockApi(page);
  const weather = {
    type: 'tool', id: 'weather-result', tool_call_id: 'weather', name: 'query_weather', content: '模型专用内容不得展示', status: 'success',
    artifact: { version: 1, kind: 'weather', status: 'success', evidence_id: 'Ewea', data: {
      ok: true, location: { station_uuid: support.station_uuid, station_name: '测试点 A', latitude: 30.1, longitude: 103.5 },
      query: { timezone: 'Asia/Shanghai', history_start_date: '2026-10-26', history_end_date: '2026-10-28', forecast_days: 0 },
      history: { daily: { time: ['2026-10-26', '2026-10-27', '2026-10-28'], precipitation_sum: [3, 18.2, 6] } },
    } },
  };
  const computation = {
    type: 'tool', id: 'compute-result', tool_call_id: 'compute', name: 'compute', content: '模型专用内容不得展示', status: 'success',
    artifact: { version: 1, kind: 'computation', status: 'success', evidence_id: 'Ecmp', data: {
      description: '降雨前后北向变化对比', code: 'result = {}', inputs: [], result: { 降雨前_mm: 1.2, 降雨后_mm: 2.8 }, truncated: false,
    } },
  };
  const history = [
    { type: 'human', id: 'question-1', content: '这段时间发生了什么？', additional_kwargs: { metadata: { ask_targets: [{
      station_uuid: support.station_uuid, station_name: '测试点 A', start: '2026-10-27T00:00+08:00', end: '2026-10-29T00:00+08:00',
    }] } } },
    { type: 'ai', id: 'query-1', content: [], tool_calls: [
      { id: 'gnss-long', name: 'get_displacement', args: {} },
      { id: 'weather', name: 'query_weather', args: {} },
      { id: 'compute', name: 'compute', args: {} },
    ] },
    { ...gnssResult('gnss-long', '2026-08-01 00:00:00'), artifact: { ...gnssResult('gnss-long', '2026-08-01 00:00:00').artifact, evidence_id: 'Elong' } },
    weather, computation,
    { type: 'ai', id: 'answer-1', content: '北向持续变化。[1](#evidence-Elong)\n\n10 月 27 日降雨 18.2 mm。[2](#evidence-Ewea) 降雨后北向变化略大。[3](#evidence-Ecmp)' },
  ];
  await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: history }, latest_run: null } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?threadId=report-session');

  await expect(page.locator('[data-role="user"]').getByRole('list', { name: '追问对象' })).toHaveText('测试点 A · 10月27日–10月28日');
  // 卡片标题写明对象和时间，编号只留在句末引用上。
  await expect(page.locator('[data-slot="evidence-card"]').filter({ hasText: '测试点 A 同期天气' })).toContainText('10-26 至 10-28');
  await expect(page.locator('[data-slot="evidence-card"]').filter({ hasText: /\[\d\]/ })).toHaveCount(0);

  await page.getByRole('button', { name: /查看依据 2：/ }).click();
  await expect(inspector(page).getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await expect(inspector(page).getByRole('tab', { name: '天气', exact: true })).toHaveAttribute('aria-selected', 'true');

  // 不属于测点的计算结果在同一面板里打开，而不是另起弹窗。
  await page.getByRole('button', { name: /查看依据 3：/ }).click();
  await expect(inspector(page).getByRole('heading', { name: '降雨前后北向变化对比' })).toBeVisible();
  await expect(inspector(page).getByRole('cell', { name: '2.8' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await inspector(page).getByRole('button', { name: '关闭依据' }).click();
  await expect(inspector(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /查看依据 3：/ })).toBeFocused();
});

for (const width of [320, 390, 1440]) {
  test(`${width}px 调查过程在回答顶部、一个测点一张时间轴卡，核查后返回阅读位置`, async ({ page }) => {
    await mockApi(page);
    await page.route('**/api/sessions/report-session/state', (route) => route.fulfill({ json: { values: { messages: proseHistory() }, latest_run: null } }));
    const chartErrors: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('[ECharts]')) {
        chartErrors.push(message.text());
      }
    });
    let runs = 0;
    await page.route('**/api/sessions/*/runs', (route) => {
      runs += 1;
      return route.abort();
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/?threadId=report-session');
    // 两个窗口、三次引用只合成一张时间轴卡，窗口作为卡内标签。
    const cards = page.locator('[data-slot="evidence-card"]');
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'open');
    await expect(cards.nth(0).getByRole('tab')).toHaveCount(2);
    await cards.nth(0).scrollIntoViewIfNeeded();
    await expect(cards.nth(0).locator('canvas')).toBeVisible();
    const answer = page.getByText('测试点 A 需要优先复核，测试点 B 未见明显变化。', { exact: true });
    const process = page.locator('[data-slot="investigation"]');
    // 调查过程在回答顶部，收起时只有一行；判断头紧随其后，正文在判断头之后。
    const processBox = (await process.boundingBox())!;
    expect(processBox.y).toBeLessThan((await answer.boundingBox())!.y);
    const processRow = (await process.getByRole('button', { name: /已调查 1 个测点/ }).boundingBox())!;
    expect(processRow.height).toBeLessThan(60);
    const judgment = (await page.locator('.judgment-head').first().boundingBox())!;
    expect(judgment.y).toBeGreaterThan(processRow.y);
    expect(judgment.y).toBeLessThan((await answer.boundingBox())!.y);
    await answer.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/answer-${width}.png`, animations: 'disabled' });
    await cards.nth(0).getByRole('tab', { name: /11-01~11-03/ }).click();
    const entry = cards.nth(0).getByRole('button', { name: '展开测试点 A 时间轴', exact: true });
    // 输入框固定在底部；先滚到按钮可点击的位置，再记录实际打开时的阅读位置。
    await entry.click({ trial: true });
    const entryTop = (await entry.boundingBox())!.y;
    await page.screenshot({ path: `test-results/reading-${width}.png`, animations: 'disabled' });
    await entry.click();
    await expect(inspector(page).getByRole('radio', { name: /11-01 至 11-03/ })).toHaveAttribute('aria-checked', 'true');
    await inspector(page).getByRole('button', { name: '关闭依据' }).click();
    await expect(inspector(page)).toHaveCount(0);
    await expect(entry).toBeFocused();
    if (width < 1024) {
      await expect.poll(async () => Math.abs((await entry.boundingBox())!.y - entryTop)).toBeLessThan(3);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(runs).toBe(0);
    expect(chartErrors).toEqual([]);
  });
}

test('今日页按当前判断分组，点击进入测点页直接看数据，不调用模型', async ({ page }) => {
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

  await expect(page.getByRole('heading', { name: '3 个测点，1 个需要处理' })).toBeVisible();
  expect(await page.getByRole('region', { name: '今日页面', exact: true }).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(page.getByRole('region', { name: '需要处理' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('region', { name: '数据问题' }).getByRole('listitem')).toHaveCount(1);
  // 调查之后巡检又发现变化：用巡检结果并提示，标签写明来源与日期。
  await expect(page.getByText('上次调查后有新变化')).toBeVisible();
  await expect(page.getByRole('region', { name: '需要处理' })).toContainText('11-09 巡检');
  await expect(page.getByRole('region', { name: '需要处理' })).toContainText('mm 水平');
  await expect(page.getByRole('button', { name: /其余 1 个未见明显变化.*全部测点/ })).toBeVisible();

  await page.getByRole('button', { name: '查看 测试点 A' }).click();
  await expect(page).toHaveURL(/station=/);
  await expect(page.getByRole('heading', { name: '测试点 A' })).toBeVisible();
  await expect(page.getByText('北向本窗口变化')).toBeVisible();
  await expect(page.getByRole('img', { name: '测试点 A 位移时间轴' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  expect(runRequests).toBe(0);

  await page.getByRole('radio', { name: '30 天' }).click();
  await expect.poll(() => timelineQueries.at(-1)).toBe('?days=30');

  // 历次调查在测点页自己的对话面板里打开，窄屏切到对话显示那次的结论。
  await page.getByRole('button', { name: /需人工复核.*长期同向变化/ }).click();
  await expect(page).toHaveURL(/station=/);
  await expect(page.getByRole('complementary', { name: 'AI 调查' }).getByText(fallbackText)).toBeVisible();
  expect(runRequests).toBe(0);
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
  await expect(page.getByRole('heading', { name: /1 个需要处理/ })).toBeVisible({ timeout: 6000 });
  await expect(page.getByRole('button', { name: '重新巡检' })).toBeEnabled();
  await expect(input).toHaveValue('保留我的调查问题');
  await expect(page.getByRole('textbox', { name: '输入监测问题' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
