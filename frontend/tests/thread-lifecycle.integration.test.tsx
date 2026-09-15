import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  options: null as any, current: null as string | null, loading: false,
  messages: [] as any[], finishRun: null as null | (() => void),
  remove: vi.fn(), submit: vi.fn(), get: vi.fn(), update: vi.fn(), run: vi.fn(),
  sessions: vi.fn(), title: vi.fn(), disconnect: vi.fn(),
  factory: vi.fn(),
  statuses: vi.fn(),
  stop: vi.fn(), lastRuns: vi.fn(), state: vi.fn(),
  histories: null as Record<string, any[]> | null,
}));
vi.mock('@langchain/react', () => ({ useStream: (options: any) => {
  mock.options = options;
  return { messages: mock.histories ? mock.histories[options.threadId] || [] : mock.messages, values: {}, isLoading: mock.loading, isThreadLoading: false,
    submit: mock.submit, stop: mock.stop, disconnect: mock.disconnect, getThread: () => ({ threadId: mock.current }),
    client: options.client,
  };
} }));
vi.mock('../src/services/api', async (original) => ({ ...await original<any>(),
  getSessions: async (client: any, offset: number) => {
    const res = await mock.sessions(client, offset);
    return { ...res, sessions: res.sessions.map((session: any) => ({ updated_at: session.created_at, ...session })),
      nextOffset: res.nextOffset ?? offset + res.sessions.length, hasMore: res.hasMore ?? false };
  }, generateSessionTitle: mock.title,
  getSessionStatuses: mock.statuses,
  createLangGraphClient: mock.factory,
}));
vi.mock('../src/components/ChatWindow', () => ({ ChatWindow: (props: any) =>
  <><button onClick={() => void props.onSendMessage('首条消息')}>发送测试消息</button>
    <button onClick={props.onStopGeneration}>停止测试消息</button>
    <span>{props.errorMessage}</span>{props.messages.map((message: any, index: number) => <p key={index}>{message.content}</p>)}</> }));
import { App } from '../src/App';
const thread = (name?: string) => ({ thread_id: 'sdk-thread', created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z',
  metadata: { graph_id: 'lma-agent', ...(name ? { name } : {}) }, status: 'busy' });
async function acceptRun() {
  await act(async () => { mock.options.onCreated({ runId: 'run-1' }); });
}
async function finishRun() {
  await act(async () => { mock.loading = false; mock.finishRun?.(); });
}

