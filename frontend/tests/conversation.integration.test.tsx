import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { decodeToolArtifact } from '../src/features/monitoring/artifacts';
import { GnssResultView } from '../src/features/monitoring/tools/GnssResultView';
import { NumericalResultView } from '../src/features/monitoring/tools/NumericalResultView';
import { StationResultView } from '../src/features/monitoring/tools/StationResultView';
import { WeatherResultView } from '../src/features/monitoring/tools/WeatherResultView';
import { ComputationResultView } from '../src/features/monitoring/tools/ComputationResultView';
import {
  hasSummarizationSource,
  ThreadSummaryMessage,
} from '../src/components/assistant-ui/elements/thread.aui';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { HumanMessage } from '@langchain/core/messages';
import { convertLangChainBaseMessage } from '@assistant-ui/react-langchain';

const station = (station_name: string, fields: Record<string, unknown> = {}) => ({
  station_name,
  coordinate_system: 'WGS84',
  ...fields,
});

const stationListData = (stations: Array<Record<string, unknown>>) => ({
  total: stations.length,
  groups: [],
  stations: stations.map((item) => station(String(item.station_name), item)),
});

const stationGroupData = (groups: Array<Record<string, unknown>>) => ({
  total: 0,
  groups,
  stations: [],
});

const gnssData = (station_name: string, points: Array<Record<string, unknown>>) => ({
  station_name,
  begin_time: '2026-09-15 00:00:00',
  end_time: '2026-09-20 00:00:00',
  timezone: 'Asia/Shanghai',
  total_points: points.length,
  returned_points: points.length,
  downsampled: false,
  points,
  summary: {
    n: { count: points.length },
    e: { count: points.length },
    u: { count: points.length },
    gaps: [],
  },
});

