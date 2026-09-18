import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Reasoning } from '../src/components/assistant-ui/reasoning.aui';
import { ToolFallback } from '../src/components/assistant-ui/tool-fallback.aui';
import { ThreadEmpty } from '../src/components/assistant-ui/thread.aui';
import { Composer } from '../src/components/assistant-ui/composer.aui';
import { decodeToolEnvelope, TOOL_KIND_MAP } from '../src/agent/toolResultAdapter';
import { StationResultView } from '../src/features/monitoring/StationResultView';
import { WeatherResultView } from '../src/features/monitoring/WeatherResultView';
import { GnssResultView } from '../src/features/monitoring/GnssResultView';
import { VisionResultView } from '../src/features/monitoring/VisionResultView';
import { EmptyOrGenericResultView } from '../src/features/monitoring/EmptyOrGenericResultView';
import { TooltipProvider } from '../src/components/ui/tooltip';

// Mock assistant-ui stream hook
vi.mock('@assistant-ui/react-langchain', () => ({
  useLangChainStream: () => ({
    messages: [],
    isLoading: false,
  }),
  useLangChainInterrupts: () => [],
  useLangChainRespond: () => vi.fn(),
  useLangChainRecommendations: () => [],
  useLangChainState: () => undefined,
  useStreamRuntime: () => ({}),
}));

describe('V2 Reasoning component', () => {
  it('默认折叠，点击后展开显示思考批注', () => {
    render(<Reasoning text="这是深度思考的推理过程" status={{ type: 'complete' }} />);

    // 默认折叠，只显示触发按钮
    expect(screen.getByText('深度思考')).toBeInTheDocument();
    expect(screen.queryByText('这是深度思考的推理过程')).not.toBeInTheDocument();

    // 点击展开
    fireEvent.click(screen.getByText('深度思考'));
    expect(screen.getByText('这是深度思考的推理过程')).toBeInTheDocument();
    expect(screen.getByText('分析批注')).toBeInTheDocument();

    // 再次点击收起
    fireEvent.click(screen.getByText('深度思考'));
    expect(screen.queryByText('这是深度思考的推理过程')).not.toBeInTheDocument();
  });

  it('正在进行中的思考显示 running 提示', () => {
    render(<Reasoning text="进行中内容" status={{ type: 'running' }} />);
    expect(screen.getByText('思考分析中…')).toBeInTheDocument();
  });
});

describe('V2 toolResultAdapter & ToolFallback', () => {
  it('TOOL_KIND_MAP 包含 5 大核心监测工具映射', () => {
    expect(TOOL_KIND_MAP.get_daily_gnss_data.kind).toBe('gnss_series');
    expect(TOOL_KIND_MAP.query_weather.kind).toBe('weather');
    expect(TOOL_KIND_MAP.list_stations.kind).toBe('station_list');
    expect(TOOL_KIND_MAP.visual_review.kind).toBe('vision');
    expect(TOOL_KIND_MAP.site_environment.kind).toBe('site_environment');
  });

  it('解码结构化 artifact envelope', () => {
    const rawEnvelope = {
      version: 1,
      kind: 'gnss_series',
      status: 'success',
      data: {
        station_id: 'SCWM-04',
        records: [
          { date: '2026-09-15', dx: 1.2, dy: 0.5, dz: -0.8 },
          { date: '2026-09-16', dx: 2.1, dy: 0.9, dz: -1.4 },
        ],
      },
    };

    const decoded = decodeToolEnvelope('get_daily_gnss_data', rawEnvelope, null);
    expect(decoded.version).toBe(1);
    expect(decoded.kind).toBe('gnss_series');
    expect(decoded.status).toBe('success');
    expect((decoded.data as any).station_id).toBe('SCWM-04');
  });

  it('解码兼容旧版未包装对象数据', () => {
    const legacyData = {
      station_id: 'SCWM-01',
      total_days: 7,
      points: [{ time: '2026-09-15', displacement_mm: 5.4 }],
    };

    const decoded = decodeToolEnvelope('get_daily_gnss_data', null, legacyData);
    expect(decoded.version).toBe(1);
    expect(decoded.kind).toBe('gnss_series');
    expect(decoded.status).toBe('success');
    expect((decoded.data as any).station_id).toBe('SCWM-01');
  });

  it('ToolFallback 渲染运行中状态', () => {
    render(
      <ToolFallback
        toolCallId="call-1"
        toolName="get_daily_gnss_data"
        args={{ station_id: 'SCWM-04' }}
        status={{ type: 'running' }}
      />
    );

    expect(screen.getByText('获取北斗GNSS日监测数据')).toBeInTheDocument();
    expect(screen.getByText('正在查询…')).toBeInTheDocument();
  });

  it('ToolFallback 渲染错误状态', () => {
    render(
      <ToolFallback
        toolCallId="call-2"
        toolName="get_daily_gnss_data"
        args={{ station_id: 'UNKNOWN' }}
        status={{ type: 'incomplete' }}
        result="监测站 UNKNOWN 不存在"
      />
    );

    expect(screen.getByText('获取北斗GNSS日监测数据')).toBeInTheDocument();
    fireEvent.click(screen.getByText('获取北斗GNSS日监测数据'));
    expect(screen.getByText('工具执行失败')).toBeInTheDocument();
    expect(screen.getByText('监测站 UNKNOWN 不存在')).toBeInTheDocument();
  });
});