describe('标题与 Agent Run 独立生命周期', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.resetAllMocks(); window.history.replaceState(null, '', '/');
    mock.current = null; mock.loading = false; mock.messages = []; mock.finishRun = null;
    mock.histories = null;
    localStorage.clear();
    mock.factory.mockImplementation(() => ({
      threads: { delete: mock.remove, get: mock.get, update: mock.update, getState: mock.state }, runs: { get: mock.run, list: mock.lastRuns },
    }));
    mock.sessions.mockResolvedValue({ sessions: [], isLive: true });
    mock.statuses.mockResolvedValue([]);
    mock.remove.mockResolvedValue(undefined);
    mock.run.mockResolvedValue({ run_id: 'run-1' });
    mock.get.mockResolvedValue(thread());
    mock.lastRuns.mockResolvedValue([{ status: 'interrupted' }]);
    mock.state.mockResolvedValue({ values: { messages: [] } });
    mock.stop.mockImplementation(async () => { mock.loading = false; mock.finishRun?.(); });
    mock.update.mockImplementation(async (_id: string, payload: any) => thread(payload.metadata.name));
    mock.title.mockResolvedValue('正式标题');
    mock.submit.mockImplementation((input: any) => {
      mock.current = 'sdk-thread'; mock.loading = true; mock.messages = input.messages;
      mock.options.onThreadId('sdk-thread');
      return new Promise<void>((resolve) => { mock.finishRun = resolve; });
    });
    mock.disconnect.mockImplementation(() => { mock.messages = []; mock.loading = false; });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  it('重复Stop仅调用一次官方stop，不读写checkpoint；刷新后下一轮按Server证据提交', async () => {
    let completeStop!: () => void;
    mock.stop.mockImplementation(() => new Promise<void>((resolve) => { completeStop = () => { mock.loading = false; mock.finishRun?.(); resolve(); }; }));
    const first = render(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    fireEvent.click(screen.getByText('停止测试消息')); fireEvent.click(screen.getByText('停止测试消息'));
    expect(mock.stop).toHaveBeenCalledTimes(1);
    expect(mock.state).not.toHaveBeenCalled(); expect(mock.lastRuns).not.toHaveBeenCalled(); expect(mock.update).not.toHaveBeenCalled();
    await act(async () => { completeStop(); });
    first.unmount();
    const history = [{ type: 'human', content: '查询' }, { type: 'ai', tool_calls: [{ id: 'missing', name: 'list_stations', args: {} }] }];
    mock.get.mockResolvedValue({ ...thread(), status: 'idle' });
    mock.state.mockResolvedValue({ values: { messages: history } });
    mock.submit.mockResolvedValue(undefined);
    render(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    await waitFor(() => expect(mock.submit).toHaveBeenCalledTimes(2));
    expect(mock.submit.mock.calls[1][0].messages).toMatchObject([
      { type: 'tool', tool_call_id: 'missing', status: 'error', additional_kwargs: { lma_protocol: 'interrupted_tool_call' } },
      { type: 'human', content: '首条消息' },
    ]);
    expect(mock.state).toHaveBeenCalledWith('sdk-thread');
    expect(mock.update).not.toHaveBeenCalled();
  });
  it('UI加载125个会话稳定，刷新已加载范围而非丢回第一页', async () => {
    const rows = Array.from({ length: 125 }, (_, index) => ({ thread_id: `page-${index}`, name: `分页会话${index}`,
      created_at: '2026-09-01T00:00:00Z', updated_at: new Date(Date.UTC(2026, 8, 15, 0, 125 - index)).toISOString() }));
    mock.sessions.mockImplementation(async (_client, offset) => ({ sessions: rows.slice(offset, offset + 20), nextOffset: Math.min(offset + 20, rows.length), hasMore: offset + 20 < rows.length }));
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll('[data-thread-id]')).toHaveLength(20));
    for (const count of [40, 60, 80, 100, 120, 125]) {
      fireEvent.click(screen.getByText('加载更多会话'));
      await waitFor(() => expect(document.querySelectorAll('[data-thread-id]')).toHaveLength(count));
    }
    expect(screen.queryByText('加载更多会话')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('刷新会话列表'));
    await waitFor(() => expect(screen.getByLabelText('刷新会话列表')).not.toBeDisabled());
    expect(document.querySelectorAll('[data-thread-id]')).toHaveLength(125);
    expect(mock.sessions.mock.calls.slice(-7).map((call) => call[1])).toEqual([0, 20, 40, 60, 80, 100, 120]);
  });
  it('加载更多失败保留列表与offset，重新加载相同页不假成功', async () => {
    mock.sessions.mockResolvedValueOnce({ sessions: [{ thread_id: 'page-1', name: '已确认列表', created_at: '2026-09-15T00:00:00Z' }], nextOffset: 20, hasMore: true })
      .mockRejectedValueOnce(new Error('private request failure'))
      .mockResolvedValue({ sessions: [], nextOffset: 20, hasMore: false });
    render(<App />); await waitFor(() => expect(screen.getByText('已确认列表')).toBeInTheDocument());
    fireEvent.click(screen.getByText('加载更多会话'));
    await waitFor(() => expect(screen.getByText('会话列表加载失败，已保留当前列表。请刷新重试。')).toBeInTheDocument());
    expect(screen.getByText('已确认列表')).toBeInTheDocument();
    fireEvent.click(screen.getByText('加载更多会话'));
    await waitFor(() => expect(screen.queryByText('加载更多会话')).not.toBeInTheDocument());
    expect(mock.sessions.mock.calls.map((call) => call[1])).toEqual([0, 20, 20]);
    expect(screen.queryByText(/private request failure/)).not.toBeInTheDocument();
  });
  it('闲置无轮询，busy仅刷新ID，转idle后停表，迟到刷新不复活删除会话', async () => {
    const timers: (() => void)[] = [];
    const originalInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((callback: any, delay?: number) => {
      if (delay === 3000) { timers.push(callback); return 123; }
      return originalInterval(callback, delay);
    });
    const clear = vi.spyOn(window, 'clearInterval');
    const busy = { thread_id: 'busy', name: '后台会话', status: 'busy', created_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z' };
    mock.sessions.mockResolvedValueOnce({ sessions: [], hasMore: false, nextOffset: 0 });
    render(<App />); await waitFor(() => expect(mock.sessions).toHaveBeenCalledTimes(1));
    expect(timers).toHaveLength(0);
    mock.sessions.mockResolvedValue({ sessions: [busy] });
    fireEvent.click(screen.getByLabelText('刷新会话列表'));
    await waitFor(() => expect(timers).toHaveLength(1));
    mock.statuses.mockResolvedValue([{ ...busy, status: 'idle' }]);
    await act(async () => { timers[0](); });
    expect(mock.statuses).toHaveBeenCalledWith(mock.options.client, ['busy']);
    expect(mock.sessions).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledWith(123);
    expect(screen.getByTitle('删除')).toBeInTheDocument();
    mock.sessions.mockResolvedValue({ sessions: [busy] });
    fireEvent.click(screen.getByLabelText('刷新会话列表'));
    await waitFor(() => expect(timers).toHaveLength(2));
    let finishStatus!: (value: any) => void;
    mock.statuses.mockReturnValue(new Promise((resolve) => { finishStatus = resolve; }));
    await act(async () => { timers[1](); });
    // 手动刷新已确认 idle 后删除，使仍在途的旧 busy 请求失效。
    mock.sessions.mockResolvedValue({ sessions: [{ ...busy, status: 'idle' }] });
    fireEvent.click(screen.getByLabelText('刷新会话列表'));
    await waitFor(() => expect(screen.getByTitle('删除')).toBeInTheDocument());
    mock.sessions.mockResolvedValue({ sessions: [] });
    fireEvent.click(screen.getByTitle('删除')); fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('后台会话')).not.toBeInTheDocument());
    await act(async () => { finishStatus([busy]); });
    expect(screen.queryByText('后台会话')).not.toBeInTheDocument();
  });
  it('直接链接与重新挂载从 URL 选择，不被空列表或列表首项覆盖', async () => {
    window.history.replaceState(null, '', '/?view=monitor&threadId=linked#evidence');
    mock.histories = { linked: [{ type: 'human', content: '链接会话历史' }] };
    const first = render(<App />);
    await waitFor(() => expect(mock.sessions).toHaveBeenCalled());
    expect(mock.options.threadId).toBe('linked');
    expect(screen.getByText('链接会话历史')).toBeInTheDocument();
    first.unmount();
    mock.sessions.mockResolvedValue({ sessions: [{ thread_id: 'different', name: '列表首项', created_at: '2026-09-15T00:00:00Z' }], isLive: true });
    render(<App />);
    await waitFor(() => expect(screen.getByText('列表首项')).toBeInTheDocument());
    expect(mock.options.threadId).toBe('linked');
    expect(screen.getByText('链接会话历史')).toBeInTheDocument();
    expect(window.location.search).toBe('?view=monitor&threadId=linked');
    expect(window.location.hash).toBe('#evidence');
  });
  it('用户选择建立历史，真实 back/forward 同步 SDK 与侧栏，不串消息', async () => {
    window.history.replaceState(null, '', '/?view=monitor#evidence');
    mock.sessions.mockResolvedValue({ sessions: ['a', 'b'].map((id) => ({ thread_id: id, name: `会话${id}`, created_at: '2026-09-15T00:00:00Z' })), isLive: true });
    mock.histories = { a: [{ type: 'human', content: '甲历史' }], b: [{ type: 'human', content: '乙历史' }] };
    render(<App />);
    await waitFor(() => expect(screen.getByText('会话a')).toBeInTheDocument());
    const initialLength = window.history.length;
    fireEvent.click(screen.getByText('会话a'));
    fireEvent.click(screen.getByText('会话b'));
    expect(window.history.length).toBe(initialLength + 2);
    expect(mock.options.threadId).toBe('b');
    expect(screen.getByText('乙历史')).toBeInTheDocument();
    expect(screen.queryByText('甲历史')).not.toBeInTheDocument();
    async function navigate(direction: 'back' | 'forward') {
      await act(async () => { await new Promise<void>((resolve) => {
        window.addEventListener('popstate', () => resolve(), { once: true });
        window.history[direction]();
      }); });
    }
    await navigate('back');
    expect(mock.options.threadId).toBe('a');
    expect(document.querySelector('[data-thread-id="a"]')).toHaveClass('bg-neutral-200/75');
    expect(screen.getByText('甲历史')).toBeInTheDocument();
    expect(screen.queryByText('乙历史')).not.toBeInTheDocument();
    await navigate('back');
    expect(mock.options.threadId).toBeNull();
    expect(screen.queryByText('甲历史')).not.toBeInTheDocument();
    await navigate('forward'); await navigate('forward');
    expect(mock.options.threadId).toBe('b');
    expect(screen.getByText('乙历史')).toBeInTheDocument();
    expect(mock.disconnect).toHaveBeenCalledTimes(6);
    expect(mock.remove).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?view=monitor&threadId=b');
    expect(window.location.hash).toBe('#evidence');
  });
  it('重复选择不加历史或断开，首次 SDK ID 原位替换新建入口', async () => {
    window.history.replaceState(null, '', '/?threadId=existing');
    mock.sessions.mockResolvedValue({ sessions: [{ thread_id: 'existing', name: '已有会话', created_at: '2026-09-15T00:00:00Z' }], isLive: true });
    render(<App />); await waitFor(() => expect(screen.getByText('已有会话')).toBeInTheDocument());
    const length = window.history.length;
    fireEvent.click(screen.getByText('已有会话'));
    expect(window.history.length).toBe(length); expect(mock.disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('新建监测会话'));
    expect(window.history.length).toBe(length + 1);
    fireEvent.click(screen.getByText('新建监测会话'));
    expect(window.history.length).toBe(length + 1);
    fireEvent.click(screen.getByText('发送测试消息'));
    expect(window.history.length).toBe(length + 1);
    expect(mock.options.threadId).toBe('sdk-thread');
    expect(window.history.state).toBeNull();
    await finishRun();
  });
  it('删除非当前会话不改 URL，当前会话删除确认后原位清理', async () => {
    window.history.replaceState(null, '', '/?view=monitor&threadId=a#evidence');
    let rows = ['a', 'b'].map((id) => ({ thread_id: id, name: `会话${id}`, created_at: '2026-09-15T00:00:00Z' }));
    mock.sessions.mockImplementation(async () => ({ sessions: rows, isLive: true }));
    mock.remove.mockImplementation(async (id) => { rows = rows.filter((row) => row.thread_id !== id); });
    render(<App />); await waitFor(() => expect(screen.getByText('会话b')).toBeInTheDocument());
    const length = window.history.length;
    fireEvent.click(document.querySelector('[data-thread-id="b"] button[title="删除"]')!);
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('会话b')).not.toBeInTheDocument());
    expect(mock.options.threadId).toBe('a');
    fireEvent.click(document.querySelector('[data-thread-id="a"] button[title="删除"]')!);
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(mock.options.threadId).toBeNull());
    expect(window.history.length).toBe(length);
    expect(window.location.search).toBe('?view=monitor');
    expect(window.location.hash).toBe('#evidence');
  });
  it('空 threadId 视为未选择，不因列表加载自动选择历史', async () => {
    window.history.replaceState(null, '', '/?threadId='); render(<App />);
    await waitFor(() => expect(mock.sessions).toHaveBeenCalled());
    expect(mock.options.threadId).toBeNull();
    expect(mock.submit).not.toHaveBeenCalled();
  });
  it('配置切换同步更换 Client，旧列表和迟到标题不回写新服务', async () => {
    let finishList!: (value: any) => void;
    let finishTitle!: (value: string) => void;
    mock.sessions.mockImplementationOnce(() => new Promise((resolve) => { finishList = resolve; }))
      .mockResolvedValue({ sessions: [], isLive: true });
    mock.title.mockReturnValue(new Promise<string>((resolve) => { finishTitle = resolve; }));
    render(<App />);
    const firstClient = mock.options.client;
    fireEvent.click(screen.getByText('发送测试消息'));
    await acceptRun();
    expect(mock.title).toHaveBeenCalledWith(firstClient, '首条消息');
    fireEvent.click(screen.getByText('LMA 监测服务'));
    fireEvent.click(screen.getByText('LangGraph 服务配置'));
    fireEvent.change(screen.getByPlaceholderText('请输入 LangGraph API 地址或 /langgraph-api'), { target: { value: 'http://new-server:2024' } });
    fireEvent.click(screen.getByText('保存并应用'));
    const nextClient = mock.options.client;
    expect(nextClient).not.toBe(firstClient);
    await waitFor(() => expect(mock.sessions).toHaveBeenCalledWith(nextClient, 0));
    expect(mock.options.threadId).toBeNull();
    await act(async () => {
      finishList({ sessions: [{ thread_id: 'old', name: '旧服务会话', created_at: '2026-09-15T00:00:00Z' }], isLive: true });
      finishTitle('旧服务标题');
      mock.loading = false; mock.finishRun?.();
    });
    expect(screen.queryByText('旧服务会话')).not.toBeInTheDocument();
    expect(screen.queryByText('旧服务标题')).not.toBeInTheDocument();
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.sessions.mock.calls.at(-1)?.[0]).toBe(nextClient);
  });
  it('新建中央空白、列表不预建；SDK ID 后立即骨架和乐观消息', async () => {
    render(<App />);
    expect(mock.options.threadId).toBeNull();
    expect(document.querySelector('[data-thread-id]')).toBeNull();
    fireEvent.click(screen.getByText('发送测试消息'));
    expect(screen.getByLabelText('会话标题生成中')).toBeInTheDocument();
    expect(screen.getByText('首条消息')).toBeInTheDocument();
    expect(new URL(window.location.href).searchParams.get('threadId')).toBe('sdk-thread');
    expect(mock.options.optimistic).toBe(true);
    expect(mock.submit.mock.calls[0][1]).not.toHaveProperty('threadId');
    expect(mock.title).not.toHaveBeenCalled();
    await finishRun();
  });
  it('onCreated 启动标题；标题先完成时原位替换，Agent loading 保留', async () => {
    // 防止服务端轮询为空快照吞掉刚确认的会话。
    mock.sessions.mockImplementation(async () => ({ sessions: mock.update.mock.calls.length ?
      [{ thread_id: 'sdk-thread', created_at: '2026-09-15T00:00:00Z', name: '正式标题', status: mock.loading ? 'busy' : 'idle' }] : [], isLive: true }));
    render(<App />); fireEvent.click(screen.getByText('发送测试消息'));
    const row = document.querySelector('[data-thread-id="sdk-thread"]');
    await acceptRun();
    await waitFor(() => expect(screen.getByText('正式标题')).toBeInTheDocument());
    expect(document.querySelector('[data-thread-id="sdk-thread"]')).toBe(row);
    expect(screen.getByTitle('生成中，暂不可重命名或删除')).toBeInTheDocument();
    expect(mock.finishRun).not.toBeNull();
    await finishRun();
    expect(screen.queryByTitle('生成中，暂不可重命名或删除')).not.toBeInTheDocument();
  });
  it('Agent 先结束只取消 loading，骨架持续到标题完成', async () => {
    let resolveTitle!: (value: string) => void;
    mock.title.mockReturnValue(new Promise<string>((resolve) => { resolveTitle = resolve; }));
    render(<App />); fireEvent.click(screen.getByText('发送测试消息'));
    await acceptRun(); expect(mock.title).toHaveBeenCalledWith(expect.anything(), '首条消息');
    await finishRun();
    expect(screen.getByLabelText('会话标题生成中')).toBeInTheDocument();
    expect(screen.queryByTitle('生成中，暂不可重命名或删除')).not.toBeInTheDocument();
    await act(async () => { resolveTitle('正式标题'); });
    expect(mock.update).toHaveBeenCalledWith('sdk-thread', { metadata: { name: '正式标题' } });
  });
  it('标题失败保存新会话，不影响 Agent 和聊天', async () => {
    mock.title.mockRejectedValue(new Error('private title failure'));
    mock.sessions.mockImplementation(async () => ({ sessions: mock.update.mock.calls.length ?
      [{ thread_id: 'sdk-thread', created_at: '2026-09-15T00:00:00Z', name: '新会话', status: 'busy' }] : [], isLive: true }));
    render(<App />); fireEvent.click(screen.getByText('发送测试消息')); await acceptRun();
    await waitFor(() => expect(screen.getByText('新会话')).toBeInTheDocument());
    expect(mock.loading).toBe(true);
    expect(mock.update).toHaveBeenCalledWith('sdk-thread', { metadata: { name: '新会话' } });
    expect(screen.queryByText(/private title failure|标题生成失败/)).not.toBeInTheDocument();
    await finishRun();
  });
  it('刷新恢复 URL，新建清空选择态和消息，标题任务不受影响', async () => {
    window.history.replaceState(null, '', '/?threadId=restored'); render(<App />);
    expect(mock.options.threadId).toBe('restored');
    fireEvent.click(screen.getByText('新建监测会话'));
    expect(mock.options.threadId).toBeNull(); expect(new URL(window.location.href).searchParams.has('threadId')).toBe(false);
  });
  it('metadata 保存失败不伪装成标题成功，不写聊天错误', async () => {
    mock.update.mockRejectedValue(new Error('private metadata failure'));
    render(<App />); fireEvent.click(screen.getByText('发送测试消息')); await acceptRun();
    await waitFor(() => expect(screen.getByText('会话名称未保存')).toBeInTheDocument());
    expect(screen.queryByText('正式标题')).not.toBeInTheDocument();
    expect(screen.queryByText(/private metadata failure/)).not.toBeInTheDocument();
    await finishRun();
  });
  it('迟到 onCreated 在 Run 结束后仍启动标题，不重复启动', async () => {
    render(<App />); fireEvent.click(screen.getByText('发送测试消息'));
    await finishRun(); expect(mock.title).not.toHaveBeenCalled();
    await acceptRun(); await acceptRun();
    expect(mock.title).toHaveBeenCalledTimes(1);
  });
  it('删除成功后迟到的旧列表刷新不能复活会话', async () => {
    const existing = { thread_id: 'sdk-thread', name: '待删除会话', created_at: '2026-09-15T00:00:00Z', status: 'idle' };
    let resolveOld!: (value: any) => void;
    mock.sessions.mockResolvedValueOnce({ sessions: [existing], isLive: true })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ sessions: [], isLive: true });
    render(<App />);
    await waitFor(() => expect(screen.getByText('待删除会话')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('刷新会话列表'));
    fireEvent.click(screen.getByTitle('删除')); fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('待删除会话')).not.toBeInTheDocument());
    await act(async () => { resolveOld({ sessions: [existing], isLive: true }); });
    expect(screen.queryByText('待删除会话')).not.toBeInTheDocument();
    expect(mock.remove).toHaveBeenCalledTimes(1);
  });
  it('DELETE 未确认前保留会话并禁止重复请求，先断开当前订阅', async () => {
    window.history.replaceState(null, '', '/?threadId=sdk-thread');
    const existing = { thread_id: 'sdk-thread', name: '待删除会话', created_at: '2026-09-15T00:00:00Z', status: 'idle' };
    mock.sessions.mockResolvedValueOnce({ sessions: [existing], isLive: true }).mockResolvedValue({ sessions: [], isLive: true });
    let resolveDelete!: () => void;
    mock.remove.mockReturnValue(new Promise<void>((resolve) => { resolveDelete = resolve; }));
    render(<App />); await waitFor(() => expect(screen.getByText('待删除会话')).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('删除'));
    const confirm = screen.getByText('确认删除');
    act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
    await waitFor(() => expect(mock.remove).toHaveBeenCalledTimes(1));
    expect(screen.getByText('待删除会话')).toBeInTheDocument();
    expect(screen.getByTitle('删除中，暂不可重复操作')).toBeInTheDocument();
    expect(mock.disconnect.mock.invocationCallOrder[0]).toBeLessThan(mock.remove.mock.invocationCallOrder[0]);
    await act(async () => { resolveDelete(); });
    expect(new URL(window.location.href).searchParams.has('threadId')).toBe(false);
    expect(screen.queryByText('待删除会话')).not.toBeInTheDocument();
  });
  it('404 明确说明资源不存在并同步列表', async () => {
    const existing = { thread_id: 'sdk-thread', name: '待删除会话', created_at: '2026-09-15T00:00:00Z', status: 'idle' };
    mock.sessions.mockResolvedValueOnce({ sessions: [existing], isLive: true }).mockResolvedValue({ sessions: [], isLive: true });
    mock.remove.mockRejectedValue(Object.assign(new Error('private diagnosis'), { status: 404 }));
    render(<App />); await waitFor(() => expect(screen.getByText('待删除会话')).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('删除')); fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.getByText('此会话已不存在')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('待删除会话')).not.toBeInTheDocument());
    expect(screen.queryByText(/private diagnosis/)).not.toBeInTheDocument();
  });
  it('服务端拒绝删除时保留已确认会话，释放操作锁', async () => {
    const existing = { thread_id: 'sdk-thread', name: '待删除会话', created_at: '2026-09-15T00:00:00Z', status: 'idle' };
    mock.sessions.mockResolvedValue({ sessions: [existing], isLive: true });
    mock.remove.mockRejectedValue(Object.assign(new Error('private diagnosis'), { status: 409 }));
    render(<App />); await waitFor(() => expect(screen.getByText('待删除会话')).toBeInTheDocument());
    fireEvent.click(screen.getByTitle('删除')); fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.getByText('会话正在运行，请停止后再删除')).toBeInTheDocument());
    expect(screen.getByText('待删除会话')).toBeInTheDocument();
    expect(screen.getByTitle('删除')).toBeInTheDocument();
  });

  it('连续删除不同会话分别发送正确 ID，不重新删除前一会话', async () => {
    let rows = [
      { thread_id: 'sdk-thread', name: '会话甲', created_at: '2026-09-15T00:00:00Z', status: 'idle' },
      { thread_id: 'other-thread', name: '会话乙', created_at: '2026-09-15T00:01:00Z', status: 'idle' },
    ];
    mock.sessions.mockImplementation(async () => ({ sessions: [...rows], isLive: true }));
    mock.remove.mockImplementation(async (id: string) => { rows = rows.filter((row) => row.thread_id !== id); });
    render(<App />); await waitFor(() => expect(screen.getByText('会话甲')).toBeInTheDocument());
    expect(mock.sessions).toHaveBeenCalledWith(mock.options.client, 0);
    expect(mock.factory).toHaveBeenCalledTimes(1);
    fireEvent.click(document.querySelector('[data-thread-id="sdk-thread"] button[title="删除"]')!);
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('会话甲')).not.toBeInTheDocument());
    fireEvent.click(document.querySelector('[data-thread-id="other-thread"] button[title="删除"]')!);
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('会话乙')).not.toBeInTheDocument());
    expect(mock.remove.mock.calls.map(([id]) => id)).toEqual(['sdk-thread', 'other-thread']);
    expect(screen.queryByText('删除失败，请稍后重试')).not.toBeInTheDocument();
  });
  it('不同会话的删除响应逆序返回也不恢复已删除条目', async () => {
    let rows = [
      { thread_id: 'sdk-thread', name: '会话甲', created_at: '2026-09-15T00:00:00Z', status: 'idle' },
      { thread_id: 'other-thread', name: '会话乙', created_at: '2026-09-15T00:01:00Z', status: 'idle' },
    ];
    const finish = new Map<string, () => void>();
    mock.sessions.mockImplementation(async () => ({ sessions: [...rows], isLive: true }));
    mock.remove.mockImplementation((id: string) => new Promise<void>((resolve) => {
      finish.set(id, () => { rows = rows.filter((row) => row.thread_id !== id); resolve(); });
    }));
    render(<App />); await waitFor(() => expect(screen.getByText('会话甲')).toBeInTheDocument());
    fireEvent.click(document.querySelector('[data-thread-id="sdk-thread"] button[title="删除"]')!);
    fireEvent.click(screen.getByText('确认删除'));
    fireEvent.click(document.querySelector('[data-thread-id="other-thread"] button[title="删除"]')!);
    fireEvent.click(screen.getByText('确认删除'));
    await act(async () => { finish.get('other-thread')!(); });
    expect(screen.getByText('会话甲')).toBeInTheDocument();
    expect(screen.queryByText('会话乙')).not.toBeInTheDocument();
    await act(async () => { finish.get('sdk-thread')!(); });
    expect(screen.queryByText('会话甲')).not.toBeInTheDocument();
    expect(screen.queryByText('会话乙')).not.toBeInTheDocument();
    expect(mock.remove.mock.calls.map(([id]) => id)).toEqual(['sdk-thread', 'other-thread']);
  });

});