describe('会话关键路径集成回归', () => {
  it('数值特征展示两窗口和共同覆盖，缺失速度不显示为零', () => {
    const feature = { count: 4, net_change_mm: 3, robust_slope_mm_day: null,
      begin_time: '2026-11-02 00:00:00', end_time: '2026-11-03 00:00:00',
      jump_persistence: '待观察', method: 'Theil–Sen', limitations: [] };
    render(<NumericalResultView data={{
      station_uuid: 'a', station_name: '测点A', points: [], timezone: 'Asia/Shanghai',
      total_points: 0, returned_points: 0, downsampled: false,
      summary: { n: { count: 0 }, e: { count: 0 }, u: { count: 0 }, gaps: [] },
      sampling: { mode: 'hourly', points_limit: 0 },
      begin_time: '2026-11-01 00:00:00', end_time: '2026-11-04 00:00:00',
      features: { n: feature }, comparisons: {
        n: { first: feature, second: feature, velocity_difference_mm_day: null, speed_ratio: null, limitation: '倍率不构成加速结论' },
        station_names: { b: '测点B' }, common_period: { n: { b: feature } },
      },
    }} />);
    expect(screen.getByRole('table', { name: '前后两段比较' })).toBeVisible();
    expect(screen.getByText('同组共同时段')).toBeVisible();
    expect(screen.getByText('测点B')).toBeVisible();
    // 缺失速度显示为“—”，不显示为 0。
    expect(screen.getAllByText('—（描述）').length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('0.00')).toBeNull();
    expect(screen.getByText('倍率不构成加速结论')).toBeVisible();
  });

  it('结论缺少时间窗或依据时拒绝渲染，不让畸形字段使界面崩溃', () => {
    const station = { station_uuid: 'station-1', station_name: '测点A', status: '持续关注', reason: '长期同向变化' };
    const artifact = { version: 1, kind: 'conclusions', status: 'success', data: { stations: [station] } };
    expect(decodeToolArtifact('conclusions', artifact)).toBeUndefined();
    const complete = structuredClone(artifact);
    Object.assign(complete.data.stations[0]!, {
      begin_time: '2026-11-01 00:00:00', end_time: '2026-11-08 00:00:00', evidence: ['E1'],
    });
    expect(decodeToolArtifact('conclusions', complete)?.kind).toBe('conclusions');
  });

  it('领域 Renderer 将标准空结构展示为暂无数据', () => {
    const { rerender } = render(
      <StationResultView
        data={stationGroupData([{ group_name: 'K3', station_count: 2 }]) as React.ComponentProps<typeof StationResultView>['data']}
      />,
    );
    expect(screen.getByText('K3')).toBeInTheDocument();

    rerender(
      <StationResultView
        data={stationListData([]) as React.ComponentProps<typeof StationResultView>['data']}
      />,
    );
    expect(screen.getByText('暂无符合条件的监测点')).toBeInTheDocument();

    rerender(
      <GnssResultView
        data={gnssData('测试站', []) as React.ComponentProps<typeof GnssResultView>['data']}
      />,
    );
    expect(screen.getByText('该时间范围内暂无 GNSS 数据')).toBeInTheDocument();

    rerender(
      <WeatherResultView
        data={{
          ok: true,
          location: { latitude: 30, longitude: 120, timezone: 'Asia/Shanghai' },
          query: {
            timezone: 'Asia/Shanghai',
            history_start_date: '2026-09-01',
            history_end_date: '2026-09-02',
            forecast_days: 7,
          },
          units: { temperature: 'celsius', wind_speed: 'km/h', precipitation: 'mm' },
          current: null,
          rain_summary: {
            recent_24h_window: {
              start_time: '2026-09-01T00:00:00+08:00',
              end_time: '2026-09-02T00:00:00+08:00',
              available_hours: 0,
              expected_hours: 24,
              complete: false,
              precipitation: null,
              note: '暂无数据',
            },
            history_total_precipitation: null,
            forecast_total_precipitation: null,
          },
          wind_summary: {},
          history: { daily: { time: [] } },
          forecast: { daily: { time: [] } },
          source: { provider: 'Open-Meteo' },
        }}
      />,
    );
    expect(screen.getByText('该位置和时间范围内暂无天气数据')).toBeInTheDocument();
  });

  it('GNSS 空值与非有限值显示为缺测，不会转换为零', () => {
    render(
      <GnssResultView
        data={gnssData('测试站', [
          { time: '2026-09-15 08:00:00', n: null, e: undefined, u: '' },
          { time: '2026-09-15 09:00:00', n: Number.NaN, e: Number.POSITIVE_INFINITY, u: '12.5' },
          { time: '2026-09-15 10:00:00', n: 0, e: '0', u: 0 },
        ]) as React.ComponentProps<typeof GnssResultView>['data']}
      />,
    );
    expect(screen.getAllByText('—')).toHaveLength(5);
    expect(screen.getAllByText('0.000')).toHaveLength(3);
    expect(screen.getByText('12.500')).toBeInTheDocument();
  });

  it('长序列分页展示，每页最多 100 条且能返回上一页', async () => {
    const points = Array.from({ length: 120 }, (_, index) => ({ time: `t-${index}`, n: 1, e: 2, u: 3 }));
    render(<GnssResultView data={gnssData('测试站', points) as React.ComponentProps<typeof GnssResultView>['data']} />);
    expect(screen.queryByText('t-100')).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(101);
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('t-119')).toBeInTheDocument();
    expect(screen.queryByText('t-0')).not.toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(21);
    expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '上一页' }));
    expect(screen.getByText('t-0')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(101);
  });

});

it('P0-4: decodeToolArtifact 严格验证 version 1 规范与 artifactKind 匹配，非法/缺失产物安全返回 undefined', () => {
  const validEnvelope = {
    version: 1,
    kind: 'station_list',
    status: 'success',
    data: stationListData([]),
  };
  expect(decodeToolArtifact('station_list', validEnvelope)).toMatchObject({
    version: 1,
    kind: 'station_list',
    status: 'success',
  });

  // 2. kind 与注册工具不匹配时拒绝
  expect(decodeToolArtifact('station_list', { ...validEnvelope, kind: 'weather' })).toBeUndefined();

  // 3. 非 version 1 拒绝
  expect(decodeToolArtifact('station_list', { ...validEnvelope, version: 2 })).toBeUndefined();

  // 4. 非法 status 拒绝
  expect(decodeToolArtifact('station_list', { ...validEnvelope, status: 'unknown' })).toBeUndefined();

  // 5. 传统无 envelope 结构拒绝
  expect(decodeToolArtifact('station_list', { stations: [] })).toBeUndefined();
  expect(decodeToolArtifact('station_list', 'not an object')).toBeUndefined();
  expect(decodeToolArtifact('station_list', null)).toBeUndefined();
  expect(decodeToolArtifact('station_list', undefined)).toBeUndefined();
});

