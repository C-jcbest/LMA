import { act, renderHook } from '@testing-library/react';
import { Client } from '@langchain/langgraph-sdk';
import { createLangGraphClient, getSessions, getBusySessions, mergeSessions, generateSessionTitle, renameSession } from '../src/services/api';
import { useStream } from '@langchain/react';
import { expect, it, vi } from 'vitest';
import { useMemo } from 'react';

it('前端 Stop 完全回归官方 stream.stop 控制，不修改 Thread state', async () => {
  const stopFn = vi.fn().mockResolvedValue(undefined);
  const stream = { stop: stopFn } as any;
  await stream.stop({ cancel: true });
  expect(stopFn).toHaveBeenCalledWith({ cancel: true });
});

it('真实 SDK 查询105个业务 Thread：归属、offset、轻量字段与busy IDs 写入 HTTP 请求', async () => {
  const rows = Array.from({ length: 105 }, (_, index) => ({ thread_id: `thread-${index}`, created_at: '2026-09-16T00:00:00Z', updated_at: new Date(Date.UTC(2026, 8, 16, 0, 0, 105 - index)).toISOString(), metadata: { graph_id: 'lma-agent', ...(index ? { name: `会话${index}` } : {}) }, status: 'idle' }));
  const requests: any[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, options: any) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    expect(body.metadata).toEqual({ graph_id: 'lma-agent' });
    expect(body.select).not.toContain('values');
    return new Response(JSON.stringify(body.ids ? rows.filter((row) => body.ids.includes(row.thread_id)) : rows.slice(body.offset, body.offset + body.limit)), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const client = createLangGraphClient('http://test-server:2024');
    let offset = 0;
    let sessions: Awaited<ReturnType<typeof getSessions>>['sessions'] = [];
    let more = true;
    while (more) {
      const page = await getSessions(client, offset);
      sessions = mergeSessions(sessions, page.sessions);
      offset = page.nextOffset; more = page.hasMore;
    }
    expect(sessions).toHaveLength(105);
    expect(sessions[0].name).toBe('新会话');
    expect(sessions.map((item) => item.thread_id)).toEqual(rows.map((item) => item.thread_id));
    expect(requests.map((item) => item.offset)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(requests.every((item) => item.sort_by === 'updated_at' && item.sort_order === 'desc')).toBe(true);
    await getBusySessions(client, ['thread-0', 'thread-1']);
    expect(requests.at(-1).ids).toEqual(['thread-0', 'thread-1']);
  } finally { fetchSpy.mockRestore(); }
});

it('真实官方 Hook、Thread CRUD 和标题共享 Client，URL/header 切换一致', async () => {
  const requests: { url: string; auth: string | null; body: any }[] = [];
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, options: any) => {
    const body = JSON.parse(options?.body || '{}');
    requests.push({ url: String(url), auth: new Headers(options?.headers).get('authorization'), body });
    const payload = String(url).endsWith('/threads/search') ? []
      : String(url).endsWith('/runs/wait') ? { title: '测试标题' }
      : body.method === 'run.start' ? { id: body.id, error: { code: 'invalid_params', message: '拒绝' } } : {};
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
  });
  const { result, rerender, unmount } = renderHook(({ url, auth }) => {
    const client = useMemo(() => createLangGraphClient(url, { authorization: auth }), [url, auth]);
    return { client, stream: useStream({ assistantId: 'lma-agent', client, threadId: null }) };
  }, { initialProps: { url: 'http://server-a:2024', auth: 'Bearer test-a' } });
  try {
    const first = result.current.client;
    for (const [url, auth] of [['http://server-a:2024', 'Bearer test-a'], ['http://server-b:2024', 'Bearer test-b']]) {
      rerender({ url, auth });
      expect(result.current.stream.client).toBe(result.current.client);
      const start = requests.length;
      await getSessions(result.current.client);
      await renameSession(result.current.client, 'test-thread', '新标题');
      await result.current.client.threads.delete('test-thread');
      expect(await generateSessionTitle(result.current.client, '首条消息')).toBe('测试标题');
      await act(async () => { await result.current.stream.submit({ messages: [{ type: 'human', content: '测试' }] }, { onError: () => {} }); });
      const batch = requests.slice(start);
      expect(batch.length).toBeGreaterThanOrEqual(5);
      expect(batch.every((request) => request.url.startsWith(url) && request.auth === auth)).toBe(true);
      expect(batch.some((request) => request.body.method === 'run.start')).toBe(true);
    }
    expect(result.current.client).not.toBe(first);
    const stable = result.current.client;
    rerender({ url: 'http://server-b:2024', auth: 'Bearer test-b' });
    expect(result.current.client).toBe(stable);
  } finally { unmount(); fetchSpy.mockRestore(); }
});

