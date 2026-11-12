import type { PartState } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import { answerToMarkdown, buildSteps, collectStations } from '../src/features/monitoring/investigation';

const complete = { type: 'complete' } as const;

const toolPart = (toolName: string, fields: Record<string, unknown> = {}) => ({
  type: 'tool-call',
  toolCallId: `call-${Math.random()}`,
  toolName,
  args: {},
  argsText: '{}',
  status: complete,
  ...fields,
}) as unknown as PartState;

const gnssEnvelope = (stationName: string, points: unknown[] = [{ time: '2026-11-01 00:00:00', n: 1, e: 2, u: 3 }]) => ({
  version: 1,
  kind: 'gnss_series',
  status: 'success',
  data: {
    station_name: stationName,
    station_uuid: stationName === '测试点 B' ? 'uuid-B' : 'uuid-A',
    begin_time: '2026-11-01 00:00:00',
    end_time: '2026-11-08 00:00:00',
    timezone: 'Asia/Shanghai',
    total_points: points.length,
    returned_points: points.length,
    downsampled: false,
    points,
    summary: { n: { count: 1 }, e: { count: 1 }, u: { count: 1 }, gaps: [] },
  },
});

const stepsOf = (parts: PartState[]) => buildSteps(parts, collectStations(parts));

it('内部参数与报告纠错不冒充查询失败，保留其他站和其他窗口的真正失败', () => {
  const feedback = { version: 1, kind: 'tool_feedback', category: 'input_validation' };
  const failure = {
    version: 1, kind: 'acquisition_failure', status: 'error',
    data: { station_uuid: 'uuid-B', station_name: '测试点 B', requested_station: 'uuid-B', message: '数据服务暂不可用。',
      begin_time: '2026-10-01 00:00:00', end_time: '2026-10-31 00:00:00' },
    error: { code: 'unavailable', category: 'business', message: '数据服务暂不可用。', retryable: false },
  };
  const parts = [
    toolPart('get_displacement', { isError: true, args: { begin_time: 'too-long' }, artifact: feedback }),
    toolPart('get_displacement', { isError: true, args: { begin_time: 'still-too-long' }, artifact: feedback }),
    toolPart('record_conclusions', { isError: true, artifact: feedback }),
    toolPart('get_displacement', { isError: true, args: { station: 'uuid-B', window: 'October' }, artifact: failure }),
    toolPart('get_displacement', { args: { station: 'uuid-A', window: 'November' }, artifact: gnssEnvelope('测试点 A') }),
    toolPart('get_displacement', { args: { station: 'uuid-B', window: 'November' }, artifact: gnssEnvelope('测试点 B') }),
  ];
  expect(stepsOf(parts).map((step) => step.state)).toEqual(['failed', 'complete', 'complete']);
  expect(stepsOf(parts)[0]?.envelope?.error?.message).toBe('数据服务暂不可用。');
  expect(stepsOf(parts.slice(0, 3))).toEqual([]);
});

const conclusion = (station_uuid: string, station_name: string, status: string, reason: string) => ({
  station_uuid, station_name, status, reason,
  begin_time: '2026-11-01 00:00:00', end_time: '2026-11-08 00:00:00', evidence: [],
});

const conclusionsPart = (stations: unknown[] = []) => toolPart('record_conclusions', { artifact: {
  version: 1, kind: 'conclusions', status: 'success', data: { stations },
} });

it('正文是回答：结论登记只补测点状态，前后的正文都进入复制和导出', () => {
  const parts = [
    { type: 'text', text: '## 调查结论\n\nK3-07 需要人工复核。' } as PartState,
    conclusionsPart([
      conclusion('uuid-B', '测试点 B', '未见明显变化', '平稳'),
      conclusion('uuid-A', '测试点 A', '需人工复核', '持续变化'),
    ]),
    toolPart('get_displacement', { isError: true }),
    { type: 'text', text: '补充查询失败，C 尚未覆盖。' } as PartState,
  ];
  const markdown = answerToMarkdown(parts);
  expect(markdown).toContain('测点状态：测试点 A：需人工复核；测试点 B：未见明显变化');
  expect(markdown).toContain('K3-07 需要人工复核。');
  expect(markdown).toContain('补充查询失败，C 尚未覆盖。');
  // 结论登记是留档，不作为调查步骤出现；失败的查询仍可见。
  expect(stepsOf(parts).map((step) => step.state)).toEqual(['failed']);
});

it('只登记结论没有正文时，导出各测点状态与原因', () => {
  const markdown = answerToMarkdown([conclusionsPart([conclusion('uuid-A', '测试点 A', '持续关注', '长期同向变化')])]);
  expect(markdown).toContain('测试点 A · 持续关注');
  expect(markdown).toContain('长期同向变化');
});

