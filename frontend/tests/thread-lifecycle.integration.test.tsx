import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  options: null as any,
  current: null as string | null,
  submit: vi.fn(), get: vi.fn(), update: vi.fn(), list: vi.fn(), state: vi.fn(), history: vi.fn(),
  sessions: vi.fn(), title: vi.fn(), disconnect: vi.fn(),
}));
vi.mock('@langchain/react', () => ({ useStream: (options: any) => {
  mock.options = options;
  return { messages: [], values: {}, isLoading: false, isThreadLoading: false,
    submit: mock.submit, disconnect: mock.disconnect, getThread: () => ({ threadId: mock.current }),
    client: { threads: { get: mock.get, update: mock.update, getState: mock.state, getHistory: mock.history },
      runs: { list: mock.list } },
  };
} }));
vi.mock('../src/services/api', async (original) => ({ ...await original<any>(),
  getSessions: mock.sessions, generateSessionTitle: mock.title,
}));
vi.mock('../src/components/ChatWindow', () => ({ ChatWindow: (props: any) =>
  <><button onClick={() => void props.onSendMessage('首条消息')}>发送测试消息</button><span>{props.errorMessage}</span></> }));
import { App } from '../src/App';

describe('SDK Thread 生命周期界面契约', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.history.replaceState(null, '', '/');
    mock.current = null;
    mock.sessions.mockResolvedValue({ sessions: [], isLive: true });
    mock.list.mockResolvedValue([{ run_id: 'run-1' }]);
    mock.state.mockResolvedValue({ checkpoint: { checkpoint_id: 'checkpoint-1' } });
    mock.history.mockResolvedValue([{}]);
    mock.get.mockResolvedValue({ metadata: { name: '新会话' } });
    mock.update.mockResolvedValue({});
    mock.title.mockResolvedValue('正式标题');
    mock.submit.mockImplementation(async (_input: any, _options: any) => {
      mock.current = 'sdk-thread';
      mock.options.onThreadId('sdk-thread');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  it('首条提交不传 ID；SDK 回调写入 URL，标题独立更新', async () => {
    mock.get.mockResolvedValueOnce({ metadata: {} }).mockResolvedValue({ metadata: { name: '新会话' } });
    render(<App />);
    expect(mock.options.threadId).toBeNull();
    fireEvent.click(screen.getByText('发送测试消息'));
    await waitFor(() => expect(mock.title).toHaveBeenCalledWith('首条消息'));
    expect(mock.submit.mock.calls[0][1]).not.toHaveProperty('threadId');
    expect(new URL(window.location.href).searchParams.get('threadId')).toBe('sdk-thread');
    await waitFor(() => expect(mock.update).toHaveBeenCalledWith('sdk-thread', { metadata: { name: '正式标题' } }));
  });
  it('刷新 URL 恢复选择态；列表刷新不切回旧会话', async () => {
    window.history.replaceState(null, '', '/?threadId=restored');
    render(<App />);
    expect(mock.options.threadId).toBe('restored');
    fireEvent.click(screen.getByText('新建监测会话'));
    await waitFor(() => expect(mock.options.threadId).toBeNull());
    expect(new URL(window.location.href).searchParams.has('threadId')).toBe(false);
  });
  it('无 Run 和 checkpoint 的失败提交不登记空会话、不生成标题', async () => {
    mock.list.mockResolvedValue([]); mock.state.mockResolvedValue({ checkpoint: null }); mock.history.mockResolvedValue([]);
    mock.submit.mockImplementation(async (_input: any, options: any) => {
      mock.current = 'sdk-thread'; mock.options.onThreadId(mock.current);
      options.onError(new Error('private server stack'));
    });
    render(<App />);
    fireEvent.click(screen.getByText('发送测试消息'));
    await waitFor(() => expect(mock.history).toHaveBeenCalled());
    expect(mock.update).not.toHaveBeenCalled(); expect(mock.title).not.toHaveBeenCalled();
    expect(screen.queryByText(/private server stack/)).not.toBeInTheDocument();
  });
  it('标题失败保留服务端默认名，不写聊天错误', async () => {
    mock.get.mockResolvedValueOnce({ metadata: {} });
    mock.title.mockRejectedValue(new Error('private title failure'));
    render(<App />); fireEvent.click(screen.getByText('发送测试消息'));
    await waitFor(() => expect(mock.title).toHaveBeenCalled());
    await act(async () => {});
    expect(mock.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/private title failure|标题生成失败/)).not.toBeInTheDocument();
  });
  it('标题生成期间手动改名不被覆盖', async () => {
    mock.get.mockResolvedValueOnce({ metadata: {} }).mockResolvedValue({ metadata: { name: '用户命名' } });
    render(<App />); fireEvent.click(screen.getByText('发送测试消息'));
    await waitFor(() => expect(mock.get).toHaveBeenCalledTimes(2));
    expect(mock.update).toHaveBeenCalledTimes(1);
  });
});