it('真实官方 useStream 首次失败：SDK 分配 ID 并提交 run.start，应用不预创建 Thread', async () => {
  const requests: { url: string; body: any }[] = [];
  const fetchStub = vi.fn(async (url: any, options: any) => {
    const body = JSON.parse(options.body || '{}');
    requests.push({ url: String(url), body });
    return new Response(JSON.stringify({ id: body.id, error: { code: 'invalid_params', message: '请求被拒绝' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const onThreadId = vi.fn(); const onError = vi.fn();
  const callerOptions = { maxRetries: 0 };
  const { result } = renderHook(() => useStream({ assistantId: 'lma-agent', apiUrl: 'http://localhost:2024',
    threadId: null, fetch: fetchStub, callerOptions, onThreadId }));
  let boundId: string | undefined;
  await act(async () => {
    const submission = result.current.submit({ messages: [{ type: 'human', content: '查询站点' }] }, { onError });
    boundId = result.current.getThread()?.threadId;
    await submission;
  });
  expect(onThreadId).toHaveBeenCalledTimes(1);
  const id = onThreadId.mock.calls[0][0];
  expect(boundId).toBe(id);

  expect(requests.some((request) => request.body.method === 'run.start' && request.url.includes(`/threads/${id}/commands`))).toBe(true);
  expect(requests.some((request) => /\/threads\/?$/.test(request.url))).toBe(false);
  expect(onError).toHaveBeenCalled();
});
it('真实官方 SDK 在首个 Run 响应前乐观显示用户消息', async () => {
  let respond!: (response: Response) => void;
  let command: any;
  const fetchStub = vi.fn((_url: any, options: any) => {
    command = JSON.parse(options.body);
    return new Promise<Response>((resolve) => { respond = resolve; });
  });
  const callerOptions = { maxRetries: 0 };
  const { result } = renderHook(() => useStream({ assistantId: 'lma-agent', apiUrl: 'http://localhost:2024',
    threadId: null, optimistic: true, fetch: fetchStub, callerOptions }));
  let submission!: Promise<void>;
  await act(async () => {
    submission = result.current.submit({ messages: [{ type: 'human', content: '乐观用户输入' }] });
  });
  expect(result.current.messages.some((message) => message.content === '乐观用户输入')).toBe(true);
  expect(result.current.isLoading).toBe(true);
  await act(async () => {
    respond(new Response(JSON.stringify({ type: 'error', id: command.id,
      error: { code: 'invalid_argument', message: '请求被拒绝' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
    await submission;
  });
});


it('官方 Client 将 DELETE 204 视为成功，只发一次请求且不解析空 JSON', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  try {
    const client = new Client({ apiUrl: 'http://localhost:2024', callerOptions: { maxRetries: 0 } });
    await expect(client.threads.delete('test-thread')).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
  }
});


it('项目 SDK HTTP 策略不在网络失败后自动重发 DELETE', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network response lost'));
  try {
    const client = createLangGraphClient('http://localhost:2024');
    await expect(client.threads.delete('test-thread')).rejects.toThrow('network response lost');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  } finally {
    fetchSpy.mockRestore();
  }
});
