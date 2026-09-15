import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatWindow } from '../src/components/ChatWindow';
import { InlineToolCall } from '../src/components/InlineToolCall';
import { MessageActions } from '../src/components/MessageActions';
import { getUnansweredToolCalls, projectLangGraphMessages, projectThreadSessions } from '../src/services/api';

describe('会话关键路径集成回归', () => {
  it('官方内部摘要不成为用户气泡，普通同文消息仍展示', () => {
    const raw = [
      { type: 'human', id: 'summary', content: '历史摘要', additional_kwargs: { lc_source: 'summarization' } },
      { type: 'human', id: 'user', content: '历史摘要' },
      { type: 'ai', id: 'answer', content: '回答' },
    ];
    expect(projectLangGraphMessages(raw)).toEqual([
      { id: 'user', role: 'user', content: '历史摘要', created_at: undefined },
      { id: 'answer', role: 'assistant', content: '回答', created_at: undefined },
    ]);
  });
  it('停止后将未闭合工具调用投影为已停止，并识别需要补齐的调用', () => {
    const raw = [
      { type: 'human', id: 'u1', content: '查询站点' },
      {
        type: 'ai',
        id: 'a1',
        content: '',
        tool_calls: [{ id: 'call-1', name: 'list_stations', args: {} }],
      },
    ];

    expect(getUnansweredToolCalls(raw)).toEqual([{ id: 'call-1', name: 'list_stations' }]);
    const projected = projectLangGraphMessages(raw, { isRunActive: false });
    const assistant = projected[1];
    expect(assistant.parts?.[0]).toMatchObject({
      type: 'tool',
      toolCall: { id: 'call-1', status: 'cancelled' },
    });
  });

  it('已完成的 ToolMessage 不会被误判为待补齐', () => {
    const raw = [
      { type: 'ai', tool_calls: [{ id: 'call-1', name: 'list_stations', args: {} }] },
      { type: 'tool', tool_call_id: 'call-1', name: 'list_stations', content: '{"ok":true}' },
      { type: 'ai', content: '查询完成。' },
    ];

    expect(getUnansweredToolCalls(raw)).toEqual([]);
    const projected = projectLangGraphMessages(raw, { isRunActive: false });
    expect(projected[0].parts?.[0]).toMatchObject({ type: 'tool', toolCall: { status: 'success' } });
    expect(projected[0].parts?.[1]).toMatchObject({ type: 'text', content: '查询完成。' });
  });

  it('模型思考按调用顺序投影，并可折叠展示思考用时与差异化正文', async () => {
    const raw = [
      {
        type: 'ai',
        id: 'a1',
        content: '',
        additional_kwargs: {
          reasoning_content: '先确认目标站点，再查询监测数据。',
          lma_thinking_duration_ms: 1250,
        },
        tool_calls: [{ id: 'call-1', name: 'list_stations', args: {} }],
      },
      { type: 'tool', tool_call_id: 'call-1', name: 'list_stations', content: '{"ok":true}' },
      {
        type: 'ai',
        id: 'a2',
        content: '查询完成。',
        additional_kwargs: {
          reasoning_content: '根据返回结果组织结论。',
          lma_thinking_duration_ms: 2100,
        },
      },
    ];

    const projected = projectLangGraphMessages(raw, { isRunActive: false });
    expect(projected[0].parts?.map((part) => part.type)).toEqual([
      'thinking',
      'tool',
      'thinking',
      'text',
    ]);

    render(
      <ChatWindow
        messages={projected}
        onSendMessage={() => undefined}
        isGenerating={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.getByText('1.3 秒')).toBeInTheDocument();
    expect(screen.queryByText('先确认目标站点，再查询监测数据。')).not.toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /已思考/ })[0]);
    expect(screen.getByText('先确认目标站点，再查询监测数据。')).toBeInTheDocument();
  });

  it('推荐动作可直接发送，回到底部按钮仅在上翻后显示在输入区附近', async () => {
    const onSend = vi.fn();
    render(
      <ChatWindow
        messages={[{ id: 'a1', role: 'assistant', content: '分析完成。' }]}
        onSendMessage={onSend}
        isGenerating={false}
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

  it('取消的工具调用不再显示旋转中的执行状态', () => {
    render(
      <InlineToolCall
        toolCall={{
          id: 'call-1',
          name: 'get_daily_gnss_data',
          display_name: 'GNSS 数据',
          status: 'cancelled',
        }}
      />
    );
    expect(screen.getByText('获取北斗GNSS日监测数据（已停止）')).toBeInTheDocument();
    expect(screen.queryByText('正在执行')).not.toBeInTheDocument();
  });

  it('GNSS 空值与非有限值显示为缺测，不会转换为零', async () => {
    render(
      <InlineToolCall
        toolCall={{
          id: 'call-gnss',
          name: 'get_daily_gnss_data',
          display_name: 'GNSS 数据',
          status: 'success',
          detail: {
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
    await userEvent.click(screen.getByText('获取北斗GNSS日监测数据'));
    expect(screen.getAllByText('—')).toHaveLength(5);
    expect(screen.getAllByText('0.000')).toHaveLength(3);
    expect(screen.getByText('12.500')).toBeInTheDocument();
  });

  it('GNSS 折线在缺测点处分段，不把缺测绘制为零或跨段连线', async () => {
    const { container } = render(
      <InlineToolCall
        toolCall={{
          id: 'call-chart',
          name: 'analyze_gnss_chart',
          display_name: '视觉复核',
          status: 'success',
          detail: { station_name: '测试站', observations: {}, total_points: 5 },
          chartPoints: [
            { t: '2026-09-15 08:00:00', n: 1, e: 2, u: 3 },
            { t: '2026-09-15 09:00:00', n: 2, e: 3, u: 4 },
            { t: '2026-09-15 10:00:00', n: null, e: '', u: Number.NaN },
            { t: '2026-09-15 11:00:00', n: 3, e: 4, u: 5 },
            { t: '2026-09-15 12:00:00', n: 4, e: 5, u: 6 },
          ],
        }}
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
        toolCall={{
          id: 'call-stations',
          name: 'list_stations',
          display_name: '监测点列表',
          status: 'success',
          detail: {
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
    await userEvent.click(screen.getByText('查询监测点列表'));
    for (const label of ['正常', '离线', '告警', '故障']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText('未知')).toHaveLength(2);
    expect(screen.queryByText('正常 (10)')).not.toBeInTheDocument();
  });

  it('未知工具结果只在折叠的技术详情中展示', async () => {
    const { container } = render(
      <InlineToolCall
        toolCall={{
          id: 'call-internal',
          name: 'internal_step',
          display_name: '',
          status: 'success',
          detail: { internal_field: 'value' },
        }}
      />
    );
    expect(screen.queryByText('internal_step')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('执行技术步骤'));
    expect(screen.getByText('技术详情')).toBeInTheDocument();
    expect(container.querySelector('details')).not.toHaveAttribute('open');
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
        isGenerating={false}
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
        isGenerating={false}
        contextUsage={{ context_limit_tokens: 1_048_576 }}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.queryByText(/上下文窗口|未配置/)).not.toBeInTheDocument();
  });

  it('推荐生成失败时显示真实错误，不生成固定推荐', () => {
    render(
      <ChatWindow
        messages={[{ role: 'assistant', content: '分析完成。' }]}
        onSendMessage={() => undefined}
        isGenerating={false}
        recommendationError="下一步建议返回格式无效。"
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.getByText('下一步建议返回格式无效。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /查看近期趋势/ })).not.toBeInTheDocument();
  });

  it('会话列表过滤 session-title 产生的无名称临时 Thread', () => {
    expect(projectThreadSessions([
      { thread_id: 'temp', created_at: '2026-09-14T00:00:00Z', metadata: {} },
      { thread_id: 'real', created_at: '2026-09-14T00:00:01Z', metadata: { name: '  站点分析  ' } },
    ])).toEqual([
      { thread_id: 'real', created_at: '2026-09-14T00:00:01Z', name: '站点分析', status: undefined },
    ]);
  });

  it('流式输出中支持从 content 块和 think 标签提取思考内容，并默认展开实时查看', () => {
    // 场景 1：LangGraph protocol v2 content 块流
    const rawBlocks = [
      {
        type: 'ai',
        id: 'a1',
        content: [
          { type: 'reasoning', reasoning: '正在实时分析斜坡变形特征…' },
          { type: 'text', text: '结论如下：' },
        ],
      },
    ];
    const projected1 = projectLangGraphMessages(rawBlocks, { isRunActive: true });
    expect(projected1[0].parts?.[0]).toMatchObject({
      type: 'thinking',
      thinking: { content: '正在实时分析斜坡变形特征…' },
    });
    expect(projected1[0].parts?.[1]).toMatchObject({
      type: 'text',
      content: '结论如下：',
    });

    // 场景 2：流式输出中未闭合的 <think> 标签（正在流式思考中）
    const rawStreamingThink = [
      {
        type: 'ai',
        id: 'a2',
        content: '<think>正在对比历史雨量与位移数据',
      },
    ];
    const projected2 = projectLangGraphMessages(rawStreamingThink, { isRunActive: true });
    expect(projected2[0].parts?.[0]).toMatchObject({
      type: 'thinking',
      thinking: { content: '正在对比历史雨量与位移数据' },
    });
    // 思考尚未结束时，正文为空
    expect(projected2[0].content).toBe('');

    // 场景 3：正在思考状态下（isActive=true）思考过程默认展开可直接查看
    render(
      <ChatWindow
        messages={projected2}
        onSendMessage={() => undefined}
        isGenerating={true}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.getByText('正在思考')).toBeInTheDocument();
    expect(screen.getByText('正在对比历史雨量与位移数据')).toBeInTheDocument();
  });
});