it('计算结果可在步骤内展开', () => {
  const parts = [
    toolPart('compute', { artifact: { version: 1, kind: 'computation', status: 'success', evidence_id: 'Ecalc', data: {
      description: '每周北向变化', code: 'result = 1', inputs: [{ evidence_id: 'E1', description: 'A 位移' }], result: 1.5, truncated: false,
    } } }),
  ];
  const steps = stepsOf(parts);
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({ label: '已完成计算', detail: '每周北向变化', evidenceId: 'Ecalc' });
  expect(steps[0]!.inlineEnvelope?.kind).toBe('computation');
});

it('复制与导出的正文引用保留测点、完整窗口和来源，不输出内部锚点', () => {
  const parts = [
    toolPart('get_displacement', { artifact: {
      ...gnssEnvelope('测点 A'), evidence_id: 'E123abc',
      sources: [{ provider: '监测平台', name: 'GNSS观测', observed_at: '2026-11-08' }],
    } }),
    { type: 'text', text: '北向持续变化。[E123abc](#evidence-E123abc) 再次引用[99](#evidence-E123abc)' } as PartState,
  ];
  const markdown = answerToMarkdown(parts);
  expect(markdown).toContain('北向持续变化。[1]');
  expect(markdown).toContain('测点 A；2026-11-01 00:00:00 至 2026-11-08 00:00:00');
  expect(markdown).toContain('监测平台');
  expect(markdown).not.toContain('#evidence-');
  expect(markdown).not.toContain('E123abc');
  expect(markdown.match(/## 依据/g)).toHaveLength(1);
});

it('非法位置不进入测点地图，已有有效位置不会被后续错误记录覆盖', () => {
  const envelope = gnssEnvelope('测点 A');
  const parts = [
    toolPart('get_displacement', { artifact: { ...envelope, data: { ...envelope.data, location: { latitude: 39.87, longitude: 116.48 } } } }),
    toolPart('get_displacement', { artifact: { ...envelope, data: { ...envelope.data, location: { latitude: 116.48, longitude: 39.87 } } } }),
  ];
  expect(collectStations(parts)[0]?.coordinates).toEqual({ latitude: 39.87, longitude: 116.48 });
  expect(collectStations(parts.slice(1))[0]?.coordinates).toBeUndefined();
});

it('按 UUID 保留基准站和移动站类型，供地图决定是否显示方向', () => {
  const parts = [
    toolPart('get_displacement', { artifact: gnssEnvelope('测试点 A') }),
    toolPart('get_displacement', { artifact: gnssEnvelope('测试点 B') }),
    toolPart('find_stations', { artifact: {
      version: 1, kind: 'station_list', status: 'success', data: {
        total: 2, groups: [], stations: [
          { station_uuid: 'uuid-A', station_name: '测试点 A', station_type: '基准站', coordinate_system: 'WGS84' },
          { station_uuid: 'uuid-B', station_name: '测试点 B', station_type: '移动站RTK模式', coordinate_system: 'WGS84' },
        ],
      },
    } }),
  ];
  expect(collectStations(parts).map((station) => [station.uuid, station.stationType])).toEqual([
    ['uuid-A', '基准站'],
    ['uuid-B', '移动站RTK模式'],
  ]);
});

it('失败查询快照作为限制依据导出，保留对象、窗口及失败原因', () => {
  const parts = [
    toolPart('get_displacement', { isError: true, artifact: {
      version: 1, kind: 'acquisition_failure', status: 'error', evidence_id: 'Efailure',
      data: {
        station_uuid: 'uuid-B', station_name: '测试点 B', requested_station: 'uuid-B',
        begin_time: '2026-11-01 00:00:00', end_time: '2026-11-08 00:00:00',
        message: '监测平台拒绝本次查询。',
      },
      error: { code: 'unavailable', category: 'business', message: '监测平台拒绝本次查询。', retryable: false },
    } }),
    { type: 'text', text: 'B本次暂无法分析。[1](#evidence-Efailure)' } as PartState,
  ];
  const markdown = answerToMarkdown(parts);
  expect(markdown).toContain('B本次暂无法分析。[1]');
  expect(markdown).toContain('测试点 B；监测平台拒绝本次查询。');
  expect(markdown).toContain('2026-11-01 00:00:00 至 2026-11-08 00:00:00');
  expect(markdown).not.toContain('原始依据未随本次结果提供');
  expect(stepsOf(parts)[0]?.inlineEnvelope).toBeUndefined();
});

describe('调查过程由官方 tool part 派生', () => {
  it('同名不同UUID不合并，同UUID改名保留同一对象', () => {
    const first = gnssEnvelope('同名');
    const second = { ...gnssEnvelope('同名'), data: { ...first.data, station_uuid: 'uuid-other' } };
    const renamed = { ...first, data: { ...first.data, station_name: '更名后的测点' } };
    const parts = [first, second, renamed].map((artifact) => toolPart('get_displacement', { artifact }));
    const stations = collectStations(parts);
    expect(stations).toHaveLength(2);
    expect(stations[0]!.series).toHaveLength(2);
    expect(stations[1]!.series).toHaveLength(1);
    expect(stations.map((station) => station.id)).toEqual(['uuid-A', 'uuid-other']);
  });
  it('同一测点的多次查询归为一个依据入口', () => {
    const parts = [
      toolPart('get_displacement', { artifact: gnssEnvelope('测试点 A') }),
      toolPart('get_displacement', { artifact: gnssEnvelope('测试点 A') }),
      toolPart('get_displacement', { artifact: gnssEnvelope('测试点 B') }),
      toolPart('find_stations', {
        artifact: {
          version: 1,
          kind: 'station_list',
          status: 'success',
          data: {
            total: 1,
            groups: [],
            stations: [{ station_uuid: 'uuid-A', station_name: '测试点 A', coordinate_system: 'WGS84', station_status: '告警', group_name: 'K3' }],
          },
        },
      }),
    ];

    const stations = collectStations(parts);
    expect(stations.map((station) => station.name)).toEqual(['测试点 A', '测试点 B']);
    expect(stations[0]).toMatchObject({ status: '告警', group: 'K3' });
    expect(stations[0]!.series).toHaveLength(2);

    const steps = buildSteps(parts, stations);
    expect(steps[0]).toMatchObject({ stationName: '测试点 A', label: '已获取位移数据' });
    expect(steps[0]!.detail).toBe('测试点 A · 11-01 至 11-08');
    expect(steps[3]).toMatchObject({ stationName: undefined, detail: '1 个测点' });
    expect(steps[3]!.inlineEnvelope?.kind).toBe('station_list');
  });

  it('普通错误保留真实状态，不将内部原因投影到展示步骤', () => {
    const [step] = stepsOf([
      toolPart('get_displacement', { isError: true, result: '未找到指定监测点，请确认站点。' }),
    ]);
    expect(step).toMatchObject({
      state: 'failed',
      label: '本次未取得位移数据',
    });
    expect(step).not.toHaveProperty('errorMessage');
  });

  it('部分失败保留已取得的证据，并给出受控原因', () => {
    const parts = [
      toolPart('get_displacement', {
        isError: true,
        result: 'MODEL_ONLY',
        artifact: {
          ...gnssEnvelope('测试点 A'),
          status: 'error',
          error: {
            code: 'upstream',
            category: 'upstream',
            message: '部分分片未取得，已保留取得的数据。',
            retryable: true,
          },
        },
      }),
    ];
    const [step] = stepsOf(parts);
    expect(step).toMatchObject({ state: 'failed', stationName: '测试点 A' });
    expect(step).not.toHaveProperty('errorMessage');
    expect(collectStations(parts)[0]!.series).toHaveLength(1);
  });

  it('取消不呈现为失败，运行中的步骤使用进行时文案', () => {
    const [cancelled, running] = stepsOf([
      toolPart('get_displacement', { status: { type: 'incomplete', reason: 'cancelled' } }),
      toolPart('find_stations', { status: { type: 'running' } }),
    ]);
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect(running).toMatchObject({ state: 'running', label: '正在查询监测点…' });
  });

  it('空结果给出说明，不生成测点入口', () => {
    const parts = [toolPart('get_displacement', { artifact: gnssEnvelope('测试点 A', []) })];
    expect(collectStations(parts)).toEqual([]);
    expect(stepsOf(parts)[0]).toMatchObject({
      state: 'complete',
      notice: '该时间范围内暂无位移数据。',
      stationName: undefined,
      inlineEnvelope: undefined,
    });
  });

  it('仅供模型的答复不进入调查过程，真正错误仍然可见', () => {
    expect(stepsOf([toolPart('get_displacement', { artifact: null, result: '基准站不适用形变查询' })])).toEqual([]);
    expect(stepsOf([toolPart('get_displacement', { artifact: null, result: '没有访问权限', isError: true })])[0])
      .toMatchObject({ state: 'failed', label: '本次未取得位移数据' });
  });

  it('未注册工具使用通用文案，不泄露工具名与模型内容', () => {
    const [step] = stepsOf([toolPart('internal_step', { result: 'MODEL_ONLY' })]);
    expect(step).toMatchObject({ state: 'complete', label: '已完成辅助查询', detail: undefined, notice: undefined });
    expect(JSON.stringify(step)).not.toContain('internal_step');
    expect(JSON.stringify(step)).not.toContain('MODEL_ONLY');
  });

  it('同一查询成功后收起此前失败，不消除其他测点或后续失败', () => {
    const parts = [
      toolPart('get_displacement', { args: { station: 'A' }, isError: true }),
      toolPart('get_displacement', { args: { station: 'B' }, isError: true }),
      toolPart('get_displacement', { args: { station: 'A' }, artifact: gnssEnvelope('A') }),
      toolPart('get_displacement', { args: { station: 'A' }, isError: true }),
    ];
    expect(stepsOf(parts).map((step) => step.state)).toEqual(['failed', 'complete', 'failed']);
  });
});
