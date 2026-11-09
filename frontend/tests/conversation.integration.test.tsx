import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { decodeToolArtifact } from '../src/features/monitoring/artifacts';
import { GnssResultView } from '../src/features/monitoring/tools/GnssResultView';
import { VisionResultView } from '../src/features/monitoring/tools/VisionResultView';
import { StationResultView } from '../src/features/monitoring/tools/StationResultView';
import { WeatherResultView } from '../src/features/monitoring/tools/WeatherResultView';
import {
  hasSummarizationSource,
  ThreadSummaryMessage,
} from '../src/components/assistant-ui/elements/thread.aui';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ContextUsageElement } from '../src/components/assistant-ui/elements/context-usage.aui';
import { HumanMessage } from '@langchain/core/messages';
import { createSessionListAdapter } from '../src/lib/session-list-adapter';
import { convertLangChainBaseMessage } from '@assistant-ui/react-langchain';

const station = (station_name: string, fields: Record<string, unknown> = {}) => ({
  station_name,
  coordinate_system: 'WGS84',
  ...fields,
});

const stationListData = (stations: Array<Record<string, unknown>>) => ({
  total: stations.length,
  stations: stations.map((item) => station(String(item.station_name), item)),
});

const stationGroupData = (groups: Array<Record<string, unknown>>) => ({
  total: groups.length,
  groups,
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

const visionData = (fields: Record<string, unknown> = {}) => ({
  station_name: '测试站',
  begin_time: '2026-09-15 00:00:00',
  end_time: '2026-09-16 00:00:00',
  timezone: 'Asia/Shanghai',
  total_points: 0,
  images: [],
  chart_points: [],
  ...fields,
});

describe('会话关键路径集成回归', () => {
  it('领域 Renderer 将标准空结构展示为暂无数据', () => {
    const { rerender } = render(
      <StationResultView
        data={stationGroupData([]) as React.ComponentProps<typeof StationResultView>['data']}
      />,
    );
    expect(screen.getByText('暂无监测点分组')).toBeInTheDocument();

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
      <VisionResultView
        data={visionData() as React.ComponentProps<typeof VisionResultView>['data']}
      />,
    );
    expect(screen.getByText('该时间范围内暂无可供复核的 GNSS 数据')).toBeInTheDocument();

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

  it('长序列先显示前 100 条，可按需展开全部', async () => {
    const points = Array.from({ length: 120 }, (_, index) => ({ time: `t-${index}`, n: 1, e: 2, u: 3 }));
    render(<GnssResultView data={gnssData('测试站', points) as React.ComponentProps<typeof GnssResultView>['data']} />);
    expect(screen.queryByText('t-100')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '显示全部 120 条' }));
    expect(screen.getByText('t-119')).toBeInTheDocument();
  });

  it('视觉复核无图时折线在缺测点处分段，不把缺测绘制为零或跨段连线', () => {
    render(
      <VisionResultView
        data={visionData({
          observations: {},
          total_points: 5,
          chart_points: [
            { t: '2026-09-15 08:00:00', n: 1, e: 2, u: 3 },
            { t: '2026-09-15 09:00:00', n: 2, e: 3, u: 4 },
            { t: '2026-09-15 10:00:00', n: null, e: null, u: null },
            { t: '2026-09-15 11:00:00', n: 3, e: 4, u: 5 },
            { t: '2026-09-15 12:00:00', n: 4, e: 5, u: 6 },
          ],
        }) as React.ComponentProps<typeof VisionResultView>['data']}
      />,
    );
    const polylines = Array.from(document.querySelectorAll('polyline'));
    expect(polylines).toHaveLength(6);
    expect(polylines.every((line) => !line.getAttribute('points')?.includes('50.00,'))).toBe(true);
  });

  it('站点状态分别展示，旧数字状态和缺失类型均显示未知', () => {
    render(
      <StationResultView
        data={stationListData([
          { station_name: 'A', station_status: '正常', station_type: '基准站' },
          { station_name: 'B', station_status: '离线', station_type: '移动站RTK模式' },
          { station_name: 'C', station_status: '告警', station_type: '移动站单点模式' },
          { station_name: 'D', station_status: '故障', station_type: '中继站' },
          { station_name: 'E', station_status: '其他' },
        ]) as React.ComponentProps<typeof StationResultView>['data']}
      />,
    );
    for (const label of ['正常', '离线', '告警', '故障']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('未知')).toHaveLength(2);
  });

  it('视觉复核图可放大查看', async () => {
    render(
      <VisionResultView
        data={visionData({
          images: [{ name: 'raw_coordinates', png_base64: 'TEST_IMAGE' }],
        }) as React.ComponentProps<typeof VisionResultView>['data']}
      />,
    );
    expect(screen.getByRole('img', { name: /原始坐标时序/ })).toBeInTheDocument();
    const zoom = screen.getByRole('button', { name: /放大原始坐标时序/ });
    await userEvent.click(zoom);
    expect(screen.getByRole('button', { name: /缩小原始坐标时序/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('上下文用量接近上限时才出现', () => {
    render(
      <ContextUsageElement
        usage={{
          input_tokens: 850,
          output_tokens: 20,
          total_tokens: 870,
          max_input_tokens: 1000,
          usage_ratio: 0.85,
          model: 'deepseek-flash',
        }}
      />
    );

    const trigger = screen.getByLabelText('上下文用量');
    expect(trigger).toHaveTextContent('85%');
    expect(trigger.querySelector('svg')).toBeInTheDocument();
  });

  it('用量较低或缺少真实 usage 时不渲染上下文占比', () => {
    const { rerender } = render(
      <ContextUsageElement usage={{ max_input_tokens: 1_048_576 }} />
    );
    expect(screen.queryByLabelText('上下文用量')).not.toBeInTheDocument();
    rerender(<ContextUsageElement usage={{ input_tokens: 250, max_input_tokens: 1000 }} />);
    expect(screen.queryByLabelText('上下文用量')).not.toBeInTheDocument();
  });

  it('会话目录映射服务端 id 到 remoteId 与 externalId', async () => {
    const searchMock = vi.fn().mockImplementation(async (query: any) => {
      expect(query).toEqual({ limit: 21, offset: 0 });
      return [
        { id: 'real', name: '站点分析', archived: false, updated_at: '2026-09-14T00:00:01Z' },
      ];
    });
    const mockClient = {
      listSessions: searchMock,
    } as any;
    const adapter = createSessionListAdapter(mockClient);
    const res = await adapter.list();
    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(res.threads).toEqual([
      {
        status: 'regular',
        remoteId: 'real',
        externalId: 'real',
        title: '站点分析',
        lastMessageAt: new Date('2026-09-14T00:00:01Z'),
      },
    ]);
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

  // 6. 已删除的顶层业务字段不得再被兼容读取
  expect(
    decodeToolArtifact('vision', {
      version: 1,
      kind: 'vision',
      status: 'success',
      data: { station_name: '旧协议' },
      images: [{ name: 'raw_coordinates', png_base64: 'LEGACY' }],
      chart_points: [],
    }),
  ).toBeUndefined();
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
