import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  controller: Symbol('controller'),
  options: null as any, current: null as string | null, loading: false,
  messages: [] as any[], toolCalls: [] as any[], messageMetadata: {} as Record<string, any>, finishRun: null as null | (() => void),
  remove: vi.fn(), submit: vi.fn(), get: vi.fn(), update: vi.fn(), run: vi.fn(), join: vi.fn(),
  sessions: vi.fn(), busy: vi.fn(), title: vi.fn(), disconnect: vi.fn(), stop: vi.fn(), hydrate: vi.fn(), cleanup: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('@langchain/react', () => ({ STREAM_CONTROLLER: mock.controller,
  useToolCalls: () => mock.toolCalls,
  useMessageMetadata: (_stream: any, messageId?: string) => messageId ? mock.messageMetadata[messageId] : undefined,
  useStream: (options: any) => {
  mock.options = options;
  return { messages: mock.messages, values: {}, isLoading: mock.loading, isThreadLoading: false,
    submit: mock.submit, stop: mock.stop, disconnect: mock.disconnect, getThread: () => ({ threadId: mock.current }),
    [mock.controller]: { hydrate: mock.hydrate },
    client: options.client,
  };
} }));
vi.mock('../src/services/api', async (original) => ({ ...await original<any>(),
  getSessions: mock.sessions, generateSessionTitle: mock.title,
  getBusySessions: mock.busy,
  removeIncompleteToolCallMessages: mock.cleanup,
  createLangGraphClient: mock.factory,
}));
vi.mock('../src/components/ChatWindow', () => ({ ChatWindow: (props: any) =>
  <><button onClick={() => void props.onSendMessage('首条消息')}>发送测试消息</button>
    <button onClick={() => void props.onStopGeneration()}>停止测试生成</button>
    {props.runError && <span>本次回答未能完成</span>}
    {props.stopError && <span>{props.stopError.message}</span>}
    {props.hydrationError && <span>会话加载失败</span>}
    {props.messages.map((message: any, index: number) => <p key={index}>{message.content}</p>)}</> }));
import { App } from '../src/App';
const thread = (name?: string) => ({ thread_id: 'sdk-thread', created_at: '2026-09-15T00:00:00Z',
  metadata: name ? { name, graph_id: 'lma-agent' } : { graph_id: 'lma-agent' }, status: 'busy' });
async function acceptRun() {
  await act(async () => { mock.options.onCreated({ runId: 'run-1' }); });
}
async function finishRun() {
  await act(async () => { mock.loading = false; mock.finishRun?.(); });
}

