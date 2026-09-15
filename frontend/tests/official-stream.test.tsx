import { act, renderHook, waitFor } from '@testing-library/react';
import { Client } from '@langchain/langgraph-sdk';
import { createLangGraphClient, getSessions, generateSessionTitle, renameSession } from '../src/services/api';
import { useStream } from '@langchain/react';
import { expect, it, vi } from 'vitest';
import { useMemo } from 'react';

it.each(['stop', 'disconnect'] as const)('真实官方 Hook %s 只操作当前 Run，不扫描或修改 checkpoint', async (action) => {
  const fetchStub = vi.fn(async (_url: any, options: any) => {
    const body = JSON.parse(options?.body || '{}');
    if (body.method === 'run.start') {
      return new Response(JSON.stringify({ id: body.id, result: { run_id: 'run-current' } }),
        { headers: { 'content-type': 'application/json' } });
    }
    return new Response(new ReadableStream({ start(controller) {
      options?.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const client = new Client({ apiUrl: 'http://localhost:2024', fetch: fetchStub, callerOptions: { maxRetries: 0 } });
  const cancel = vi.spyOn(client.runs, 'cancel').mockResolvedValue(undefined);
  const list = vi.spyOn(client.runs, 'list');
  const update = vi.spyOn(client.threads, 'updateState');
  const onCreated = vi.fn();
  const { result, unmount } = renderHook(() => useStream({ assistantId: 'lma-agent', client, threadId: null, onCreated }));
  let submission!: Promise<void>;
  try {
    await act(async () => { submission = result.current.submit({ messages: [{ type: 'human', content: '查询' }] }); });
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const threadId = result.current.getThread()!.threadId;
    await act(async () => { await result.current[action](); await submission; });
    if (action === 'stop') {
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel).toHaveBeenCalledWith(threadId, onCreated.mock.calls[0][0].runId);
    }
    else expect(cancel).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  } finally { unmount(); }
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
