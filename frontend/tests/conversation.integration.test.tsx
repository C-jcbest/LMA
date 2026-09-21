import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToolFallback } from '../src/components/assistant-ui/elements/tool-fallback.aui';
import { decodeToolArtifact } from '../src/features/monitoring/tools/registry';
import { GnssResultView } from '../src/features/monitoring/tools/GnssResultView';
import { VisionResultView } from '../src/features/monitoring/tools/VisionResultView';
import { StationResultView } from '../src/features/monitoring/tools/StationResultView';
import { WeatherResultView } from '../src/features/monitoring/tools/WeatherResultView';
import { ThreadSummaryMessage } from '../src/components/assistant-ui/elements/thread.aui';
import { ReasoningRoot, ReasoningTrigger } from '../src/components/assistant-ui/elements/reasoning';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ContextUsageElement } from '../src/components/assistant-ui/elements/context-usage.aui';
import { AIMessage } from '@langchain/core/messages';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import { createLangGraphThreadListAdapter } from '../src/lib/langgraph/thread-list-adapter';
import { AssistantRuntimeProvider, useLocalRuntime } from '@assistant-ui/react';

describe('会话关键路径集成回归', () => {
  it('优先展示标准 contentBlocks reasoning，不读取耗时字段', () => {
    const firstAI = new AIMessage({
      id: 'a1',
      contentBlocks: [
        { type: 'reasoning', reasoning: '先确认目标站点，再查询监测数据。' },
        { type: 'tool_call', id: 'call-1', name: 'list_stations', args: {} },
      ],
      additional_kwargs: {
        reasoning_content: '不应重复展示的兼容内容',
      },
    });

    const reasoningBlocks = firstAI.contentBlocks.filter((b) => b.type === 'reasoning');
    expect(reasoningBlocks).toHaveLength(1);
    expect((reasoningBlocks[0] as any).reasoning).toBe('先确认目标站点，再查询监测数据。');
    expect((firstAI as any).elapsed_seconds).toBeUndefined();
  });


  it('GNSS 空值与非有限值显示为缺测，不会转换为零', async () => {
    render(
      <ToolFallback
        toolName="get_daily_gnss_data"
        status={{ type: 'complete' }}
        argsText="{}"
        artifact={{
          version: 1,
          kind: 'gnss_series',
          status: 'success',
          data: {
            station_name: '测试站',
            points: [
              { time: '2026-09-15 08:00:00', n: null, e: undefined, u: '' },
              { time: '2026-09-15 09:00:00', n: Number.NaN, e: Number.POSITIVE_INFINITY, u: '12.5' },
              { time: '2026-09-15 10:00:00', n: 0, e: '0', u: 0 },
            ],
          },
        }}
      />
    );
    await userEvent.click(screen.getByText(/已获取 GNSS 监测数据/));
    expect(screen.getAllByText('—')).toHaveLength(5);
    expect(screen.getAllByText('0.000')).toHaveLength(3);
    expect(screen.getByText('12.500')).toBeInTheDocument();
  });

  it('GNSS 折线在缺测点处分段，不把缺测绘制为零或跨段连线', async () => {
    const { container } = render(
      <ToolFallback
        toolName="analyze_gnss_chart"
        status={{ type: 'complete' }}
        argsText="{}"
        artifact={{
          version: 1,
          kind: 'vision',
          status: 'success',
          data: { station_name: '测试站', observations: {}, total_points: 5 },
          chart_points: [
            { t: '2026-09-15 08:00:00', n: 1, e: 2, u: 3 },
            { t: '2026-09-15 09:00:00', n: 2, e: 3, u: 4 },
            { t: '2026-09-15 10:00:00', n: null, e: '', u: Number.NaN },
            { t: '2026-09-15 11:00:00', n: 3, e: 4, u: 5 },
            { t: '2026-09-15 12:00:00', n: 4, e: 5, u: 6 },
          ],
        }}
      />
    );
    await userEvent.click(screen.getByText(/已完成位移曲线复核/));
    const polylines = Array.from(container.querySelectorAll('polyline'));
    expect(polylines).toHaveLength(6);
    expect(polylines.every((line) => !line.getAttribute('points')?.includes('50.00,'))).toBe(true);
  });

  it('站点状态分别展示，旧数字状态和缺失类型均显示未知', async () => {
    render(
      <ToolFallback
        toolName="list_stations"
        status={{ type: 'complete' }}
        argsText="{}"
        artifact={{
          version: 1,
          kind: 'station_list',
          status: 'success',
          data: {
            stations: [
              { station_name: 'A', station_status: '正常', station_type: '基准站' },
              { station_name: 'B', station_status: '离线', station_type: '移动站RTK模式' },
              { station_name: 'C', station_status: '告警', station_type: '移动站单点模式' },
              { station_name: 'D', station_status: '故障', station_type: '中继站' },
              { station_name: 'E', station_status: 10 },
            ],
          },
        }}
      />
    );
    await userEvent.click(screen.getByText(/已查询监测点信息/));
    for (const label of ['正常', '离线', '告警', '故障']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('未知')).toHaveLength(2);
    expect(screen.queryByText('正常 (10)')).not.toBeInTheDocument();
  });

  it('未注册工具以通用友好状态展示，不泄露内部名称与原始调试 JSON', async () => {
    render(
      <ToolFallback
        toolName="internal_step"
        status={{ type: 'complete' }}
        argsText="{}"
        result="MODEL_ONLY"
      />
    );
    expect(screen.getByText('已完成辅助查询')).toBeInTheDocument();
    expect(screen.queryByText(/internal_step/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('已完成辅助查询'));
    expect(screen.getByText(/已完成辅助信息查询并同步至模型上下文/)).toBeInTheDocument();
    expect(screen.queryByText('MODEL_ONLY')).not.toBeInTheDocument();
  });

  it('工具异常状态展示友好错误信息，不显示机械已调用', async () => {
    render(
      <ToolFallback
        toolName="get_daily_gnss_data"
        status={{ type: 'incomplete', error: '未找到指定监测点，请确认站点。' }}
        argsText="{}"
      />
    );
    expect(screen.getByText('GNSS 数据获取失败')).toBeInTheDocument();
    await userEvent.click(screen.getByText('GNSS 数据获取失败'));
    expect(screen.getByText('未找到指定监测点，请确认站点。')).toBeInTheDocument();
  });

  it('官方 isError/result 在没有 artifact 时仍恢复工具错误终态', async () => {
    render(
      <ToolFallback
        toolName="get_daily_gnss_data"
        status={{ type: 'complete' }}
        argsText="{}"
        result="未找到指定监测点，请确认站点。"
        isError
      />
    );
    expect(screen.getByText('GNSS 数据获取失败')).toBeInTheDocument();
    await userEvent.click(screen.getByText('GNSS 数据获取失败'));
    expect(screen.getByText('未找到指定监测点，请确认站点。')).toBeInTheDocument();
  });

  it('成功工具只从合法 v1 artifact.data 取业务展示', async () => {
    const { container } = render(
      <ToolFallback
        toolName="list_stations"
        status={{ type: 'complete' }}
        argsText="{}"
        result="MODEL_ONLY"
        artifact={{
          version: 1,
          kind: 'station_list',
          status: 'success',
          data: { total: 0, stations: [] },
        }}
      />
    );
    await userEvent.click(screen.getByText(/已查询监测点信息/));
    expect(container.textContent).toContain('共查询到 0 个监测点详情');
    expect(container.textContent).not.toContain('MODEL_ONLY');
  });

  it('视觉复核展示图表图片', async () => {
    render(
      <ToolFallback
        toolName="analyze_gnss_chart"
        status={{ type: 'complete' }}
        argsText="{}"
        artifact={{
          version: 1,
          kind: 'vision',
          status: 'success',
          data: { station_name: '测试站' },
          images: [{ name: 'raw_coordinates', png_base64: 'TEST_IMAGE' }],
        }}
      />
    );
    await userEvent.click(screen.getByText(/已完成位移曲线复核/));
    expect(screen.getByRole('img', { name: /原始坐标时序/ })).toBeInTheDocument();
  });

  it('调用限额/异常信息展示友好错误文案', () => {
    render(
      <ToolFallback
        toolName="list_stations"
        status={{ type: 'incomplete', error: '本轮查询次数已达到上限，未执行此查询；请依据已有证据继续分析。' }}
        argsText="{}"
      />
    );
    expect(screen.getByText('监测点信息查询失败')).toBeInTheDocument();
  });

  it('畸形 artifact 字段 fail-closed，不扩散为聊天窗口异常', async () => {
    render(
      <ToolFallback
        toolName="internal_step"
        status={{ type: 'complete' }}
        argsText="{}"
        artifact={{
          data: 'not-an-object',
          images: { filter: 'not-a-function' },
          chart_points: [null, { t: 1 }],
          site_environment: { coordinate_system: 'WGS84' },
        }}
      />
    );
    expect(screen.getByText('已完成辅助查询')).toBeInTheDocument();
    await userEvent.click(screen.getByText('已完成辅助查询'));
    expect(screen.getByText(/已完成辅助信息查询并同步至模型上下文/)).toBeInTheDocument();
  });

  it('输入框发送按钮左侧可查看上下文 token 明细', async () => {
    render(
      <ContextUsageElement
        usage={{
          input_tokens: 250,
          context_limit_tokens: 1000,
          remaining_tokens: 750,
          usage_ratio: 0.25,
          estimated_history_tokens: 120,
          estimated_fixed_input_tokens: 130,
          accounting_difference_tokens: 0,
          output_reserve_tokens: 100,
          safety_margin_tokens: 20,
          trigger_tokens: 800,
          counter: 'provider_reported',
          model: 'deepseek-flash',
        }}
      />
    );

    await userEvent.click(screen.getByLabelText('上下文预算已用 25%'));
    expect(screen.getByText('当前请求输入')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.queryByText('75.0K')).not.toBeInTheDocument();
  });

  it('缺少真实 usage 时不渲染上下文占比，也不显示未配置占位', () => {
    render(
      <ContextUsageElement usage={{ context_limit_tokens: 1_048_576 }} />
    );
    expect(screen.queryByText(/上下文窗口|未配置/)).not.toBeInTheDocument();
  });

  it('会话归属依据 graph_id，adapter.list 严格过滤 assistantId 并映射 remoteId 与 externalId', async () => {
    const searchMock = vi.fn().mockImplementation(async (query: any) => {
      expect(query.metadata).toEqual({ graph_id: 'lma-agent' });
      return [
        { thread_id: 'real', created_at: '2026-09-14T00:00:01Z', metadata: { graph_id: 'lma-agent', name: '  站点分析  ' } },
      ];
    });
    const mockClient = {
      threads: { search: searchMock },
    } as any;
    const adapter = createLangGraphThreadListAdapter(mockClient);
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

  it('官方 DeepSeek AIMessage 通过 translator 标准化 contentBlocks，消费层只消费 contentBlocks', async () => {
    const message = new AIMessage({
      id: 'msg-1',
      content: '最终回答',
      additional_kwargs: {
        reasoning_content: '先检查监测数据',
      },
      response_metadata: {
        model_provider: 'deepseek',
      },
    });

    expect(message.contentBlocks).toEqual([
      {
        type: 'reasoning',
        reasoning: '先检查监测数据',
      },
      {
        type: 'text',
        text: '最终回答',
      },
    ]);
  });

  it('thinking=false 时不生成 reasoning block', () => {
    const message = new AIMessage({
      id: 'msg-plain',
      content: '纯文本回答，未开启思考模式。',
      response_metadata: {
        model_provider: 'deepseek',
      },
    });

    expect(message.contentBlocks).toEqual([
      {
        type: 'text',
        text: '纯文本回答，未开启思考模式。',
      },
    ]);
  });

  it('rejoin/hydrate 验证：保留 model_provider 与 reasoning_content 时可恢复 contentBlocks reasoning', () => {
    const hydratedMessage = new AIMessage({
      id: 'hydrated-ai-1',
      content: '恢复的历史回答',
      additional_kwargs: {
        reasoning_content: '历史思考过程：已核验位移曲线',
        created_at: '2026-09-18T10:00:00+08:00',
      },
      response_metadata: {
        model_provider: 'deepseek',
      },
    });

    expect(hydratedMessage.contentBlocks.some((b) => b.type === 'reasoning')).toBe(true);
    const reasoningBlock = hydratedMessage.contentBlocks.find((b) => b.type === 'reasoning');
    expect((reasoningBlock as any)?.reasoning).toBe('历史思考过程：已核验位移曲线');
  });

});

it('并行工具按 callId 独立更新，rejoin 后终态正确渲染', async () => {
  const { rerender } = render(
    <ToolFallback
      toolName="query_weather"
      status={{ type: 'running' }}
      argsText="{}"
    />
  );
  expect(screen.getByText('正在查询同期天气…')).toBeInTheDocument();

  rerender(
    <ToolFallback
      toolName="query_weather"
      status={{ type: 'incomplete', error: '天气服务暂不可用' }}
      argsText="{}"
    />
  );
  expect(screen.getByText('天气数据查询失败')).toBeInTheDocument();
  await userEvent.click(screen.getByText('天气数据查询失败'));
  expect(screen.getByText('天气服务暂不可用')).toBeInTheDocument();
});

it('合法 v1 artifact 到达后直接展示业务数据，不依赖 raw JSON', async () => {
  render(
    <ToolFallback
      toolName="list_stations"
      status={{ type: 'complete' }}
      argsText="{}"
      artifact={{
        version: 1,
        kind: 'station_list',
        status: 'success',
        data: { stations: [{ station_name: '实时测点X', station_status: '正常' }] },
      }}
    />
  );
  await userEvent.click(screen.getByText(/已查询监测点信息/));
  expect(screen.getByText('实时测点X')).toBeInTheDocument();
});

it('返回空内容时显示空状态，不处于 loading 态', async () => {
  render(
    <ToolFallback
      toolName="list_stations"
      status={{ type: 'complete' }}
      argsText="{}"
    />
  );
  expect(screen.getByText('已查询监测点信息')).toBeInTheDocument();
});

it('P0-1 & P0-3: liveToolCall 返回任意合法结果（空数组/字符串/0/false/null）均视为完成，不回退为 loading', async () => {
  const legalOutputs = [[], '', 0, false, null];
  for (const out of legalOutputs) {
    const { unmount } = render(
      <ToolFallback
        toolName="list_stations"
        status={{ type: 'complete' }}
        argsText="{}"
        result={out}
      />
    );
    expect(screen.getByText('已查询监测点信息')).toBeInTheDocument();
    unmount();
  }
});

it('P0-2: ToolMessage.artifact 到达后自然呈现业务结果，两阶段数据平滑衔接', async () => {
  // 阶段 1：未收到 ToolMessage 时处于完成状态并显示通用友好说明，不输出 raw JSON
  const { rerender } = render(
    <ToolFallback
      toolName="list_stations"
      status={{ type: 'complete' }}
      argsText="{}"
      result="正在同步..."
    />
  );
  expect(screen.getByText('已查询监测点信息')).toBeInTheDocument();
  await userEvent.click(screen.getByText('已查询监测点信息'));
  expect(screen.getByText('未查询到符合条件的业务监测数据。')).toBeInTheDocument();
  expect(screen.queryByText('正在同步...')).not.toBeInTheDocument();

  // 阶段 2：权威 ToolMessage 到达，自然渲染业务点列表
  rerender(
    <ToolFallback
      toolName="list_stations"
      status={{ type: 'complete' }}
      argsText="{}"
      result="ok"
      artifact={{
        version: 1,
        kind: 'station_list',
        status: 'success',
        data: { stations: [{ station_name: '持久化确定点', station_status: '正常' }] },
      }}
    />
  );
  expect(screen.getByText('持久化确定点')).toBeInTheDocument();
});

it('P0-4: decodeToolArtifact 严格验证 version 1 规范与 artifactKind 匹配，非法/缺失产物安全返回 undefined', () => {
  const validEnvelope = {
    version: 1,
    kind: 'station_list',
    status: 'success',
    data: { stations: [] },
  };
  expect(decodeToolArtifact('list_stations', validEnvelope)).toMatchObject({
    version: 1,
    kind: 'station_list',
    status: 'success',
  });

  // 2. kind 与注册工具不匹配时拒绝
  expect(decodeToolArtifact('list_stations', { ...validEnvelope, kind: 'weather' })).toBeUndefined();

  // 3. 非 version 1 拒绝
  expect(decodeToolArtifact('list_stations', { ...validEnvelope, version: 2 })).toBeUndefined();

  // 4. 非法 status 拒绝
  expect(decodeToolArtifact('list_stations', { ...validEnvelope, status: 'unknown' })).toBeUndefined();

  // 5. 传统无 envelope 结构拒绝
  expect(decodeToolArtifact('list_stations', { stations: [] })).toBeUndefined();
  expect(decodeToolArtifact('list_stations', 'not an object')).toBeUndefined();
  expect(decodeToolArtifact('list_stations', null)).toBeUndefined();
  expect(decodeToolArtifact('list_stations', undefined)).toBeUndefined();
});

it('真实流式异步：A/B/C 三个工具分别延迟异步返回，完成的工具即时展示内容，空结果显示成功与无数据，互不阻塞', async () => {
  vi.useFakeTimers();
  try {
    const StreamingContainer = () => {
      const [toolStatuses, setToolStatuses] = React.useState<Record<string, { status: any; artifact?: any }>>({
        'call-a': { status: { type: 'running' } },
        'call-b': { status: { type: 'running' } },
        'call-c': { status: { type: 'running' } },
      });

      React.useEffect(() => {
        const t1 = setTimeout(() => {
          setToolStatuses((prev) => ({
            ...prev,
            'call-a': {
              status: { type: 'complete' },
              artifact: {
                version: 1,
                kind: 'station_list',
                status: 'success',
                data: { stations: [{ station_name: '测点A', station_status: '正常' }] },
              },
            },
          }));
        }, 100);

        const t2 = setTimeout(() => {
          setToolStatuses((prev) => ({
            ...prev,
            'call-b': {
              status: { type: 'complete' },
              artifact: {
                version: 1,
                kind: 'station_list',
                status: 'success',
                data: { groups: [] },
              },
            },
          }));
        }, 500);

        const t3 = setTimeout(() => {
          setToolStatuses((prev) => ({
            ...prev,
            'call-c': {
              status: { type: 'complete' },
              artifact: {
                version: 1,
                kind: 'gnss_series',
                status: 'success',
                data: { points: [{ time: '2026-09-18 12:00:00', n: 1.234, e: 2.345, u: 3.456 }] },
              },
            },
          }));
        }, 1000);

        return () => {
          clearTimeout(t1);
          clearTimeout(t2);
          clearTimeout(t3);
        };
      }, []);

      return (
        <div>
          <ToolFallback
            toolName="list_stations"
            status={toolStatuses['call-a'].status}
            argsText="{}"
            artifact={toolStatuses['call-a'].artifact}
          />
          <ToolFallback
            toolName="list_station_groups"
            status={toolStatuses['call-b'].status}
            argsText="{}"
            artifact={toolStatuses['call-b'].artifact}
          />
          <ToolFallback
            toolName="get_daily_gnss_data"
            status={toolStatuses['call-c'].status}
            argsText="{}"
            artifact={toolStatuses['call-c'].artifact}
          />
        </div>
      );
    };

    render(<StreamingContainer />);

    // 初始状态（0ms）：全部 running
    expect(screen.getByRole('button', { name: /正在查询监测点信息…/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /正在查询监测点分组…/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /正在获取 GNSS 监测数据…/ })).toBeInTheDocument();

    // 前进 100ms：A 完成并展示结果，B/C 仍 running
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole('button', { name: /已查询监测点信息/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /正在查询监测点分组…/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /正在获取 GNSS 监测数据…/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已查询监测点信息/ }));
    expect(screen.getByText('测点A')).toBeInTheDocument();

    // 前进 400ms（到达 500ms）：B 完成，C 仍 running
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByRole('button', { name: /已查询监测点信息/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /已查询监测点分组/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /正在获取 GNSS 监测数据…/ })).toBeInTheDocument();

    // 前进 500ms（到达 1000ms）：C 完成，三者均完成
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole('button', { name: /已获取 GNSS 监测数据/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已获取 GNSS 监测数据/ }));
    expect(screen.getByText('1.234')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('P6: ReasoningTrigger 根据 active 状态显示“正在思考…”或“已思考”，且 streaming 自动控制展开', async () => {
  // 1. active 状态标签
  const { rerender, container } = render(
    <ReasoningRoot>
      <ReasoningTrigger active={true} />
    </ReasoningRoot>
  );
  expect(screen.getByText('正在思考…')).toBeInTheDocument();

  rerender(
    <ReasoningRoot>
      <ReasoningTrigger active={false} />
    </ReasoningRoot>
  );
  expect(screen.getByText('已思考')).toBeInTheDocument();

  // 2. streaming=true 自动展开面板
  rerender(
    <ReasoningRoot streaming={true}>
      <ReasoningTrigger active={true} />
      <div data-testid="reasoning-body">正在实时思考推理中...</div>
    </ReasoningRoot>
  );
  const rootEl = container.querySelector('[data-slot="reasoning-root"]');
  expect(rootEl).toHaveAttribute('data-state', 'open');
  expect(screen.getByTestId('reasoning-body')).toBeInTheDocument();

  // 3. streaming=false 自动恢复折叠（默认 defaultOpen=false）
  rerender(
    <ReasoningRoot streaming={false}>
      <ReasoningTrigger active={false} />
      <div data-testid="reasoning-body">正在实时思考推理中...</div>
    </ReasoningRoot>
  );
  expect(rootEl).toHaveAttribute('data-state', 'closed');

  // 4. 用户手动点击展开
  await userEvent.click(screen.getByRole('button'));
  expect(rootEl).toHaveAttribute('data-state', 'open');
});

it('摘要消息通过 ThreadSummaryMessage 渲染折叠卡片，绝不作为用户气泡', async () => {
  render(<ThreadSummaryMessage text="这是之前轮次的滑坡监测背景摘要。" />);
  expect(screen.getByText('更早的对话已压缩为摘要')).toBeInTheDocument();

  await userEvent.click(screen.getByText('更早的对话已压缩为摘要'));
  expect(screen.getByText('这是之前轮次的滑坡监测背景摘要。')).toBeInTheDocument();
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

it('ReasoningTrigger 与 ToolFallbackTrigger 排版对齐：思考去图标、工具运行态隐藏 Chevron 并禁止交互', async () => {
  // 1. ReasoningTrigger：不渲染 BrainIcon，仅文本与极淡 Chevron
  const { container: reasoningContainer, rerender: rerenderReasoning } = render(
    <ReasoningRoot>
      <ReasoningTrigger active={true} />
    </ReasoningRoot>
  );
  expect(screen.getByText('正在思考…')).toBeInTheDocument();
  expect(reasoningContainer.querySelector('svg.aui-reasoning-trigger-icon')).not.toBeInTheDocument();
  expect(reasoningContainer.querySelector('svg.aui-reasoning-trigger-chevron')).toBeInTheDocument();

  rerenderReasoning(
    <ReasoningRoot>
      <ReasoningTrigger active={false} />
    </ReasoningRoot>
  );
  expect(screen.getByText('已思考')).toBeInTheDocument();
  expect(reasoningContainer.querySelector('svg.aui-reasoning-trigger-icon')).not.toBeInTheDocument();

  // 2. ToolFallback: running 时无 chevron 且 disabled
  const { container: toolContainer, rerender: rerenderTool } = render(
    <ToolFallback
      toolName="get_daily_gnss_data"
      status={{ type: 'running' }}
      argsText="{}"
    />
  );
  expect(screen.getByText('正在获取 GNSS 监测数据…')).toBeInTheDocument();
  expect(toolContainer.querySelector('svg.aui-tool-fallback-trigger-chevron')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /正在获取 GNSS 监测数据…/ })).toBeDisabled();

  // 3. ToolFallback: complete 时有 chevron，且默认折叠
  rerenderTool(
    <ToolFallback
      toolName="get_daily_gnss_data"
      status={{ type: 'complete' }}
      argsText="{}"
      artifact={{
        version: 1,
        kind: 'gnss_series',
        status: 'success',
        data: {
          station_name: '测试站-01',
          points: [{ time: '2026-09-19 12:00:00', n: 1.0, e: 2.0, u: 3.0 }],
        },
      }}
    />
  );
  expect(screen.getByText('已获取 GNSS 监测数据')).toBeInTheDocument();
  expect(toolContainer.querySelector('svg.aui-tool-fallback-trigger-chevron')).toBeInTheDocument();
  expect(screen.queryByText('测试站-01')).not.toBeInTheDocument();

  // 点击展开后，直接展示业务结果（无二级查看详细数据层级）
  await userEvent.click(screen.getByText('已获取 GNSS 监测数据'));
  expect(screen.getByText('测试站-01')).toBeInTheDocument();
  expect(screen.getByText('2026-09-19 12:00:00')).toBeInTheDocument();
});

it('所有普通工具（包括场地环境）默认折叠，仅 HITL / requires-action 自动展开', async () => {
  // 1. inspect_site_environment 默认折叠（移除 defaultExpanded）
  render(
    <ToolFallback
      toolName="inspect_site_environment"
      status={{ type: 'complete' }}
      argsText="{}"
      artifact={{
        version: 1,
        kind: 'site_environment',
        status: 'success',
        data: {
          site_environment: {
            station: { id: 's1', name: '监测点A', latitude: 30.1, longitude: 104.2 },
            terrain: { elevation_m: 520 },
            geology: { unit_name: '泥质灰岩' },
          },
        },
      }}
    />
  );
  expect(screen.getByText('已获取场地环境信息')).toBeInTheDocument();
  expect(screen.queryByText('监测点A')).not.toBeInTheDocument();

  // 2. requires-action 工具默认展开供用户交互
  const TestAuiWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const runtime = useLocalRuntime({});
    return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
  };

  render(
    <TestAuiWrapper>
      <ToolFallback
        toolName="dangerous_action"
        status={{ type: 'requires-action', reason: 'approval' }}
        argsText="{}"
        approval={{
          type: 'approval',
          decision: 'pending',
          prompt: '请确认是否执行此辅助调查操作？',
        } as any}
      />
    </TestAuiWrapper>
  );
  expect(screen.getByText(/待确认辅助操作|待确认/)).toBeInTheDocument();
  expect(screen.getByText('请确认是否执行此辅助调查操作？')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
});
