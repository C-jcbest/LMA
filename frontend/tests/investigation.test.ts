import type { PartState } from '@assistant-ui/react';
import { describe, expect, it } from 'vitest';
import { buildSteps, collectStations } from '../src/features/monitoring/investigation';

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

describe('调查过程由官方 tool part 派生', () => {
  it('同一测点的多次查询归为一个依据入口', () => {
    const parts = [
      toolPart('get_daily_gnss_data', { artifact: gnssEnvelope('测试点 A') }),
      toolPart('get_daily_gnss_data', { artifact: gnssEnvelope('测试点 A') }),
      toolPart('get_daily_gnss_data', { artifact: gnssEnvelope('测试点 B') }),
      toolPart('list_stations', {
        artifact: {
          version: 1,
          kind: 'station_list',
          status: 'success',
          data: {
            total: 1,
            stations: [{ station_name: '测试点 A', coordinate_system: 'WGS84', station_status: '告警', group_name: 'K3' }],
          },
        },
      }),
    ];

    const stations = collectStations(parts);
    expect(stations.map((station) => station.name)).toEqual(['测试点 A', '测试点 B']);
    expect(stations[0]).toMatchObject({ status: '告警', group: 'K3' });
    expect(stations[0]!.series).toHaveLength(2);

    const steps = buildSteps(parts, stations);
    expect(steps[0]).toMatchObject({ stationName: '测试点 A', label: '已获取 GNSS 监测数据' });
    expect(steps[0]!.detail).toBe('测试点 A · 11-01 至 11-08');
    expect(steps[3]).toMatchObject({ stationName: undefined, detail: '1 个测点' });
    expect(steps[3]!.inlineEnvelope?.kind).toBe('station_list');
  });

  it('普通错误保留真实状态，不将内部原因投影到展示步骤', () => {
    const [step] = stepsOf([
      toolPart('get_daily_gnss_data', { isError: true, result: '未找到指定监测点，请确认站点。' }),
    ]);
    expect(step).toMatchObject({
      state: 'failed',
      label: '本次未取得监测记录',
    });
    expect(step).not.toHaveProperty('errorMessage');
  });

  it('部分失败保留已取得的证据，并给出受控原因', () => {
    const parts = [
      toolPart('analyze_gnss_chart', {
        isError: true,
        result: 'MODEL_ONLY',
        artifact: {
          version: 1,
          kind: 'vision',
          status: 'error',
          data: {
            station_name: '测试点 A',
            begin_time: '2026-09-21 00:00:00',
            end_time: '2026-09-21 01:00:00',
            timezone: 'Asia/Shanghai',
            total_points: 1,
            images: [{ name: 'raw_coordinates', png_base64: 'TEST_IMAGE' }],
            chart_points: [],
          },
          error: {
            code: 'configuration',
            category: 'configuration',
            message: '视觉模型未配置，已返回图表供人工查看。',
            retryable: false,
          },
        },
      }),
    ];
    const [step] = stepsOf(parts);
    expect(step).toMatchObject({ state: 'failed', stationName: '测试点 A' });
    expect(step).not.toHaveProperty('errorMessage');
    expect(collectStations(parts)[0]!.vision).toHaveLength(1);
  });

  it('取消不呈现为失败，运行中的步骤使用进行时文案', () => {
    const [cancelled, running] = stepsOf([
      toolPart('get_daily_gnss_data', { status: { type: 'incomplete', reason: 'cancelled' } }),
      toolPart('list_station_groups', { status: { type: 'running' } }),
    ]);
    expect(cancelled).toMatchObject({ state: 'cancelled' });
    expect(running).toMatchObject({ state: 'running', label: '正在查询监测点分组…' });
  });

  it('空结果给出说明，不生成测点入口', () => {
    const parts = [toolPart('get_daily_gnss_data', { artifact: gnssEnvelope('测试点 A', []) })];
    expect(collectStations(parts)).toEqual([]);
    expect(stepsOf(parts)[0]).toMatchObject({
      state: 'complete',
      notice: '该时间范围内暂无 GNSS 数据。',
      stationName: undefined,
      inlineEnvelope: undefined,
    });
  });

  it('仅供模型的答复不进入调查过程，真正错误仍然可见', () => {
    expect(stepsOf([toolPart('get_daily_gnss_data', { artifact: null, result: '基准站不适用形变查询' })])).toEqual([]);
    expect(stepsOf([toolPart('get_daily_gnss_data', { artifact: null, result: '没有访问权限', isError: true })])[0])
      .toMatchObject({ state: 'failed', label: '本次未取得监测记录' });
  });

  it('未注册工具使用通用文案，不泄露工具名与模型内容', () => {
    const [step] = stepsOf([toolPart('internal_step', { result: 'MODEL_ONLY' })]);
    expect(step).toMatchObject({ state: 'complete', label: '已完成辅助查询', detail: undefined, notice: undefined });
    expect(JSON.stringify(step)).not.toContain('internal_step');
    expect(JSON.stringify(step)).not.toContain('MODEL_ONLY');
  });

  it('同一查询成功后收起此前失败，不消除其他测点或后续失败', () => {
    const parts = [
      toolPart('get_daily_gnss_data', { args: { station: 'A' }, isError: true }),
      toolPart('get_daily_gnss_data', { args: { station: 'B' }, isError: true }),
      toolPart('get_daily_gnss_data', { args: { station: 'A' }, artifact: gnssEnvelope('A') }),
      toolPart('get_daily_gnss_data', { args: { station: 'A' }, isError: true }),
    ];
    expect(stepsOf(parts).map((step) => step.state)).toEqual(['failed', 'complete', 'failed']);
  });
});
