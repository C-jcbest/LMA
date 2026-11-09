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
      listSessions: vi.fn().mockResolvedValue([]),
      createSession: vi.fn().mockResolvedValue({ id: 'new-thread' }),
      getSession: vi.fn().mockImplementation(async (id: string) => ({
        id, name: '会话 ' + id, archived: false,
        created_at: '2026-09-18T10:00:00Z', updated_at: '2026-09-18T10:00:00Z',
      })),
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

    expect(await screen.findByRole('alert')).toHaveTextContent('会话列表加载失败');
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

    expect(screen.getByRole('alert')).toHaveTextContent('会话列表加载失败');
    expect(screen.getByText('已有调查')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('会话列表加载失败');
    expect(screen.getByText('已有调查')).toBeInTheDocument();
    expect(mockClient.listSessions).toHaveBeenCalledTimes(3);
  });

  it('P5: Composer 与 ThreadWelcome 完整集成业务快捷提问与中文提示', async () => {
    render(<App />);

    // 1. 欢迎区文案与快捷推荐按钮
    expect(screen.getByText('您好，我是滑坡连续监测智能体')).toBeInTheDocument();
    expect(
      screen.getByText('可以向我咨询监测点状态、形变位移、气象分析或现场多源环境证据。')
    ).toBeInTheDocument();

    const welcomePromptBtn = screen.getByText('ZJ-MS10 2025年10月监测数据稳定性如何');
    expect(welcomePromptBtn).toBeInTheDocument();

    // 2. 输入框 placeholder 与推荐提问快捷入口
    const input = screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境…');
    expect(input).toBeInTheDocument();
    expect(screen.getByLabelText('推荐业务提问')).toBeInTheDocument();

    // 3. 点击推荐问题，输入框被自动填充
    await act(async () => {
      fireEvent.click(welcomePromptBtn);
    });

    await waitFor(() => {
      expect(input).toHaveValue('ZJ-MS10 2025年10月监测数据稳定性如何');
    });
  });

  it('P5: ComposerQuickActions 快捷菜单点击呼出浮层并选择业务问题', async () => {
    render(<App />);

    const quickActionBtn = screen.getByLabelText('推荐业务提问');
    expect(quickActionBtn).toBeInTheDocument();

    // 点击呼出 popover
    await userEvent.click(quickActionBtn);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('推荐监测业务提问')).toBeInTheDocument();
    const promptItem = within(dialog).getByText('查询 ZJ-MS04 站点周边近期的天气与降雨情况');
    expect(promptItem).toBeInTheDocument();

    // 点击第二个 prompt
    await userEvent.click(promptItem);

    const input = screen.getByPlaceholderText('询问监测数据、变化趋势、降雨关联或场地环境…');
    await waitFor(() => {
      expect(input).toHaveValue('查询 ZJ-MS04 站点周边近期的天气与降雨情况');
    });
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
