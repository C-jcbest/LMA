import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  options: null as any, current: null as string | null, loading: false,
  messages: [] as any[], finishRun: null as null | (() => void),
  remove: vi.fn(), submit: vi.fn(), get: vi.fn(), update: vi.fn(), run: vi.fn(),
  sessions: vi.fn(), title: vi.fn(), disconnect: vi.fn(),
  factory: vi.fn(),
}));
vi.mock('@langchain/react', () => ({ useStream: (options: any) => {
  mock.options = options;
  return { messages: mock.messages, values: {}, isLoading: mock.loading, isThreadLoading: false,
    submit: mock.submit, disconnect: mock.disconnect, getThread: () => ({ threadId: mock.current }),
    client: options.client,
  };
} }));
vi.mock('../src/services/api', async (original) => ({ ...await original<any>(),
  getSessions: mock.sessions, generateSessionTitle: mock.title,
  createLangGraphClient: mock.factory,
}));
vi.mock('../src/components/ChatWindow', () => ({ ChatWindow: (props: any) =>
  <><button onClick={() => void props.onSendMessage('首条消息')}>发送测试消息</button>
    <span>{props.errorMessage}</span>{props.messages.map((message: any, index: number) => <p key={index}>{message.content}</p>)}</> }));
import { App } from '../src/App';
const thread = (name?: string) => ({ thread_id: 'sdk-thread', created_at: '2026-09-15T00:00:00Z',
  metadata: name ? { name } : {}, status: 'busy' });
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
    localStorage.clear();
    mock.factory.mockImplementation(() => ({
      threads: { delete: mock.remove, get: mock.get, update: mock.update }, runs: { get: mock.run },
    }));
    mock.sessions.mockResolvedValue({ sessions: [], isLive: true });
    mock.remove.mockResolvedValue(undefined);
    mock.run.mockResolvedValue({ run_id: 'run-1' });
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
    await waitFor(() => expect(mock.sessions).toHaveBeenCalledWith(nextClient));
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
  it('删除成功后迟到的旧轮询不能复活会话', async () => {
    const existing = { thread_id: 'sdk-thread', name: '待删除会话', created_at: '2026-09-15T00:00:00Z', status: 'idle' };
    let poll!: () => void;
    let resolveOld!: (value: any) => void;
    const interval = vi.spyOn(window, 'setInterval').mockImplementation((callback: any) => { poll = callback; return 123; });
    mock.sessions.mockResolvedValueOnce({ sessions: [existing], isLive: true })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue({ sessions: [], isLive: true });
    render(<App />);
    const refresh = poll;
    interval.mockRestore();
    await waitFor(() => expect(screen.getByText('待删除会话')).toBeInTheDocument());
    await act(async () => { refresh(); });
    fireEvent.click(screen.getByTitle('删除')); fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('待删除会话')).not.toBeInTheDocument());
    await act(async () => { resolveOld({ sessions: [existing], isLive: true }); });
    expect(screen.queryByText('待删除会话')).not.toBeInTheDocument();
    expect(mock.remove).toHaveBeenCalledTimes(1);
    interval.mockRestore();
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
    expect(mock.sessions).toHaveBeenCalledWith(mock.options.client);
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
