import React from 'react';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLangGraphThreadListAdapter } from '@/lib/langgraph/thread-list-adapter';
import { AssistantProvider } from '@/app/providers/AssistantProvider';
import { App } from '@/App';
import { useAui, useAuiState } from '@assistant-ui/react';
import * as api from '@/services/api';

describe('LangGraph Thread List Adapter (P3)', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockClient = {
      threads: {
        search: vi.fn(),
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      runs: {
        wait: vi.fn(),
      },
    };
  });

  it('list() 正确按 updated_at 倒序分页查询并将数据映射为 RemoteThreadMetadata', async () => {
    const mockThreads = [
      {
        thread_id: 't-1',
        metadata: { graph_id: 'lma-agent', name: '滑坡历史监测 A' },
        created_at: '2026-09-18T10:00:00Z',
        updated_at: '2026-09-18T10:30:00Z',
        status: 'idle',
      },
      {
        thread_id: 't-2',
        metadata: { graph_id: 'lma-agent', name: '' },
        created_at: '2026-09-18T09:00:00Z',
        updated_at: '2026-09-18T09:10:00Z',
        status: 'idle',
      },
    ];

    mockClient.threads.search.mockResolvedValue(mockThreads);
    const adapter = createLangGraphThreadListAdapter(mockClient);

    const result = await adapter.list();

    expect(mockClient.threads.search).toHaveBeenCalledWith({
      metadata: { graph_id: 'lma-agent' },
      limit: 20,
      offset: 0,
      sortBy: 'updated_at',
      sortOrder: 'desc',
      select: ['thread_id', 'metadata', 'created_at', 'updated_at', 'status'],
    });

    expect(result.threads).toHaveLength(2);
    expect(result.threads[0]).toEqual({
      status: 'regular',
      remoteId: 't-1',
      externalId: 't-1',
      title: '滑坡历史监测 A',
      lastMessageAt: new Date('2026-09-18T10:30:00Z'),
    });
    // 空标题回退为新会话
    expect(result.threads[1].title).toBe('新会话');
    expect(result.nextCursor).toBeUndefined();
  });

  it('list() 达到一页上限时返回 nextCursor 支持继续分页', async () => {
    const mockThreads = Array.from({ length: 20 }, (_, i) => ({
      thread_id: `t-${i}`,
      metadata: { graph_id: 'lma-agent', name: `会话 ${i}` },
      created_at: '2026-09-18T10:00:00Z',
      updated_at: '2026-09-18T10:00:00Z',
      status: 'idle',
    }));

    mockClient.threads.search.mockResolvedValue(mockThreads);
    const adapter = createLangGraphThreadListAdapter(mockClient);

    const page1 = await adapter.list();
    expect(page1.nextCursor).toBe('20');

    await adapter.list({ after: '20' });
    expect(mockClient.threads.search).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 20 })
    );
  });

  it('initialize() 调用 client.threads.create 创建初始线程', async () => {
    mockClient.threads.create.mockResolvedValue({ thread_id: 'new-thread-123' });
    const adapter = createLangGraphThreadListAdapter(mockClient);

    const res = await adapter.initialize();

    expect(mockClient.threads.create).toHaveBeenCalledWith({
      metadata: {
        graph_id: 'lma-agent',
        name: '新会话',
      },
    });
    expect(res).toEqual({ remoteId: 'new-thread-123', externalId: 'new-thread-123' });
  });

  it('rename() 调用 client.threads.update 更新元数据', async () => {
    mockClient.threads.update.mockResolvedValue({});
    const adapter = createLangGraphThreadListAdapter(mockClient);

    await adapter.rename('t-123', '监测报告总结');

    expect(mockClient.threads.update).toHaveBeenCalledWith('t-123', {
      metadata: { name: '监测报告总结' },
    });
  });

  it('rename() 遇到空白标题时不发送请求', async () => {
    const adapter = createLangGraphThreadListAdapter(mockClient);
    await adapter.rename('t-123', '   ');
    expect(mockClient.threads.update).not.toHaveBeenCalled();
  });

  it('delete() 调用 client.threads.delete 删除线程', async () => {
    mockClient.threads.delete.mockResolvedValue({});
    const adapter = createLangGraphThreadListAdapter(mockClient);

    await adapter.delete('t-to-delete');

    expect(mockClient.threads.delete).toHaveBeenCalledWith('t-to-delete');
  });

  it('fetch() 调用 client.threads.get 获取线程信息并映射', async () => {
    mockClient.threads.get.mockResolvedValue({
      thread_id: 't-fetch',
      metadata: { name: '已知监测点' },
      created_at: '2026-09-18T12:00:00Z',
      updated_at: '2026-09-18T12:05:00Z',
    });
    const adapter = createLangGraphThreadListAdapter(mockClient);

    const thread = await adapter.fetch('t-fetch');

    expect(mockClient.threads.get).toHaveBeenCalledWith('t-fetch');
    expect(thread).toEqual({
      status: 'regular',
      remoteId: 't-fetch',
      externalId: 't-fetch',
      title: '已知监测点',
      lastMessageAt: new Date('2026-09-18T12:05:00Z'),
    });
  });

  it('generateTitle() 提取首条用户消息、调用后端无状态图生成并持久化回写', async () => {
    const generateSessionTitleSpy = vi
      .spyOn(api, 'generateSessionTitle')
      .mockResolvedValue('黄土滑坡 GNSS 位移分析');
    mockClient.threads.update.mockResolvedValue({});

    const adapter = createLangGraphThreadListAdapter(mockClient);
    const mockMessages: any[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '分析一下近期监测点位移和降雨趋势' }],
      },
    ];

    const stream = await adapter.generateTitle('t-title-1', mockMessages);
    expect(stream).toBeDefined();

    // 等待流内任务执行
    await waitFor(() => {
      expect(generateSessionTitleSpy).toHaveBeenCalledWith(
        mockClient,
        '分析一下近期监测点位移和降雨趋势'
      );
      expect(mockClient.threads.update).toHaveBeenCalledWith('t-title-1', {
        metadata: { name: '黄土滑坡 GNSS 位移分析' },
      });
    });
  });
});

