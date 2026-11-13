import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import * as api from '@/services/api';

describe('访问保护', () => {
  let mockClient: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockClient = {
      getAuthSession: vi.fn().mockResolvedValue({ enabled: true, authenticated: false }),
      login: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      suggestQuestions: vi.fn().mockResolvedValue([]),
      listStations: vi.fn().mockResolvedValue([]),
      getLatestInspection: vi.fn().mockResolvedValue({ running: null, latest_attempt: null, inspection: null, stations: [] }),
      listSessions: vi.fn().mockResolvedValue([]),
      listSessionConclusions: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({ values: { messages: [] }, latest_run: null }),
    };
    vi.spyOn(api, 'createLmaClient').mockReturnValue(mockClient);
  });

  it('未登录只显示登录页，不请求业务数据；账号密码错误时保留账号并提示', async () => {
    mockClient.login.mockRejectedValueOnce(new Error('账号或密码错误。'));
    render(<App />);

    const username = await screen.findByRole('textbox', { name: '账号' });
    expect(mockClient.listSessions).not.toHaveBeenCalled();
    expect(mockClient.getLatestInspection).not.toHaveBeenCalled();

    await userEvent.type(username, 'admin');
    await userEvent.type(screen.getByLabelText('密码'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('账号或密码错误。');
    expect(mockClient.login).toHaveBeenCalledWith('admin', 'wrong');
    expect(username).toHaveValue('admin');
    expect(screen.getByLabelText('密码')).toHaveValue('');
  });

  it('登录成功进入应用；之后任一接口返回 401 时回到登录页并说明已过期', async () => {
    mockClient.login.mockResolvedValueOnce(undefined);
    render(<App />);

    await userEvent.type(await screen.findByRole('textbox', { name: '账号' }), 'admin');
    await userEvent.type(screen.getByLabelText('密码'), 'right');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('button', { name: '退出登录' })).toBeInTheDocument();
    await waitFor(() => expect(mockClient.getLatestInspection).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(new Event(api.UNAUTHORIZED_EVENT));
    });
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument();
  });

  it('未启用访问保护时直接进入应用，不显示退出登录', async () => {
    mockClient.getAuthSession.mockResolvedValue({ enabled: false, authenticated: true });
    render(<App />);

    expect(await screen.findByRole('textbox', { name: '输入监测问题' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '退出登录' })).not.toBeInTheDocument();
  });
});
