import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatWindow } from '../src/components/ChatWindow';
import { InlineToolCall } from '../src/components/InlineToolCall';
import { MessageActions } from '../src/components/MessageActions';
import { Sidebar } from '../src/components/Sidebar';
import { OptimisticMessageStatus } from '../src/components/OptimisticMessageStatus';
import { STREAM_CONTROLLER } from '@langchain/react';
import { getIncompleteToolCallMessageUpdates, projectLangGraphMessages, projectThreadSessions, runErrorMessage } from '../src/services/api';

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
  it('停止后整批未完成的 AI tool-call 消息生成 RemoveMessage，UI 不保留工具', () => {
    const raw = [
      { type: 'human', id: 'u1', content: '查询站点' },
      {
        type: 'ai',
        id: 'a1',
        content: '',
        tool_calls: [{ id: 'call-1', name: 'list_stations', args: {} }],
      },
    ];

    expect(getIncompleteToolCallMessageUpdates(raw).map((message) => ({ type: message.type, id: message.id })))
      .toEqual([{ type: 'remove', id: 'a1' }]);
    expect(projectLangGraphMessages([raw[0]])).toEqual([{ id: 'u1', role: 'user', content: '查询站点', created_at: undefined }]);
  });

  it('已完成的 ToolMessage 不会被误判为待补齐', () => {
    const raw = [
      { type: 'ai', tool_calls: [{ id: 'call-1', name: 'list_stations', args: {} }] },
      { type: 'tool', tool_call_id: 'call-1', name: 'list_stations', content: '{"ok":true}' },
      { type: 'ai', content: '查询完成。' },
    ];

    expect(getIncompleteToolCallMessageUpdates(raw)).toEqual([]);
    const projected = projectLangGraphMessages(raw);
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

    const projected = projectLangGraphMessages(raw);
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
        threadLoading={false} runActive={false} stopReconciling={false} hasRunningTool={false}
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
        threadLoading={false} runActive={false} stopReconciling={false} hasRunningTool={false}
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

  it('并行工具部分完成时只从 AIMessage 移除未回答 call，保留成功配对', () => {
    const updates = getIncompleteToolCallMessageUpdates([
      { type: 'human', id: 'u1', content: '并行查询' },
      { type: 'ai', id: 'a1', content: '', tool_calls: [
        { id: 'done', name: 'list_stations', args: {} },
        { id: 'pending', name: 'query_weather', args: {} },
      ] },
      { type: 'tool', id: 't1', tool_call_id: 'done', name: 'list_stations', content: '成功' },
    ]);
    expect(updates).toHaveLength(1);
    expect((updates[0] as any).type).toBe('ai');
    expect((updates[0] as any).tool_calls).toEqual([{ id: 'done', name: 'list_stations', args: {} }]);
  });

  it('失败重试追加 HumanMessage 后仍清理更早残留的多个未完成 AIMessage', () => {
    const updates = getIncompleteToolCallMessageUpdates([
      { type: 'human', id: 'old-user', content: '旧问题' },
      { type: 'ai', id: 'old-ai', tool_calls: [{ id: 'old-call', name: 'query_weather', args: {} }] },
      { type: 'human', id: 'new-user', content: '新问题' },
      { type: 'ai', id: 'new-ai-1', tool_calls: [{ id: 'new-call-1', name: 'query_weather', args: {} }] },
      { type: 'ai', id: 'new-ai-2', tool_calls: [{ id: 'new-call-2', name: 'list_stations', args: {} }] },
      { type: 'human', id: 'retry-user', content: '重试问题' },
    ]);
    expect(updates.map((message) => message.id)).toEqual(['old-ai', 'new-ai-1', 'new-ai-2']);
    expect(updates.every((message: any) => message.type === 'remove')).toBe(true);
  });

  it('只接受紧随 AIMessage 的 ToolMessage，不能用其他位置的同 ID 伪造配对', () => {
    const updates = getIncompleteToolCallMessageUpdates([
      { type: 'tool', id: 'orphan-before', tool_call_id: 'same-call', content: '错误位置' },
      { type: 'ai', id: 'a1', tool_calls: [{ id: 'same-call', name: 'query_weather', args: {} }] },
      { type: 'human', id: 'u1', content: '下一条消息' },
      { type: 'tool', id: 'orphan-after', tool_call_id: 'same-call', content: '非连续结果' },
    ]);
    expect(updates.map((message) => ({ type: message.type, id: message.id })))
      .toEqual([{ type: 'remove', id: 'a1' }]);
  });

  it('总结前停止后发送继续，旧工具结果、继续消息和新 AI 回复保持独立顺序', () => {
    const projected = projectLangGraphMessages([
      { type: 'human', id: 'u1', content: '查询监测数据' },
      { type: 'ai', id: 'a1', content: '', tool_calls: [{ id: 'c1', name: 'get_daily_gnss_data', args: {} }] },
      { type: 'tool', id: 't1', tool_call_id: 'c1', name: 'get_daily_gnss_data', content: '完成' },
      { type: 'human', id: 'u2', content: '继续' },
      { type: 'ai', id: 'a2', content: '这是新 Run 的总结。' },
    ]);
    expect(projected.map((message) => ({ role: message.role, content: message.content }))).toEqual([
      { role: 'user', content: '查询监测数据' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '这是新 Run 的总结。' },
    ]);
    expect(projected[1].parts?.[0]).toMatchObject({ type: 'tool', toolCall: { id: 'c1', status: 'success' } });
  });

  it('GNSS 空值与非有限值显示为缺测，不会转换为零', async () => {
    render(
      <InlineToolCall
        toolCall={{
          id: 'call-gnss',
          name: 'get_daily_gnss_data',
          display_name: 'GNSS 数据',
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
          data: { station_name: '测试站', observations: {}, total_points: 5 },
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
        toolCall={{
          id: 'call-internal',
          name: 'internal_step',
          display_name: '',
          status: 'success',
          data: { internal_field: 'value' },
        }}
      />
    );
    expect(screen.queryByText('internal_step')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('执行工具查询'));
    expect(screen.queryByText('技术详情')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('internal_field');
    expect(screen.getByText('该步骤没有可展示的业务数据')).toBeInTheDocument();
  });

  it('业务失败按官方 status 展示，原因无需展开，模型文本和内部字段不可见', async () => {
    const projected = projectLangGraphMessages([
      { type: 'ai', tool_calls: [{ id: 'c1', name: 'get_daily_gnss_data', args: {} }] },
      { type: 'tool', name: 'get_daily_gnss_data', tool_call_id: 'c1', status: 'error',
        content: 'MODEL_ONLY net_change_mm secret://internal',
        artifact: { data: { message: '未找到指定监测点，请确认站点。' }, error: { category: 'business' }, internal: 'PRIVATE' } },
      { type: 'ai', content: '请确认监测点名称。' },
    ]);
    const part = projected[0].parts?.[0];
    expect(part).toMatchObject({ type: 'tool', toolCall: { status: 'error' } });
    if (part?.type !== 'tool') throw new Error('缺少工具结果');
    const { container } = render(<InlineToolCall toolCall={part.toolCall} />);
    expect(screen.getByRole('alert')).toHaveTextContent('未找到指定监测点');
    await userEvent.click(screen.getByText(/获取北斗GNSS日监测数据/));
    expect(container.textContent).not.toMatch(/MODEL_ONLY|net_change_mm|secret:|PRIVATE|business/);
  });

  it('成功工具仅从 artifact.data 取业务展示，content 不作为界面数据源', () => {
    const projected = projectLangGraphMessages([
      { type: 'ai', tool_calls: [{ id: 'c1', name: 'list_stations', args: {} }] },
      { type: 'tool', name: 'list_stations', tool_call_id: 'c1', status: 'success',
        content: '{"internal_field":"MODEL_ONLY"}', artifact: { data: { total: 0, stations: [] } } },
      { type: 'ai', content: '已查询。' },
    ]);
    expect(projected[0].parts?.[0]).toMatchObject({ type: 'tool', toolCall: { data: { total: 0, stations: [] } } });
    expect(JSON.stringify(projected)).not.toContain('MODEL_ONLY');
  });

  it('视觉复核失败的原因可见，已获得的图表仍可展开查看', async () => {
    render(<InlineToolCall toolCall={{ id: 'c1', name: 'analyze_gnss_chart', display_name: '', status: 'error',
      data: { station_name: '测试站', message: '视觉模型未配置，图表可供人工查看。' },
      chartPoints: [{ t: '08:00', n: 1, e: 2, u: 3 }, { t: '09:00', n: 2, e: 3, u: 4 }],
      images: [{ name: 'raw_coordinates', png_base64: 'TEST_IMAGE' }],
    }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('视觉模型未配置');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('视觉复核（未完成）'));
    expect(screen.getByRole('img', { name: /原始坐标时序/ })).toBeInTheDocument();
  });

  it('官方预算错误只展示中文限制说明，内部异常不直接展示', () => {
    expect(runErrorMessage({ name: 'ModelCallLimitExceededError', message: 'internal counts' })).toContain('分析次数已达到上限');
    expect(runErrorMessage(new Error('secret://internal'))).not.toContain('secret:');
    const messages = projectLangGraphMessages([
      { type: 'ai', tool_calls: [{ id: 'c', name: 'list_stations', args: {} }] },
      { type: 'tool', tool_call_id: 'c', name: 'list_stations', status: 'error',
        content: 'Tool call limit exceeded. Do not make additional tool calls.' },
      { type: 'ai', content: '说明限制。' },
    ]);
    const part = messages[0].parts?.[0];
    if (part?.type !== 'tool') throw new Error('缺少工具');
    render(<InlineToolCall toolCall={part.toolCall} />);
    expect(screen.getByRole('alert')).toHaveTextContent('查询次数已达到上限');
    expect(screen.queryByText(/Tool call limit/)).not.toBeInTheDocument();
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
        threadLoading={false} runActive={false} stopReconciling={false} hasRunningTool={false}
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
        threadLoading={false} runActive={false} stopReconciling={false} hasRunningTool={false}
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
        threadLoading={false} runActive={false} stopReconciling={false} hasRunningTool={false}
        recommendationError="下一步建议返回格式无效。"
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.getByText('下一步建议返回格式无效。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /查看近期趋势/ })).not.toBeInTheDocument();
  });

  it('会话归属依据 graph_id，辅助图即使有名称也不展示', () => {
    expect(projectThreadSessions([
      { thread_id: 'temp', created_at: '2026-09-14T00:00:00Z', metadata: { graph_id: 'session-title', name: '辅助名称' } },
      { thread_id: 'other', created_at: '2026-09-14T00:00:00Z', metadata: { name: '无归属名称' } },
      { thread_id: 'real', created_at: '2026-09-14T00:00:01Z', metadata: { graph_id: 'lma-agent', name: '  站点分析  ' } },
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
    const projected1 = projectLangGraphMessages(rawBlocks);
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
    const projected2 = projectLangGraphMessages(rawStreamingThink);
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
        threadLoading={false} runActive stopReconciling={false} hasRunningTool={false}
        isSidebarCollapsed={false}
        onToggleSidebar={() => undefined}
      />
    );
    expect(screen.getByText('正在思考')).toBeInTheDocument();
    expect(screen.getByText('正在对比历史雨量与位移数据')).toBeInTheDocument();
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
    stopReconciling={false} hasRunningTool={false}
    isSidebarCollapsed={false} onToggleSidebar={vi.fn()} isNewSessionDraft />);
  expect(screen.getByLabelText('对话消息').textContent).toBe('');
  expect(screen.getByLabelText('对话消息').querySelectorAll('p,h3,svg')).toHaveLength(0);
  expect(screen.queryByText('开启滑坡连续监测业务调查')).not.toBeInTheDocument();
});

it('Thread hydration 只显示历史加载态，不显示 Stop 或 AI 思考', () => {
  render(<ChatWindow messages={[]} onSendMessage={vi.fn()} threadLoading runActive={false}
    stopReconciling={false} hasRunningTool={false}
    isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />);
  expect(screen.getByText('正在加载会话…')).toBeInTheDocument();
  expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument();
  expect(screen.queryByText('智能体正在检索北斗平台与分析监测数据...')).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境...')).toBeDisabled();
});

it('Run active 才显示 Stop 和思考；Stop reconciliation 允许输入但禁止发送', async () => {
  const props = {
    messages: [{ id: 'u1', role: 'user' as const, content: '查询' }],
    onSendMessage: vi.fn(), threadLoading: false, runActive: true,
    stopReconciling: false, hasRunningTool: false,
    isSidebarCollapsed: false, onToggleSidebar: vi.fn(),
  };
  const mounted = render(<ChatWindow {...props} />);
  expect(screen.getByTitle('停止生成')).toBeInTheDocument();
  expect(screen.getByText('智能体正在检索北斗平台与分析监测数据...')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境...')).toBeDisabled();

  mounted.rerender(<ChatWindow {...props} runActive={false} stopReconciling />);
  const textarea = screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境...');
  expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument();
  expect(screen.queryByText('智能体正在检索北斗平台与分析监测数据...')).not.toBeInTheDocument();
  expect(screen.getByText('正在结束本轮并同步记录…')).toBeInTheDocument();
  expect(textarea).toBeEnabled();
  await userEvent.type(textarea, '下一条问题');
  expect(screen.getByTitle('正在结束本轮')).toBeDisabled();
});

it('工具是否仍在执行来自官方 Tool projection，不把 Run active 等同于工具状态', () => {
  const message = {
    id: 'a1', role: 'assistant' as const, content: '',
    parts: [{ type: 'tool' as const, toolCall: {
      id: 'c1', name: 'query_weather', display_name: '天气查询', status: 'success' as const,
    } }],
  };
  const mounted = render(<ChatWindow messages={[message]} onSendMessage={vi.fn()} threadLoading={false} runActive
    stopReconciling={false} hasRunningTool
    isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />);
  expect(screen.queryByText('正在根据查询结果整理回答...')).not.toBeInTheDocument();
  mounted.rerender(<ChatWindow messages={[message]} onSendMessage={vi.fn()} threadLoading={false} runActive
    stopReconciling={false} hasRunningTool={false}
    isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />);
  expect(screen.getByText('正在根据查询结果整理回答...')).toBeInTheDocument();
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
