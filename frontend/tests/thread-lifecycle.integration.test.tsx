import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadSidebar } from '../src/features/threads/ThreadSidebar';
import * as langgraph from '../src/lib/langgraph';
import { LangGraphClientProvider } from '../src/lib/langgraph';

// Mock Sonner toast
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('V2 会话管理与生命周期集成测试', () => {
  let queryClient: QueryClient;
  const mockClient = {
    threads: {
      delete: vi.fn(),
      update: vi.fn(),
      search: vi.fn(),
    },
  } as any;

  beforeEach(() => {
    vi.restoreAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  const renderSidebar = (initialEntries = ['/chat']) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <LangGraphClientProvider client={mockClient}>
          <MemoryRouter initialEntries={initialEntries}>
            <Routes>
              <Route path="/chat" element={<ThreadSidebar />} />
              <Route path="/chat/:threadId" element={<ThreadSidebar />} />
            </Routes>
          </MemoryRouter>
        </LangGraphClientProvider>
      </QueryClientProvider>
    );
  };

  it('正确加载并渲染会话列表', async () => {
    vi.spyOn(langgraph, 'getSessions').mockResolvedValue({
      sessions: [
        {
          thread_id: 'thread-1',
          name: '监测点SCWM-04位移分析',
          created_at: '2026-09-15T00:00:00Z',
          updated_at: '2026-09-16T12:00:00Z',
          status: 'idle',
        },
        {
          thread_id: 'thread-2',
          name: '降雨量关联排查',
          created_at: '2026-09-14T00:00:00Z',
          updated_at: '2026-09-15T08:00:00Z',
          status: 'idle',
        },
      ],
      isLive: true,
      nextOffset: 2,
      hasMore: false,
    });

    renderSidebar();

    expect(screen.getByText('LMA 滑坡连续监测')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('监测点SCWM-04位移分析')).toBeInTheDocument();
      expect(screen.getByText('降雨量关联排查')).toBeInTheDocument();
    });
  });

  it('支持根据关键词过滤会话', async () => {
    vi.spyOn(langgraph, 'getSessions').mockResolvedValue({
      sessions: [
        {
          thread_id: 'thread-1',
          name: '监测点SCWM-04位移分析',
          created_at: '2026-09-15T00:00:00Z',
          status: 'idle',
        },
        {
          thread_id: 'thread-2',
          name: '降雨量关联排查',
          created_at: '2026-09-14T00:00:00Z',
          status: 'idle',
        },
      ],
      isLive: true,
      nextOffset: 2,
      hasMore: false,
    });

    renderSidebar();

    await waitFor(() => expect(screen.getByText('监测点SCWM-04位移分析')).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText('搜索会话…');
    fireEvent.change(searchInput, { target: { value: '降雨' } });

    expect(screen.queryByText('监测点SCWM-04位移分析')).not.toBeInTheDocument();
    expect(screen.getByText('降雨量关联排查')).toBeInTheDocument();
  });

  it('重命名会话调用 renameSession 并在成功后更新列表', async () => {
    vi.spyOn(langgraph, 'getSessions').mockResolvedValue({
      sessions: [
        {
          thread_id: 'thread-1',
          name: '原标题',
          created_at: '2026-09-15T00:00:00Z',
          status: 'idle',
        },
      ],
      isLive: true,
      nextOffset: 1,
      hasMore: false,
    });
    const renameSpy = vi.spyOn(langgraph, 'renameSession').mockResolvedValue({
      thread_id: 'thread-1',
      metadata: { name: '修改后的标题' },
    } as any);

    renderSidebar();

    await waitFor(() => expect(screen.getByText('原标题')).toBeInTheDocument());

    // 打开操作菜单
    const menuBtn = screen.getByRole('button', { name: '会话操作' });
    fireEvent.click(menuBtn);

    // 点击重命名
    const renameOption = screen.getByText('重命名');
    fireEvent.click(renameOption);

    // 弹窗输入新名称
    const dialogInput = screen.getByPlaceholderText('请输入新会话名称');
    fireEvent.change(dialogInput, { target: { value: '修改后的标题' } });

    fireEvent.click(screen.getByText('确认'));

    await waitFor(() => {
      expect(renameSpy).toHaveBeenCalledWith(mockClient, 'thread-1', '修改后的标题');
    });
  });

  it('删除会话弹出二次确认框，确认后调用 deleteSession', async () => {
    vi.spyOn(langgraph, 'getSessions').mockResolvedValue({
      sessions: [
        {
          thread_id: 'thread-del',
          name: '待删除会话',
          created_at: '2026-09-15T00:00:00Z',
          status: 'idle',
        },
      ],
      isLive: true,
      nextOffset: 1,
      hasMore: false,
    });
    const deleteSpy = vi.spyOn(langgraph, 'deleteSession').mockResolvedValue(undefined);

    renderSidebar();

    await waitFor(() => expect(screen.getByText('待删除会话')).toBeInTheDocument());

    // 打开操作菜单
    const menuBtn = screen.getByRole('button', { name: '会话操作' });
    fireEvent.click(menuBtn);

    // 点击删除
    const deleteOption = screen.getByText('删除');
    fireEvent.click(deleteOption);

    // 弹出确认框
    expect(screen.getByText('确认删除此会话？')).toBeInTheDocument();
    const confirmBtn = screen.getByText('确认删除');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteSpy).toHaveBeenCalledWith(mockClient, 'thread-del');
    });
  });
});
