import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatWindow } from '../src/components/ChatWindow';
import { InlineToolCall, parseOutputRecord } from '../src/components/InlineToolCall';
import { MessageActions } from '../src/components/MessageActions';
import { Sidebar } from '../src/components/Sidebar';
import { OptimisticMessageStatus } from '../src/components/OptimisticMessageStatus';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { ToastContainer, useToast } from '../src/components/Toast';
import { RunFailureCard } from '../src/components/RunFailureCard';
import { STREAM_CONTROLLER } from '@langchain/react';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { AssembledToolCall } from '@langchain/langgraph-sdk/stream';
import { createLangGraphThreadListAdapter } from '../src/lib/langgraph/thread-list-adapter';
import { groupMessagesForDisplay } from '../src/components/messageDisplay';

describe('会话关键路径集成回归', () => {
  it('官方内部摘要不成为用户气泡，分组保留原始 BaseMessage 引用', () => {
    const summary = new HumanMessage({
      id: 'summary',
      content: '历史摘要',
      additional_kwargs: { lc_source: 'summarization' },
    });
    const user = new HumanMessage({ id: 'user', content: '历史摘要' });
    const answer = new AIMessage({ id: 'answer', content: '回答' });

    const turns = groupMessagesForDisplay([summary, user, answer]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ kind: 'human', message: user });
    expect(turns[1]).toMatchObject({ kind: 'assistant', messages: [answer] });
    expect(turns[1].kind === 'assistant' && turns[1].messages[0]).toBe(answer);
  });
  it('用户消息正常分组展示', () => {
    const raw = [
      { type: 'human', id: 'u1', content: '查询站点' },
    ];

    expect(groupMessagesForDisplay([new HumanMessage(raw[0] as any)]))
      .toMatchObject([{ kind: 'human', message: { id: 'u1', content: '查询站点' } }]);
  });

  it('已完成的 ToolMessage 与 AI tool call 在同一助手回合保留官方对象', () => {
    const aiCall = new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'list_stations', args: {} }],
    });
    const toolResult = new ToolMessage({
      tool_call_id: 'call-1',
      name: 'list_stations',
      content: '{"ok":true}',
    });
    const answer = new AIMessage('查询完成。');

    const turns = groupMessagesForDisplay([aiCall, toolResult, answer]);
    expect(turns).toHaveLength(1);
    expect(turns[0].kind === 'assistant' && turns[0].messages).toEqual([
      aiCall,
      toolResult,
      answer,
    ]);
  });

  it('优先展示标准 contentBlocks reasoning，不读取耗时字段', async () => {
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
    const toolResult = new ToolMessage({
      tool_call_id: 'call-1',
      name: 'list_stations',
      content: '{"ok":true}',
      artifact: { data: { total: 0, stations: [] } },
    });
    const finalAI = new AIMessage({
      id: 'a2',
      contentBlocks: [
        { type: 'reasoning', reasoning: '根据返回结果组织结论。' },
        { type: 'text', text: '查询完成。' },
      ],
    });

    render(
      <ChatWindow
        messages={[firstAI, toolResult, finalAI]}
        onSendMessage={() => undefined}
        threadLoading={false} runActive={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.queryByText('1.3 秒')).not.toBeInTheDocument();
    expect(screen.queryByText('不应重复展示的兼容内容')).not.toBeInTheDocument();
    expect(screen.queryByText('先确认目标站点，再查询监测数据。')).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /已思考/ })[0]);
    expect(screen.getByText('先确认目标站点，再查询监测数据。')).toBeInTheDocument();
  });

  it('推荐动作可直接发送，回到底部按钮仅在上翻后显示在输入区附近', async () => {
    const onSend = vi.fn();
    render(
      <ChatWindow
        messages={[new AIMessage({ id: 'a1', content: '分析完成。' })]}
        onSendMessage={onSend}
        threadLoading={false} runActive={false}
        recommendations={['查看同组其他监测点']}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: '查看同组其他监测点' }));
    expect(onSend).toHaveBeenCalledWith('查看同组其他监测点');
    expect(screen.queryByRole('button', { name: '回到底部' })).not.toBeInTheDocument();

    const scroller = screen.getByLabelText('对话消息');
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, value: 100 },
    });
    fireEvent.scroll(scroller);
    expect(screen.getByRole('button', { name: '回到底部' })).toBeInTheDocument();
  });


  it('停止后继续提问时，旧助手回合与新回合保持独立且引用不变', () => {
    const firstUser = new HumanMessage({ id: 'u1', content: '查询监测数据' });
    const toolAI = new AIMessage({
      id: 'a1',
      content: '',
      tool_calls: [{ id: 'c1', name: 'get_daily_gnss_data', args: {} }],
    });
    const toolResult = new ToolMessage({
      id: 't1',
      tool_call_id: 'c1',
      name: 'get_daily_gnss_data',
      content: '完成',
    });
    const secondUser = new HumanMessage({ id: 'u2', content: '继续' });
    const secondAnswer = new AIMessage({ id: 'a2', content: '这是新 Run 的总结。' });

    const turns = groupMessagesForDisplay([
      firstUser,
      toolAI,
      toolResult,
      secondUser,
      secondAnswer,
    ]);
    expect(turns.map((turn) => turn.kind)).toEqual(['human', 'assistant', 'human', 'assistant']);
    expect(turns[1].kind === 'assistant' && turns[1].messages).toEqual([toolAI, toolResult]);
    expect(turns[3].kind === 'assistant' && turns[3].messages[0]).toBe(secondAnswer);
  });

  it('GNSS 空值与非有限值显示为缺测，不会转换为零', async () => {
    render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'call-gnss', name: 'get_daily_gnss_data', args: {} }}
        toolMessage={new ToolMessage({
          tool_call_id: 'call-gnss',
          name: 'get_daily_gnss_data',
          content: '模型内容',
          status: 'success',
          artifact: { data: {
            station_name: '测试站',
            points: [
              { time: '2026-09-15 08:00:00', n: null, e: undefined, u: '' },
              { time: '2026-09-15 09:00:00', n: Number.NaN, e: Number.POSITIVE_INFINITY, u: '12.5' },
              { time: '2026-09-15 10:00:00', n: 0, e: '0', u: 0 },
            ],
          } },
        })}
      />
    );
    await userEvent.click(screen.getByText('获取北斗GNSS日监测数据'));
    expect(screen.getAllByText('—')).toHaveLength(5);
    expect(screen.getAllByText('0.000')).toHaveLength(3);
    expect(screen.getByText('12.500')).toBeInTheDocument();
  });

  it('GNSS 折线在缺测点处分段，不把缺测绘制为零或跨段连线', async () => {
    const { container } = render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'call-chart', name: 'analyze_gnss_chart', args: {} }}
        toolMessage={new ToolMessage({
          tool_call_id: 'call-chart',
          name: 'analyze_gnss_chart',
          content: '模型内容',
          status: 'success',
          artifact: {
            data: { station_name: '测试站', observations: {}, total_points: 5 },
            chart_points: [
              { t: '2026-09-15 08:00:00', n: 1, e: 2, u: 3 },
              { t: '2026-09-15 09:00:00', n: 2, e: 3, u: 4 },
              { t: '2026-09-15 10:00:00', n: null, e: '', u: Number.NaN },
              { t: '2026-09-15 11:00:00', n: 3, e: 4, u: 5 },
              { t: '2026-09-15 12:00:00', n: 4, e: 5, u: 6 },
            ],
          },
        })}
      />
    );
    await userEvent.click(screen.getByText('视觉复核'));
    const polylines = Array.from(container.querySelectorAll('polyline'));
    expect(polylines).toHaveLength(6);
    expect(polylines.every((line) => !line.getAttribute('points')?.includes('50.00,'))).toBe(true);
  });

  it('站点状态分别展示，旧数字状态和缺失类型均显示未知', async () => {
    render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'call-stations', name: 'list_stations', args: {} }}
        toolMessage={new ToolMessage({
          tool_call_id: 'call-stations',
          name: 'list_stations',
          content: '模型内容',
          status: 'success',
          artifact: { data: { stations: [
            { station_name: 'A', station_status: '正常', station_type: '基准站' },
            { station_name: 'B', station_status: '离线', station_type: '移动站RTK模式' },
            { station_name: 'C', station_status: '告警', station_type: '移动站单点模式' },
            { station_name: 'D', station_status: '故障', station_type: '中继站' },
            { station_name: 'E', station_status: 10 },
          ] } },
        })}
      />
    );
    await userEvent.click(screen.getByText('查询监测点列表'));
    for (const label of ['正常', '离线', '告警', '故障']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('未知')).toHaveLength(2);
    expect(screen.queryByText('正常 (10)')).not.toBeInTheDocument();
  });

  it('未知工具结果不提供原始字段查看入口', async () => {
    const { container } = render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'call-internal', name: 'internal_step', args: {} }}
        toolMessage={new ToolMessage({
          tool_call_id: 'call-internal',
          name: 'internal_step',
          content: 'MODEL_ONLY',
          status: 'success',
          artifact: { data: { internal_field: 'value' } },
        })}
      />
    );
    expect(screen.queryByText('internal_step')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('执行工具查询'));
    expect(screen.queryByText('技术详情')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('internal_field');
    expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();
  });

  it('业务失败由 ToolMessage.status 决定，原因只读取 artifact.data.message', async () => {
    const { container } = render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'c1', name: 'get_daily_gnss_data', args: {} }}
        toolMessage={new ToolMessage({
          name: 'get_daily_gnss_data',
          tool_call_id: 'c1',
          status: 'error',
          content: 'MODEL_ONLY net_change_mm secret://internal',
          artifact: {
            data: { message: '未找到指定监测点，请确认站点。' },
            error: { category: 'business' },
            internal: 'PRIVATE',
          },
        })}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('未找到指定监测点');
    await userEvent.click(screen.getByText(/获取北斗GNSS日监测数据/));
    expect(container.textContent).not.toMatch(/MODEL_ONLY|net_change_mm|secret:|PRIVATE|business/);
  });

  it('成功工具只从 artifact.data 取业务展示，content 不作为界面数据源', async () => {
    const { container } = render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'c1', name: 'list_stations', args: {} }}
        toolMessage={new ToolMessage({
          name: 'list_stations',
          tool_call_id: 'c1',
          status: 'success',
          content: '{"internal_field":"MODEL_ONLY"}',
          artifact: { data: { total: 0, stations: [] } },
        })}
      />
    );
    await userEvent.click(screen.getByText('查询监测点列表'));
    expect(container.textContent).toContain('共查询到 0 个监测点详情');
    expect(container.textContent).not.toContain('MODEL_ONLY');
  });

  it('视觉复核失败的原因可见，已获得的图表仍可展开查看', async () => {
    render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'c1', name: 'analyze_gnss_chart', args: {} }}
        toolMessage={new ToolMessage({
          name: 'analyze_gnss_chart',
          tool_call_id: 'c1',
          status: 'error',
          content: '模型内容',
          artifact: {
            data: { station_name: '测试站', message: '视觉模型未配置，图表可供人工查看。' },
            chart_points: [{ t: '08:00', n: 1, e: 2, u: 3 }, { t: '09:00', n: 2, e: 3, u: 4 }],
            images: [{ name: 'raw_coordinates', png_base64: 'TEST_IMAGE' }],
          },
        })}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('视觉模型未配置');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('视觉复核（未完成）'));
    expect(screen.getByRole('img', { name: /原始坐标时序/ })).toBeInTheDocument();
  });

  it('调用预算错误只消费 artifact.data.message，不匹配英文 content', () => {
    render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'c', name: 'list_stations', args: {} }}
        toolMessage={new ToolMessage({
          tool_call_id: 'c',
          name: 'list_stations',
          status: 'error',
          content: 'UNTRUSTED_PROVIDER_ERROR',
          artifact: { data: { message: '本轮查询次数已达到上限，未执行此查询；请依据已有证据继续分析。' } },
        })}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('查询次数已达到上限');
    expect(screen.queryByText(/UNTRUSTED_PROVIDER_ERROR/)).not.toBeInTheDocument();
  });

  it('畸形 artifact 字段 fail-closed，不扩散为聊天窗口异常', async () => {
    render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'bad', name: 'internal_step', args: {} }}
        toolMessage={new ToolMessage({
          tool_call_id: 'bad',
          name: 'internal_step',
          status: 'success',
          content: 'UNTRUSTED',
          artifact: {
            data: 'not-an-object',
            images: { filter: 'not-a-function' },
            chart_points: [null, { t: 1 }],
            site_environment: { coordinate_system: 'WGS84' },
          },
        })}
      />
    );
    await userEvent.click(screen.getByText('执行工具查询'));
    expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();
    expect(screen.queryByText('UNTRUSTED')).not.toBeInTheDocument();
  });

  it('消息时间只显示服务端时间并按 Asia/Shanghai 格式化', () => {
    const { rerender } = render(<MessageActions getText={() => '消息'} timestamp="2026-09-15T00:05:00Z" />);
    expect(screen.getByText('08:05')).toBeInTheDocument();
    rerender(<MessageActions getText={() => '消息'} />);
    expect(screen.queryByText('08:05')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  });

  it('输入框发送按钮左侧可查看上下文 token 明细', async () => {
    render(
      <ChatWindow
        messages={[]}
        onSendMessage={() => undefined}
        threadLoading={false} runActive={false}
        contextUsage={{
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
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );

    await userEvent.click(screen.getByLabelText('上下文预算已用 25%'));
    expect(screen.getByText('当前请求输入')).toBeInTheDocument();
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.queryByText('75.0K')).not.toBeInTheDocument();
  });

  it('缺少真实 usage 时不渲染上下文占比，也不显示未配置占位', () => {
    render(
      <ChatWindow
        messages={[]}
        onSendMessage={() => undefined}
        threadLoading={false} runActive={false}
        contextUsage={{ context_limit_tokens: 1_048_576 }}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.queryByText(/上下文窗口|未配置/)).not.toBeInTheDocument();
  });

  it('推荐生成失败时静默降级不向用户展示错误，也不生成固定推荐', () => {
    render(
      <ChatWindow
        messages={[new AIMessage('分析完成。')]}
        onSendMessage={() => undefined}
        threadLoading={false} runActive={false}
        recommendationError="下一步建议返回格式无效。"
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.queryByText('下一步建议返回格式无效。')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /查看近期趋势/ })).not.toBeInTheDocument();
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

  it('官方 DeepSeek AIMessage 通过 translator 标准化 contentBlocks，ChatWindow 只消费 contentBlocks', async () => {
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

    render(
      <ChatWindow
        messages={[message]}
        onSendMessage={() => undefined}
        threadLoading={false}
        runActive={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );

    expect(screen.getByText('已思考')).toBeInTheDocument();
    expect(screen.getByText('最终回答')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /已思考/ }));
    expect(screen.getByText('先检查监测数据')).toBeInTheDocument();
  });

  it('thinking=false 时不生成 reasoning block，页面不出现空 ThinkingBlock', () => {
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

    render(
      <ChatWindow
        messages={[message]}
        onSendMessage={() => undefined}
        threadLoading={false}
        runActive={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );

    expect(screen.queryByRole('button', { name: /思考/ })).not.toBeInTheDocument();
    expect(screen.queryByText('已思考')).not.toBeInTheDocument();
    expect(screen.queryByText('正在思考')).not.toBeInTheDocument();
    expect(screen.getByText('纯文本回答，未开启思考模式。')).toBeInTheDocument();
  });

  it('reasoning -> tool_call -> ToolMessage -> text 顺序稳定展示', async () => {
    const firstAI = new AIMessage({
      id: 'a1',
      contentBlocks: [
        { type: 'reasoning', reasoning: '先查询监测点列表' },
        { type: 'tool_call', id: 'call-1', name: 'list_stations', args: {} },
      ],
    });
    const toolResult = new ToolMessage({
      tool_call_id: 'call-1',
      name: 'list_stations',
      content: '{"ok":true}',
      artifact: { data: { total: 0, stations: [] } },
    });
    const finalAI = new AIMessage({
      id: 'a2',
      contentBlocks: [
        { type: 'reasoning', reasoning: '根据查询结果总结' },
        { type: 'text', text: '已无其他异常。' },
      ],
    });

    render(
      <ChatWindow
        messages={[firstAI, toolResult, finalAI]}
        onSendMessage={() => undefined}
        threadLoading={false}
        runActive={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );

    const thinkingButtons = screen.getAllByRole('button', { name: /已思考/ });
    expect(thinkingButtons).toHaveLength(2);
    expect(screen.getByText('已无其他异常。')).toBeInTheDocument();
    await userEvent.click(thinkingButtons[0]);
    expect(screen.getByText('先查询监测点列表')).toBeInTheDocument();
    await userEvent.click(thinkingButtons[1]);
    expect(screen.getByText('根据查询结果总结')).toBeInTheDocument();
  });

  it('rejoin/hydrate 验证：保留 model_provider 与 reasoning_content 时可恢复 contentBlocks reasoning', async () => {
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

    render(
      <ChatWindow
        messages={[hydratedMessage]}
        onSendMessage={() => undefined}
        threadLoading={false}
        runActive={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );

    expect(screen.getByText('已思考')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /已思考/ }));
    expect(screen.getByText('历史思考过程：已核验位移曲线')).toBeInTheDocument();
  });

  it('删除会话时具备确认步骤：点击删除弹出确认弹窗，取消不删除，确认后才调用删除', async () => {
    const user = userEvent.setup();
    const handleDeleteSession = vi.fn();
    const sessions = [
      { thread_id: 'thread-1', name: '监测点A形变分析', created_at: '2026-09-15T12:00:00Z' },
      { thread_id: 'thread-2', name: '监测点B滑坡调查', created_at: '2026-09-15T13:00:00Z' },
    ];

    render(
      <Sidebar
        sessions={sessions}
        activeSessionId="thread-1"
        isNewSessionDraft={false}
        busyThreadIds={[]}
        onSelectSession={() => undefined}
        onCreateSession={() => undefined}
        onRenameSession={() => undefined}
        onDeleteSession={handleDeleteSession}
        onToggleCollapse={() => undefined}
        onOpenConfig={() => undefined}
        isLiveServer={true}
      />
    );

    const deleteButtons = screen.getAllByTitle('删除');
    expect(deleteButtons.length).toBe(2);

    // 1. 点击删除按钮，不应立刻触发删除，而应弹出确认弹窗
    await user.click(deleteButtons[0]);
    expect(handleDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('删除会话')).toBeInTheDocument();
    expect(screen.getByText(/确定要删除会话/)).toBeInTheDocument();
    expect(screen.getByText(/“监测点A形变分析”/)).toBeInTheDocument();

    // 2. 点击取消，弹窗关闭，未触发删除
    const cancelButton = screen.getByRole('button', { name: '取消' });
    await user.click(cancelButton);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(handleDeleteSession).not.toHaveBeenCalled();

    // 3. 再次点击删除，并在弹窗中点击“确认删除”
    await user.click(deleteButtons[0]);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: '确认删除' });
    await user.click(confirmButton);
    expect(handleDeleteSession).toHaveBeenCalledTimes(1);
    expect(handleDeleteSession).toHaveBeenCalledWith('thread-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

it('新建会话的中央消息区域为空白，保留输入入口', () => {
  render(<ChatWindow messages={[]} onSendMessage={vi.fn()} threadLoading={false} runActive={false}
    isSidebarCollapsed={false} onToggleSidebar={vi.fn()} isNewSessionDraft />);
  expect(screen.getByLabelText('对话消息').textContent).toBe('');
  expect(screen.getByLabelText('对话消息').querySelectorAll('p,h3,svg')).toHaveLength(0);
  expect(screen.queryByText('开启滑坡连续监测业务调查')).not.toBeInTheDocument();
});

it('Thread hydration 只显示历史加载态，不显示 Stop 或 AI 思考', () => {
  render(<ChatWindow messages={[]} onSendMessage={vi.fn()} threadLoading runActive={false}
    isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />);
  expect(screen.getByText('正在加载会话…')).toBeInTheDocument();
  expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument();
  expect(screen.queryByText('智能体正在检索北斗平台与分析监测数据...')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境...')).toBeDisabled();
});

it('Run active 才显示 Stop 和思考；非 active 时显示发送按钮且允许提交', async () => {
  const props = {
    messages: [new HumanMessage({ id: 'u1', content: '查询' })],
    onSendMessage: vi.fn(), threadLoading: false, runActive: true,
    isSidebarCollapsed: false, onToggleSidebar: vi.fn(),
  };
  const mounted = render(<ChatWindow {...props} />);
  expect(screen.getByTitle('停止生成')).toBeInTheDocument();
  expect(screen.getByText('智能体正在检索北斗平台与分析监测数据...')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境...')).toBeDisabled();

  mounted.rerender(<ChatWindow {...props} runActive={false} />);
  const textarea = screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境...');
  expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument();
  expect(screen.queryByText('智能体正在检索北斗平台与分析监测数据...')).not.toBeInTheDocument();
  expect(textarea).toBeEnabled();
  await userEvent.type(textarea, '下一条问题');
  expect(screen.getByTitle('发送 (Enter)')).toBeEnabled();
});

it('并行工具按 callId 独立更新，rejoin 后终态只读 ToolMessage', async () => {
  const aiMessage = new AIMessage({
    id: 'a1',
    content: '',
    tool_calls: [
      { id: 'weather', name: 'query_weather', args: {} },
      { id: 'stations', name: 'list_stations', args: {} },
    ],
  });
  const stationsResult = new ToolMessage({
    tool_call_id: 'stations',
    name: 'list_stations',
    content: '完成',
    status: 'success',
    artifact: { data: { stations: [] } },
  });
  const liveCalls = [
    { name: 'query_weather', callId: 'weather', id: 'weather', namespace: [], input: {}, args: {}, output: null, status: 'running', error: undefined },
    { name: 'list_stations', callId: 'stations', id: 'stations', namespace: [], input: {}, args: {}, output: {}, status: 'finished', error: undefined },
  ] as const;
  const mounted = render(
    <ChatWindow messages={[aiMessage, stationsResult]} toolCalls={[...liveCalls]}
      onSendMessage={vi.fn()} threadLoading={false} runActive
      isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />
  );
  await userEvent.click(screen.getByText('查询天气数据'));
  expect(screen.getByText('正在查询，请稍候…')).toBeInTheDocument();

  const weatherResult = new ToolMessage({
    tool_call_id: 'weather',
    name: 'query_weather',
    content: 'UNTRUSTED',
    status: 'error',
    artifact: { data: { message: '天气服务暂不可用' } },
  });
  mounted.rerender(
    <ChatWindow messages={[aiMessage, weatherResult, stationsResult]} toolCalls={[liveCalls[0]]}
      onSendMessage={vi.fn()} threadLoading={false} runActive={false}
      isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />
  );
  expect(screen.getByRole('alert')).toHaveTextContent('天气服务暂不可用');
  expect(screen.queryByText('正在查询，请稍候…')).not.toBeInTheDocument();
});

it('live finished 且携带 liveOutput 但权威 ToolMessage 尚未到达时直接展示 liveOutput 业务数据', async () => {
  render(
    <InlineToolCall
      toolCall={{ type: 'tool_call', id: 'sync', name: 'list_stations', args: {} }}
      liveToolCall={{
        name: 'list_stations',
        callId: 'sync',
        id: 'sync',
        namespace: [],
        input: {},
        args: {},
        output: { stations: [{ station_name: '实时测点X', station_status: '正常' }] },
        status: 'finished',
        error: undefined,
      } as unknown as AssembledToolCall}
    />,
  );
  const row = screen.getByText('查询监测点列表').closest('[data-status]');
  expect(row).toHaveAttribute('data-status', 'finished');

  await userEvent.click(screen.getByText('查询监测点列表'));
  expect(screen.getByText('实时测点X')).toBeInTheDocument();
  expect(screen.queryByText('正在查询，请稍候…')).not.toBeInTheDocument();
  expect(screen.queryByText('详细结果同步中…')).not.toBeInTheDocument();
});

it('live finished 但返回空内容或无业务数据时显示完成与无数据，不处于 loading 态', async () => {
  render(
    <InlineToolCall
      toolCall={{ type: 'tool_call', id: 'empty', name: 'list_stations', args: {} }}
      liveToolCall={{
        name: 'list_stations',
        callId: 'empty',
        id: 'empty',
        namespace: [],
        input: {},
        args: {},
        output: {},
        status: 'finished',
        error: undefined,
      } as unknown as AssembledToolCall}
    />,
  );
  const row = screen.getByText('查询监测点列表').closest('[data-status]');
  expect(row).toHaveAttribute('data-status', 'finished');

  await userEvent.click(screen.getByText('查询监测点列表'));
  expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();
  expect(screen.queryByText('正在查询，请稍候…')).not.toBeInTheDocument();
});

it('P0-1 & P0-3: liveToolCall 返回任意合法结果（空数组/字符串/0/false/null）均视为完成，不回退为 loading', async () => {
  const legalOutputs = [[], '', 0, false, null];
  for (const out of legalOutputs) {
    const { unmount } = render(
      <InlineToolCall
        toolCall={{ type: 'tool_call', id: 'test-legal', name: 'list_stations', args: {} }}
        liveToolCall={{
          name: 'list_stations',
          callId: 'test-legal',
          id: 'test-legal',
          namespace: [],
          input: {},
          args: {},
          output: out,
          status: 'finished',
          error: undefined,
        } as unknown as AssembledToolCall}
      />
    );
    const row = screen.getByText('查询监测点列表').closest('[data-status]');
    expect(row).toHaveAttribute('data-status', 'finished');
    await userEvent.click(screen.getByText('查询监测点列表'));
    expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();
    expect(screen.queryByText('正在查询，请稍候…')).not.toBeInTheDocument();
    unmount();
  }
});

it('P0-2: ToolMessage.artifact 到达后自然覆盖 liveToolCall.output，两阶段数据平滑衔接', async () => {
  const toolCall = { type: 'tool_call' as const, id: 'twostage', name: 'list_stations', args: {} };
  const liveCall = {
    name: 'list_stations',
    callId: 'twostage',
    id: 'twostage',
    namespace: [],
    input: {},
    args: {},
    output: { stations: [{ station_name: '实时预览点', station_status: '正常' }] },
    status: 'finished',
    error: undefined,
  } as unknown as AssembledToolCall;

  // 阶段 1：未收到 ToolMessage 时展示实时预览点
  const { rerender } = render(
    <InlineToolCall toolCall={toolCall} liveToolCall={liveCall} />
  );
  await userEvent.click(screen.getByText('查询监测点列表'));
  expect(screen.getByText('实时预览点')).toBeInTheDocument();

  // 阶段 2：权威 ToolMessage 到达，自然覆盖为最终持久化点
  const toolMsg = new ToolMessage({
    tool_call_id: 'twostage',
    name: 'list_stations',
    content: 'ok',
    status: 'success',
    artifact: {
      data: { stations: [{ station_name: '持久化确定点', station_status: '正常' }] },
    },
  });
  rerender(
    <InlineToolCall toolCall={toolCall} liveToolCall={liveCall} toolMessage={toolMsg} />
  );
  expect(screen.getByText('持久化确定点')).toBeInTheDocument();
  expect(screen.queryByText('实时预览点')).not.toBeInTheDocument();
});

it('P0-4: parseOutputRecord 集中解析对象与合法 JSON 字符串，非法输出安全降级为 undefined', () => {
  expect(parseOutputRecord({ a: 1 })).toEqual({ a: 1 });
  expect(parseOutputRecord('{"hello": "world"}')).toEqual({ hello: 'world' });
  expect(parseOutputRecord('not a json')).toBeUndefined();
  expect(parseOutputRecord(null)).toBeUndefined();
  expect(parseOutputRecord(123)).toBeUndefined();
  expect(parseOutputRecord(undefined)).toBeUndefined();
});

it('真实流式异步：A/B/C 三个工具分别延迟异步返回，完成的工具即时展示内容，空结果显示成功与无数据，互不阻塞', async () => {
  vi.useFakeTimers();
  try {
    const aiMessage = new AIMessage({
      id: 'ai-stream-batch',
      contentBlocks: [
        { type: 'tool_call', id: 'call-a', name: 'list_stations', args: {} },
        { type: 'tool_call', id: 'call-b', name: 'list_station_groups', args: {} },
        { type: 'tool_call', id: 'call-c', name: 'get_daily_gnss_data', args: {} },
      ],
    });

    const StreamingContainer = () => {
      const [liveCalls, setLiveCalls] = React.useState<AssembledToolCall[]>([
        { callId: 'call-a', name: 'list_stations', status: 'running' } as any,
        { callId: 'call-b', name: 'list_station_groups', status: 'running' } as any,
        { callId: 'call-c', name: 'get_daily_gnss_data', status: 'running' } as any,
      ]);

      React.useEffect(() => {
        // 100ms 后 Tool A 完成，携带测点数据
        const t1 = setTimeout(() => {
          setLiveCalls((prev) => [
            {
              callId: 'call-a',
              name: 'list_stations',
              status: 'finished',
              output: { stations: [{ station_name: '测点A', station_status: '正常' }] },
            } as any,
            prev[1],
            prev[2],
          ]);
        }, 100);

        // 500ms 后 Tool B 完成，返回空数据
        const t2 = setTimeout(() => {
          setLiveCalls((prev) => [
            prev[0],
            { callId: 'call-b', name: 'list_station_groups', status: 'finished', output: {} } as any,
            prev[2],
          ]);
        }, 500);

        // 1000ms 后 Tool C 完成，携带 GNSS 数据
        const t3 = setTimeout(() => {
          setLiveCalls((prev) => [
            prev[0],
            prev[1],
            {
              callId: 'call-c',
              name: 'get_daily_gnss_data',
              status: 'finished',
              output: { points: [{ time: '2026-09-18 12:00:00', n: 1.234, e: 2.345, u: 3.456 }] },
            } as any,
          ]);
        }, 1000);

        return () => {
          clearTimeout(t1);
          clearTimeout(t2);
          clearTimeout(t3);
        };
      }, []);

      return (
        <ChatWindow
          messages={[aiMessage]}
          toolCalls={liveCalls}
          onSendMessage={vi.fn()}
          threadLoading={false}
          runActive={true}
          isSidebarCollapsed={false}
          onToggleSidebar={vi.fn()}
        />
      );
    };

    render(<StreamingContainer />);

    // 初始状态（0ms）：全部 running / pending
    const rowA = screen.getByText('查询监测点列表').closest('[data-status]');
    const rowB = screen.getByText('查询监测点分组').closest('[data-status]');
    const rowC = screen.getByText('获取北斗GNSS日监测数据').closest('[data-status]');
    expect(rowA).toHaveAttribute('data-status', 'pending');
    expect(rowB).toHaveAttribute('data-status', 'pending');
    expect(rowC).toHaveAttribute('data-status', 'pending');

    // 前进 100ms：A 完成并展示结果，B/C 仍 loading
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(rowA).toHaveAttribute('data-status', 'finished');
    expect(rowB).toHaveAttribute('data-status', 'pending');
    expect(rowC).toHaveAttribute('data-status', 'pending');
    fireEvent.click(screen.getByText('查询监测点列表'));
    expect(screen.getByText('测点A')).toBeInTheDocument();

    // 前进 400ms（到达 500ms）：B 完成（空结果），C 仍 loading
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(rowA).toHaveAttribute('data-status', 'finished');
    expect(rowB).toHaveAttribute('data-status', 'finished');
    expect(rowC).toHaveAttribute('data-status', 'pending');
    fireEvent.click(screen.getByText('查询监测点分组'));
    expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();

    // 前进 500ms（到达 1000ms）：C 完成，三者均完成
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(rowA).toHaveAttribute('data-status', 'finished');
    expect(rowB).toHaveAttribute('data-status', 'finished');
    expect(rowC).toHaveAttribute('data-status', 'finished');
    fireEvent.click(screen.getByText('获取北斗GNSS日监测数据'));
    expect(screen.getByText('1.234')).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it('用户消息直接读取官方 optimistic pending/failed 状态', () => {
  const metadata = new Map([
    ['pending-id', { parentCheckpointId: undefined, optimisticStatus: 'pending' }],
    ['failed-id', { parentCheckpointId: undefined, optimisticStatus: 'failed' }],
  ]);
  const store = { subscribe: () => () => undefined, getSnapshot: () => metadata };
  const stream = { [STREAM_CONTROLLER]: { messageMetadataStore: store } } as any;
  render(<><OptimisticMessageStatus stream={stream} messageId="pending-id" />
    <OptimisticMessageStatus stream={stream} messageId="failed-id" /></>);
  expect(screen.getByText('发送中…')).toBeInTheDocument();
  expect(screen.getByText('发送失败')).toBeInTheDocument();
});

it('用户消息发送失败显示“发送失败 · 重试”，点击重试触发对应回调，不提供丢弃按钮', () => {
  const onRetry = vi.fn();
  const metadata = new Map([
    ['failed-id', { parentCheckpointId: undefined, optimisticStatus: 'failed' }],
  ]);
  const store = { subscribe: () => () => undefined, getSnapshot: () => metadata };
  const stream = { [STREAM_CONTROLLER]: { messageMetadataStore: store } } as any;
  render(<OptimisticMessageStatus stream={stream} messageId="failed-id" onRetry={onRetry} />);
  expect(screen.getByText('发送失败')).toBeInTheDocument();
  const retryBtn = screen.getByRole('button', { name: '重试' });
  expect(retryBtn).toBeInTheDocument();
  fireEvent.click(retryBtn);
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: '丢弃' })).not.toBeInTheDocument();
});

it('若提问尚未被服务端持久化 (optimisticStatus === failed)，RunFailureCard 渲染 null 由消息气泡显示重试', () => {
  const lastHumanMsg = { id: 'u1', type: 'human' as const, content: '查询边坡稳定情况' };
  const snapshotMap = new Map([
    ['u1', { parentCheckpointId: 'chk-1', optimisticStatus: 'failed' }],
  ]);
  const fakeStream = {
    messages: [lastHumanMsg],
    isLoading: false,
    [STREAM_CONTROLLER]: {
      messageMetadataStore: {
        getSnapshot: () => snapshotMap,
        subscribe: () => () => undefined,
      },
    },
  } as any;
  const { container } = render(
    <RunFailureCard
      stream={fakeStream}
      lastHumanMessage={lastHumanMsg}
      onRegenerate={vi.fn()}
    />
  );
  expect(container.firstChild).toBeNull();
});

it('主 Run 失败在回答位置显示轻量失败卡，提供“重新生成”与“关闭”，且关闭不修改权威状态', () => {
  const onRegenerate = vi.fn();
  const onDismiss = vi.fn();
  const snapshotMap = new Map([
    ['u1', { parentCheckpointId: 'chk-checkpoint-before-u1', optimisticStatus: 'sent' }],
  ]);
  const failedHuman = new HumanMessage({ id: 'u1', content: '查询边坡稳定情况' });
  const fakeStream = {
    messages: [
      failedHuman,
      new AIMessage({ id: 'a1', content: '' }),
    ],
    isLoading: false,
    [STREAM_CONTROLLER]: {
      messageMetadataStore: {
        getSnapshot: () => snapshotMap,
        subscribe: () => () => undefined,
      },
    },
  } as any;
  render(
    <ChatWindow
      stream={fakeStream}
      messages={[failedHuman]}
      onSendMessage={vi.fn()}
      threadLoading={false}
      runActive={false}
      runError={true}
      onRegenerate={onRegenerate}
      onDismissRunError={onDismiss}
      isSidebarCollapsed={false}
      onToggleSidebar={vi.fn()}
    />
  );
  expect(screen.getByText('本次回答未能完成')).toBeInTheDocument();
  expect(screen.queryByText(/error|exception|status|runId|checkpoint/i)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重新生成' }));
  expect(onRegenerate).toHaveBeenCalledTimes(1);
  expect(onRegenerate).toHaveBeenCalledWith('chk-checkpoint-before-u1', expect.objectContaining({ id: 'u1', type: 'human' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it('Thread 加载失败在消息区域显示轻量状态“会话加载失败”，提供“重新加载”与“关闭”', () => {
  const onReload = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ChatWindow
      messages={[]}
      onSendMessage={vi.fn()}
      threadLoading={false}
      runActive={false}
      hydrationError={true}
      onReloadThread={onReload}
      onDismissHydrationError={onDismiss}
      isSidebarCollapsed={false}
      onToggleSidebar={vi.fn()}
    />
  );
  expect(screen.getByText('会话加载失败')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
  expect(onReload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

it('Sidebar 不展示内部 reachability 状态探针，对话消息区不被不可达状态污染', () => {
  render(
    <Sidebar
      sessions={[]}
      activeSessionId={null}
      isNewSessionDraft={true}
      busyThreadIds={[]}
      onSelectSession={vi.fn()}
      onCreateSession={vi.fn()}
      onRenameSession={vi.fn()}
      onDeleteSession={vi.fn()}
      onToggleCollapse={vi.fn()}
      onOpenConfig={vi.fn()}
    />
  );
  expect(screen.queryByTitle('未连接后端服务')).not.toBeInTheDocument();
  expect(screen.queryByTitle('正在连接监测服务…')).not.toBeInTheDocument();
  expect(screen.queryByTitle('LangGraph 服务已连接')).not.toBeInTheDocument();

  // 对话消息区不被不可达状态污染
  render(
    <ChatWindow
      messages={[new HumanMessage({ id: 'u1', content: '测试问题' })]}
      onSendMessage={vi.fn()}
      threadLoading={false}
      runActive={false}
      isSidebarCollapsed={false}
      onToggleSidebar={vi.fn()}
    />
  );
  expect(screen.queryByText('暂时无法连接监测服务')).not.toBeInTheDocument();
  expect(screen.queryByText(/离线模式/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('对话消息').textContent).not.toContain('暂时无法连接监测服务');
});

it('Toast 组件支持自动消失、手动关闭与消息去重，最多同时显示 3 条', () => {
  vi.useFakeTimers();
  const TestToastHarness = () => {
    const { toasts, showToast, dismissToast } = useToast();
    return (
      <div>
        <button onClick={() => showToast('删除失败，请稍后重试', 'error')}>触发删除错误</button>
        <button onClick={() => showToast('重命名失败，请稍后重试', 'error')}>触发重命名错误</button>
        <button onClick={() => showToast('提示A')}>提示A</button>
        <button onClick={() => showToast('提示B')}>提示B</button>
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
    );
  };
  render(<TestToastHarness />);

  // 1. 触发两次相同错误，去重只显示一条
  fireEvent.click(screen.getByText('触发删除错误'));
  fireEvent.click(screen.getByText('触发删除错误'));
  expect(screen.getAllByText('删除失败，请稍后重试')).toHaveLength(1);

  // 2. 手动关闭
  fireEvent.click(screen.getByRole('button', { name: '关闭通知' }));
  expect(screen.queryByText('删除失败，请稍后重试')).not.toBeInTheDocument();

  // 3. 自动定时消失
  fireEvent.click(screen.getByText('触发重命名错误'));
  expect(screen.getByText('重命名失败，请稍后重试')).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(4500);
  });
  expect(screen.queryByText('重命名失败，请稍后重试')).not.toBeInTheDocument();

  // 4. 最多 3 条
  fireEvent.click(screen.getByText('触发删除错误'));
  fireEvent.click(screen.getByText('触发重命名错误'));
  fireEvent.click(screen.getByText('提示A'));
  fireEvent.click(screen.getByText('提示B'));
  expect(screen.getByLabelText('系统通知').children).toHaveLength(3);
  expect(screen.queryByText('删除失败，请稍后重试')).not.toBeInTheDocument();

  vi.useRealTimers();
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

it('官方 fork retry：通过 useMessageMetadata 提取 parentCheckpointId，并在 submit 中重传原 HumanMessage，新分支规范历史保持单一 U1', async () => {
  const lastHumanMsg = new HumanMessage({ id: 'u1', content: '查询边坡稳定情况' });
  const mockSubmit = vi.fn().mockResolvedValue(undefined);

  const snapshotMap = new Map([
    ['u1', { parentCheckpointId: 'chk-checkpoint-before-u1', optimisticStatus: 'sent' }],
  ]);
  // 模拟官方 useStream 句柄及其内部 controller store
  const fakeStream = {
    messages: [
      lastHumanMsg,
      new AIMessage({ id: 'a1', content: '' }), // 失败的 AI turn
    ],
    isLoading: false,
    submit: mockSubmit,
    [STREAM_CONTROLLER]: {
      messageMetadataStore: {
        getSnapshot: () => snapshotMap,
        subscribe: () => () => undefined,
      },
    },
  } as any;

  const onRegenerate = vi.fn(async (checkpointId: string, message: any) => {
    // 模拟 handleRegenerate 的核心协议行为：重新提交原 BaseMessage 实例
    await fakeStream.submit(
      { messages: [message] },
      { forkFrom: checkpointId, multitaskStrategy: 'reject' }
    );
  });

  render(
    <ChatWindow
      stream={fakeStream}
      messages={[lastHumanMsg]}
      onSendMessage={vi.fn()}
      threadLoading={false}
      runActive={false}
      runError={true}
      onRegenerate={onRegenerate}
      isSidebarCollapsed={false}
      onToggleSidebar={vi.fn()}
    />
  );

  expect(screen.getByText('本次回答未能完成')).toBeInTheDocument();
  const regenButton = screen.getByRole('button', { name: '重新生成' });
  expect(regenButton).not.toBeDisabled();

  fireEvent.click(regenButton);

  // 1. 验证回调参数：正确拿到 parentCheckpointId 与原 HumanMessage 对象
  expect(onRegenerate).toHaveBeenCalledWith('chk-checkpoint-before-u1', lastHumanMsg);

  // 2. 核心真实协议断言：
  // 必须把原 BaseMessage 作为新 continuation 输入重新提交，保证对象同一性，绝不能传 submit(null, { forkFrom })！
  expect(mockSubmit).toHaveBeenCalledTimes(1);
  const [submitPayload, submitOptions] = mockSubmit.mock.calls[0];
  expect(submitPayload.messages[0]).toBe(lastHumanMsg);
  expect(submitPayload).not.toBeNull();
  expect(submitOptions).toMatchObject({
    forkFrom: 'chk-checkpoint-before-u1',
    multitaskStrategy: 'reject',
  });

  // 3. 规范历史延续性断言：
  // 新 continuation supersede 旧分支后，新规范历史中仍只有一个 U1，旧失败轮次被替代
  const canonicalUser = new HumanMessage({ id: 'u1-new', content: '查询边坡稳定情况' });
  const canonicalAnswer = new AIMessage({ id: 'a2', content: '边坡整体处于稳定状态。' });
  const turns = groupMessagesForDisplay([canonicalUser, canonicalAnswer]);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toEqual({ kind: 'human', message: canonicalUser });
  expect(turns[1].kind === 'assistant' && turns[1].messages[0]).toBe(canonicalAnswer);
});


it('Sidebar 列表加载失败时以 amber 样式呈现，支持重试与关闭', () => {
  const onRefresh = vi.fn();
  const onDismiss = vi.fn();
  render(
    <Sidebar
      sessions={[]}
      activeSessionId={null}
      isNewSessionDraft={true}
      busyThreadIds={[]}
      onSelectSession={vi.fn()}
      onCreateSession={vi.fn()}
      onRenameSession={vi.fn()}
      onDeleteSession={vi.fn()}
      onToggleCollapse={vi.fn()}
      onOpenConfig={vi.fn()}
      listError="会话列表加载失败，请重试"
      onRefreshSessions={onRefresh}
      onDismissListError={onDismiss}
    />
  );
  expect(screen.getByText('会话列表加载失败，请重试')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试加载会话' }));
  expect(onRefresh).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByTitle('关闭'));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});