it('摘要消息通过 ThreadSummaryMessage 渲染折叠卡片，绝不作为用户气泡', async () => {
  render(<ThreadSummaryMessage text="这是之前轮次的滑坡监测背景摘要。" />);
  expect(screen.getByText('更早的对话已压缩为摘要')).toBeInTheDocument();

  await userEvent.click(screen.getByText('更早的对话已压缩为摘要'));
  expect(screen.getByText('这是之前轮次的滑坡监测背景摘要。')).toBeInTheDocument();
});

it('LangChain 摘要 HumanMessage 通过原始 metadata 识别，不依赖消息角色补丁', () => {
  const summaryMessage = new HumanMessage({
    id: 'summary-human-message',
    content: '这是从 LangGraph checkpoint 恢复的历史摘要。',
    additional_kwargs: { lc_source: 'summarization' },
  });
  const converted = convertLangChainBaseMessage(summaryMessage);

  expect(converted.role).toBe('user');
  expect(hasSummarizationSource([summaryMessage], 'summary-human-message')).toBe(true);
  expect(hasSummarizationSource([summaryMessage], 'another-message')).toBe(false);
});

it('ErrorBoundary 不向用户展示 error.message，窗口级提供“刷新页面”，局部级提供“重新加载”与“隐藏”', () => {
  const ProblematicChild = ({ shouldThrow }: { shouldThrow: boolean }) => {
    if (shouldThrow) {
      throw new Error('secret_database_connection_timeout');
    }
    return <div>正常内容</div>;
  };

  const reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: reloadSpy },
  });

  // 局部组件级 ErrorBoundary
  const onReload = vi.fn();
  render(
    <ErrorBoundary level="component" onReload={onReload}>
      <ProblematicChild shouldThrow={true} />
    </ErrorBoundary>
  );
  expect(screen.getByText('该内容暂时无法显示')).toBeInTheDocument();
  expect(screen.queryByText(/secret_database_connection_timeout/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '隐藏' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '隐藏' }));
  expect(screen.queryByText('该内容暂时无法显示')).not.toBeInTheDocument();

  // 窗口级 ErrorBoundary
  render(
    <ErrorBoundary level="window">
      <ProblematicChild shouldThrow={true} />
    </ErrorBoundary>
  );
  expect(screen.getByText('会话界面加载异常')).toBeInTheDocument();
  expect(screen.queryByText(/secret_database_connection_timeout/)).not.toBeInTheDocument();
  const refreshBtn = screen.getByRole('button', { name: '刷新页面' });
  expect(refreshBtn).toBeInTheDocument();
  fireEvent.click(refreshBtn);
  expect(reloadSpy).toHaveBeenCalled();
});

it('计算结果中的嵌套字典展示为对比表和小表，不显示 JSON 原文', () => {
  render(<ComputationResultView data={{
    description: '前后两段降雨', code: 'result = {}', truncated: false,
    inputs: [{ evidence_id: 'E1', description: '测点A 90 天天气' }],
    result: {
      first_period: { days: 60, rain_mm: 286.3 },
      second_period: { days: 30, rain_mm: 91.7 },
      recent_7d_rain_mm: 33,
      recent_7d_daily: { '2026-11-05': 1.3, '2026-11-06': 2.5 },
    },
  }} />);
  expect(screen.queryByText(/\{"days"/)).toBeNull();
  const tables = screen.getAllByRole('table');
  // 代码变量式键名整理成可读表头：下划线换成空格，末尾单位放进括号。
  expect(tables[0]).toHaveTextContent('first period');
  expect(tables[0]).toHaveTextContent('rain（mm）');
  expect(tables[0]).toHaveTextContent('286.3');
  expect(screen.getByText('recent 7d rain（mm）')).toBeVisible();
  expect(screen.getByText('recent 7d daily')).toBeVisible();
  expect(tables[1]).toHaveTextContent('2026-11-06');
});