describe('V2 监测领域 Renderers', () => {
  it('StationResultView 正确渲染监测站点信息', () => {
    const stationData = {
      stations: [
        { station_name: 'SCWM-01', station_status: '正常', location: '1号滑坡后缘', station_type: 'GNSS' },
        { station_name: 'SCWM-04', station_status: '告警', location: '4号滑坡前缘', station_type: '裂缝计' },
      ],
    };

    render(<StationResultView data={stationData} />);
    expect(screen.getByText('SCWM-01')).toBeInTheDocument();
    expect(screen.getByText('1号滑坡后缘')).toBeInTheDocument();
    expect(screen.getByText('SCWM-04')).toBeInTheDocument();
    expect(screen.getByText('4号滑坡前缘')).toBeInTheDocument();
  });

  it('WeatherResultView 渲染天气与降雨数据', () => {
    const weatherData = {
      location: { name: '理县' },
      current: { temperature_2m: 21.5, relative_humidity_2m: 82 },
      rain_summary: {
        recent_24h_precipitation: 38.5,
        history_total_precipitation: 120.0,
      },
    };

    render(<WeatherResultView data={weatherData} />);
    expect(screen.getByText('最近 24 个完整小时降雨')).toBeInTheDocument();
    expect(screen.getByText('38.5 mm')).toBeInTheDocument();
    expect(screen.getByText('120 mm')).toBeInTheDocument();
  });

  it('VisionResultView 渲染 Base64 视觉图像及放大 Dialog 触发', () => {
    const fakeBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const visionData = {
      station_name: 'SCWM-04',
      begin_time: '2026-09-01T00:00:00Z',
      end_time: '2026-09-15T00:00:00Z',
      chart_points: [
        { time: '2026-09-01', x: 0, y: 0, z: 0 },
        { time: '2026-09-15', x: 10, y: 5, z: -8 },
      ],
    };
    const artifactImages = [
      { name: 'raw_coordinates', title: '原始坐标时序（N/E/U）', png_base64: fakeBase64 },
    ];

    render(<VisionResultView data={visionData} artifactImages={artifactImages} />);
    expect(screen.getByText('SCWM-04')).toBeInTheDocument();
    expect(screen.getByText('图1 · 原始坐标时序（N/E/U）')).toBeInTheDocument();

    // 点击放大按钮触发 Dialog
    const zoomBtn = screen.getByRole('button', { name: /查看大图/i });
    fireEvent.click(zoomBtn);
    expect(screen.getByText('查看大图')).toBeInTheDocument();
  });

  it('EmptyOrGenericResultView 正确处理空返回', () => {
    const emptyEnvelope = {
      version: 1 as const,
      kind: 'generic',
      status: 'success' as const,
      data: null,
    };

    render(<EmptyOrGenericResultView envelope={emptyEnvelope} />);
    expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();
  });
});

describe('V2 ThreadEmpty starter prompts', () => {
  it('提供 4 个默认提示词，点击触发 onSelectPrompt 回调', () => {
    const onSelect = vi.fn();
    render(<ThreadEmpty onSelectPrompt={onSelect} />);

    expect(screen.getByText('LMA 滑坡连续监测智能体')).toBeInTheDocument();
    expect(screen.getByText('查询监测站位移')).toBeInTheDocument();
    expect(screen.getByText('滑坡区域气象实况')).toBeInTheDocument();

    fireEvent.click(screen.getByText('查询监测站位移'));
    expect(onSelect).toHaveBeenCalledWith(
      '请查询 SCWM-04 最近 3 天的 GNSS 监测数据并分析位移趋势。'
    );
  });
});
