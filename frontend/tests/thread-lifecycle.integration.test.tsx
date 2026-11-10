import React from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionListAdapter } from '@/lib/session-list-adapter';
import { AssistantProvider } from '@/app/providers/AssistantProvider';
import { App } from '@/App';
import { AppLayout } from '@/app/AppLayout';
import { useAui, useAuiState } from '@assistant-ui/react';
import * as api from '@/services/api';

describe('自托管会话目录与 assistant-ui 适配', () => {
  const session = (id: string, name = '新会话') => ({
    id, name, archived: false, created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
  });

  it.each([0, 19, 20, 21])('分页返回 %i 条时只在存在下一条时显示加载入口', async (count) => {
    const client = { listSessions: vi.fn().mockResolvedValue(
      Array.from({ length: count }, (_, index) => session('session-' + index)),
    ) } as any;
    const result = await createSessionListAdapter(client).list({ after: '20' });
    expect(client.listSessions).toHaveBeenCalledWith({ limit: 21, offset: 20 });
    expect(result.threads).toHaveLength(Math.min(count, 20));
    expect(result.nextCursor).toBe(count > 20 ? '40' : undefined);
    if (count) {
      expect(result.threads[0]).toMatchObject({ remoteId: 'session-0', externalId: 'session-0', title: '新会话' });
    }
  });

  it('创建、改名、归档和删除调用业务接口', async () => {
    const client = {
      createSession: vi.fn().mockResolvedValue(session('new-id')),
      getSession: vi.fn().mockResolvedValue(session('new-id', '站点分析')),
      updateSession: vi.fn(), deleteSession: vi.fn(),
    } as any;
    const adapter = createSessionListAdapter(client);
    expect(await adapter.initialize()).toEqual({ remoteId: 'new-id', externalId: 'new-id' });
    expect(await adapter.fetch('new-id')).toMatchObject({ title: '站点分析' });
    await adapter.rename('new-id', '监测报告');
    await adapter.archive('new-id');
    await adapter.unarchive('new-id');
    await adapter.delete('new-id');
    expect(client.updateSession.mock.calls).toEqual([
      ['new-id', { name: '监测报告' }], ['new-id', { archived: true }], ['new-id', { archived: false }],
    ]);
    expect(client.deleteSession).toHaveBeenCalledWith('new-id');
  });

  it('标题由官方生命周期异步生成并回写', async () => {
    const client = { generateTitle: vi.fn().mockResolvedValue('GNSS 位移分析'), updateSession: vi.fn() } as any;
    const adapter = createSessionListAdapter(client);
    await adapter.generateTitle('title-id', [{ role: 'user', content: [{ type: 'text', text: '分析近期位移' }] }] as any);
    await waitFor(() => expect(client.updateSession).toHaveBeenCalledWith('title-id', { name: 'GNSS 位移分析' }));
  });
});

