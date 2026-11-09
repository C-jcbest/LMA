import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
  monitoringToolkit,
  monitoringToolRenderers,
} from '../src/features/monitoring/toolkit';

describe('assistant-ui monitoring toolkit', () => {
  it('将所有后端监测工具声明为官方 backend renderer', () => {
    expect(Object.keys(monitoringToolkit)).toEqual([
      'list_station_groups',
      'list_stations',
      'get_daily_gnss_data',
      'query_weather',
      'analyze_gnss_chart',
      'inspect_site_environment',
    ]);

    for (const tool of Object.values(monitoringToolkit)) {
      expect(tool.type).toBe('backend');
      expect(tool.render).toBeTypeOf('function');
      expect('execute' in tool).toBe(false);
    }
  });

  it('普通错误只读取官方 isError/result，不要求 artifact', async () => {
    const Renderer = monitoringToolRenderers.get_daily_gnss_data;
    render(
      <Renderer
        toolName="get_daily_gnss_data"
        toolCallId="call-error"
        args={{}}
        argsText="{}"
        status={{ type: 'complete' }}
        result="未找到指定监测点，请确认站点。"
        isError
      />,
    );

    expect(screen.getByText('GNSS 数据获取失败')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('未找到指定监测点，请确认站点。');
    await userEvent.click(screen.getByText('GNSS 数据获取失败'));
    expect(screen.getByText('未找到指定监测点，请确认站点。')).toBeInTheDocument();
  });

  it('部分证据错误保留 artifact 展示错误终态和受控原因', async () => {
    const Renderer = monitoringToolRenderers.analyze_gnss_chart;
    render(
      <Renderer
        toolName="analyze_gnss_chart"
        toolCallId="call-partial"
        args={{}}
        argsText="{}"
        status={{ type: 'complete' }}
        result="视觉模型未配置"
        isError
        artifact={{
          version: 1,
          kind: 'vision',
          status: 'error',
          data: {
            station_name: '测试站',
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
        }}
      />,
    );

    expect(screen.getByText('位移曲线复核失败')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('视觉模型未配置，已返回图表供人工查看。');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('位移曲线复核失败'));
    expect(
      screen.getByText('视觉模型未配置，已返回图表供人工查看。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /原始坐标时序/ })).toBeInTheDocument();
    await userEvent.click(screen.getByText('位移曲线复核失败'));
    expect(screen.getByRole('alert')).toHaveTextContent('视觉模型未配置，已返回图表供人工查看。');
  });

  it('取消与正常空数据不呈现失败告警', async () => {
    const Renderer = monitoringToolRenderers.get_daily_gnss_data;
    const { rerender } = render(
      <Renderer
        toolName="get_daily_gnss_data"
        toolCallId="call-cancelled"
        args={{}}
        argsText="{}"
        status={{ type: 'incomplete', reason: 'cancelled' }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('操作已取消');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const StationRenderer = monitoringToolRenderers.list_stations;
    rerender(
      <StationRenderer
        toolName="list_stations"
        toolCallId="call-empty"
        args={{}}
        argsText="{}"
        status={{ type: 'complete' }}
        artifact={{ version: 1, kind: 'station_list', status: 'success', data: { total: 0, stations: [] } }}
      />,
    );
    await userEvent.click(screen.getByText('已查询监测点信息'));
    expect(screen.getByText('暂无符合条件的监测点')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
