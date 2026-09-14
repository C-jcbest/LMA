import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatWindow } from '../src/components/ChatWindow';
import { InlineToolCall } from '../src/components/InlineToolCall';
import { getUnansweredToolCalls, projectLangGraphMessages, projectThreadSessions } from '../src/services/api';

describe('会话关键路径集成回归', () => {
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
});
