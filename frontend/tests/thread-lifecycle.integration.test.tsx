import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLangGraphThreadListAdapter } from '@/lib/langgraph/thread-list-adapter';
import { AssistantProvider } from '@/app/providers/AssistantProvider';
import { App } from '@/App';
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
        get: vi.fn().mockResolvedValue({ thread_id: 'new-thread', metadata: {} }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
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

  it('App 根组件正确挂载并渲染 Sidebar 品牌标识与主聊天视口', async () => {
    render(<App />);

    expect(screen.getByText('LMA Monitor')).toBeInTheDocument();
    expect(screen.getByText('滑坡连续监测智能体')).toBeInTheDocument();
    expect(screen.getByText('服务配置')).toBeInTheDocument();
  });

  it('点击服务配置能正常呼出 ConfigModal，修改 API URL 后更新客户端', async () => {
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
});