describe('AssistantProvider 与 App 组装 (P2)', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockClient = {
      listStations: vi.fn().mockResolvedValue([]),
      getLatestInspection: vi.fn().mockResolvedValue({ running: null, latest_attempt: null, inspection: null, stations: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionConclusions: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockResolvedValue({ id: 'new-thread' }),
      getSession: vi.fn().mockImplementation(async (id: string) => ({
        id, name: '会话 ' + id, archived: false,
        created_at: '2026-09-18T10:00:00Z', updated_at: '2026-09-18T10:00:00Z',
      })),
      listInvestigations: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({ values: { messages: [] }, latest_run: null }),
      updateSession: vi.fn().mockResolvedValue({}), deleteSession: vi.fn().mockResolvedValue(undefined),
      streamRun: vi.fn().mockImplementation(() => (async function* () {})()),
      findCheckpoint: vi.fn(), generateTitle: vi.fn(),
    };
    vi.spyOn(api, 'createLmaClient').mockReturnValue(mockClient);
  });


  it('会话列表失败显示受控提示，手动重试成功且保留输入草稿', async () => {
    mockClient.listSessions.mockRejectedValueOnce(new Error('PRIVATE_BACKEND_DIAGNOSTIC'));
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('会话列表尚未载入');
    expect(screen.queryByText('PRIVATE_BACKEND_DIAGNOSTIC')).not.toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '输入监测问题' });
    await userEvent.type(input, '尚未发送的监测问题');
    mockClient.listSessions.mockResolvedValueOnce([{
      id: 'recovered-thread', name: '恢复后的历史会话', archived: false,
      created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
    }]);
    await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }));

    expect(await screen.findByText('恢复后的历史会话')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveValue('尚未发送的监测问题');
    expect(mockClient.listSessions).toHaveBeenCalledTimes(2);
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('刷新列表失败保留已有会话，再次失败不会自动循环重试', async () => {
    mockClient.listSessions.mockResolvedValueOnce([{
      id: 'existing-thread', name: '已有调查', archived: false,
      created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T01:00:00Z',
    }]);
    let aui: ReturnType<typeof useAui>;
    function RuntimeActions() {
      aui = useAui();
      return null;
    }
    render(
      <AssistantProvider client={mockClient}>
        <RuntimeActions />
        <AppLayout />
      </AssistantProvider>,
    );
    expect(await screen.findByText('已有调查')).toBeInTheDocument();
    mockClient.listSessions.mockRejectedValue(new Error('服务不可用'));
    await act(async () => { await aui!.threads().reload(); });

    expect(screen.getByRole('alert')).toHaveTextContent('会话列表尚未载入');
    expect(screen.getByText('已有调查')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('会话列表尚未载入');
    expect(screen.getByText('已有调查')).toBeInTheDocument();
    expect(mockClient.listSessions).toHaveBeenCalledTimes(3);
  });

  it('新会话保留直接输入入口，不再提供推荐问题或快捷提问菜单', async () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: '今天要查哪个测点？' })).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: '输入监测问题' });
    expect(input).toHaveAttribute('placeholder', '询问监测数据、变化趋势、降雨关联或场地环境…');
    expect(screen.queryByLabelText('推荐业务提问')).not.toBeInTheDocument();
    expect(screen.queryByText('ZJ-MS10 2025年10月监测数据稳定性如何')).not.toBeInTheDocument();
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.type(input, '查看这个测点近期的变化');
    expect(input).toHaveValue('查看这个测点近期的变化');
  });

  it('消息产生前的发送异常提供单一受控反馈和重试入口', async () => {
    mockClient.streamRun.mockImplementation(() => (async function* () {
      throw new Error('PRIVATE_STREAM_DIAGNOSTIC');
    })());
    render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入监测问题' })).toBeEnabled());
    await userEvent.type(screen.getByRole('textbox', { name: '输入监测问题' }), '查看近期变化');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByText('本次回答未完成。')).toBeInTheDocument();
    expect(screen.queryByText('PRIVATE_STREAM_DIAGNOSTIC')).not.toBeInTheDocument();
    expect(screen.getAllByText('本次回答未完成。')).toHaveLength(1);
    mockClient.streamRun.mockImplementation(() => (async function* () {})());
    await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
    await waitFor(() => expect(mockClient.streamRun).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('本次回答未完成。')).not.toBeInTheDocument();
  });

  it('已有回答的运行错误只在消息内显示，不重复弹出全局提示', async () => {
    mockClient.streamRun.mockImplementation(() => (async function* () {
      yield { event: 'messages/complete', data: [{ type: 'ai', id: 'partial-answer', content: '已取得部分监测记录。' }] };
      yield { event: 'error', data: { message: 'PRIVATE_RUNTIME_DIAGNOSTIC' } };
    })());
    render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: '输入监测问题' })).toBeEnabled());
    await userEvent.type(screen.getByRole('textbox', { name: '输入监测问题' }), '查看近期变化');
    await userEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(await screen.findByText('本次回答未完成，请重试。')).toBeInTheDocument();
    expect(screen.queryByText('本次回答未完成。')).not.toBeInTheDocument();
    expect(screen.queryByText('PRIVATE_RUNTIME_DIAGNOSTIC')).not.toBeInTheDocument();
    expect(screen.getByText('已取得部分监测记录。')).toBeInTheDocument();
  });

  it('点击服务配置能正常呼出 ServiceSettingsDialog，修改 API URL 后更新客户端', async () => {
    render(<App />);

    // 点击服务配置按钮
    fireEvent.click(screen.getByText('服务配置'));

    expect(screen.getByText('LMA 服务对接配置')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('请输入 LMA API 地址或 /api')).toBeInTheDocument();

    // 修改地址并保存
    fireEvent.change(
      screen.getByPlaceholderText('请输入 LMA API 地址或 /api'),
      { target: { value: 'http://new-domain:2024' } }
    );
    fireEvent.click(screen.getByText('保存并应用'));

    await waitFor(() => {
      expect(localStorage.getItem('lma_api_url')).toBe('http://new-domain:2024');
    });
  });

  it('AssistantProvider 与浏览器 URL 保持双向同步，驱动 pushState 并通过真实 history.back 返回上一个会话', async () => {
    mockClient.listSessions.mockResolvedValue([
      { id: 't-history-2', name: '会话 2', archived: false, created_at: '2026-09-18T11:00:00Z', updated_at: '2026-09-18T11:00:00Z' },
    ]);

    // 1. 初始挂载：URL 带有 ?threadId=t-history-1
    window.history.replaceState(null, '', '?threadId=t-history-1');
    const pushStateSpy = vi.spyOn(window.history, 'pushState');

    let capturedAui: any;
    function Consumer() {
      capturedAui = useAui();
      const activeThreadId = useAuiState((s) => s.threads.mainThreadId);
      const items = useAuiState((s) => s.threads.threadItems);
      const currentItem = items.find((i) => i.id === activeThreadId);
      return (
        <div>
          <div data-testid="active-thread-id">{activeThreadId}</div>
          <div data-testid="active-external-id">{currentItem?.externalId ?? 'none'}</div>
        </div>
      );
    }

    render(
      <AssistantProvider client={mockClient}>
        <Consumer />
      </AssistantProvider>
    );

    // 初始应正确从 URL 读取 t-history-1
    await waitFor(() => {
      expect(capturedAui.threads.getState().mainThreadId).toBe('t-history-1');
      expect(screen.getByTestId('active-thread-id')).toHaveTextContent('t-history-1');
    });
    // 深链接目标不在首屏列表时，官方 switchToThread 会通过 adapter.fetch 精确加载。
    expect(mockClient.getSession).toHaveBeenCalledWith('t-history-1');
    // 初始挂载读取 URL，不应重复触发 pushState
    expect(pushStateSpy).not.toHaveBeenCalled();

    // 2. 在 assistant-ui 内部切换会话到 t-history-2
    await act(async () => {
      capturedAui.threads.switchToThread('t-history-2');
    });

    await waitFor(() => {
      expect(screen.getByTestId('active-thread-id')).toHaveTextContent('t-history-2');
      expect(new URL(window.location.href).searchParams.get('threadId')).toBe('t-history-2');
    });
    // 校验主动切换触发了 window.history.pushState
    expect(pushStateSpy).toHaveBeenCalledTimes(1);

    // 3. 触发真实浏览器后退（window.history.back）通过 history 栈返回上一个会话
    await act(async () => {
      window.history.back();
    });

    await waitFor(() => {
      expect(new URL(window.location.href).searchParams.get('threadId')).toBe('t-history-1');
      expect(screen.getByTestId('active-thread-id')).toHaveTextContent('t-history-1');
      expect(capturedAui.threads.getState().mainThreadId).toBe('t-history-1');
    });

    // 4. 前进应再次切回 t-history-2，且不会额外写入 history。
    await act(async () => {
      window.history.forward();
    });

    await waitFor(() => {
      expect(new URL(window.location.href).searchParams.get('threadId')).toBe('t-history-2');
      expect(screen.getByTestId('active-thread-id')).toHaveTextContent('t-history-2');
    });
    expect(pushStateSpy).toHaveBeenCalledTimes(1);
  });

});