describe('标题与 Agent Run 独立生命周期', () => {
  beforeEach(() => {
    vi.restoreAllMocks(); vi.resetAllMocks(); window.history.replaceState(null, '', '/');
    mock.current = null; mock.loading = false; mock.messages = []; mock.toolCalls = []; mock.messageMetadata = {}; mock.finishRun = null;
    localStorage.clear();
    mock.factory.mockImplementation(() => ({
      threads: { delete: mock.remove, get: mock.get, update: mock.update }, runs: { get: mock.run, join: mock.join },
    }));
    mock.sessions.mockResolvedValue({ sessions: [], isLive: true });
    mock.remove.mockResolvedValue(undefined);
    mock.run.mockResolvedValue({ run_id: 'run-1' });
    mock.join.mockResolvedValue({});
    mock.get.mockResolvedValue(thread());
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
      [{ thread_id: 'sdk-thread', created_at: '2026-09-15T00:00:00Z', name: '正式标题', status: 'busy' }] : [], isLive: true }));
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
  it('Stop 只停止当前 Run，清理最终 checkpoint 后重新 hydrate；下一条消息仍是普通新 Run', async () => {
    window.history.replaceState(null, '', '/?threadId=sdk-thread');
    mock.current = 'sdk-thread';
    const mounted = render(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    await acceptRun();
    fireEvent.click(screen.getByText('停止测试生成'));
    await waitFor(() => expect(mock.hydrate).toHaveBeenCalledWith('sdk-thread'));
    expect(mock.stop).toHaveBeenCalledWith({ cancel: true });
    expect(mock.join).toHaveBeenCalledWith('sdk-thread', 'run-1');
    expect(mock.cleanup).toHaveBeenCalledWith(mock.options.client, 'sdk-thread');
    expect(mock.stop.mock.invocationCallOrder[0]).toBeLessThan(mock.join.mock.invocationCallOrder[0]);
    expect(mock.join.mock.invocationCallOrder[0]).toBeLessThan(mock.cleanup.mock.invocationCallOrder[0]);
    expect(mock.cleanup.mock.invocationCallOrder[0]).toBeLessThan(mock.hydrate.mock.invocationCallOrder[0]);
    await finishRun();
    mounted.rerender(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    expect(mock.submit).toHaveBeenCalledTimes(2);
    expect(mock.submit).toHaveBeenCalledWith(
      { messages: [{ type: 'human', content: '首条消息' }] },
      expect.objectContaining({ multitaskStrategy: 'reject' })
    );
    expect(mock.submit.mock.calls.at(-1)?.[0]).not.toHaveProperty('command');
    await finishRun();
  });
  it('迟到 onCreated 使用产生 Run 的 submission 归属，不串到此刻选中的 Thread', async () => {
    window.history.replaceState(null, '', '/?threadId=thread-a');
    mock.current = 'thread-a';
    mock.sessions.mockResolvedValue({ sessions: [
      { thread_id: 'thread-a', name: '会话甲', status: 'busy' },
      { thread_id: 'thread-b', name: '会话乙', status: 'idle' },
    ], isLive: true, nextOffset: 2, hasMore: false });
    render(<App />);
    await waitFor(() => expect(screen.getByText('会话乙')).toBeInTheDocument());
    fireEvent.click(screen.getByText('发送测试消息'));
    fireEvent.click(screen.getByText('会话乙'));
    await acceptRun();
    fireEvent.click(screen.getByText('停止测试生成'));
    await waitFor(() => expect(mock.cleanup).toHaveBeenCalledWith(mock.options.client, 'thread-b'));
    expect(mock.join).not.toHaveBeenCalled();
    await finishRun();
  });
  it('提交流报错但同一服务端 Run 最终成功时，等待收敛并从权威 checkpoint 恢复', async () => {
    window.history.replaceState(null, '', '/?threadId=sdk-thread');
    mock.current = 'sdk-thread';
    mock.run
      .mockResolvedValueOnce({ run_id: 'run-1', status: 'running' })
      .mockResolvedValueOnce({ run_id: 'run-1', status: 'success' });
    render(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    await acceptRun();
    const submitOptions = mock.submit.mock.calls[0][1];
    await act(async () => {
      submitOptions.onError(new Error('private stream failure'));
      mock.loading = false;
      mock.finishRun?.();
    });
    await waitFor(() => expect(mock.hydrate).toHaveBeenCalledWith('sdk-thread'));
    expect(mock.join).toHaveBeenCalledWith('sdk-thread', 'run-1');
    expect(mock.run).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('本次请求未完成，已保留现有记录，请稍后重试。')).not.toBeInTheDocument();
  });
  it('用户 Stop 导致的旧提交错误不会在清理完成后回写失败弹窗', async () => {
    window.history.replaceState(null, '', '/?threadId=sdk-thread');
    mock.current = 'sdk-thread';
    render(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    await acceptRun();
    const submitOptions = mock.submit.mock.calls[0][1];
    fireEvent.click(screen.getByText('停止测试生成'));
    await act(async () => {
      submitOptions.onError(new Error('abort after stop'));
      mock.loading = false;
      mock.finishRun?.();
    });
    await waitFor(() => expect(mock.cleanup).toHaveBeenCalledWith(mock.options.client, 'sdk-thread'));
    expect(screen.queryByText('本次请求未完成，已保留现有记录，请稍后重试。')).not.toBeInTheDocument();
  });
  it('停止后清理失败不伪造成功，且不 hydrate 未确认状态', async () => {
    window.history.replaceState(null, '', '/?threadId=sdk-thread');
    mock.cleanup.mockRejectedValue(new Error('private cleanup failure'));
    render(<App />);
    fireEvent.click(screen.getByText('停止测试生成'));
    await waitFor(() => expect(screen.getByText('会话记录尚未同步')).toBeInTheDocument());
    expect(mock.hydrate).not.toHaveBeenCalled();
    expect(screen.queryByText(/private cleanup failure/)).not.toBeInTheDocument();
  });
  it('重复 Stop 在首个流程完成前只处理一次当前 Run', async () => {
    window.history.replaceState(null, '', '/?threadId=sdk-thread');
    let finishStop!: () => void;
    mock.stop.mockReturnValue(new Promise<void>((resolve) => { finishStop = resolve; }));
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText('停止测试生成'));
      fireEvent.click(screen.getByText('停止测试生成'));
    });
    expect(mock.stop).toHaveBeenCalledTimes(1);
    expect(mock.cleanup).not.toHaveBeenCalled();
    await act(async () => { finishStop(); });
    await waitFor(() => expect(mock.cleanup).toHaveBeenCalledTimes(1));
  });
  it('分页失败保留列表，重试不跳页，分页重叠去重并按服务端更新时间排序', async () => {
    const row = (id: string, updated_at: string) => ({ thread_id: id, name: id, created_at: updated_at, updated_at, status: 'idle' });
    mock.sessions.mockResolvedValueOnce({ sessions: [row('甲', '2026-09-16T00:00:00Z')], isLive: true, nextOffset: 20, hasMore: true })
      .mockRejectedValueOnce(new Error('unavailable'));
    render(<App />);
    await waitFor(() => expect(screen.getByText('加载更多会话')).toBeInTheDocument());
    fireEvent.click(screen.getByText('加载更多会话'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('会话列表加载失败'));
    expect(screen.getByText('甲')).toBeInTheDocument();
    mock.sessions.mockResolvedValueOnce({ sessions: [row('甲', '2026-09-16T02:00:00Z'), row('乙', '2026-09-16T01:00:00Z')], isLive: true, nextOffset: 22, hasMore: false });
    fireEvent.click(screen.getByText('加载更多会话'));
    await waitFor(() => expect(screen.getByText('乙')).toBeInTheDocument());
    expect(mock.sessions.mock.calls.slice(1).map((call) => call[1])).toEqual([20, 20]);
    expect([...document.querySelectorAll('[data-thread-id]')].map((node) => node.getAttribute('data-thread-id'))).toEqual(['甲', '乙']);
    expect(screen.queryByText('加载更多会话')).not.toBeInTheDocument();
  });
  it('空闲无列表轮询；busy 仅刷新指定 ID，恢复 idle 后停止定时刷新', async () => {
    let poll!: () => void;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback: any) => { poll = callback; return 123; });
    const clear = vi.spyOn(window, 'clearInterval');
    mock.sessions.mockResolvedValue({ sessions: [{ thread_id: '忙碌', name: '忙碌', status: 'busy' }, { thread_id: '空闲', name: '空闲', status: 'idle' }], isLive: true, nextOffset: 2, hasMore: false });
    mock.busy.mockResolvedValue([{ thread_id: '忙碌', name: '忙碌', status: 'idle' }]);
    render(<App />);
    await waitFor(() => expect(interval).toHaveBeenCalledTimes(1));
    await act(async () => { poll(); });
    expect(mock.busy).toHaveBeenCalledWith(mock.options.client, ['忙碌']);
    expect(mock.sessions).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(123);
    expect(screen.queryByTitle('生成中，暂不可重命名或删除')).not.toBeInTheDocument();
  });
  it('空闲列表不创建刷新定时器，事件刷新保留已加载页范围', async () => {
    const interval = vi.spyOn(window, 'setInterval');
    const row = (id: string) => ({ thread_id: id, name: id, status: 'idle' });
    mock.sessions.mockResolvedValueOnce({ sessions: [row('第一页')], isLive: true, nextOffset: 20, hasMore: true })
      .mockResolvedValueOnce({ sessions: [row('第二页')], isLive: true, nextOffset: 21, hasMore: false })
      .mockResolvedValueOnce({ sessions: [row('第一页')], isLive: true, nextOffset: 20, hasMore: true })
      .mockResolvedValueOnce({ sessions: [row('第二页')], isLive: true, nextOffset: 21, hasMore: false });
    render(<App />);
    await waitFor(() => expect(screen.getByText('加载更多会话')).toBeInTheDocument());
    fireEvent.click(screen.getByText('加载更多会话'));
    await waitFor(() => expect(screen.getByText('第二页')).toBeInTheDocument());
    fireEvent.click(screen.getByText('刷新会话列表'));
    await waitFor(() => expect(mock.sessions).toHaveBeenCalledTimes(4));
    expect(screen.getByText('第二页')).toBeInTheDocument();
    expect(mock.sessions.mock.calls.map((call) => call[1])).toEqual([0, 20, 0, 20]);
    expect(interval.mock.calls.filter((call) => call[1] === 3000)).toHaveLength(0);
  });
  it('直接链接与重新挂载保留 URL 选择，不被列表首项或空列表改写', async () => {
    window.history.replaceState(null, '', '/?view=monitor&threadId=linked#details');
    mock.sessions.mockResolvedValue({ sessions: [{ thread_id: 'first', name: '列表首项' }], isLive: true });
    const mounted = render(<App />);
    await waitFor(() => expect(screen.getByText('列表首项')).toBeInTheDocument());
    expect(mock.options.threadId).toBe('linked');
    mounted.unmount();
    mock.sessions.mockResolvedValue({ sessions: [], isLive: true });
    mock.busy.mockResolvedValue([]);
    mock.stop.mockResolvedValue(undefined); mock.cleanup.mockResolvedValue(undefined); mock.hydrate.mockResolvedValue(undefined);
    render(<App />);
    expect(mock.options.threadId).toBe('linked');
    expect(window.location.search).toBe('?view=monitor&threadId=linked');
    expect(window.location.hash).toBe('#details');
  });
  it('选择与新建支持真实后退前进，同一会话不重复插入历史', async () => {
    window.history.replaceState(null, '', '/?view=monitor&threadId=alpha#details');
    mock.sessions.mockResolvedValue({ sessions: [
      { thread_id: 'alpha', name: '会话甲' }, { thread_id: 'beta', name: '会话乙' },
    ], isLive: true });
    render(<App />);
    await waitFor(() => expect(screen.getByText('会话乙')).toBeInTheDocument());
    const push = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByText('会话乙'));
    expect(mock.options.threadId).toBe('beta');
    expect(document.querySelector('[data-thread-id="beta"]')?.className).toContain('bg-neutral-200/75');
    fireEvent.click(screen.getByText('会话乙'));
    expect(push).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('新建监测会话'));
    expect(mock.options.threadId).toBeNull();
    mock.disconnect.mockClear();
    act(() => window.history.back());
    await waitFor(() => expect(mock.options.threadId).toBe('beta'));
    expect(mock.disconnect).toHaveBeenCalledTimes(1);
    act(() => window.history.back());
    await waitFor(() => expect(mock.options.threadId).toBe('alpha'));
    act(() => window.history.forward());
    await waitFor(() => expect(mock.options.threadId).toBe('beta'));
    expect(push).toHaveBeenCalledTimes(2);
    expect(new URL(window.location.href).searchParams.get('view')).toBe('monitor');
    expect(window.location.hash).toBe('#details');
  });
  it('metadata 保存失败不伪装成标题成功，静默降级保留新会话不写聊天错误', async () => {
    mock.update.mockRejectedValue(new Error('private metadata failure'));
    const unconfirmedSession = { thread_id: 'sdk-thread', name: '新会话', created_at: '2026-09-15T00:00:00Z', status: 'busy' };
    mock.sessions.mockResolvedValue({ sessions: [unconfirmedSession], isLive: true });
    render(<App />); fireEvent.click(screen.getByText('发送测试消息')); await acceptRun();
    await waitFor(() => expect(screen.getByText('新会话')).toBeInTheDocument());
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
    fireEvent.click(screen.getByText('刷新会话列表'));
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