describe('AssistantProvider 与 App 组装 (P2)', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockClient = {
      threads: {
        search: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue({ thread_id: 'new-thread' }),
        get: vi.fn().mockImplementation(async (id: string) => ({
          thread_id: id,
          metadata: { graph_id: 'lma-agent', name: `会话 ${id}` },
          created_at: '2026-09-18T10:00:00Z',
          updated_at: '2026-09-18T10:00:00Z',
        })),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
        stream: vi.fn().mockImplementation(() => ({
          onEvent: vi.fn().mockReturnValue(() => {}),
          onError: vi.fn().mockReturnValue(() => {}),
          startLifecycleWatcher: vi.fn(),
          close: vi.fn().mockResolvedValue(undefined),
          messages: (async function* () {})(),
          values: (async function* () {})(),
          toolCalls: (async function* () {})(),
          subgraphs: (async function* () {})(),
          subagents: (async function* () {})(),
        })),
      },
      runs: {
        stream: vi.fn().mockImplementation(() => (async function* () {})()),
      },
    };
    vi.spyOn(api, 'createLangGraphClient').mockReturnValue(mockClient);
  });

  it('AssistantProvider 正确挂载运行时并提供子组件渲染环境', () => {
    const { getByText } = render(
      <AssistantProvider client={mockClient}>
        <div>内部业务界面</div>
      </AssistantProvider>
    );

    expect(getByText('内部业务界面')).toBeInTheDocument();
  });

  it('App 根组件正确挂载并渲染 ThreadList 品牌区与主聊天视口', async () => {
    render(<App />);

    expect(screen.getByText('LMA Monitor')).toBeInTheDocument();
    expect(screen.getByText('滑坡连续监测智能体')).toBeInTheDocument();
    expect(screen.getByText('服务配置')).toBeInTheDocument();
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

    expect(screen.getByText('LangGraph 服务对接配置')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('请输入 LangGraph API 地址或 /langgraph-api')).toBeInTheDocument();

    // 修改地址并保存
    fireEvent.change(
      screen.getByPlaceholderText('请输入 LangGraph API 地址或 /langgraph-api'),
      { target: { value: 'http://new-domain:2024' } }
    );
    fireEvent.click(screen.getByText('保存并应用'));

    await waitFor(() => {
      expect(localStorage.getItem('lma_langgraph_config')).toBe('http://new-domain:2024');
    });
  });

  it('AssistantProvider 与浏览器 URL 保持双向同步，驱动 pushState 并通过真实 history.back 返回上一个会话', async () => {
    mockClient.threads.search.mockResolvedValue([
      { thread_id: 't-history-2', metadata: { graph_id: 'lma-agent', name: '会话 2' }, created_at: '2026-09-18T11:00:00Z', updated_at: '2026-09-18T11:00:00Z' },
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
    expect(mockClient.threads.get).toHaveBeenCalledWith('t-history-1');
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

  it('多会话切换与创建集成：从初始未绑定到 initialize 创建、externalId 与 thread_id 对齐并在切走切回时保持一致', async () => {
    const createdThread = {
      thread_id: 'thread-stream-test',
      created_at: '2026-09-18T10:00:00Z',
      updated_at: '2026-09-18T10:00:00Z',
      metadata: { graph_id: 'lma-agent', name: '新会话' },
    };
    mockClient.threads.create.mockResolvedValue(createdThread);
    mockClient.threads.get.mockImplementation(async (id: string) => ({
      thread_id: id,
      created_at: '2026-09-18T10:00:00Z',
      updated_at: '2026-09-18T10:00:00Z',
      metadata: { graph_id: 'lma-agent', name: `会话 ${id}` },
    }));

    const adapter = createLangGraphThreadListAdapter(mockClient);

    // 1. 初始化会话
    const initialized = await adapter.initialize();
    expect(initialized.remoteId).toBe('thread-stream-test');
    expect(initialized.externalId).toBe('thread-stream-test');
    expect(mockClient.threads.create).toHaveBeenCalledWith({
      metadata: { graph_id: 'lma-agent', name: '新会话' },
    });

    // 2. 验证 fetch
    const fetched = await adapter.fetch(initialized.remoteId);
    expect(fetched.externalId).toBe(initialized.remoteId);
    expect(fetched.remoteId).toBe(initialized.remoteId);

    // 3. 在 AssistantProvider 中通过 assistant-ui 真实状态驱动会话切换
    let capturedAui: any;
    function Consumer() {
      capturedAui = useAui();
      const activeThreadId = useAuiState((s) => s.threads.mainThreadId);
      const isRunning = useAuiState((s) => s.thread.isRunning);
      const items = useAuiState((s) => s.threads.threadItems);
      const activeItem = items.find((i) => i.id === activeThreadId);
      return (
        <div>
          <div data-testid="aui-active-id">{activeThreadId}</div>
          <div data-testid="aui-external-id">{activeItem?.externalId ?? 'none'}</div>
          <div data-testid="aui-is-running">{isRunning ? 'running' : 'idle'}</div>
        </div>
      );
    }

    render(
      <AssistantProvider client={mockClient}>
        <Consumer />
      </AssistantProvider>
    );

    // 切换到刚刚初始化的会话
    await act(async () => {
      capturedAui.threads.switchToThread('thread-stream-test');
    });

    await waitFor(() => {
      expect(screen.getByTestId('aui-active-id')).toHaveTextContent('thread-stream-test');
      expect(screen.getByTestId('aui-external-id')).toHaveTextContent('thread-stream-test');
      expect(screen.getByTestId('aui-is-running')).toHaveTextContent('idle');
    });

    // 切走会话到 thread-another
    await act(async () => {
      capturedAui.threads.switchToThread('thread-another');
    });

    await waitFor(() => {
      expect(screen.getByTestId('aui-active-id')).toHaveTextContent('thread-another');
      expect(screen.getByTestId('aui-external-id')).toHaveTextContent('thread-another');
    });

    // 切回原会话，验证上下文与 externalId 状态保持一致
    await act(async () => {
      capturedAui.threads.switchToThread('thread-stream-test');
    });

    await waitFor(() => {
      expect(screen.getByTestId('aui-active-id')).toHaveTextContent('thread-stream-test');
      expect(screen.getByTestId('aui-external-id')).toHaveTextContent('thread-stream-test');
      expect(capturedAui.threads.getState().mainThreadId).toBe('thread-stream-test');
    });
  });
});
